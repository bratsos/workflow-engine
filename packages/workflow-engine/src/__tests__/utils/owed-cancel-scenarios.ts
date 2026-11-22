/**
 * A provider batch the engine created and still knows by any record ends
 * cancelled, or is named by id in a returned outcome and in a WARN on the run.
 *
 * Two records nobody completed before:
 * - a batch an execution of the submit step created and lost (another
 *   execution recorded the step first) is recorded as owed a cancel
 *   (`cancelOwed`) before the cancel is sent; when that process stops before
 *   the request leaves, the next run.cancel, the redrive, the step's next
 *   execution and, on a completed or finally failed row, the stage's next
 *   replay each complete it (left: an id recorded after the last replay);
 * - a row a `run.redrive` from start deletes while a cancel was asked for on
 *   it (a sweep holds it, or recorded an intent, or the run is CANCELLED):
 *   the redrive and the sweep send the cancel with no record, and report it,
 *   and the redrive names each batch on the run before its commit.
 *
 * Driven through `kernel.dispatch` with the real AI SDK transports and a fake
 * provider `fetch` (`real-batch-cancel-harness.ts`), in memory and on the
 * Prisma databases.
 */

import { expect, it } from "vitest";
import { z } from "zod";
import type { EngineBatchModel } from "../../ai/batch/model.js";
import { defineAsyncBatchStage } from "../../core/stage-factory.js";
import { deriveStepExternalKey } from "../../core/step-external-key.js";
import type { RunRedriveResult } from "../../kernel/commands.js";
import { owedRetryOf } from "../../kernel/helpers/batch-submit-record.js";
import {
  BATCH_MODEL,
  createBatchAwareFactory,
} from "../durable/ai-map-harness.js";
import { createMockAIHelperFactory } from "./index.js";
import {
  barrier,
  createHarness,
  type Harness,
  type KernelDb,
  logsOf,
  setup,
} from "./real-batch-cancel-harness.js";

type Vendor = "anthropic" | "google";
const VENDORS: Vendor[] = ["anthropic", "google"];
const firstBatch = (vendor: Vendor) =>
  vendor === "anthropic" ? "msgbatch_1" : "batches/b1";

type Submit = {
  refs?: Array<{ id: string }>;
  cancelOwed?: Array<{ id: string }>;
  cancelledBatchIds?: string[];
};

export function owedCancelScenarios(database: () => KernelDb | undefined) {
  const warnsNaming = async (h: Harness, id: string) =>
    (await logsOf(h, database()))
      .filter((l) => l.level === "WARN" && l.message.includes(`"${id}"`))
      .map((l) => l.message);

  const submitResult = async (h: Harness) =>
    ((await h.row())?.result ?? {}) as Submit;

  /**
   * Execution A of the submit step is held before its create; the run is
   * cancelled and redriven, B records batch 2, then A creates batch 1, loses
   * the row, records batch 1 as owed and its process stops before the cancel
   * request leaves (the request never returns). `beforeHold` runs before the
   * first hold of a sweep, once.
   */
  async function loserStopsAfterOwed(
    id: string,
    vendor: Vendor,
    beforeHold?: (go: () => void) => Promise<void>,
  ) {
    const h = await setup(id, vendor, {
      onReclaim: "resubmit",
      database: database(),
    });
    const entered = barrier();
    const go = barrier();
    let n = 0;
    h.setBeforeStart(async () => {
      if (++n === 1) {
        entered.release();
        await go.promise;
      }
    });
    const a = h.execute();
    await entered.promise;
    await h.cancel();
    await h.redrive();
    await h.execute();
    const never = barrier();
    let cancels = 0;
    h.setBeforeCancel(async () => {
      if (++cancels === 1) await never.promise;
    });
    const owed = async () => {
      for (let i = 0; i < 500; i++) {
        const r = await submitResult(h);
        if (r.cancelOwed?.length && cancels > 0) return;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error("the loser never recorded its batch as owed");
    };
    return {
      h,
      a,
      lost: firstBatch(vendor),
      owed,
      start: async () => {
        if (beforeHold) return;
        go.release();
        await owed();
      },
      go: () => go.release(),
      /** Lets the stopped process's request answer, and waits for it. */
      cleanup: async () => {
        never.release();
        await a.catch(() => undefined);
      },
      cancels: () => cancels,
    };
  }

  for (const vendor of VENDORS) {
    it(`G1 ${vendor}: a loser that stops between recording its batch as owed and cancelling it: the next run.cancel cancels it`, async () => {
      const s = await loserStopsAfterOwed(`g1-${vendor}`, vendor);
      try {
        await s.start();
        const { h, lost } = s;
        // Owed and cancelled are told apart in the row.
        const before = await submitResult(h);
        expect(before.cancelOwed?.map((r) => r.id)).toEqual([lost]);
        expect(before.cancelledBatchIds ?? []).not.toContain(lost);

        const c1 = await h.cancel();
        expect(c1.batches).toContainEqual(
          expect.objectContaining({
            stepId: "x:submit",
            ref: expect.objectContaining({ id: lost }),
            status: "cancelled",
          }),
        );
        expect(h.live()).not.toContain(lost);
        const after = await submitResult(h);
        expect(after.cancelOwed).toBeUndefined();
        expect(after.cancelledBatchIds).toContain(lost);

        // The gate's recovery sequence: nothing brings it back.
        await h.cancel();
        await h.redrive();
        await h.execute();
        await h.cancel();
        expect(h.live()).not.toContain(lost);
      } finally {
        await s.cleanup();
      }
    });
  }

  it("an owed cancel the sweep cannot complete stays owed and named; the redrive completes it and reports it", async () => {
    const s = await loserStopsAfterOwed("owed-redrive", "anthropic");
    try {
      await s.start();
      const { h, lost } = s;
      h.failCancel(true);
      const c1 = await h.cancel();
      expect(c1.batches).toContainEqual(
        expect.objectContaining({
          ref: expect.objectContaining({ id: lost }),
          status: "failed",
        }),
      );
      expect((await submitResult(h)).cancelOwed?.map((r) => r.id)).toEqual([
        lost,
      ]);
      expect(await warnsNaming(h, lost)).not.toEqual([]);

      h.failCancel(false);
      const redrive = (await h.redrive()) as RunRedriveResult;
      expect(redrive.batches).toContainEqual(
        expect.objectContaining({
          stepId: "x:submit",
          ref: expect.objectContaining({ id: lost }),
          status: "cancelled",
        }),
      );
      expect(h.live()).not.toContain(lost);
      expect((await submitResult(h)).cancelOwed).toBeUndefined();
    } finally {
      await s.cleanup();
    }
  });

  it("an owed cancel neither the sweep nor the redrive can send is named with cancel-at-the-provider advice, and the step's next execution completes it", async () => {
    const s = await loserStopsAfterOwed("owed-step", "anthropic");
    try {
      await s.start();
      const { h, lost } = s;
      h.failCancel(true);
      await h.cancel();
      h.failCancel(false);
      // No transport for the redrive's cancel (the step's own model is not
      // resolved through it).
      h.setResolver(() => Promise.reject(new Error("no transport here")));
      const redrive = (await h.redrive()) as RunRedriveResult;
      expect(redrive.batches).toContainEqual(
        expect.objectContaining({
          ref: expect.objectContaining({ id: lost }),
          status: "unavailable",
          error: expect.stringContaining("stays owed"),
        }),
      );
      const warns = await warnsNaming(h, lost);
      expect(warns.some((w) => w.includes("cancel it at the provider"))).toBe(
        true,
      );
      // The run is RUNNING again: no WARN written now advises run.cancel.
      expect(
        warns.filter((w) => w.startsWith("Redriving")).join(),
      ).not.toContain("run.cancel");
      h.setResolver(async () => h.model);

      await h.execute();
      expect(h.live()).not.toContain(lost);
      const after = await submitResult(h);
      expect(after.cancelOwed).toBeUndefined();
      expect(after.cancelledBatchIds).toContain(lost);
    } finally {
      await s.cleanup();
    }
  });

  it("a sweep that read the row before the loser recorded its batch as owed cannot hold it with the record dropped", async () => {
    let released = false;
    const s = await loserStopsAfterOwed(
      "owed-hold-race",
      "anthropic",
      async () => {},
    );
    const { h, lost } = s;
    try {
      const cas = h.ledger.compareAndSet.bind(h.ledger);
      h.ledger.compareAndSet = async (sid, key, expected, patch) => {
        const result = patch.result as { cancelFence?: unknown } | undefined;
        if (
          !released &&
          key === "x:submit" &&
          patch.leaseExpiresAt instanceof Date &&
          result?.cancelFence
        ) {
          // The sweep has scanned the row; the loser records its batch as
          // owed (and stops) before the hold is written.
          released = true;
          s.go();
          await s.owed();
        }
        return cas(sid, key, expected, patch);
      };
      const c = await h.cancel();
      expect(released).toBe(true);
      expect(c.batches).toContainEqual(
        expect.objectContaining({
          ref: expect.objectContaining({ id: lost }),
          status: "cancelled",
        }),
      );
      expect(h.live()).not.toContain(lost);
      // Settled on the row the sweep did not hold.
      expect((await submitResult(h)).cancelOwed).toBeUndefined();
    } finally {
      await s.cleanup();
    }
  });

  it("an owed cancel is sent by a sweep a run.redrive overtook (the redrive leaves the row the sweep holds to it)", async () => {
    const s = await loserStopsAfterOwed("owed-overtaken", "anthropic");
    try {
      await s.start();
      const { h, lost } = s;
      const wait = barrier();
      const go = barrier();
      let first = true;
      h.setResolver(async () => {
        if (first) {
          first = false;
          wait.release();
          await go.promise;
        }
        return h.model;
      });
      const c = h.cancel();
      await wait.promise;
      const redrive = (await h.redrive()) as RunRedriveResult;
      expect(redrive.batches).toContainEqual(
        expect.objectContaining({ status: "held" }),
      );
      go.release();
      const outcome = await c;
      expect(outcome.batches).toContainEqual(
        expect.objectContaining({
          ref: expect.objectContaining({ id: lost }),
          status: "cancelled",
        }),
      );
      expect(h.live()).not.toContain(lost);
      // The batch the redriven run goes on with is untouched.
      expect(h.live()).toContain("msgbatch_2");
    } finally {
      await s.cleanup();
    }
  });

  it("the WARN of a loser whose cancel failed is on the run, and outlives a run.redrive from the start", async () => {
    const s = await loserStopsAfterOwed(
      "owed-warn",
      "anthropic",
      async () => {},
    );
    const { h, lost } = s;
    try {
      h.failCancel(true);
      s.go();
      await s.a.catch(() => undefined);
      await h.cancel();
      await h.kernel.dispatch({
        type: "run.redrive",
        workflowRunId: h.workflowRunId,
        from: { kind: "start" },
      });
      const warns = await warnsNaming(h, lost);
      expect(
        warns.some((w) => w.includes("whose outcome was not recorded")),
      ).toBe(true);
    } finally {
      await s.cleanup();
    }
  });

  it("a batch owed a cancel is never adopted: a retry that cannot cancel it searches past it and keeps it owed", async () => {
    const h = await setup("owed-adopt", "google", { database: database() });
    const entered = barrier();
    const go = barrier();
    let n = 0;
    h.setBeforeStart(async () => {
      if (++n === 1) {
        entered.release();
        await go.promise;
      }
    });
    // A is held before its create; its lease lapses, B takes the step over
    // and its create is rejected: the row is failed, with no batch.
    const a = h.execute();
    await entered.promise;
    h.clock.advance(10 * 60_000);
    h.rejectStart(2);
    await h.execute();
    // A creates batches/b1, loses the row, records it as owed and stops
    // before its cancel request leaves.
    const never = barrier();
    h.setBeforeCancel(() => never.promise);
    go.release();
    try {
      for (let i = 0; i < 500; i++) {
        if ((await submitResult(h)).cancelOwed) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect((await submitResult(h)).cancelOwed?.map((r) => r.id)).toEqual([
        "batches/b1",
      ]);
      // The retry's cancel of b1 fails, and its search for the step's
      // external key (Gemini can search) finds b1 running: it is not adopted.
      h.setBeforeCancel(undefined);
      h.failCancel(true);
      h.clock.advance(10 * 60_000);
      await h.execute();
      const after = await submitResult(h);
      expect(after.refs?.map((r) => r.id)).not.toContain("batches/b1");
      expect(after.cancelOwed?.map((r) => r.id)).toEqual(["batches/b1"]);
      // Recorded for the replays that follow.
      expect(owedRetryOf((await h.row())?.result)["batches/b1"]?.tries).toBe(1);
      // Tried once by this execution: its own result is not replayed.
      expect(
        (await warnsNaming(h, "batches/b1")).filter((w) =>
          w.includes("cancelling them failed"),
        ),
      ).toHaveLength(1);
    } finally {
      never.release();
      await a.catch(() => undefined);
    }
  });

  for (const vendor of VENDORS) {
    it(`G2 ${vendor}: a run.redrive from start while a sweep holds the row: the batch is cancelled and reported by both`, async () => {
      const h = await setup(`g2-${vendor}`, vendor, { database: database() });
      await h.execute();
      const wait = barrier();
      const go = barrier();
      let first = true;
      h.setResolver(async () => {
        if (first) {
          first = false;
          wait.release();
          await go.promise;
        }
        return h.model;
      });
      const c = h.cancel();
      await wait.promise;
      const redrive = (await h.kernel.dispatch({
        type: "run.redrive",
        workflowRunId: h.workflowRunId,
        from: { kind: "start" },
      })) as RunRedriveResult;
      go.release();
      const outcome = await c;
      await h.execute();
      const old = firstBatch(vendor);
      expect(redrive.batches).toContainEqual(
        expect.objectContaining({
          ref: expect.objectContaining({ id: old }),
          status: "cancelled",
        }),
      );
      expect(outcome.batches).toContainEqual(
        expect.objectContaining({
          ref: expect.objectContaining({ id: old }),
          status: "cancelled",
          error: expect.stringContaining("deleted with its stage record"),
        }),
      );
      expect(h.live()).not.toContain(old);
      // The WARN is on the run (it outlives the deleted stage record), and
      // the run is RUNNING: it does not advise repeating run.cancel.
      const warns = await warnsNaming(h, old);
      expect(warns).not.toEqual([]);
      expect(warns.join()).not.toContain("repeat run.cancel");
    });
  }

  it("G2 with no cancel getting through: the batch is named as failed by the redrive and the sweep, in WARNs that survive and advise cancelling at the provider", async () => {
    const h = await setup("g2-failing", "anthropic", { database: database() });
    await h.execute();
    const wait = barrier();
    const go = barrier();
    let first = true;
    h.setResolver(async () => {
      if (first) {
        first = false;
        wait.release();
        await go.promise;
      }
      return h.model;
    });
    h.failCancel(true);
    const c = h.cancel();
    await wait.promise;
    const redrive = (await h.kernel.dispatch({
      type: "run.redrive",
      workflowRunId: h.workflowRunId,
      from: { kind: "start" },
    })) as RunRedriveResult;
    go.release();
    const outcome = await c;
    expect(redrive.batches).toContainEqual(
      expect.objectContaining({
        ref: expect.objectContaining({ id: "msgbatch_1" }),
        status: "failed",
        error: expect.stringContaining("nothing else will cancel this batch"),
      }),
    );
    expect(outcome.batches).toContainEqual(
      expect.objectContaining({
        ref: expect.objectContaining({ id: "msgbatch_1" }),
        status: "failed",
        error: expect.stringContaining("nothing else will cancel this batch"),
      }),
    );
    const warns = await warnsNaming(h, "msgbatch_1");
    expect(warns.length).toBeGreaterThanOrEqual(2);
    for (const w of warns) {
      expect(w).toContain("cancel it at the provider");
      expect(w).not.toContain("repeat run.cancel");
    }
  });

  for (const vendor of VENDORS) {
    it(`G3 ${vendor}: a run.redrive from start over a recorded intent sends the cancel and reports it`, async () => {
      const h = await setup(`g3-${vendor}`, vendor, { database: database() });
      await h.execute();
      await h.cancelDyingAfter("intent");
      expect(
        ((await h.row())?.result as { cancelIntent?: unknown }).cancelIntent,
      ).toBeDefined();
      const redrive = (await h.kernel.dispatch({
        type: "run.redrive",
        workflowRunId: h.workflowRunId,
        from: { kind: "start" },
      })) as RunRedriveResult;
      await h.execute();
      const old = firstBatch(vendor);
      expect(redrive.batches).toEqual([
        expect.objectContaining({
          stepId: "x:submit",
          ref: expect.objectContaining({ id: old }),
          status: "cancelled",
        }),
      ]);
      expect(h.live()).not.toContain(old);
    });
  }

  it("a run.redrive from start over the intent a released sweep left sends the cancel and reports it", async () => {
    const h = await setup("g3-released", "anthropic", { database: database() });
    await h.execute();
    h.failCancel(true);
    await h.cancel();
    h.failCancel(false);
    const left = (await h.row())?.result as {
      cancelIntent?: unknown;
      cancelFence?: unknown;
    };
    expect(left.cancelIntent).toBeDefined();
    expect(left.cancelFence).toBeUndefined();
    const redrive = (await h.kernel.dispatch({
      type: "run.redrive",
      workflowRunId: h.workflowRunId,
      from: { kind: "start" },
    })) as RunRedriveResult;
    expect(redrive.batches).toEqual([
      expect.objectContaining({
        ref: expect.objectContaining({ id: "msgbatch_1" }),
        status: "cancelled",
      }),
    ]);
    expect(h.live()).not.toContain("msgbatch_1");
  });

  /** A cancelled run whose row records no cancel: what a redrive that read it before a sweep held it sees. */
  async function cancelledWithNoRecord(id: string) {
    const h = await setup(id, "anthropic", { database: database() });
    await h.execute();
    // A sweep with no transport sends nothing and records nothing.
    h.setResolver(async () => undefined as unknown as EngineBatchModel);
    await h.cancel();
    h.setResolver(async () => h.model);
    const left = (await h.row())?.result as Record<string, unknown>;
    expect(left.cancelIntent).toBeUndefined();
    expect(left.cancelledBatchIds).toBeUndefined();
    return h;
  }

  it("a run.redrive from start of a run no longer cancelled sends the cancel a sweep's fence or intent records on a row it deletes", async () => {
    for (const left of ["fence", "intent"] as const) {
      const h = await setup(`left-${left}`, "anthropic", {
        database: database(),
      });
      await h.execute();
      if (left === "fence") await h.cancelDyingAfter("hold");
      else {
        // Released with the intent alone: the request may have reached it.
        h.failCancel(true);
        await h.cancel();
        h.failCancel(false);
        const row = (await h.row())?.result as Record<string, unknown>;
        expect(row.cancelIntent).toBeDefined();
        expect(row.cancelFence).toBeUndefined();
      }
      // The row outlived the cancel (a redrive from the stage keeps it) and
      // the run then failed.
      await h.persistence.updateRun(h.workflowRunId, { status: "FAILED" });
      const redrive = (await h.kernel.dispatch({
        type: "run.redrive",
        workflowRunId: h.workflowRunId,
        from: { kind: "start" },
      })) as RunRedriveResult;
      expect(redrive.batches).toEqual([
        expect.objectContaining({
          ref: expect.objectContaining({ id: "msgbatch_1" }),
          status: "cancelled",
        }),
      ]);
      expect(h.live()).not.toContain("msgbatch_1");
    }
  });

  it("a run.redrive from start of a cancelled run sends the cancel run.cancel asked for on a row it deletes that records none, and names it first", async () => {
    const h = await cancelledWithNoRecord("plain-cancelled");
    const redrive = (await h.kernel.dispatch({
      type: "run.redrive",
      workflowRunId: h.workflowRunId,
      from: { kind: "start" },
    })) as RunRedriveResult;
    expect(redrive.batches).toEqual([
      expect.objectContaining({
        stepId: "x:submit",
        ref: expect.objectContaining({ id: "msgbatch_1" }),
        status: "cancelled",
      }),
    ]);
    expect(h.live()).not.toContain("msgbatch_1");
    const logs = (await logsOf(h, database())).filter((l) =>
      l.message.includes('"msgbatch_1"'),
    );
    expect(
      logs.some(
        (l) =>
          l.level === "WARN" &&
          l.message.startsWith("Redriving this run sends a cancel"),
      ),
    ).toBe(true);
    expect(
      logs.some(
        (l) => l.level === "INFO" && l.message.includes("was cancelled"),
      ),
    ).toBe(true);
  });

  it("a run.redrive from start of a failed run over a row with batches and no recorded cancel leaves them to the abandoned-step WARN", async () => {
    const h = await setup("plain-failed", "anthropic", {
      database: database(),
    });
    await h.execute();
    await h.persistence.updateRun(h.workflowRunId, { status: "FAILED" });
    const redrive = (await h.kernel.dispatch({
      type: "run.redrive",
      workflowRunId: h.workflowRunId,
      from: { kind: "start" },
    })) as RunRedriveResult;
    expect(redrive.batches).toBeUndefined();
    expect(h.cancelPosts()).toBe(0);
    expect(h.live()).toContain("msgbatch_1");
    const logs = await logsOf(h, database());
    expect(logs.some((l) => l.message.includes("abandoned"))).toBe(true);
  });

  it("a run.redrive from start of a cancelled run sends no cancel for a row the engine cannot prove it wrote, or for a stage that completed", async () => {
    const h = await cancelledWithNoRecord("plain-unowned");
    const row = await h.row();
    const { externalKey: _key, ...unowned } = row!.result as Record<
      string,
      unknown
    >;
    await h.ledger.compareAndSet(
      row!.stageRecordId,
      "x:submit",
      { status: row!.status, attempt: row!.attempt },
      { result: unowned },
    );
    const redrive = (await h.kernel.dispatch({
      type: "run.redrive",
      workflowRunId: h.workflowRunId,
      from: { kind: "start" },
    })) as RunRedriveResult;
    expect(redrive.batches).toBeUndefined();
    expect(h.live()).toContain("msgbatch_1");

    const done = await setup("plain-completed", "anthropic", {
      database: database(),
    });
    await done.execute();
    expect(await drive(done)).toBe("COMPLETED");
    // A completed legacy stage that kept its handle is not sent to either.
    const completed = await done.row();
    await done.persistence.updateStage(completed!.stageRecordId, {
      suspendedState: {
        batchId: "msgbatch_1",
        metadata: {
          batchRefs: (completed!.result as { refs: unknown[] }).refs,
        },
      },
    });
    await done.persistence.updateRun(done.workflowRunId, {
      status: "CANCELLED",
    });
    const posts = done.cancelPosts();
    const again = (await done.kernel.dispatch({
      type: "run.redrive",
      workflowRunId: done.workflowRunId,
      from: { kind: "start" },
    })) as RunRedriveResult;
    expect(again.batches).toBeUndefined();
    expect(done.cancelPosts()).toBe(posts);
  });

  // Not on SQLite: its one connection is the redrive's transaction's until the
  // commit, so a sweep's write waits for it and then finds the row gone.
  it.skipIf(process.env.SQLITE8_KERNEL_SQLITE === "1")(
    "a sweep that holds a row after a run.redrive from start read it, records its intent and stops: the redrive sends the cancel",
    async () => {
      const h = await cancelledWithNoRecord("window-intent");
      const read = barrier();
      const resume = barrier();
      const list = h.ledger.list.bind(h.ledger);
      let armed = true;
      h.ledger.list = async (...args: Parameters<typeof list>) => {
        const rows = await list(...args);
        if (armed) {
          armed = false;
          read.release();
          await resume.promise;
        }
        return rows;
      };
      const redrive = h.kernel.dispatch({
        type: "run.redrive",
        workflowRunId: h.workflowRunId,
        from: { kind: "start" },
      }) as Promise<RunRedriveResult>;
      await read.promise;
      // A repeated run.cancel's sweep holds the row, records its intent and
      // its process stops before the request leaves.
      await h.cancelDyingAfter("intent").catch(() => undefined);
      expect(
        ((await h.row())?.result as { cancelIntent?: unknown }).cancelIntent,
      ).toBeDefined();
      expect(h.live()).toContain("msgbatch_1");
      resume.release();
      const result = await redrive;
      expect(result.batches).toContainEqual(
        expect.objectContaining({
          ref: expect.objectContaining({ id: "msgbatch_1" }),
          status: "cancelled",
        }),
      );
      expect(h.live()).not.toContain("msgbatch_1");
    },
  );

  it("a run.redrive from start of a cancelled run cancels a batch named only by a legacy stage's suspendedState", async () => {
    const h = await setup("legacy-redrive", "anthropic", {
      database: database(),
    });
    await h.execute();
    const row = await h.row();
    const ref = (row!.result as { refs: unknown[] }).refs[0];
    // The stage as a legacy async-batch stage keeps it: on its record only.
    await h.ledger.clear(row!.stageRecordId);
    await h.persistence.updateStage(row!.stageRecordId, {
      suspendedState: { batchId: "msgbatch_1", metadata: { batchRefs: [ref] } },
    });
    // Cancelled with no sweep yet (one still running, or stopped).
    await h.persistence.updateRun(h.workflowRunId, { status: "CANCELLED" });
    const redrive = (await h.kernel.dispatch({
      type: "run.redrive",
      workflowRunId: h.workflowRunId,
      from: { kind: "start" },
    })) as RunRedriveResult;
    expect(redrive.batches).toEqual([
      expect.objectContaining({
        stageId: "legacy-redrive",
        ref: expect.objectContaining({ id: "msgbatch_1" }),
        status: "cancelled",
      }),
    ]);
    expect(redrive.batches?.[0]).not.toHaveProperty("stepId");
    expect(h.live()).not.toContain("msgbatch_1");
  });

  it("a legacy stage's checkCompletion that maps on the batch path writes its batch WARN on the run, not on the stage record", async () => {
    const schema = z.object({});
    const stage = defineAsyncBatchStage({
      id: "legacy-map",
      name: "Legacy map",
      mode: "async-batch",
      schemas: { input: schema, output: schema, config: schema },
      async execute() {
        return {
          suspended: true as const,
          state: { batchId: "legacy" },
          pollConfig: {
            pollInterval: 1_000,
            maxWaitTime: 3_600_000,
            // Due at once, whatever the harness clock says.
            nextPollAt: new Date(0),
          },
        };
      },
      async checkCompletion(_state, ctx) {
        await ctx.step.ai.map("x", [1], {
          model: BATCH_MODEL,
          policy: "batch",
          prompt: (i) => String(i),
        });
        return { ready: false, nextCheckIn: 60_000 };
      },
    });
    // A transport with no cancel call that creates nothing.
    const model = {
      provider: "anthropic",
      modelId: "claude-sonnet-4-5",
      start: () => Promise.reject(new Error("no create here")),
    } as unknown as EngineBatchModel;
    const mock = createMockAIHelperFactory();
    const h = await createHarness(database(), {
      stage,
      inputSchema: schema,
      outputSchema: schema,
      input: {},
      mock,
      aiFactory: createBatchAwareFactory(mock, model),
    });
    // A log written on the stage record is lost (as a redrive from start
    // would delete it with the record).
    const createLog = h.persistence.createLog.bind(h.persistence);
    h.persistence.createLog = async (input) => {
      if (input.workflowStageId) throw new Error("the stage record is gone");
      return createLog(input);
    };
    await h.execute();
    const record = await h.stage();
    expect(record?.status).toBe("SUSPENDED");
    // The submit row owes a cancel for a batch an earlier execution lost,
    // and nothing holds it: the next execution of the step completes it
    // first, and cannot (no cancel call), so it WARNs.
    await h.ledger.claim({
      stageRecordId: record!.id,
      stepId: "x:submit",
      seq: 0,
      kind: "run",
      status: "running",
      attempt: 1,
      leaseExpiresAt: null,
      deadlineAt: null,
      externalKey: deriveStepExternalKey(record!.id, "x:submit"),
      result: {
        cancelOwed: [
          {
            version: 1,
            type: "text",
            id: "msgbatch_owed",
            provider: "anthropic",
            modelId: "claude-sonnet-4-5",
          },
        ],
      },
      error: null,
    });
    await h.tick(5_000);
    let warns: string[] = [];
    for (let i = 0; i < 100 && warns.length === 0; i++) {
      warns = (await logsOf(h, database()))
        .filter(
          (l) =>
            l.level === "WARN" &&
            l.message.includes('"msgbatch_owed"') &&
            !(l as { workflowStageId?: string | null }).workflowStageId,
        )
        .map((l) => l.message);
      if (warns.length === 0) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
    expect(warns.some((w) => w.includes("owed a cancel"))).toBe(true);
  });

  /**
   * A loser by lease loss alone: execution A is held before its provider
   * create past its step lease, B reclaims the step and records batch 2, then
   * A creates batch 1, records it as owed and its process stops before the
   * cancel request leaves. With `afterStage`, A is let go only once the stage
   * and the run have completed.
   */
  async function leaseLoser(
    id: string,
    vendor: Vendor,
    afterStage?: (h: Harness) => Promise<void>,
  ) {
    const h = await setup(id, vendor, {
      onReclaim: "resubmit",
      database: database(),
    });
    const entered = barrier();
    const go = barrier();
    let n = 0;
    h.setBeforeStart(async () => {
      if (++n === 1) {
        entered.release();
        await go.promise;
      }
    });
    const a = h.execute();
    await entered.promise;
    h.clock.advance(5 * 60_000 + 1_000);
    await h.execute();
    if (afterStage) await afterStage(h);
    const never = barrier();
    let cancels = 0;
    h.setBeforeCancel(async () => {
      if (++cancels === 1) await never.promise;
    });
    go.release();
    for (let i = 0; i < 500; i++) {
      const r = await submitResult(h);
      if (r.cancelOwed?.length && cancels > 0) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect((await submitResult(h)).cancelOwed?.map((r) => r.id)).toEqual([
      firstBatch(vendor),
    ]);
    return {
      h,
      lost: firstBatch(vendor),
      cleanup: async () => {
        never.release();
        await a.catch(() => undefined);
      },
    };
  }

  /** Polls the stage until it settles; `finish` ends the live batches first. */
  async function drive(h: Harness, finish = true) {
    for (let i = 0; i < 12; i++) {
      if (finish && i > 0) h.finish();
      await h.tick(2_000);
      const st = await h.stage();
      if (st?.status === "COMPLETED" || st?.status === "FAILED") break;
      if (st?.status === "PENDING" || st?.status === "RUNNING") {
        await h.execute().catch(() => undefined);
      }
    }
    await h.kernel.dispatch({
      type: "run.transition",
      workflowRunId: h.workflowRunId,
    });
    return (await h.stage())?.status;
  }

  for (const vendor of VENDORS) {
    it(`E1 ${vendor}: a lease-loss loser stops after recording its batch as owed; the run goes on, and the stage's next replay of the step cancels it`, async () => {
      const s = await leaseLoser(`e1-${vendor}`, vendor);
      try {
        const { h, lost } = s;
        expect(await drive(h)).toBe("COMPLETED");
        expect((await h.persistence.getRun(h.workflowRunId))?.status).toBe(
          "COMPLETED",
        );
        expect(h.live()).not.toContain(lost);
        const row = await submitResult(h);
        expect(row.cancelOwed).toBeUndefined();
        expect(row.cancelledBatchIds).toContain(lost);
      } finally {
        await s.cleanup();
      }
    });
  }

  it("E1: a replay whose owed cancel fails names the batch on the run, keeps it owed, and the next replay completes it", async () => {
    const s = await leaseLoser("e1-failing", "anthropic");
    try {
      const { h, lost } = s;
      h.failCancel(true);
      await h.tick(2_000);
      await h.execute().catch(() => undefined);
      expect((await submitResult(h)).cancelOwed?.map((r) => r.id)).toEqual([
        lost,
      ]);
      const warns = (await logsOf(h, database())).filter(
        (l) =>
          l.level === "WARN" &&
          l.message.includes(`"${lost}"`) &&
          !(l as { workflowStageId?: string | null }).workflowStageId,
      );
      expect(
        warns.some((w) =>
          w.message.includes(
            "the stage's next execution tries again on a backoff",
          ),
        ),
      ).toBe(true);
      h.failCancel(false);
      // The next attempt is due a minute after the failure.
      h.clock.advance(60_000);
      expect(await drive(h)).toBe("COMPLETED");
      expect(h.live()).not.toContain(lost);
      expect((await submitResult(h)).cancelledBatchIds).toContain(lost);
    } finally {
      await s.cleanup();
    }
  });

  it("E1: a replay of a failed submit with no retry left completes the cancel the row owes", async () => {
    const s = await leaseLoser("e1-failed", "anthropic");
    try {
      const { h, lost } = s;
      const row = await h.row();
      await h.ledger.compareAndSet(
        row!.stageRecordId,
        "x:submit",
        { status: row!.status, attempt: row!.attempt },
        {
          status: "failed",
          error: "the provider rejected the batch",
          // Replayed as its failure, never executed.
          result: row!.result,
        },
      );
      await h.tick(2_000);
      await h.execute().catch(() => undefined);
      expect(h.live()).not.toContain(lost);
      const after = await submitResult(h);
      expect(after.cancelOwed).toBeUndefined();
      expect(after.cancelledBatchIds).toContain(lost);
    } finally {
      await s.cleanup();
    }
  });

  const owedWarns = async (h: Harness, id: string, text: string) =>
    (await warnsNaming(h, id)).filter((w) => w.includes(text));

  it("a failing owed cancel is retried by the replays on the backoff recorded on the row, with one WARN; run.cancel still sends it at once", async () => {
    const s = await leaseLoser("owed-backoff", "anthropic");
    try {
      const { h, lost } = s;
      h.failCancel(true);
      const before = h.cancelPosts();
      for (let i = 0; i < 20; i++) await h.tick(60_000);
      // Due 1, 2, 4, 8 and 16 minutes in: the wait doubles from a minute.
      expect(h.cancelPosts() - before).toBe(5);
      expect(await owedWarns(h, lost, "cancelling them failed")).toHaveLength(
        1,
      );
      const retry = (
        (await h.row())?.result as {
          cancelRetry?: Record<string, { tries: number; kind: string }>;
        }
      ).cancelRetry?.[lost];
      expect(retry).toMatchObject({ tries: 5, kind: "error" });

      // Not due for another 16 minutes; run.cancel does not wait for that.
      h.failCancel(false);
      const posts = h.cancelPosts();
      const cancelled = await h.cancel();
      expect(h.cancelPosts()).toBeGreaterThan(posts);
      expect(cancelled.batches).toContainEqual(
        expect.objectContaining({
          ref: expect.objectContaining({ id: lost }),
          status: "cancelled",
        }),
      );
      expect(h.live()).not.toContain(lost);
      expect((await submitResult(h)).cancelOwed).toBeUndefined();
    } finally {
      await s.cleanup();
    }
  });

  it("the wait between a replay's attempts at a failing owed cancel stops doubling at an hour", async () => {
    const s = await leaseLoser("owed-backoff-cap", "anthropic");
    try {
      const { h, lost } = s;
      h.failCancel(true);
      const before = h.cancelPosts();
      // Hourly polls: every one is due (1, 2, ... 32 minutes, then 60).
      for (let i = 0; i < 20; i++) await h.tick(3_600_000);
      expect(h.cancelPosts() - before).toBe(20);
      expect(await owedWarns(h, lost, "cancelling them failed")).toHaveLength(
        1,
      );
    } finally {
      await s.cleanup();
    }
  });

  it("a run.redrive sends an owed cancel at once, whatever the backoff on the row", async () => {
    const s = await leaseLoser("owed-backoff-redrive", "anthropic");
    try {
      const { h, lost } = s;
      h.failCancel(true);
      await h.tick(60_000);
      expect(owedRetryOf((await h.row())?.result)[lost]?.tries).toBe(1);
      h.failCancel(false);
      await h.persistence.updateRun(h.workflowRunId, { status: "FAILED" });
      const redrive = (await h.kernel.dispatch({
        type: "run.redrive",
        workflowRunId: h.workflowRunId,
        from: { kind: "start" },
      })) as RunRedriveResult;
      expect(redrive.batches).toContainEqual(
        expect.objectContaining({
          ref: expect.objectContaining({ id: lost }),
          status: "cancelled",
        }),
      );
      expect(h.live()).not.toContain(lost);
    } finally {
      await s.cleanup();
    }
  });

  it("an owed cancel on a provider with no cancel call is settled once, with one WARN, and never sent again", async () => {
    const s = await leaseLoser("owed-no-cancel", "anthropic");
    try {
      const { h, lost } = s;
      // The provider's transport has no cancel call, as OpenRouter's.
      (h.model as { cancel?: unknown }).cancel = undefined;
      const before = h.cancelPosts();
      for (let i = 0; i < 20; i++) await h.tick(60_000);
      expect(h.cancelPosts()).toBe(before);
      const warns = await owedWarns(h, lost, "has no cancel call");
      expect(warns).toHaveLength(1);
      expect(warns[0]).toContain("Cancel them in the provider's console");
      const row = (await h.row())?.result as Submit & {
        noCancelBatchIds?: string[];
      };
      expect(row.cancelOwed).toBeUndefined();
      expect(row.noCancelBatchIds).toEqual([lost]);
      // It is still never adopted, and nothing else names it as owed.
      expect(await owedWarns(h, lost, "cancelling them failed")).toEqual([]);
    } finally {
      await s.cleanup();
    }
  });

  it("a batch settled as having no cancel call is never adopted: a retry that searches by the external key passes it", async () => {
    const h = await setup("no-cancel-adopt", "google", {
      database: database(),
    });
    await h.execute();
    const row = await h.row();
    // A failed row re-opened for a retry that only records batches/b1 as
    // uncancellable (its loser owed it, and its provider has no cancel call).
    await h.ledger.compareAndSet(
      row!.stageRecordId,
      "x:submit",
      { status: row!.status, attempt: row!.attempt },
      {
        status: "running",
        leaseExpiresAt: null,
        error: "the provider rejected the batch",
        result: {
          noCancelBatchIds: ["batches/b1"],
        },
      },
    );
    expect(h.live()).toContain("batches/b1");
    await h.execute();
    const after = await submitResult(h);
    expect(after.refs?.map((r) => r.id)).toEqual(["batches/b2"]);
    expect((after as { noCancelBatchIds?: string[] }).noCancelBatchIds).toEqual(
      ["batches/b1"],
    );
  });

  it("E1 residual: a loser that records its batch as owed after the stage's last replay leaves it named by id on the completed row", async () => {
    const s = await leaseLoser("e1-residual", "anthropic", async (h) => {
      expect(await drive(h)).toBe("COMPLETED");
    });
    try {
      const { h, lost } = s;
      expect((await h.persistence.getRun(h.workflowRunId))?.status).toBe(
        "COMPLETED",
      );
      // Nothing reads the row again: the batch runs on, and the row (kept
      // with the run) names it by id.
      expect(h.live()).toContain(lost);
      const row = await h.row();
      expect(row?.status).toBe("completed");
      expect((row?.result as Submit).cancelOwed?.map((r) => r.id)).toEqual([
        lost,
      ]);
      // And the WARN that the execution lost the step names its external key.
      expect(
        (await logsOf(h, database())).some(
          (l) =>
            l.level === "WARN" && l.message.includes(row!.externalKey ?? "-"),
        ),
      ).toBe(true);
    } finally {
      await s.cleanup();
    }
  });

  for (const vendor of VENDORS) {
    it(`E2 ${vendor}: a run.redrive from start names on the run, before its commit, every batch it is about to cancel; a process that stops before the cancel leaves it named`, async () => {
      const s = await leaseLoser(`e2-${vendor}`, vendor);
      const stuck = barrier();
      try {
        const { h, lost } = s;
        await h.persistence.updateRun(h.workflowRunId, { status: "FAILED" });
        let sent = 0;
        h.setBeforeCancel(async () => {
          sent++;
          await stuck.promise;
        });
        void h.kernel
          .dispatch({
            type: "run.redrive",
            workflowRunId: h.workflowRunId,
            from: { kind: "start" },
          })
          .catch(() => undefined);
        for (let i = 0; i < 500 && sent === 0; i++) {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        expect(sent).toBe(1);
        // The redrive's process has stopped; its row is deleted.
        expect(h.live()).toContain(lost);
        const named = (await logsOf(h, database())).filter((l) =>
          l.message.includes(`"${lost}"`),
        );
        expect(named).toEqual([
          expect.objectContaining({
            level: "WARN",
            message: expect.stringContaining("cancel it at the provider"),
          }),
        ]);
        expect(named[0]!.message).toContain(
          "A line naming each batch follows with the outcome of its cancel",
        );
        expect(
          (named[0] as { workflowStageId?: string | null }).workflowStageId ??
            null,
        ).toBeNull();
      } finally {
        stuck.release();
        await s.cleanup();
      }
    });
  }
}
