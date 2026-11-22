/**
 * run.cancel against stateful providers, when the sweep or the process is cut
 * off at any point.
 *
 * The real `ctx.step.ai.map`, `AIBatchImpl`, the installed AI SDK Gemini,
 * Anthropic and OpenAI transports and the in-memory ledger run unchanged; only
 * provider HTTP is a fake `fetch` that tracks every batch. Gemini cancels
 * asynchronously when asked to (the batch keeps reporting RUNNING), OpenAI
 * reports `cancelling`, Anthropic `canceling` and cannot be searched.
 *
 * Three parts:
 * - the deep gate's round-2 replays of round 1 (F1, F2, F7, F8, F9);
 * - its round-2 race matrix (C1 to C4), with the expectations the recovery
 *   rules change noted where they are;
 * - a crash matrix: the process dies right after each write and each provider
 *   call of the sweep, on each transport, then a repeated run.cancel, a
 *   redrive, or both, each driven to a terminal run.
 */

import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineStage } from "../../core/stage-factory.js";
import { StageAbortedError } from "../../core/steps.js";
import { createAiMapHarness } from "../durable/ai-map-harness.js";
import {
  barrier,
  type Harness,
  type Point,
  type SetupOptions,
  setup,
  type Vendor,
} from "../utils/real-batch-cancel-harness.js";

const schema = z.object({});

// ── Round 1 replays (F1, F2, F7, F8, F9) ──────────────────────────────────

describe("round 1 replays", () => {
  it("F1: a sweep held up past a redrive does not cancel the redriven run's batch", async () => {
    const h = await setup("sweep-race");
    await h.execute();
    const entered = barrier();
    const go = barrier();
    const original = h.jobTransport.cancelByRun.bind(h.jobTransport);
    h.jobTransport.cancelByRun = async (id) => {
      const count = await original(id);
      entered.release();
      await go.promise;
      return count;
    };
    const cancelling = h.cancel();
    await entered.promise;
    await h.redrive();
    await h.execute();
    go.release();
    await cancelling;
    expect(h.states()).toEqual(["JOB_STATE_RUNNING"]);
  });

  it("F2: a partial submit rejected after the cancel does not orphan the accepted partition", async () => {
    const h = await setup("partial", "google", { count: 2 });
    const abort = new AbortController();
    h.rejectStart(2);
    let starts = 0;
    h.setBeforeStart(async () => {
      if (++starts === 2) {
        await h.cancel();
        abort.abort(new StageAbortedError("cancelled", h.workflowRunId));
      }
    });
    await h.kernel.dispatch({
      type: "job.execute",
      workflowId: "wf-partial",
      workflowRunId: h.workflowRunId,
      stageId: "partial",
      config: {},
      abortSignal: abort.signal,
    });
    await h.cancel();
    expect(h.states()[0]).toBe("JOB_STATE_CANCELLED");
  });

  it("F7: a ref listed by the row and by suspendedState still re-opens the row", async () => {
    const h = await setup("dedup");
    await h.execute();
    const s = (await h.stage())!;
    const row = (await h.row())!;
    await h.persistence.updateStage(s.id, {
      suspendedState: {
        ...(s.suspendedState as any),
        metadata: {
          ...(s.suspendedState as any).metadata,
          batchRefs: (row.result as any).refs,
        },
      },
    });
    await h.cancel();
    await h.redrive();
    await h.execute();
    expect(h.batches.size).toBe(2);
  });

  it("F7: a cancel whose outcome is unknown on one partition is completed by the redrive, which replaces both", async () => {
    const h = await setup("mixed", "google", { count: 2 });
    await h.execute();
    let failing = true;
    h.setBeforeCancel(async () => {
      if (failing && h.calls.at(-1)?.endsWith("b2:cancel")) {
        throw new Error("socket reset");
      }
    });
    const first = await h.cancel();
    expect(first.batches.map((b) => b.status)).toEqual(["cancelled", "failed"]);
    expect(
      h.persistence.getAllLogs().filter((l) => l.level === "WARN"),
    ).toHaveLength(1);
    // Changed from the gate's expectation (partition 2 adopted): its cancel
    // may have reached the provider, so no execution continues on it.
    await h.redrive();
    await h.execute();
    expect((await h.stage())?.errorMessage).toMatch(
      /may have sent a cancel for batch\(es\) "batches\/b2"/,
    );
    expect(h.batches.size).toBe(2);
    failing = false;
    await h.execute();
    const refs = ((await h.row())!.result as any).refs.map((r: any) => r.id);
    expect(refs).toEqual(["batches/b3", "batches/b4"]);
    expect(h.live()).toEqual(["batches/b3", "batches/b4"]);
  });

  it("a second cancel is idempotent and a terminal run's cancel changes nothing", async () => {
    const h = await setup("idempotent");
    await h.execute();
    await h.cancel();
    const posts = h.cancelPosts();
    await h.cancel();
    expect(h.cancelPosts()).toBe(posts);
    for (const status of ["FAILED", "COMPLETED"] as const) {
      await h.persistence.updateRun(h.workflowRunId, { status });
      const before = JSON.stringify(await h.ledger.list((await h.stage())!.id));
      const count = h.calls.length;
      expect(await h.cancel()).toEqual({ cancelled: false, batches: [] });
      expect(h.calls).toHaveLength(count);
      expect(JSON.stringify(await h.ledger.list((await h.stage())!.id))).toBe(
        before,
      );
    }
  });

  it("F8: ordinary x:submit data is not cancelled", async () => {
    const stage = defineStage({
      id: "ordinary",
      name: "ordinary",
      schemas: { input: schema, output: schema, config: schema },
      async execute(ctx) {
        await ctx.step.run("x:submit", async () => ({
          id: "not-batch",
          result: "ok",
        }));
        await ctx.step.sleep("wait", "1h");
        return { output: {} };
      },
    });
    const h = await createAiMapHarness({
      stage,
      inputSchema: schema,
      outputSchema: schema,
      input: {},
    });
    await h.execute();
    expect(
      (
        await h.kernel.dispatch({
          type: "run.cancel",
          workflowRunId: h.workflowRunId,
        })
      ).batches,
    ).toEqual([]);
    expect(
      (await h.ledger.get((await h.stage())!.id, "x:submit"))?.status,
    ).toBe("completed");
  });

  it("F8: a normal step returning a foreign handle confers no cancel ownership", async () => {
    const provider = await setup("foreign-provider");
    const ref = await provider.model.start([
      { id: "r", prompt: "external request" } as any,
    ]);
    const stage = defineStage({
      id: "ordinary-handle",
      name: "ordinary-handle",
      schemas: { input: schema, output: schema, config: schema },
      async execute(ctx) {
        await ctx.step.run("x:submit", async () => ({
          handleId: ref.id,
          refs: [ref],
          requestIds: ["r"],
          totalRequests: 1,
        }));
        await ctx.step.sleep("wait", "1h");
        return { output: {} };
      },
    });
    const h = await createAiMapHarness({
      stage,
      inputSchema: schema,
      outputSchema: schema,
      input: {},
      batchModels: () => provider.model,
    });
    await h.execute();
    const result = await h.kernel.dispatch({
      type: "run.cancel",
      workflowRunId: h.workflowRunId,
    });
    expect(result.batches).toEqual([
      expect.objectContaining({
        status: "unverified",
        ref: expect.objectContaining({ id: ref.id }),
      }),
    ]);
    expect(provider.states()).toEqual(["JOB_STATE_RUNNING"]);
  });

  it("F9: an asynchronous Gemini cancel is never re-adopted", async () => {
    const h = await setup("async-cancel");
    await h.execute();
    h.asyncCancel();
    await h.cancel();
    await h.redrive();
    await h.execute();
    h.settleCancels();
    await h.tick(1000);
    await h.tick(60000);
    expect(h.batches.size).toBe(2);
    expect(h.live()).toEqual(["batches/b2"]);
  });
});

// ── Round 2 race matrix (C1 to C4) ────────────────────────────────────────

for (const vendor of ["google", "anthropic"] as const) {
  describe(`round 2: ${vendor}`, () => {
    it("C1: a partial failure keeps its refs and a repeated cancel reaches them", async () => {
      const h = await setup(`partial-record-${vendor}`, vendor, { count: 2 });
      h.rejectStart(2);
      await h.execute();
      const first = await h.row();
      const result = await h.cancel();
      expect(first?.result).toHaveProperty("refs");
      expect(result.batches[0]?.status).toBe("cancelled");
    });

    it("C1: a cancelled partial submit redrives with its tombstone", async () => {
      const id = `partial-aborted-${vendor}`;
      const h = await setup(id, vendor, { count: 2 });
      const abort = new AbortController();
      h.rejectStart(2);
      let n = 0;
      h.setBeforeStart(async () => {
        if (++n === 2) {
          await h.cancel();
          abort.abort(new StageAbortedError("cancelled", h.workflowRunId));
        }
      });
      await h.kernel.dispatch({
        type: "job.execute",
        workflowId: `wf-${id}`,
        workflowRunId: h.workflowRunId,
        stageId: id,
        config: {},
        abortSignal: abort.signal,
      });
      await h.redrive();
      await h.execute();
      expect((await h.row())?.result).toHaveProperty("generation", 1);
      expect((await h.stage())?.status).toBe("SUSPENDED");
    });

    it("C2: a timeout does not release a handle while its provider cancel is still in flight", async () => {
      const h = await setup(`slow-cancel-${vendor}`, vendor, {
        batchMs: 30,
        sweepMs: 60,
      });
      await h.execute();
      const entered = barrier();
      const go = barrier();
      const landed = barrier();
      let posts = 0;
      // Only the sweep's request is slow; the gate held every cancel POST,
      // which would also hold the redriven step's completion of it.
      h.setBeforeCancel(async () => {
        if (++posts > 1) return;
        entered.release();
        await go.promise;
        landed.release();
      });
      const p = h.cancel();
      await entered.promise;
      const result = await p;
      expect(result.batches[0]).toMatchObject({ status: "failed" });
      expect((await h.row())?.result).toMatchObject({
        cancelIntent: { batchIds: [expect.any(String)] },
      });
      await h.redrive();
      await h.execute();
      go.release();
      await landed.promise;
      await new Promise((r) => setTimeout(r, 5));
      await h.tick(6000);
      expect(h.batches.size).toBe(2);
      expect((await h.row())?.result).toHaveProperty("generation", 1);
      expect(h.live()).toHaveLength(1);
    });

    for (const landed of [false, true]) {
      for (const recovery of ["cancel", "redrive", "both"] as const) {
        it(`final write lost, cancel landed=${landed}, recovered by ${recovery}`, async () => {
          const h = await setup(
            `crash-${vendor}-${landed}-${recovery}`,
            vendor,
          );
          await h.execute();
          h.failCancel(!landed);
          h.die(true);
          await h.cancel();
          h.die(false);
          expect((await h.row())?.result).toHaveProperty("cancelFence");
          h.clock.advance(300000);
          h.failCancel(false);
          if (recovery !== "redrive") await h.cancel();
          if (recovery !== "cancel") {
            await h.redrive();
            await h.execute();
            expect((await h.stage())?.status).toBe("SUSPENDED");
            // Changed from the gate's expectation for landed=false and a
            // redrive alone (1): a request left for the provider and only an
            // error came back, so the redrive completes the cancel and
            // replaces the batch rather than wait on it.
            expect(h.batches.size).toBe(2);
            h.finish();
            await h.tick(6000);
            await h.kernel.dispatch({
              type: "run.transition",
              workflowRunId: h.workflowRunId,
            });
            expect((await h.persistence.getRun(h.workflowRunId))?.status).toBe(
              "COMPLETED",
            );
          }
          expect((await h.row())?.result).not.toHaveProperty("cancelFence");
          expect((await h.row())?.result).not.toHaveProperty("cancelIntent");
        });
      }
    }

    it("C4: a provider that cannot be reached keeps the fence for the next attempt", async () => {
      const h = await setup(`unaskable-${vendor}`, vendor);
      await h.execute();
      h.die(true);
      await h.cancel();
      h.die(false);
      h.clock.advance(300000);
      h.failStatus(true);
      await h.redrive();
      await h.execute();
      const failed = await h.row();
      h.failStatus(false);
      await h.execute();
      expect(failed?.result).toHaveProperty("cancelFence");
      expect(failed?.result).toHaveProperty("cancelIntent");
      expect((await h.row())?.result).toHaveProperty("generation", 1);
      expect((await h.stage())?.status).toBe("SUSPENDED");
    });

    it("two full cancel/redrive cycles keep generations and exclusions", async () => {
      const h = await setup(`twice-${vendor}`, vendor);
      await h.execute();
      for (let i = 1; i <= 2; i++) {
        await h.cancel();
        await h.cancel();
        await h.redrive();
        await h.execute();
        expect((await h.row())?.result).toMatchObject({
          generation: i,
          cancelledBatchIds: expect.any(Array),
        });
        expect(h.batches.size).toBe(i + 1);
      }
      expect((await h.row())?.result).toHaveProperty(
        "cancelledBatchIds",
        vendor === "google"
          ? ["batches/b1", "batches/b2"]
          : ["msgbatch_1", "msgbatch_2"],
      );
    });

    it("a concurrent repeated sweep respects a live fence", async () => {
      const h = await setup(`concurrent-${vendor}`, vendor);
      await h.execute();
      const entered = barrier();
      const go = barrier();
      h.setBeforeCancel(async () => {
        entered.release();
        await go.promise;
      });
      const first = h.cancel();
      await entered.promise;
      const second = await h.cancel();
      go.release();
      await first;
      expect(second.batches).toEqual([
        expect.objectContaining({
          status: "held",
          ref: expect.objectContaining({ id: expect.any(String) }),
          heldUntil: expect.any(String),
        }),
      ]);
      expect(h.cancelPosts()).toBe(1);
      expect((await h.row())?.result).toHaveProperty("engineCancelled");
    });

    it("C3: two sweeps that read the same expired fence cannot both hold it", async () => {
      const h = await setup(`expired-double-${vendor}`, vendor);
      await h.execute();
      h.failCancel(true);
      h.die(true);
      await h.cancel();
      h.die(false);
      h.failCancel(false);
      h.clock.advance(300000);
      const firstHold = barrier();
      const secondHold = barrier();
      const firstGo = barrier();
      const secondGo = barrier();
      const providerEntered = barrier();
      const providerGo = barrier();
      let holds = 0;
      let providerCalls = 0;
      const cas = h.ledger.compareAndSet.bind(h.ledger);
      h.ledger.compareAndSet = async (sid, key, expected, patch) => {
        if (
          key === "x:submit" &&
          (patch.result as any)?.cancelFence &&
          patch.leaseExpiresAt
        ) {
          holds++;
          if (holds === 1) {
            firstHold.release();
            await firstGo.promise;
          } else if (holds === 2) {
            secondHold.release();
            await secondGo.promise;
          }
        }
        return cas(sid, key, expected, patch);
      };
      h.setBeforeCancel(async () => {
        if (++providerCalls === 1) {
          providerEntered.release();
          await providerGo.promise;
        } else throw new Error("second sweep network failure");
      });
      const a = h.cancel();
      await firstHold.promise;
      const b = h.cancel();
      await secondHold.promise;
      firstGo.release();
      await providerEntered.promise;
      secondGo.release();
      const br = await b;
      // B lost the takeover to A, read the row again and reports A's hold.
      expect(br.batches).toEqual([
        expect.objectContaining({
          status: "held",
          ref: expect.anything(),
          heldUntil: expect.any(String),
        }),
      ]);
      await h.redrive();
      await h.execute();
      providerGo.release();
      await a;
      await h.tick(6000);
      expect(providerCalls).toBe(1);
      expect(h.batches.size).toBe(2);
      expect((await h.stage())?.status).toBe("SUSPENDED");
    });

    it("C4: a slow ledger scan does not start the provider calls under an expired hold", async () => {
      const h = await setup(`lease-expired-${vendor}`, vendor, {
        batchMs: 1000,
        sweepMs: 2000,
      });
      await h.execute();
      const entered = barrier();
      const go = barrier();
      h.setBeforeCancel(async () => {
        entered.release();
        await go.promise;
      });
      const list = h.ledger.list.bind(h.ledger);
      let delayed = false;
      h.ledger.list = async (sid) => {
        const rows = await list(sid);
        if (!delayed) {
          delayed = true;
          h.clock.advance(4000);
        }
        return rows;
      };
      const p = h.cancel();
      // The hold's lease starts once the row is taken, so the call is sent:
      // a lease counted from the start of the scan would already be over.
      await Promise.race([entered.promise, p]);
      expect(h.cancelPosts()).toBe(1);
      await h.redrive();
      await h.execute();
      go.release();
      expect((await p).batches[0]?.status).toBe("cancelled");
      await h.tick(6000);
      expect(h.batches.size).toBe(2);
      expect((await h.stage())?.status).toBe("SUSPENDED");
    });

    it("C1: a later tombstone takeover after a lost replacement response never creates a third batch", async () => {
      const h = await setup(`later-takeover-${vendor}`, vendor);
      await h.execute();
      await h.cancel();
      await h.redrive();
      let lost = false;
      h.setAfterStart(async () => {
        if (!lost) {
          lost = true;
          throw new Error(
            "provider accepted replacement but response was lost",
          );
        }
      });
      await h.execute();
      await h.execute();
      expect(h.batches.size).toBe(2);
      if (vendor === "google") {
        expect((await h.row())?.result).toHaveProperty("generation", 1);
        expect((await h.stage())?.status).toBe("SUSPENDED");
      } else {
        expect((await h.stage())?.errorMessage).toContain(
          "BatchNotAdoptableError",
        );
      }
    });

    it("C2: a late transport resolver cannot send a cancel after the budget released the row and a redrive", async () => {
      const h = await setup(`late-resolver-${vendor}`, vendor, {
        batchMs: 30,
        sweepMs: 60,
      });
      await h.execute();
      const entered = barrier();
      const go = barrier();
      h.setResolver(async () => {
        entered.release();
        await go.promise;
        return h.model;
      });
      const p = h.cancel();
      await entered.promise;
      await p;
      await h.redrive();
      await h.execute();
      const postsBefore = h.cancelPosts();
      go.release();
      await new Promise((r) => setTimeout(r, 5));
      expect(h.cancelPosts()).toBe(postsBefore);
      expect(h.live()).toHaveLength(1);
    });

    it("a cancel racing an un-aborted submit warns, then the ghost sweep cancels the recorded batch", async () => {
      const h = await setup(`ghost-${vendor}`, vendor);
      const entered = barrier();
      const go = barrier();
      h.setBeforeStart(async () => {
        entered.release();
        await go.promise;
      });
      const job = h.execute();
      await entered.promise;
      const first = await h.cancel();
      expect(first.batches[0]?.status).toBe("unrecorded");
      go.release();
      expect(await job).toMatchObject({ ghost: true });
      expect(h.states()).toEqual([
        vendor === "google" ? "JOB_STATE_CANCELLED" : "canceling",
      ]);
      const posts = h.cancelPosts();
      await h.cancel();
      expect(h.cancelPosts()).toBe(posts);
    });

    it("run.cancel racing a ghost-exit sweep respects its live hold", async () => {
      const h = await setup(`ghost-concurrent-${vendor}`, vendor);
      const submitEntered = barrier();
      const submitGo = barrier();
      const cancelEntered = barrier();
      const cancelGo = barrier();
      h.setBeforeStart(async () => {
        submitEntered.release();
        await submitGo.promise;
      });
      h.setBeforeCancel(async () => {
        cancelEntered.release();
        await cancelGo.promise;
      });
      const job = h.execute();
      await submitEntered.promise;
      expect((await h.cancel()).batches[0]?.status).toBe("unrecorded");
      submitGo.release();
      await cancelEntered.promise;
      expect((await h.row())?.result).toHaveProperty("cancelFence");
      const concurrent = await h.cancel();
      expect(concurrent.batches[0]).toMatchObject({
        status: "held",
        heldUntil: expect.any(String),
      });
      expect(concurrent.batches[0]?.error).toContain(
        `held until ${concurrent.batches[0]?.heldUntil}`,
      );
      expect(h.cancelPosts()).toBe(1);
      cancelGo.release();
      expect(await job).toMatchObject({ ghost: true });
      expect((await h.row())?.result).toHaveProperty("engineCancelled");
      expect((await h.row())?.result).not.toHaveProperty("cancelFence");
    });

    for (const point of ["hold", "provider"] as const) {
      for (const recovery of ["cancel", "redrive", "both"] as const) {
        it(`death right after the ${point === "hold" ? "hold" : "provider accepted the cancel"}, recovered by ${recovery}`, async () => {
          const h = await setup(`exact-${vendor}-${point}-${recovery}`, vendor);
          await h.execute();
          const getRun = h.persistence.getRun.bind(h.persistence);
          let reads = 0;
          if (point === "hold") {
            h.persistence.getRun = async (id) => {
              if (++reads === 4) throw new Error("process died after hold");
              return getRun(id);
            };
          } else {
            h.setBeforeCancel(async () => {
              const b = [...h.batches.values()][0];
              if (vendor === "google") b.metadata.state = "JOB_STATE_CANCELLED";
              else {
                b.processing_status = "canceling";
                b.cancel_initiated_at = "2026-01-01T00:05:00Z";
              }
              throw new Error("socket lost after provider accepted cancel");
            });
          }
          h.die(true);
          await h.cancel();
          h.die(false);
          h.persistence.getRun = getRun;
          h.setBeforeCancel(async () => {});
          expect((await h.row())?.result).toHaveProperty("cancelFence");
          if (point === "hold") expect(h.cancelPosts()).toBe(0);
          h.clock.advance(300000);
          if (recovery !== "redrive") await h.cancel();
          if (recovery !== "cancel") {
            await h.redrive();
            await h.execute();
            expect(h.batches.size).toBe(
              point === "provider" || recovery === "both" ? 2 : 1,
            );
            h.finish();
            await h.tick(6000);
            await h.kernel.dispatch({
              type: "run.transition",
              workflowRunId: h.workflowRunId,
            });
            expect((await h.persistence.getRun(h.workflowRunId))?.status).toBe(
              "COMPLETED",
            );
          }
          expect((await h.row())?.result).not.toHaveProperty("cancelFence");
        });
      }
    }
  });
}

describe("round 2: shared", () => {
  for (const itemId of ["submit", "poll.1", "collect.2", "submit.3"]) {
    it(`item id ${itemId} is reserved`, async () => {
      const h = await setup(`reserved-${itemId}`, "google", { itemId });
      await h.execute();
      expect((await h.stage())?.errorMessage).toContain("reserved");
      expect(h.batches.size).toBe(0);
    });
  }

  it("C1: a partial Anthropic retry with resubmit keeps the recorded partitions", async () => {
    const h = await setup("partial-resubmit-anthropic", "anthropic", {
      count: 2,
      onReclaim: "resubmit",
    });
    h.rejectStart(2);
    await h.execute();
    await h.execute();
    expect(h.batches.size).toBe(2);
  });

  for (const collision of ["x:poll.1", "x:collect.1"]) {
    it(`an ordinary step ${collision} is rejected, never replayed as bookkeeping`, async () => {
      const h = await setup(
        `collision-${collision.replaceAll(":", "-")}`,
        "google",
        {
          collision,
        },
      );
      await h.execute();
      await h.cancel();
      await h.redrive();
      await h.execute();
      h.finish();
      await h.tick(6000);
      expect((await h.stage())?.errorMessage).toContain(
        "Duplicate durable step key",
      );
      expect(
        (await h.ledger.get((await h.stage())!.id, collision))?.result,
      ).toEqual({ ordinary: true });
    });
  }

  it("an ordinary failed *:submit step gets the accepted unrecorded WARN", async () => {
    const stage = defineStage({
      id: "false-positive",
      name: "false-positive",
      schemas: { input: schema, output: schema, config: schema },
      async execute(ctx) {
        await ctx.step.run("user:submit", async () => {
          throw new Error("ordinary failed action");
        });
        return { output: {} };
      },
    });
    const h = await createAiMapHarness({
      stage,
      inputSchema: schema,
      outputSchema: schema,
      input: {},
    });
    await h.execute();
    const result = await h.kernel.dispatch({
      type: "run.cancel",
      workflowRunId: h.workflowRunId,
    });
    expect(result.batches).toEqual([
      expect.objectContaining({ stepId: "user:submit", status: "unrecorded" }),
    ]);
    expect(
      h.persistence
        .getAllLogs()
        .some((l) => l.level === "WARN" && l.message.includes("user:submit")),
    ).toBe(true);
  });

  it("C4: an accepted asynchronous Gemini cancel whose final write was lost is completed, not taken for a cancel never sent", async () => {
    const h = await setup("async-crashed-google");
    await h.execute();
    h.asyncCancel();
    h.die(true);
    const cancelled = await h.cancel();
    h.die(false);
    expect(cancelled.batches[0]?.status).toBe("cancelled");
    expect(h.states()).toEqual(["JOB_STATE_RUNNING"]);
    expect((await h.row())?.result).toHaveProperty("cancelFence");
    h.clock.advance(300000);
    await h.redrive();
    await h.execute();
    h.settleCancels();
    await h.tick(6000);
    expect(h.batches.size).toBe(2);
    expect((await h.row())?.result).toHaveProperty("generation", 1);
    expect(h.live()).toEqual(["batches/b2"]);
  });

  it("an accepted asynchronous Gemini cancel with a lost final write resolves on a repeated cancel then a redrive", async () => {
    const h = await setup("async-crashed-repeated-google");
    await h.execute();
    h.asyncCancel();
    h.die(true);
    await h.cancel();
    h.die(false);
    h.clock.advance(300000);
    await h.cancel();
    await h.redrive();
    await h.execute();
    expect(h.batches.size).toBe(2);
    expect((await h.row())?.result).toHaveProperty("generation", 1);
  });
});

// ── Crash matrix ──────────────────────────────────────────────────────────

/**
 * The process running the sweep dies right after one of its steps: the hold
 * write, the intent write, the provider's status read, the provider's cancel
 * (accepted), the final write. Then the run is recovered by a repeated
 * run.cancel, a redrive, or both, and driven to a terminal state. Invariant:
 * at most one live batch for the step (exactly one once redriven), the step
 * never waits on a batch a cancel reached, no refusal although the row holds
 * the handle, never a second replacement.
 */
describe("a sweep whose process dies", () => {
  const points: Point[] = ["hold", "intent", "read", "cancel", "final"];
  for (const vendor of ["google", "openai", "anthropic"] as const) {
    for (const point of points) {
      for (const recovery of ["cancel", "redrive", "both"] as const) {
        it(`${vendor}: after the ${point} step, then ${recovery}`, async () => {
          const h: Harness = await setup(
            `die-${vendor}-${point}-${recovery}`,
            vendor,
          );
          if (vendor === "google") h.asyncCancel();
          await h.execute();
          await h.cancelDyingAfter(point);
          const left = (await h.row())!;
          // Whatever the process managed to send is on the row before it.
          if (h.cancelPosts() > 0 || point === "read") {
            expect(left.result as Record<string, unknown>).toHaveProperty(
              point === "final" ? "engineCancelled" : "cancelIntent",
            );
          }
          h.clock.advance(300000);

          if (recovery !== "redrive") {
            await h.cancel();
            expect(h.live()).toEqual([]);
            const row = (await h.row())!;
            expect(row.result).not.toHaveProperty("cancelFence");
            expect(row.result).not.toHaveProperty("cancelIntent");
            expect(row.result).toHaveProperty("engineCancelled");
          }
          if (recovery === "cancel") {
            expect((await h.persistence.getRun(h.workflowRunId))?.status).toBe(
              "CANCELLED",
            );
            expect(h.batches.size).toBe(1);
            return;
          }

          await h.redrive();
          await h.execute();
          const stage = await h.stage();
          expect(stage?.errorMessage ?? "").not.toMatch(/BatchNotAdoptable/);
          expect(stage?.status).toBe("SUSPENDED");
          // Only when nothing left the dying process does the run continue
          // on its batch; otherwise the cancel is completed and replaced once.
          const sentNothing = point === "hold" && recovery === "redrive";
          expect(h.batches.size).toBe(sentNothing ? 1 : 2);
          expect(h.live()).toHaveLength(1);
          const row = (await h.row())!;
          const record = row.result as { refs: Array<{ id: string }> };
          expect(record.refs.map((r) => r.id)).toEqual(h.live());
          expect(row.result).not.toHaveProperty("cancelFence");
          expect(row.result).not.toHaveProperty("cancelIntent");

          h.settleCancels();
          h.finish();
          await h.tick(6000);
          await h.kernel.dispatch({
            type: "run.transition",
            workflowRunId: h.workflowRunId,
          });
          expect((await h.persistence.getRun(h.workflowRunId))?.status).toBe(
            "COMPLETED",
          );
          expect(h.batches.size).toBe(sentNothing ? 1 : 2);
        });
      }
    }
  }
});

// ── One test per guard (each fails when its guard is removed) ─────────────

/** Intercept the ledger write that records a cancel intent. */
function onIntentWrite(
  h: Harness,
  around: (apply: () => Promise<any>) => Promise<any>,
) {
  const cas = h.ledger.compareAndSet.bind(h.ledger);
  h.ledger.compareAndSet = async (sid, key, expected, patch) => {
    const result = patch.result as Record<string, unknown> | undefined;
    if (
      key === "x:submit" &&
      result?.cancelIntent &&
      !Object.hasOwn(patch, "leaseExpiresAt")
    ) {
      return around(() => cas(sid, key, expected, patch));
    }
    return cas(sid, key, expected, patch);
  };
}

describe("the sweep's guards", () => {
  const timeouts = { batchMs: 60_000, sweepMs: 120_000 };

  it("a sweep whose expired hold was taken over writes nothing more to the row", async () => {
    const h = await setup("guard-taken-over", "google", timeouts);
    await h.execute();
    const entered = barrier();
    const go = barrier();
    let first = true;
    h.setResolver(async () => {
      if (first) {
        first = false;
        entered.release();
        await go.promise;
      }
      return h.model;
    });
    const slow = h.cancel();
    await entered.promise;
    h.clock.advance(timeouts.batchMs + timeouts.sweepMs + 1);
    expect((await h.cancel()).batches[0]?.status).toBe("cancelled");
    const taken = await h.row();
    go.release();
    expect((await slow).batches[0]?.status).toBe("failed");
    expect(h.cancelPosts()).toBe(1);
    expect(await h.row()).toEqual(taken);
  });

  it("a hold that ran out while the transport resolved sends nothing", async () => {
    const h = await setup("guard-lease", "google", timeouts);
    await h.execute();
    h.setResolver(async () => {
      h.clock.advance(timeouts.batchMs + timeouts.sweepMs + 1);
      return h.model;
    });
    const result = await h.cancel();
    expect(result.batches[0]).toMatchObject({
      status: "failed",
      error: expect.stringMatching(/hold on the step would end/),
    });
    expect(h.cancelPosts()).toBe(0);
  });

  it("an intent write that does not apply stops the provider call", async () => {
    const h = await setup("guard-unapplied", "google", timeouts);
    await h.execute();
    // The row is there, at another attempt.
    onIntentWrite(h, async () => ({ applied: false, record: await h.row() }));
    const result = await h.cancel();
    expect(result.batches[0]).toMatchObject({
      status: "failed",
      error: expect.stringMatching(
        /could not be recorded .*another execution took the step over/,
      ),
    });
    expect(h.cancelPosts()).toBe(0);
    expect(h.states()).toEqual(["JOB_STATE_RUNNING"]);
  });

  it("a redrive during the intent write stops the provider call", async () => {
    const h = await setup("guard-redrive", "google", timeouts);
    await h.execute();
    const entered = barrier();
    const go = barrier();
    onIntentWrite(h, async (apply) => {
      entered.release();
      await go.promise;
      return apply();
    });
    const sweep = h.cancel();
    await entered.promise;
    await h.redrive();
    go.release();
    await sweep;
    expect(h.cancelPosts()).toBe(0);
    expect(h.states()).toEqual(["JOB_STATE_RUNNING"]);
  });

  it("a budget that ran out during the intent write sends nothing after the sweep returned", async () => {
    const h = await setup("guard-budget", "google", {
      batchMs: 30,
      sweepMs: 60,
    });
    await h.execute();
    onIntentWrite(h, async (apply) => {
      await new Promise((r) => setTimeout(r, 80));
      return apply();
    });
    expect((await h.cancel()).batches[0]?.status).toBe("failed");
    await new Promise((r) => setTimeout(r, 120));
    expect(h.cancelPosts()).toBe(0);
  });

  /** A submit the run is cancelled (and the job aborted) during. */
  async function cancelledDuringSubmit(
    h: Harness,
    id: string,
    then: () => void,
  ) {
    const abort = new AbortController();
    let starts = 0;
    h.setBeforeStart(async () => {
      if (++starts > 1) return;
      expect((await h.cancel()).batches[0]?.status).toBe("unrecorded");
      abort.abort(new StageAbortedError("cancelled", h.workflowRunId));
      then();
    });
    await h.kernel
      .dispatch({
        type: "job.execute",
        workflowId: `wf-${id}`,
        workflowRunId: h.workflowRunId,
        stageId: id,
        config: {},
        abortSignal: abort.signal,
      })
      .catch(() => undefined);
  }

  for (const vendor of ["google", "openai", "anthropic"] as const) {
    it(`${vendor}: a step that cancels the batches it created records the intent first, so a death after the call is recovered`, async () => {
      const id = `guard-step-dies-${vendor}`;
      const h = await setup(id, vendor);
      if (vendor === "google") h.asyncCancel();
      await cancelledDuringSubmit(h, id, () => h.dieAfter("cancel"));
      h.dieAfter(undefined);
      expect(h.cancelPosts()).toBe(1);
      expect((await h.row())?.result).toHaveProperty("cancelIntent");

      h.clock.advance(300000);
      await h.redrive();
      await h.execute();
      const stage = await h.stage();
      expect(stage?.errorMessage ?? "").not.toMatch(/BatchNotAdoptable/);
      expect(stage?.status).toBe("SUSPENDED");
      expect(h.batches.size).toBe(2);
      h.settleCancels();
      expect(h.live()).toHaveLength(1);
      expect(
        ((await h.row())!.result as { refs: Array<{ id: string }> }).refs.map(
          (r) => r.id,
        ),
      ).toEqual(h.live());
    });
  }

  it("a step whose intent write does not apply sends nothing on it, and leaves its batch to the loser's cleanup, which records it before cancelling", async () => {
    const id = "guard-step-unapplied";
    const h = await setup(id, "google");
    await cancelledDuringSubmit(h, id, () =>
      onIntentWrite(h, async () => ({ applied: false, record: null })),
    );
    const row = await h.row();
    // No intent was recorded, so the body's own cancel sent nothing; the
    // row is not the step's at its attempt, and the loser's cleanup recorded
    // the batch as excluded, then cancelled it.
    expect(row?.result).not.toHaveProperty("cancelIntent");
    expect(row?.result).toMatchObject({ cancelledBatchIds: ["batches/b1"] });
    expect(h.cancelPosts()).toBe(1);
    expect(
      h.persistence
        .getAllLogs()
        .some(
          (l) => l.level === "WARN" && /could not be cancelled/.test(l.message),
        ),
    ).toBe(false);
  });
});

// ── Writers that could go around a hold (round 6) ─────────────────────────

/**
 * The replacement execution of a cancelled and redriven run, held up inside
 * its provider call; the run is then cancelled again and its lease runs out,
 * so a sweep may take the row while the body is still alive.
 */
async function lateReplacement(
  id: string,
  then: "creates" | "throws" = "creates",
) {
  const h = await setup(id, "google", { batchMs: 60_000, sweepMs: 120_000 });
  await h.execute();
  await h.cancel();
  await h.redrive();
  const entered = barrier();
  const go = barrier();
  let starts = 0;
  h.setBeforeStart(async () => {
    if (++starts > 1) return;
    entered.release();
    await go.promise;
    if (then === "throws")
      throw new Error("socket reset after the lease ended");
  });
  const job = h.execute();
  await entered.promise;
  await h.cancel();
  h.clock.advance(300_001);
  return { h, job, go };
}

describe("a submit body that outlived its lease", () => {
  it("cannot replace a sweep's hold with its outcome, and cancels the batch it created", async () => {
    const { h, job, go } = await lateReplacement("late-hold");
    const resolving = barrier();
    const resolveGo = barrier();
    let first = true;
    h.setResolver(async () => {
      if (first) {
        first = false;
        resolving.release();
        await resolveGo.promise;
      }
      return h.model;
    });
    const sweep = h.cancel();
    await resolving.promise;
    const held = (await h.row())!;
    expect(held.result).toHaveProperty("cancelFence");

    go.release();
    await job;
    // The body created batches/b2; its outcome write did not apply.
    const after = (await h.row())!;
    expect(after.attempt).toBe(held.attempt);
    expect(after.result).toEqual(held.result);
    expect(h.cancelReached.has("batches/b2")).toBe(true);

    resolveGo.release();
    await sweep;
    // Released as the sweep found it. Its tombstone counts from the attempt
    // before the lost replacement, so the next takeover searches (excluding
    // b1) as after any crash while a replacement was being created.
    const released = (await h.row())!;
    const { cancelFence: _fence, ...unfenced } = held.result as Record<
      string,
      unknown
    >;
    expect(released.result).toEqual(unfenced);
    expect(h.live()).toEqual([]);
  });

  it("returning after a sweep released the row (running, no lease): records its batch as excluded, then cancels it", async () => {
    const { h, job, go } = await lateReplacement("late-released");
    await h.cancel();
    const released = (await h.row())!;
    expect(released).toMatchObject({ status: "running", leaseExpiresAt: null });
    go.release();
    // The job then finds the run cancelled; its own sweep may hold and
    // release the row again (a later attempt), on the same result.
    expect(await job).toMatchObject({ ghost: true });
    expect(h.cancelReached.has("batches/b2")).toBe(true);
    expect(h.live()).toEqual([]);
    const row = (await h.row())!;
    expect(row).toMatchObject({ status: "running", leaseExpiresAt: null });
    expect(row.result).toEqual({
      ...(released.result as Record<string, unknown>),
      cancelledBatchIds: ["batches/b1", "batches/b2"],
    });
  });

  it("cannot drop a sweep's write that landed just before its failure write", async () => {
    const { h, job, go } = await lateReplacement("late-failure", "throws");
    const compareAndSet = h.ledger.compareAndSet.bind(h.ledger);
    let armed = true;
    let swept: Awaited<ReturnType<typeof h.cancel>> | undefined;
    h.ledger.compareAndSet = async (sid, key, expected, patch) => {
      if (armed && key === "x:submit" && patch.status === "failed") {
        armed = false;
        // The whole sweep runs just before the failure write is sent.
        swept = await h.cancel();
      }
      return compareAndSet(sid, key, expected, patch);
    };
    go.release();
    await job;
    h.ledger.compareAndSet = compareAndSet;
    expect(swept?.batches[0]?.status).toBe("cancelled");
    const row = (await h.row())!;
    // The sweep's release stands: re-opened with its tombstone.
    expect(row.status).toBe("running");
    expect(row.leaseExpiresAt).toBeNull();
    expect(row.result).toHaveProperty("engineCancelled");
  });
});

describe("an execution that loses the submit row cancels the batches it created", () => {
  /** Execution A of the submit, held up inside its provider call. */
  async function heldUp(
    id: string,
    vendor: Vendor = "google",
    opts: SetupOptions = {},
  ) {
    const h = await setup(id, vendor, opts);
    const entered = barrier();
    const go = barrier();
    let starts = 0;
    h.setBeforeStart(async () => {
      if (++starts > 1) return;
      entered.release();
      await go.promise;
    });
    const a = h.execute();
    await entered.promise;
    return { h, a, go };
  }

  it("superseded after a cancel and a redrive: the redriven execution's batch is the one kept", async () => {
    const { h, a, go } = await heldUp("loser-superseded");
    expect((await h.cancel()).batches[0]?.status).toBe("unrecorded");
    await h.redrive();
    await h.execute();
    expect(h.live()).toEqual(["batches/b2"]);

    go.release();
    expect(await a).toMatchObject({ ghost: true, ghostReason: "orphan" });
    // A created batches/b1 and parked on B's outcome: b1 is recorded as
    // excluded on the row, then cancelled.
    expect(h.cancelReached.has("batches/b1")).toBe(true);
    expect(h.live()).toEqual(["batches/b2"]);
    const row = (await h.row())!;
    expect(row.result).toMatchObject({
      refs: [expect.objectContaining({ id: "batches/b2" })],
      cancelledBatchIds: ["batches/b1"],
    });

    h.finish();
    await h.tick(6000);
    await h.kernel.dispatch({
      type: "run.transition",
      workflowRunId: h.workflowRunId,
    });
    expect((await h.persistence.getRun(h.workflowRunId))?.status).toBe(
      "COMPLETED",
    );
  });

  it("whose row is gone (its stage record deleted) cancels them", async () => {
    const { h, a, go } = await heldUp("loser-gone");
    // What a redrive's delete of the stage record does to its rows.
    await h.ledger.clear((await h.stage())!.id);
    go.release();
    expect(await a).toMatchObject({ outcome: "failed" });
    expect(h.cancelReached.has("batches/b1")).toBe(true);
    expect(h.live()).toEqual([]);
  });

  it("taken over by another live execution: left for its adoption, with a WARN", async () => {
    const { h, a, go } = await heldUp("loser-live");
    h.clock.advance(300_001);
    const bEntered = barrier();
    const bGo = barrier();
    h.setBeforeStart(async () => {
      bEntered.release();
      await bGo.promise;
    });
    const b = h.execute();
    await bEntered.promise;
    go.release();
    await a;
    expect(h.cancelReached.has("batches/b1")).toBe(false);
    expect(
      h.persistence
        .getAllLogs()
        .some(
          (l) =>
            l.level === "WARN" &&
            /lost the step to another execution/.test(l.message),
        ),
    ).toBe(true);
    bGo.release();
    await b;
  });

  it("taken over by another live execution on a transport that cannot adopt: cancelled, since the winner never lists them", async () => {
    // Anthropic has no search; "resubmit" lets the winner start at all.
    const { h, a, go } = await heldUp("loser-live-anthropic", "anthropic", {
      onReclaim: "resubmit",
    });
    h.clock.advance(300_001);
    const bEntered = barrier();
    const bGo = barrier();
    h.setBeforeStart(async () => {
      bEntered.release();
      await bGo.promise;
    });
    const b = h.execute();
    await bEntered.promise;
    go.release();
    await a;
    expect(h.cancelReached.has("msgbatch_1")).toBe(true);
    bGo.release();
    await b;
    const row = (await h.row())!;
    expect(row.status).toBe("completed");
    expect(row.result).toMatchObject({
      refs: [expect.objectContaining({ id: "msgbatch_2" })],
    });
    expect(h.live()).toEqual(["msgbatch_2"]);
  });

  it("on a transport that cannot adopt, a failed cancel leaves the batch running with a WARN naming it", async () => {
    const { h, a, go } = await heldUp("loser-live-fail", "anthropic", {
      onReclaim: "resubmit",
    });
    h.clock.advance(300_001);
    const bEntered = barrier();
    const bGo = barrier();
    h.setBeforeStart(async () => {
      bEntered.release();
      await bGo.promise;
    });
    const b = h.execute();
    await bEntered.promise;
    h.failCancel(true);
    go.release();
    await a;
    h.failCancel(false);
    expect(h.live()).toContain("msgbatch_1");
    expect(
      h.persistence
        .getAllLogs()
        .some(
          (l) =>
            l.level === "WARN" &&
            l.message.includes('"msgbatch_1"') &&
            /cancelling them failed/.test(l.message),
        ),
    ).toBe(true);
    bGo.release();
    await b;
  });
});
