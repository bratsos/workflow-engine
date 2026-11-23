/**
 * Two signals whose ledger rows carry the same timestamp (the same
 * millisecond, or a coarser adapter clock) are two deliveries: the second one
 * must wake the stage even though the first one's wake claim still exists.
 * Through kernel.dispatch and the maintenance tick both hosts share, on the
 * in-memory ports and, with SQLITE8_KERNEL_SQLITE=1 or DATABASE_URL, on the
 * Prisma ones. Every ledger row reads back with one fixed timestamp, which is
 * what an adapter with a coarse clock produces.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { defineStage } from "../core/stage-factory.js";
import { WorkflowBuilder } from "../core/workflow.js";
import { runMaintenanceTick } from "../kernel/helpers/host-support.js";
import { createKernel, type KernelConfig } from "../kernel/kernel.js";
import type { StepLedger, StepRecord } from "../kernel/ports.js";
import {
  CollectingEventSink,
  InMemoryBlobStore,
} from "../kernel/testing/index.js";
import {
  InMemoryJobQueue,
  InMemoryStepLedger,
  InMemoryWorkflowPersistence,
} from "../testing/index.js";
import {
  type KernelDatabase,
  kernelDatabase,
  realDatabase,
  sqlite,
} from "./sqlite8-kernel-utils.js";
import { wrapStepLedger } from "./utils/step-ledger-double.js";

const schema = z.object({});
const tick = new Date("2030-01-01T00:00:00.000Z");
const future = new Date("2099-01-01T00:00:00.000Z");

/** A ledger whose rows all read back created and updated at `tick`. */
function coarse(ledger: StepLedger): StepLedger {
  const pin = <T extends StepRecord | null>(row: T): T =>
    row && { ...row, createdAt: tick, updatedAt: tick };
  return wrapStepLedger(ledger, {
    claim: async (row) => {
      const out = await ledger.claim(row);
      return { ...out, record: pin(out.record) };
    },
    get: async (...args) => pin(await ledger.get(...args)),
    update: async (...args) => pin(await ledger.update(...args)),
    compareAndSet: async (...args) => {
      const out = await ledger.compareAndSet(...args);
      return { ...out, record: pin(out.record) };
    },
    list: async (id) => (await ledger.list(id)).map(pin),
  });
}

describe(`signals in the same tick on ${realDatabase ? (sqlite ? "SQLite" : "Postgres") : "memory"}`, () => {
  let db: KernelDatabase | undefined;
  let ports: Pick<
    KernelConfig,
    "persistence" | "jobTransport" | "stepLedger" | "blobStore"
  >;

  beforeAll(async () => {
    if (realDatabase) db = await kernelDatabase();
  }, 120_000);
  beforeEach(async () => {
    await db?.reset();
    ports = db
      ? {
          persistence: db.persistence,
          jobTransport: db.jobTransport,
          stepLedger: coarse(db.stepLedger),
          blobStore: db.blobStore,
        }
      : {
          persistence: new InMemoryWorkflowPersistence(),
          jobTransport: new InMemoryJobQueue(),
          stepLedger: coarse(new InMemoryStepLedger()),
          blobStore: new InMemoryBlobStore(),
        };
  });
  afterAll(async () => {
    await db?.close();
  });

  /** A stage that waits for "approval" and, while `failing`, throws after it. */
  async function waiting(bend?: (inner: StepLedger) => StepLedger) {
    const state = { failing: false };
    const workflow = new WorkflowBuilder(
      "signal-same-tick",
      "Signal same tick",
      "signal-same-tick",
      schema,
      z.any(),
    )
      .pipe(
        defineStage({
          id: "s",
          name: "S",
          schemas: { input: schema, output: z.any(), config: schema },
          async execute(ctx) {
            const value = await ctx.step.waitForSignal("approval", {
              timeout: "10m",
            });
            if (state.failing) throw new Error("retry me");
            return { output: { value } };
          },
        }),
      )
      .build();
    const kernel = createKernel({
      ...ports,
      ...(bend ? { stepLedger: bend(ports.stepLedger!) } : {}),
      eventSink: new CollectingEventSink(),
      clock: { now: () => new Date() },
      registry: { getWorkflow: () => workflow },
    });
    const { workflowRunId } = await kernel.dispatch({
      type: "run.create",
      workflowId: workflow.id,
      input: {},
      idempotencyKey: crypto.randomUUID(),
    });
    await kernel.dispatch({ type: "run.claimPending", workerId: "w" });
    const stage = (await ports.persistence.getStage(workflowRunId, "s"))!;
    const signal = (payload: unknown) =>
      kernel.dispatch({
        type: "step.signal",
        workflowRunId,
        stageId: "s",
        stepId: "approval",
        payload,
      });
    const execute = (numbered = false) =>
      kernel.dispatch({
        type: "job.execute",
        workflowRunId,
        workflowId: workflow.id,
        stageId: "s",
        config: {},
        ...(numbered ? { attempt: 1, maxAttempts: 1 } : {}),
      });
    const payloads = async () =>
      (await ports.persistence.getUnpublishedOutboxEvents(1000))
        .filter((row) => row.eventType === "step:signalled")
        .map((row) => (row.payload as { payload: unknown }).payload);
    const nextPollAt = async () =>
      (await ports.persistence.getStage(workflowRunId, "s"))!.nextPollAt!;
    /** Pushes the poll out, so only a wake can bring it forward. */
    const park = () =>
      ports.persistence.updateStage(stage.id, { nextPollAt: future });
    return {
      kernel,
      state,
      stage,
      signal,
      execute,
      payloads,
      nextPollAt,
      park,
      workflowRunId,
    };
  }

  it("wakes the stage for a signal that follows a ledger reset", async () => {
    const t = await waiting();
    await t.signal("first");
    // The last attempt fails after consuming "first"; an explicit re-run
    // resets the ledger and suspends on a fresh row.
    t.state.failing = true;
    await t.execute(true);
    t.state.failing = false;
    await expect(t.execute()).resolves.toMatchObject({ outcome: "suspended" });
    await t.park();

    await expect(t.signal("second")).resolves.toMatchObject({
      signalled: true,
      alreadyCompleted: false,
    });

    expect((await t.nextPollAt()).getTime()).toBeLessThan(future.getTime());
    expect(await t.payloads()).toEqual(["first", "second"]);
    await expect(t.signal("ignored")).resolves.toMatchObject({
      alreadyCompleted: true,
    });
    expect(await t.payloads()).toEqual(["first", "second"]);
    // The host's maintenance tick resumes the stage on the second value.
    const counts = await runMaintenanceTick(t.kernel, { workerId: "w" });
    expect(counts.suspendedChecked).toBe(1);
    expect(
      (await ports.persistence.getStage(t.workflowRunId, "s"))?.status,
    ).toBe("COMPLETED");
  });

  it("does not wake twice for a signal sent again after a failed ledger clear", async () => {
    const t = await waiting((inner) =>
      wrapStepLedger(inner, {
        async clear() {
          throw new Error("clear failed");
        },
      }),
    );
    await t.signal("first");
    t.state.failing = true;
    await t.execute(true);
    // The explicit re-run's clear fails: the signal row is still there.
    await expect(t.execute()).rejects.toThrow("clear failed");

    await expect(t.signal("first")).resolves.toMatchObject({
      alreadyCompleted: true,
    });

    expect(await t.payloads()).toEqual(["first"]);
  });

  it("does not wake twice for a signal sent again while the ledger clear runs", async () => {
    let again: (() => Promise<unknown>) | undefined;
    let retried: unknown;
    const t = await waiting((inner) =>
      wrapStepLedger(inner, {
        async clear(id) {
          retried = await again?.();
          return inner.clear(id);
        },
      }),
    );
    again = () => t.signal("first");
    await t.signal("first");
    t.state.failing = true;
    await t.execute(true);
    t.state.failing = false;

    await expect(t.execute()).resolves.toMatchObject({ outcome: "suspended" });

    expect(retried).toMatchObject({ alreadyCompleted: true });
    expect(await t.payloads()).toEqual(["first"]);
    // The claim went with the row: the next signal wakes the stage.
    await t.park();
    await expect(t.signal("second")).resolves.toMatchObject({
      alreadyCompleted: false,
    });
    expect(await t.payloads()).toEqual(["first", "second"]);
  });

  it("wakes the stage for a signal row that replaced another outside the kernel", async () => {
    const t = await waiting();
    await t.execute();
    await t.signal("first");
    // Another position and no kernel reset: only the row itself differs.
    await ports.stepLedger!.clear(t.stage.id);
    await t.park();

    await expect(t.signal("second")).resolves.toMatchObject({
      alreadyCompleted: false,
    });

    expect((await t.nextPollAt()).getTime()).toBeLessThan(future.getTime());
    expect(await t.payloads()).toEqual(["first", "second"]);
  });

  it("keeps a wake claim stored before rows were told apart valid", async () => {
    const t = await waiting();
    await t.execute();
    await t.signal("first");
    // The claim an earlier release stored: the delivery time alone.
    const key = JSON.stringify([t.stage.id, "approval"]);
    await ports.persistence.releaseIdempotencyKey(key, "step.signal.wake");
    await ports.persistence.acquireIdempotencyKey(key, "step.signal.wake");
    await ports.persistence.completeIdempotencyKey(
      key,
      "step.signal.wake",
      { signalled: true, delivery: tick.getTime() },
      null,
    );
    await t.park();

    await expect(t.signal("again")).resolves.toMatchObject({
      alreadyCompleted: true,
    });

    expect((await t.nextPollAt()).getTime()).toBe(future.getTime());
    expect(await t.payloads()).toEqual(["first"]);
  });
});
