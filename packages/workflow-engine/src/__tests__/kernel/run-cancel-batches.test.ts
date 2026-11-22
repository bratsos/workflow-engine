/**
 * run.cancel cancels the provider batches a run created.
 *
 * Every case drives `kernel.dispatch` over the real `ctx.step.ai.map` batch
 * path (a stage that submits, then suspends in the poll) with a fake
 * `EngineBatchModel` that records its calls. The per-transport request shapes
 * are in `09-async-batch/batch-cancel.test.ts`.
 */

import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { EngineBatchModel, EngineBatchRef } from "../../ai/batch/model.js";
import { defineStage } from "../../core/stage-factory.js";
import { StageAbortedError } from "../../core/steps.js";
import { batchRefsOfSubmitRow } from "../../kernel/helpers/batch-submit-record.js";
import {
  BATCH_MODEL,
  createAiMapHarness,
  createBatchAwareFactory,
  makeFakeBackend,
} from "../durable/ai-map-harness.js";
import { createMockAIHelperFactory, wrapStepLedger } from "../utils/index.js";

const inputSchema = z.object({ count: z.number() });
const outputSchema = z.object({ done: z.number() });
const itemSchema = z.object({ v: z.string() });

type Resolver = (
  ref: EngineBatchRef,
) => Promise<EngineBatchModel | undefined> | EngineBatchModel | undefined;

interface SetupOptions {
  adoptable?: boolean;
  spillThresholdBytes?: number;
  /** Status polls that answer "pending" before the batch completes. */
  pendingPolls?: number;
  /** One upstream batch per this many requests (fan-out). */
  maxRequestsPerBatch?: number;
  /** Also map "second" after "extract", in the same stage. */
  secondMap?: boolean;
  /** Time budgets of the cancel sweep. */
  batchCancelTimeouts?: { batchMs?: number; sweepMs?: number };
  /** Runs inside the stage body before it maps; the abort tests use it. */
  beforeMap?: (ctx: { workflowRunId: string }) => void | Promise<void>;
  /**
   * The provider keeps listing a batch it was told to cancel as running (Gemini
   * cancels asynchronously), so only the engine's own record excludes it.
   */
  listsCancelledAsRunning?: boolean;
  /**
   * The id of a sleep before mapping, so the submit runs in a
   * `stage.pollSuspended` replay; a new id makes a redriven stage sleep again.
   */
  sleepFirst?: () => string;
}

async function setup(id: string, opts: SetupOptions = {}) {
  const mock = createMockAIHelperFactory();
  const backend = makeFakeBackend({
    pendingPolls: opts.pendingPolls ?? 1000,
    adoptable: opts.adoptable ?? true,
  });
  const model = backend.model;

  // A provider that has cancelled a batch no longer offers it for adoption.
  const cancelledIds = new Set<string>();
  const cancelCalls: string[] = [];
  model.cancel = vi.fn(async (ref: EngineBatchRef) => {
    cancelCalls.push(ref.id);
    cancelledIds.add(ref.id);
    return { outcome: "cancelled" as const, rawStatus: "in_progress" };
  });
  const adopt = model.adopt!;
  model.adopt = vi.fn(async (key: string, o) => {
    const batchId = backend.byExternalKey.get(key);
    // Every transport's search honours the engine's own exclusion list.
    if (batchId && o?.excludeBatchIds?.includes(batchId)) return null;
    if (batchId && cancelledIds.has(batchId) && !opts.listsCancelledAsRunning) {
      return null;
    }
    return adopt(key, o);
  });
  // A batch that was told to cancel reports itself cancelled when asked.
  const status = model.status;
  model.status = vi.fn(async (ref: EngineBatchRef, o) =>
    cancelledIds.has(ref.id)
      ? {
          status: "failed" as const,
          rawStatus: "cancelled",
          cancelled: true,
        }
      : status(ref, o),
  );

  // A process that dies after its provider calls cannot write its outcome:
  // the final write and the release of the step row both fail.
  let dying = false;

  let resolver: Resolver = () => model;
  const stage = defineStage({
    id,
    name: id,
    schemas: { input: inputSchema, output: outputSchema, config: z.object({}) },
    async execute(ctx) {
      if (opts.sleepFirst) await ctx.step.sleep(opts.sleepFirst(), "1s");
      await opts.beforeMap?.(ctx);
      const items = Array.from({ length: ctx.input.count }, (_, i) => i);
      const spec = {
        model: BATCH_MODEL,
        schema: itemSchema,
        policy: "batch" as const,
        prompt: (item: number) => `Extract <<${item}>>`,
        batch: {
          pollEvery: "60s",
          timeout: "24h",
          ...(opts.maxRequestsPerBatch
            ? { options: { maxRequestsPerBatch: opts.maxRequestsPerBatch } }
            : {}),
        },
      };
      let results = await ctx.step.ai.map("extract", items, spec);
      if (opts.secondMap)
        results = await ctx.step.ai.map("second", items, spec);
      return { output: { done: results.length } };
    },
  });
  const h = await createAiMapHarness({
    stage,
    inputSchema,
    outputSchema,
    input: { count: 3 },
    mock,
    aiFactory: createBatchAwareFactory(mock, model),
    batchModels: (ref) => resolver(ref),
    wrapLedger: (inner) =>
      wrapStepLedger(inner, {
        compareAndSet: (stageRecordId, stepId, expected, patch) =>
          dying &&
          expected.status === "running" &&
          patch.leaseExpiresAt === null &&
          Object.hasOwn(patch, "result")
            ? Promise.reject(new Error("the process died"))
            : inner.compareAndSet(stageRecordId, stepId, expected, patch),
      }),
    ...(opts.spillThresholdBytes !== undefined
      ? { spillThresholdBytes: opts.spillThresholdBytes }
      : {}),
    ...(opts.batchCancelTimeouts
      ? { batchCancelTimeouts: opts.batchCancelTimeouts }
      : {}),
  });
  return {
    ...h,
    backend,
    model,
    cancelCalls,
    setResolver: (next: Resolver) => {
      resolver = next;
    },
    /** While on, a sweep cannot record its outcome or release the step row. */
    die: (on: boolean) => {
      dying = on;
    },
    cancel: () =>
      h.kernel.dispatch({
        type: "run.cancel",
        workflowRunId: h.workflowRunId,
      }),
    submitRow: async () =>
      h.ledger.get((await h.stage())!.id, "extract:submit"),
    run: () => h.persistence.getRun(h.workflowRunId),
    warnings: () =>
      h.persistence
        .getAllLogs()
        .filter(
          (l) => l.workflowRunId === h.workflowRunId && l.level === "WARN",
        ),
  };
}

const REF = {
  version: 1,
  type: "text",
  id: "batch-1",
  provider: "openrouter",
  modelId: "openai/gpt-4o",
} as const;

describe("run.cancel: provider batches", () => {
  it("cancels the batch a suspended ctx.step.ai.map is waiting on", async () => {
    const h = await setup("cancel-happy");
    await h.execute();
    expect((await h.stage())?.status).toBe("SUSPENDED");

    const result = await h.cancel();

    expect(result).toEqual({
      cancelled: true,
      batches: [
        {
          stageId: "cancel-happy",
          stepId: "extract:submit",
          ref: REF,
          status: "cancelled",
          providerStatus: "in_progress",
        },
      ],
    });
    expect(h.cancelCalls).toEqual(["batch-1"]);
    expect((await h.run())?.status).toBe("CANCELLED");
    expect(h.warnings()).toEqual([]);
  });

  it("calls the provider only after the transaction has committed", async () => {
    const h = await setup("cancel-after-commit");
    await h.execute();
    let inTransaction = false;
    const withTransaction = h.persistence.withTransaction.bind(h.persistence);
    h.persistence.withTransaction = async (fn) => {
      inTransaction = true;
      try {
        return await withTransaction(fn);
      } finally {
        inTransaction = false;
      }
    };
    const open: boolean[] = [];
    h.model.cancel = vi.fn(async () => {
      open.push(inTransaction);
      return { outcome: "cancelled" as const };
    });

    await h.cancel();

    expect(open).toEqual([false]);
  });

  it("reports a batch that had already ended and leaves its step alone", async () => {
    const h = await setup("cancel-terminal");
    await h.execute();
    h.model.cancel = vi.fn(async () => ({
      outcome: "already-terminal" as const,
      rawStatus: "completed",
    }));

    const result = await h.cancel();

    expect(result.batches).toEqual([
      expect.objectContaining({
        status: "already-terminal",
        providerStatus: "completed",
      }),
    ]);
    // Its results are good, so a redrive keeps collecting from it.
    expect((await h.submitRow())?.status).toBe("completed");
    expect(h.warnings()).toEqual([]);
  });

  it("reports a transport with no cancel call as unsupported and warns", async () => {
    const h = await setup("cancel-unsupported");
    await h.execute();
    delete h.model.cancel;

    const result = await h.cancel();

    expect(result.cancelled).toBe(true);
    expect(result.batches).toEqual([
      expect.objectContaining({ status: "unsupported", ref: REF }),
    ]);
    expect((await h.run())?.status).toBe("CANCELLED");
    expect(h.warnings()).toHaveLength(1);
    expect(h.warnings()[0]!.message).toMatch(/batch "batch-1".*no cancel call/);
    // Not cancelled, so a redrive still finds the live batch where it was.
    expect((await h.submitRow())?.status).toBe("completed");
  });

  it("does not fail or undo the cancel when the provider call throws", async () => {
    const h = await setup("cancel-throws");
    await h.execute();
    h.model.cancel = vi.fn(async () => {
      throw new Error("HTTP 503");
    });

    const result = await h.cancel();

    expect(result.cancelled).toBe(true);
    expect(result.batches).toEqual([
      expect.objectContaining({ status: "failed", error: "HTTP 503" }),
    ]);
    expect((await h.run())?.status).toBe("CANCELLED");
    expect((await h.stage())?.status).toBe("CANCELLED");
    expect(h.warnings()).toHaveLength(1);
    expect(h.warnings()[0]!.message).toMatch(/HTTP 503/);
  });

  it("reports a batch no transport can be built for as unavailable", async () => {
    const h = await setup("cancel-unavailable");
    await h.execute();
    h.setResolver(() => undefined);
    const noTransport = await h.cancel();
    h.setResolver(() => {
      throw new Error("OpenRouter batch access needs an API key");
    });
    const noCredentials = await h.cancel();
    // The SDK's own "no API key" error is unavailable too, not a failure.
    h.setResolver(() => ({
      ...h.model,
      cancel: async () => {
        throw Object.assign(new Error("API key is missing"), {
          name: "AI_LoadAPIKeyError",
        });
      },
    }));
    const noKey = await h.cancel();

    expect(noTransport.batches).toEqual([
      expect.objectContaining({ status: "unavailable" }),
    ]);
    expect(noCredentials.batches).toEqual([
      expect.objectContaining({
        status: "unavailable",
        error: "OpenRouter batch access needs an API key",
      }),
    ]);
    expect(noKey.batches).toEqual([
      expect.objectContaining({
        status: "unavailable",
        error: "API key is missing",
      }),
    ]);
    expect((await h.run())?.status).toBe("CANCELLED");
    expect(h.warnings()).toHaveLength(3);
  });

  it("retries the outstanding provider cancels when run.cancel is repeated", async () => {
    const h = await setup("cancel-retry");
    await h.execute();
    const working = h.model.cancel!;
    h.model.cancel = vi.fn(async () => {
      throw new Error("HTTP 503");
    });
    const first = await h.cancel();
    expect(first.batches[0]?.status).toBe("failed");
    // The request may have reached the provider: the row says so, and is
    // re-opened so that no replay continues on a batch it may have reached.
    expect(await h.submitRow()).toMatchObject({
      status: "running",
      result: { cancelIntent: { batchIds: ["batch-1"], from: "completed" } },
    });

    h.model.cancel = working;
    const second = await h.cancel();

    // `cancelled` keeps its meaning: this command did not cancel the run.
    expect(second.cancelled).toBe(false);
    expect(second.batches).toEqual([
      expect.objectContaining({ status: "cancelled", ref: REF }),
    ]);
    expect(h.cancelCalls).toEqual(["batch-1"]);
    expect((await h.submitRow())?.status).toBe("running");
  });

  it("still attempts the provider cancels when the job update throws", async () => {
    const h = await setup("cancel-jobs-throw");
    await h.execute();
    h.jobTransport.cancelByRun = async () => {
      throw new Error("queue down");
    };

    await expect(h.cancel()).rejects.toThrow("queue down");

    expect(h.cancelCalls).toEqual(["batch-1"]);
    expect((await h.run())?.status).toBe("CANCELLED");
  });

  it("does not touch the batches of a FAILED or COMPLETED run", async () => {
    for (const status of ["FAILED", "COMPLETED"] as const) {
      const h = await setup(`cancel-${status.toLowerCase()}`);
      await h.execute();
      await h.persistence.updateRun(h.workflowRunId, { status });

      const result = await h.cancel();

      // A redrive of a FAILED run re-adopts the live batch.
      expect(result).toEqual({ cancelled: false, batches: [] });
      expect(h.cancelCalls).toEqual([]);
    }
  });

  it("finds a submit result that was spilled to the blob store", async () => {
    const h = await setup("cancel-spilled", { spillThresholdBytes: 1 });
    await h.execute();
    // The ledger holds a claim check, not the handle.
    expect((await h.submitRow())?.result).toMatchObject({ $wfSpill: 1 });

    const result = await h.cancel();

    expect(result.batches).toEqual([
      expect.objectContaining({
        status: "cancelled",
        stepId: "extract:submit",
      }),
    ]);
  });

  it("cancels a batch a legacy async-batch stage kept in suspendedState", async () => {
    const h = await setup("cancel-legacy");
    // A stage that was never executed through ctx.step: only its record exists.
    await h.persistence.createStage({
      workflowRunId: h.workflowRunId,
      stageId: "legacy",
      stageName: "legacy",
      stageNumber: 2,
      executionGroup: 2,
      status: "SUSPENDED",
    });
    const legacy = await h.persistence.getStage(h.workflowRunId, "legacy");
    await h.persistence.updateStage(legacy!.id, {
      suspendedState: {
        batchId: "batch-legacy",
        metadata: { batchRefs: [{ ...REF, id: "batch-legacy" }] },
      },
    });
    const noRefs = await h.persistence.createStage({
      workflowRunId: h.workflowRunId,
      stageId: "no-refs",
      stageName: "no-refs",
      stageNumber: 3,
      executionGroup: 3,
      status: "SUSPENDED",
    });
    await h.persistence.updateStage(noRefs.id, {
      suspendedState: { batchId: "batch-unknown" },
    });

    const result = await h.cancel();

    // The engine cancels what it can identify. A handle kept anywhere but
    // `metadata.batchRefs` belongs to the stage (`AIBatch.cancel`).
    expect(result.batches).toEqual([
      {
        stageId: "legacy",
        ref: { ...REF, id: "batch-legacy" },
        status: "cancelled",
        providerStatus: "in_progress",
      },
    ]);
  });
});

describe("run.cancel: bounded provider time", () => {
  /** A stage record holding `count` legacy batch refs, as `run.cancel` finds them. */
  async function withLegacyRefs(
    h: Awaited<ReturnType<typeof setup>>,
    count: number,
  ) {
    const stage = await h.persistence.createStage({
      workflowRunId: h.workflowRunId,
      stageId: "many",
      stageName: "many",
      stageNumber: 2,
      executionGroup: 2,
      status: "SUSPENDED",
    });
    await h.persistence.updateStage(stage.id, {
      suspendedState: {
        batchId: "b0",
        metadata: {
          batchRefs: Array.from({ length: count }, (_, i) => ({
            ...REF,
            id: `b${i}`,
          })),
        },
      },
    });
  }

  it("reports a batch whose call outlives its budget, and one the sweep never reached, as failed", async () => {
    const h = await setup("cancel-deadline", {
      batchCancelTimeouts: { batchMs: 60, sweepMs: 150 },
    });
    await withLegacyRefs(h, 24);
    // A transport that never answers and ignores the abort signal.
    h.model.cancel = vi.fn(() => new Promise<never>(() => {}));
    const started = Date.now();

    const result = await h.cancel();

    expect(Date.now() - started).toBeLessThan(2000);
    expect(result.cancelled).toBe(true);
    expect(result.batches).toHaveLength(24);
    expect(result.batches.every((b) => b.status === "failed")).toBe(true);
    expect(result.batches[0]?.error).toMatch(/did not finish within \d+ ms/);
    const unreached = result.batches.filter((b) =>
      b.error?.startsWith("Not reached"),
    );
    expect(unreached.length).toBeGreaterThan(0);
    expect(unreached[0]?.error).toMatch(/after 150 ms/);
    expect((await h.run())?.status).toBe("CANCELLED");
    // Only the four conversations of the first wave, and the second, ran.
    expect(vi.mocked(h.model.cancel!).mock.calls.length).toBeLessThan(24);
  });

  it("does not let a hanging transport resolver hold the cancel up", async () => {
    const h = await setup("cancel-deadline-resolver", {
      batchCancelTimeouts: { batchMs: 50, sweepMs: 200 },
    });
    await h.execute();
    h.setResolver(() => new Promise<never>(() => {}));

    const result = await h.cancel();

    expect(result.batches).toEqual([
      expect.objectContaining({
        status: "failed",
        error: expect.stringMatching(/did not finish within 50 ms/),
      }),
    ]);
  });
});

describe("run.cancel then run.redrive", () => {
  it("creates a new batch, numbered as a new generation, instead of adopting the cancelled one", async () => {
    const h = await setup("redrive-new-batch");
    await h.execute();
    await h.cancel();

    await h.kernel.dispatch({
      type: "run.redrive",
      workflowRunId: h.workflowRunId,
    });
    await h.execute();

    expect(h.model.start).toHaveBeenCalledTimes(2);
    // No adoption search: the engine knows the old batch is cancelled.
    expect(h.model.adopt).not.toHaveBeenCalled();
    const row = await h.submitRow();
    expect(row?.result).toMatchObject({ handleId: "batch-2", generation: 1 });
    expect(row?.result).not.toHaveProperty("engineCancelled");
    // The new batch is polled under its own step, not the cancelled one's.
    expect(
      await h.ledger.get((await h.stage())!.id, "extract:poll.1"),
    ).toMatchObject({
      status: "pending",
    });
    expect((await h.run())?.status).toBe("RUNNING");
  });

  it("keeps the batch of a run that was not cancelled at the provider", async () => {
    const h = await setup("redrive-keeps-live");
    await h.execute();
    delete h.model.cancel;
    await h.cancel();

    await h.kernel.dispatch({
      type: "run.redrive",
      workflowRunId: h.workflowRunId,
    });
    await h.execute();

    // Still running at the provider, so the redriven stage waits on it.
    expect(h.model.start).toHaveBeenCalledTimes(1);
    expect((await h.submitRow())?.result).toMatchObject({
      handleId: "batch-1",
    });
  });

  it("writes one tombstone however often run.cancel is repeated", async () => {
    const h = await setup("cancel-tombstone-once");
    await h.execute();
    await h.cancel();
    await h.cancel();
    await h.cancel();

    // Each hold is a takeover (`attempt + 1`); the tombstone moves with the
    // row, so it still names the attempt the replacement takes over from.
    const row = (await h.submitRow())!;
    expect(row.attempt).toBe(4);
    expect(row.result).toMatchObject({
      handleId: "batch-1",
      engineCancelled: { attempt: 4, generation: 1 },
    });
  });

  // Two transport classes: one that can find a batch it created (OpenAI,
  // Gemini: `recovery: "metadata"`) and one that cannot (Anthropic,
  // OpenRouter: `recovery: "none"`). Neither sets `onReclaim`.
  describe.each([
    ["a transport that can adopt", true],
    ["a transport that cannot adopt", false],
  ])("on %s", (_name, adoptable) => {
    async function redriven(id: string) {
      const h = await setup(id, { adoptable, pendingPolls: 1 });
      await h.execute();
      expect((await h.stage())?.status).toBe("SUSPENDED");
      const stageRecordId = (await h.stage())!.id;
      const stalePoll = await h.ledger.get(stageRecordId, "extract:poll");
      await h.cancel();
      return { h, stageRecordId, stalePoll };
    }

    it("completes the run on a new batch after a cancel during the poll", async () => {
      const { h, stageRecordId, stalePoll } = await redriven(
        `redrive-complete-${adoptable ? "adopt" : "none"}`,
      );
      // The old wait's deadline was 24h from the first submit; the redrive
      // comes long after it.
      expect(stalePoll?.deadlineAt?.getTime()).toBeGreaterThan(0);
      await h.tick(30 * 60 * 60 * 1000);

      await h.kernel.dispatch({
        type: "run.redrive",
        workflowRunId: h.workflowRunId,
      });
      const outcome = await h.execute();
      await h.kernel.dispatch({
        type: "run.transition",
        workflowRunId: h.workflowRunId,
      });

      expect(outcome).toMatchObject({ outcome: "completed" });
      expect(h.model.start).toHaveBeenCalledTimes(2);
      expect(h.model.adopt).not.toHaveBeenCalled();
      expect((await h.run())?.status).toBe("COMPLETED");
      // The redrive dropped the old pending wait; the new batch polled and
      // was collected under generation-numbered steps.
      expect(await h.ledger.get(stageRecordId, "extract:poll")).toBeNull();
      expect(await h.ledger.get(stageRecordId, "extract:poll.1")).toMatchObject(
        { status: "completed" },
      );
      expect(
        await h.ledger.get(stageRecordId, "extract:collect.1"),
      ).toMatchObject({ status: "completed" });
      expect(await h.ledger.get(stageRecordId, "extract:collect")).toBeNull();
    });

    it("ignores a poll and a collect row the cancelled batch left completed", async () => {
      const { h, stageRecordId } = await redriven(
        `redrive-stale-${adoptable ? "adopt" : "none"}`,
      );
      // An execution that was still polling when the cancel landed saw the
      // batch fail and recorded it; `run.redrive` keeps completed rows.
      await h.ledger.compareAndSet(
        stageRecordId,
        "extract:poll",
        { status: "pending" },
        {
          status: "completed",
          result: { status: "failed", error: "batch cancelled" },
        },
      );
      await h.ledger.claim({
        stageRecordId,
        stepId: "extract:collect",
        seq: 99,
        kind: "run",
        status: "completed",
        attempt: 1,
        leaseExpiresAt: null,
        deadlineAt: null,
        externalKey: "wfe-stale",
        result: { stale: true },
      });

      await h.kernel.dispatch({
        type: "run.redrive",
        workflowRunId: h.workflowRunId,
      });
      const outcome = await h.execute();

      expect(outcome).toMatchObject({ outcome: "completed" });
      expect(h.model.start).toHaveBeenCalledTimes(2);
      expect(await h.ledger.get(stageRecordId, "extract:poll")).toMatchObject({
        status: "completed",
        result: { status: "failed" },
      });
      expect(
        await h.ledger.get(stageRecordId, "extract:collect.1"),
      ).toMatchObject({ status: "completed" });
    });
  });

  it("keeps today's conservative behaviour when only some batches of a submit were cancelled", async () => {
    for (const adoptable of [true, false]) {
      const h = await setup(`redrive-mixed-${adoptable}`, {
        adoptable,
        maxRequestsPerBatch: 1,
        pendingPolls: 1000,
      });
      await h.execute();
      // batch-2 had ended on its own; batch-1 and batch-3 are cancelled.
      const cancel = h.model.cancel!;
      h.model.cancel = vi.fn(async (ref: EngineBatchRef) =>
        ref.id === "batch-2"
          ? { outcome: "already-terminal" as const }
          : cancel(ref),
      );

      const result = await h.cancel();
      expect(result.batches.map((b) => b.status)).toEqual([
        "cancelled",
        "already-terminal",
        "cancelled",
      ]);
      // Not every batch is confirmed cancelled: no tombstone, row re-opened.
      const row = await h.submitRow();
      expect(row?.result).not.toHaveProperty("engineCancelled");
      expect(row?.status).toBe("running");

      await h.kernel.dispatch({
        type: "run.redrive",
        workflowRunId: h.workflowRunId,
      });
      await h.execute();

      if (adoptable) {
        // Per partition: the live batch is adopted, the cancelled ones replaced.
        expect(h.backend.adopted()).toHaveLength(1);
        expect(h.model.start).toHaveBeenCalledTimes(5);
      } else {
        expect(h.model.start).toHaveBeenCalledTimes(3);
        expect((await h.stage())?.errorMessage).toMatch(
          /cannot be recovered after a worker crash/,
        );
      }
    }
  });
});

describe("a provider cancel whose outcome is unknown", () => {
  it("is completed by the redriven step before it goes on, on every transport, and never adopted", async () => {
    for (const adoptable of [true, false]) {
      const h = await setup(`redrive-unknown-${adoptable}`, {
        adoptable,
        maxRequestsPerBatch: 1,
        pendingPolls: 1000,
      });
      await h.execute();
      const cancel = h.model.cancel!;
      let failing = true;
      h.model.cancel = vi.fn(async (ref: EngineBatchRef) => {
        if (ref.id === "batch-2" && failing) throw new Error("HTTP 503");
        return cancel(ref);
      });
      const result = await h.cancel();
      expect(result.batches.map((b) => b.status)).toEqual([
        "cancelled",
        "failed",
        "cancelled",
      ]);
      expect((await h.submitRow())?.result).toMatchObject({
        cancelIntent: { batchIds: ["batch-2"] },
      });
      await h.kernel.dispatch({
        type: "run.redrive",
        workflowRunId: h.workflowRunId,
      });

      // The provider still fails: the step does not wait on batch-2, which a
      // cancel may have reached; it fails, keeping the intent.
      await h.execute();
      expect((await h.stage())?.errorMessage).toMatch(
        /may have sent a cancel for batch\(es\) "batch-2".*HTTP 503/,
      );
      expect(h.model.start).toHaveBeenCalledTimes(3);
      expect((await h.submitRow())?.result).toMatchObject({
        cancelIntent: { batchIds: ["batch-2"] },
      });

      // Once it answers, the cancel is completed and the three are replaced.
      failing = false;
      await h.execute();
      expect(h.model.start).toHaveBeenCalledTimes(6);
      expect(h.model.adopt).not.toHaveBeenCalled();
      const row = (await h.submitRow())!;
      expect(row.result).toMatchObject({
        generation: 1,
        cancelledBatchIds: ["batch-1", "batch-3", "batch-2"],
      });
      expect(row.result).not.toHaveProperty("cancelIntent");
    }
  });
});

describe("a partial submit on a transport that cannot adopt", () => {
  it("keeps the accepted partitions reachable: the retry refuses, and run.cancel still cancels them", async () => {
    const h = await setup("partial-none", {
      adoptable: false,
      maxRequestsPerBatch: 1,
    });
    // The provider rejects the second partition.
    const start = h.model.start;
    let calls = 0;
    h.model.start = vi.fn(async (...args: Parameters<typeof start>) => {
      calls += 1;
      if (calls === 2) throw new Error("HTTP 503");
      return start(...args);
    }) as typeof start;
    await h.execute();
    expect((await h.stage())?.status).toBe("FAILED");
    expect((await h.submitRow())?.result).toMatchObject({
      partial: true,
      refs: [expect.objectContaining({ id: "batch-1" })],
    });

    // The retry cannot tell whether partition 2 exists: it refuses, as for a
    // crashed submit, but batch 1 is no longer orphaned.
    await h.execute();
    expect((await h.stage())?.errorMessage).toMatch(
      /cannot be recovered after a worker crash/,
    );
    // The refusal leaves the record in place.
    expect((await h.submitRow())?.result).toMatchObject({
      partial: true,
      refs: [expect.objectContaining({ id: "batch-1" })],
    });
    const result = await h.cancel();

    expect(result.batches).toEqual([
      expect.objectContaining({
        stepId: "extract:submit",
        status: "cancelled",
        ref: expect.objectContaining({ id: "batch-1" }),
      }),
    ]);
    expect(h.cancelCalls).toContain("batch-1");
  });
});

/**
 * A failed submit row keeps the submit record the engine reads through the
 * step's failure write, the stage retry and the cancel sweep.
 */
describe("a failed submit row that holds a submit record", () => {
  const dispatchAttempt = (
    h: Awaited<ReturnType<typeof setup>>,
    id: string,
    attempt: number,
  ) =>
    h.kernel.dispatch({
      type: "job.execute",
      workflowRunId: h.workflowRunId,
      workflowId: `wf-${id}`,
      stageId: id,
      config: {},
      attempt,
      maxAttempts: 3,
    });

  /** The provider rejects the second partition of the first submit. */
  async function rejectedSecondPartition(
    id: string,
    opts: SetupOptions = {},
    attempt = 1,
  ) {
    const h = await setup(id, { maxRequestsPerBatch: 1, ...opts });
    const start = h.model.start;
    let calls = 0;
    h.model.start = vi.fn(async (...args: Parameters<typeof start>) => {
      calls += 1;
      if (calls === 2) throw new Error("HTTP 503");
      return start(...args);
    }) as typeof start;
    const first = await dispatchAttempt(h, id, attempt);
    return { h, first };
  }

  it("the stage's job retry resumes after the accepted partitions", async () => {
    const { h, first } = await rejectedSecondPartition("failed-both-retry");

    // A retryable stage failure with attempts left: the stage is retried.
    expect(first).toMatchObject({ outcome: "failed", willRetry: true });
    expect((await h.submitRow())?.status).toBe("failed");
    expect((await h.submitRow())?.result).toMatchObject({
      partial: true,
      refs: [expect.objectContaining({ id: "batch-1" })],
    });

    const second = await dispatchAttempt(h, "failed-both-retry", 2);

    // The retry re-opened the row, found the record, created only the rest
    // (3 requests, one per batch: batch 1 was accepted, 2 and 3 are new).
    expect(second).toMatchObject({ outcome: "suspended" });
    expect(h.backend.byBatch.size).toBe(3);
    const row = await h.submitRow();
    expect(row?.result).toMatchObject({
      refs: [
        expect.objectContaining({ id: "batch-1" }),
        expect.objectContaining({ id: "batch-2" }),
        expect.objectContaining({ id: "batch-3" }),
      ],
    });
    expect(row?.result).not.toHaveProperty("partial");
  });

  describe("on the job's last attempt", () => {
    /** Attempt 3 of 3: no stage retry follows. */
    const finalVerdict = (id: string) => rejectedSecondPartition(id, {}, 3);

    it("no stage retry re-opens the row, and run.cancel still cancels the accepted partition", async () => {
      const { h, first } = await finalVerdict("failed-both-final-cancel");

      // The verdict stands: nothing more is created, the stage fails for good.
      expect(first).toMatchObject({ outcome: "failed", willRetry: false });
      expect(h.backend.byBatch.size).toBe(1);
      const row = await h.submitRow();
      expect(row?.status).toBe("failed");
      expect(row?.result).toMatchObject({ partial: true });

      const result = await h.cancel();

      expect(result.batches).toEqual([
        expect.objectContaining({
          stepId: "extract:submit",
          status: "cancelled",
          ref: expect.objectContaining({ id: "batch-1" }),
        }),
      ]);
    });

    it("a redrive re-opens it, and the step resumes after the accepted partition", async () => {
      const { h } = await finalVerdict("failed-both-final-redrive");
      await h.kernel.dispatch({
        type: "run.transition",
        workflowRunId: h.workflowRunId,
      });
      expect((await h.run())?.status).toBe("FAILED");

      await h.kernel.dispatch({
        type: "run.redrive",
        workflowRunId: h.workflowRunId,
      });
      // The reset keeps what the row holds.
      expect((await h.submitRow())?.result).toMatchObject({ partial: true });
      await h.execute();

      expect(h.backend.byBatch.size).toBe(3);
      expect((await h.submitRow())?.result).toMatchObject({
        refs: [
          expect.objectContaining({ id: "batch-1" }),
          expect.objectContaining({ id: "batch-2" }),
          expect.objectContaining({ id: "batch-3" }),
        ],
      });
    });
  });

  it("a row the sweep holds and releases keeps its record, and the one it writes", async () => {
    const { h } = await rejectedSecondPartition("failed-both-sweep", {
      adoptable: false,
    });
    const before = (await h.submitRow())!;
    expect(before.status).toBe("failed");
    // The provider cannot be reached: the row is held, then released as it was.
    const cancel = h.model.cancel!;
    h.model.cancel = vi.fn(async () => {
      throw new Error("HTTP 503");
    });
    await h.cancel();
    const released = (await h.submitRow())!;
    expect(released.status).toBe("failed");
    expect(released.leaseExpiresAt).toBeNull();
    // The cancel that may have been sent is recorded beside the record.
    expect(released.attempt).toBe(before.attempt + 1);
    expect(released.result).toEqual({
      ...(before.result as object),
      cancelIntent: { batchIds: ["batch-1"], from: "failed" },
    });

    // The next sweep cancels the partition: the tombstone is written beside it.
    h.model.cancel = cancel;
    await h.cancel();
    const finalised = (await h.submitRow())!;
    expect(finalised.status).toBe("failed");
    expect(finalised.result).toMatchObject({
      partial: true,
      engineCancelled: { attempt: finalised.attempt, generation: 1 },
      cancelledBatchIds: ["batch-1"],
    });
    expect(finalised.result).not.toHaveProperty("cancelIntent");
  });

  it("the retry's completed submit replaces the failed attempt's result", async () => {
    const { h } = await rejectedSecondPartition("failed-both-stale");
    const stage = (await h.stage())!;

    // The retry's attempt completes the submit; its result replaces the
    // failed attempt's wholesale.
    await dispatchAttempt(h, "failed-both-stale", 2);

    const row = (await h.ledger.get(stage.id, "extract:submit"))!;
    expect(row.status).toBe("completed");
    expect(row.attempt).toBe(2);
  });

  it("when the provider cannot be asked, the step's failure is retryable (not final), keeps the fence, and the stage's retry resolves it", async () => {
    const h = await setup("failed-both-unaskable", { pendingPolls: 1 });
    await h.execute();
    h.die(true);
    await h.cancel();
    h.die(false);
    await h.tick(5 * 60 * 1000);
    const cancel = h.model.cancel!;
    h.model.cancel = vi.fn(async () => {
      throw new Error("provider unreachable");
    });
    await h.kernel.dispatch({
      type: "run.redrive",
      workflowRunId: h.workflowRunId,
    });

    const first = await dispatchAttempt(h, "failed-both-unaskable", 1);

    // A plain error: the stage classifier says retryable, no `retries` stop,
    // so the stage's job is retried and the step row is re-opened by it.
    expect(first).toMatchObject({ outcome: "failed", willRetry: true });
    const failed = (await h.submitRow())!;
    expect(failed.status).toBe("failed");
    expect(failed.result).toMatchObject({
      cancelFence: { heldFrom: "completed" },
      cancelIntent: { batchIds: ["batch-1"] },
    });

    h.model.cancel = cancel;
    const second = await dispatchAttempt(h, "failed-both-unaskable", 2);

    // The cancel had landed: resolved, replaced.
    expect(second).toMatchObject({ outcome: "completed" });
    const row = await h.submitRow();
    expect(row?.result).toMatchObject({
      handleId: "batch-2",
      generation: 1,
      cancelledBatchIds: ["batch-1"],
    });
    expect(row?.result).not.toHaveProperty("cancelFence");
    expect(row?.result).not.toHaveProperty("cancelIntent");
  });

  describe("a completed row the sweep restores or re-opens", () => {
    /**
     * The step failed while it could not ask the provider (fence kept), then the run was cancelled again: the sweep finds a failed row
     * that was held from `completed`.
     */
    async function failedWhileFenced(id: string) {
      const h = await setup(id, { pendingPolls: 1 });
      await h.execute();
      h.die(true);
      await h.cancel();
      h.die(false);
      await h.tick(5 * 60 * 1000);
      const cancel = h.model.cancel!;
      h.model.cancel = vi.fn(async () => {
        throw new Error("provider unreachable");
      });
      await h.kernel.dispatch({
        type: "run.redrive",
        workflowRunId: h.workflowRunId,
      });
      await dispatchAttempt(h, id, 1);
      expect((await h.submitRow())?.status).toBe("failed");
      h.model.cancel = cancel;
      return h;
    }

    it("goes back to completed without the fence", async () => {
      const h = await failedWhileFenced("failed-both-restore");
      h.model.cancel = vi.fn(async () => ({
        outcome: "already-terminal" as const,
      }));

      await h.cancel();

      const row = await h.submitRow();
      expect(row?.status).toBe("completed");
      expect(row?.result).not.toHaveProperty("cancelFence");
    });

    it("is re-opened for the replacement without the fence", async () => {
      const h = await failedWhileFenced("failed-both-reopen");

      await h.cancel();

      const row = await h.submitRow();
      expect(row?.status).toBe("running");
      expect(row?.result).toMatchObject({
        engineCancelled: { generation: 1 },
      });
      expect(row?.result).not.toHaveProperty("cancelFence");
    });
  });
});

describe("a CANCELLED run does no batch work", () => {
  it("does not poll, collect or submit when its suspended stage is polled", async () => {
    const h = await setup("cancelled-no-poll");
    await h.execute();
    await h.cancel();
    const before = {
      start: vi.mocked(h.model.start).mock.calls.length,
      status: vi.mocked(h.model.status).mock.calls.length,
      results: vi.mocked(h.model.results).mock.calls.length,
    };

    await h.tick(10 * 60 * 1000);
    await h.tick(10 * 60 * 1000);

    expect((await h.stage())?.status).toBe("CANCELLED");
    expect({
      start: vi.mocked(h.model.start).mock.calls.length,
      status: vi.mocked(h.model.status).mock.calls.length,
      results: vi.mocked(h.model.results).mock.calls.length,
    }).toEqual(before);
  });

  it("discards a job of the run instead of executing the stage", async () => {
    const h = await setup("cancelled-no-execute");
    await h.execute();
    await h.cancel();
    const calls = vi.mocked(h.model.start).mock.calls.length;

    const outcome = await h.execute();

    expect(outcome).toMatchObject({ ghost: true, ghostReason: "orphan" });
    expect(vi.mocked(h.model.start).mock.calls.length).toBe(calls);
    expect(vi.mocked(h.model.status).mock.calls.length).toBe(1);
  });

  it("starts no step body, and writes no row, once the stage is told the run was cancelled", async () => {
    const abort = new AbortController();
    const h = await setup("cancelled-no-submit", {
      beforeMap: async (ctx) => {
        // What the host's heartbeat does once it sees the run CANCELLED.
        abort.abort(new StageAbortedError("cancelled", ctx.workflowRunId));
      },
    });

    await h.kernel.dispatch({
      type: "job.execute",
      workflowRunId: h.workflowRunId,
      workflowId: `wf-cancelled-no-submit`,
      stageId: "cancelled-no-submit",
      config: {},
      abortSignal: abort.signal,
    });

    expect(h.model.start).not.toHaveBeenCalled();
    // A failed row would be counted as an attempt by a redrive.
    expect(await h.ledger.list((await h.stage())!.id)).toEqual([]);
  });

  it("collects nothing when the cancel lands between the poll and the collect", async () => {
    const abort = new AbortController();
    const h = await setup("cancelled-no-collect");
    vi.mocked(h.model.status).mockImplementation(async () => {
      abort.abort(new StageAbortedError("cancelled", h.workflowRunId));
      return { status: "completed" as const };
    });

    await h.kernel.dispatch({
      type: "job.execute",
      workflowRunId: h.workflowRunId,
      workflowId: `wf-cancelled-no-collect`,
      stageId: "cancelled-no-collect",
      config: {},
      abortSignal: abort.signal,
    });

    expect(h.model.start).toHaveBeenCalledTimes(1);
    expect(h.model.results).not.toHaveBeenCalled();
    expect(
      await h.ledger.get((await h.stage())!.id, "extract:collect"),
    ).toBeNull();
  });

  it("cancels a batch whose submit was in flight when the run was cancelled, and records it as cancelled", async () => {
    const abort = new AbortController();
    const h = await setup("cancelled-in-flight");
    const start = h.model.start;
    h.model.start = vi.fn(async (...args: Parameters<typeof start>) => {
      const created = await start(...args);
      // The cancel arrives after the provider took the batch and before the
      // ledger recorded it: the sweep finds nothing, and the signal fires.
      const swept = await h.cancel();
      // Its submit step is executing and holds no handle: reported, not found.
      expect(swept.batches).toEqual([
        expect.objectContaining({
          stepId: "extract:submit",
          status: "unrecorded",
          externalKey: expect.stringMatching(/^wfe-/),
        }),
      ]);
      abort.abort(new StageAbortedError("cancelled", h.workflowRunId));
      return created;
    }) as typeof start;

    await h.kernel.dispatch({
      type: "job.execute",
      workflowRunId: h.workflowRunId,
      workflowId: `wf-cancelled-in-flight`,
      stageId: "cancelled-in-flight",
      config: {},
      abortSignal: abort.signal,
    });

    expect(h.cancelCalls).toContain("batch-1");
    // The failed row keeps the record, with the tombstone, so a redrive
    // replaces the batch on any transport.
    const row = await h.submitRow();
    expect(row?.status).toBe("failed");
    expect(row?.result).toMatchObject({
      handleId: "batch-1",
      engineCancelled: { attempt: row?.attempt, generation: 1 },
    });
  });
});

/**
 * A stage body in another process can create a batch after `run.cancel` read
 * the ledger, because its abort signal had not fired yet. Wherever a handler
 * that ran such a body then finds its run CANCELLED, it sweeps the run's
 * batches after its commit: the four `ghost` exits of `job.execute` that follow
 * a body, and both CANCELLED branches of `handleClaimOutcome`, which every
 * `stage.pollSuspended` replay ends in. Each case below submits after the
 * cancel committed (the cancel's own sweep finds nothing, or is not run) and
 * must still end with the batch cancelled.
 */
describe("a body that submits after the cancel committed", () => {
  /** Cancel the run (its sweep finds nothing: the row is not written yet) as the batch is created. */
  function cancelWhileSubmitting(
    h: Awaited<ReturnType<typeof setup>>,
    submitStep = "extract:submit",
  ) {
    const start = h.model.start;
    h.model.start = vi.fn(async (...args: Parameters<typeof start>) => {
      const swept = await h.cancel();
      // The step being submitted is executing and holds no handle yet: it is
      // reported as unrecorded, and its batch is not found.
      expect(swept.batches.filter((b) => b.stepId === submitStep)).toEqual([
        expect.objectContaining({ status: "unrecorded" }),
      ]);
      return start(...args);
    }) as typeof start;
  }

  /**
   * The run turns CANCELLED (by a cancel whose own sweep did nothing) after
   * the status re-check that follows the body and before the stage's Phase 3
   * transaction, so only the claim sees it. The poll arms it: it is the last
   * thing the body does before the re-check.
   */
  function cancelBeforePhase3(h: Awaited<ReturnType<typeof setup>>) {
    const real = h.persistence.getRunStatus.bind(h.persistence);
    const status = h.model.status;
    let armed = false;
    h.model.status = vi.fn(async (...args: Parameters<typeof status>) => {
      armed = true;
      return status(...args);
    }) as typeof status;
    h.persistence.getRunStatus = async (id) => {
      const current = await real(id);
      if (armed && current === "RUNNING") {
        armed = false;
        await h.persistence.updateRun(id, { status: "CANCELLED" });
      }
      return current;
    };
  }

  it("job.execute, a body that throws after the submit (Phase 3b claim)", async () => {
    const h = await setup("late-body-error");
    cancelWhileSubmitting(h);
    vi.mocked(h.model.status).mockResolvedValue({
      status: "failed" as const,
      error: "provider failed",
    });

    const outcome = await h.execute();

    expect(outcome).toMatchObject({ ghost: true, ghostReason: "orphan" });
    expect(h.cancelCalls).toEqual(["batch-1"]);
  });

  it("job.execute, a body that suspends after the submit (status re-check)", async () => {
    const h = await setup("late-recheck");
    cancelWhileSubmitting(h);

    const outcome = await h.execute();

    expect(outcome).toMatchObject({ ghost: true, ghostReason: "orphan" });
    expect(h.cancelCalls).toEqual(["batch-1"]);
    const row = await h.submitRow();
    expect(row?.result).toMatchObject({
      engineCancelled: { attempt: row?.attempt, generation: 1 },
    });
  });

  it("job.execute, a suspension committed after the re-check (Phase 3a claim)", async () => {
    const h = await setup("late-suspend-claim");
    cancelBeforePhase3(h);

    const outcome = await h.execute();

    expect(outcome).toMatchObject({ ghost: true, ghostReason: "orphan" });
    expect(h.cancelCalls).toEqual(["batch-1"]);
  });

  it("job.execute, a completion whose fenced commit finds the run CANCELLED (completion claim)", async () => {
    const h = await setup("late-complete-claim", { pendingPolls: 0 });
    // No status re-check precedes a completion: the run turns CANCELLED just
    // before the commit's transaction, armed by the body's last poll.
    const status = h.model.status;
    let armed = false;
    h.model.status = vi.fn(async (...args: Parameters<typeof status>) => {
      armed = true;
      return status(...args);
    }) as typeof status;
    const withTransaction = h.persistence.withTransaction.bind(h.persistence);
    h.persistence.withTransaction = (async (fn) => {
      if (armed) {
        armed = false;
        await h.persistence.updateRun(h.workflowRunId, { status: "CANCELLED" });
      }
      return withTransaction(fn);
    }) as typeof withTransaction;

    const outcome = await h.execute();

    expect(outcome).toMatchObject({ ghost: true, ghostReason: "orphan" });
    expect(h.cancelCalls).toEqual(["batch-1"]);
  });

  it("stage.pollSuspended, a replay whose second map submits (handleClaimOutcome)", async () => {
    const h = await setup("late-replay", { secondMap: true });
    // First map: pending on the first poll, completed on the next. Second: never.
    let firstPolls = 0;
    vi.mocked(h.model.status).mockImplementation(async (ref) => {
      if (ref.id === "batch-1") {
        firstPolls += 1;
        return {
          status:
            firstPolls > 1 ? ("completed" as const) : ("pending" as const),
        };
      }
      return { status: "pending" as const };
    });
    await h.execute();
    expect((await h.stage())?.status).toBe("SUSPENDED");
    // The replay creates the second batch; the cancel commits as it does.
    cancelWhileSubmitting(h, "second:submit");

    await h.tick(2 * 60 * 1000);

    expect((await h.run())?.status).toBe("CANCELLED");
    expect(h.cancelCalls).toContain("batch-2");
    expect((await h.stage())?.status).toBe("CANCELLED");
  });

  it("stage.pollSuspended, a replay whose stage the cancel moved, under a stale run-status read", async () => {
    const h = await setup("late-replay-stale", { secondMap: true });
    let firstPolls = 0;
    const status = vi.mocked(h.model.status);
    status.mockImplementation(async (ref) => {
      if (ref.id === "batch-1") {
        firstPolls += 1;
        return {
          status:
            firstPolls > 1 ? ("completed" as const) : ("pending" as const),
        };
      }
      return { status: "pending" as const };
    });
    await h.execute();
    cancelWhileSubmitting(h, "second:submit");
    // A run-status read after the body is stale (RUNNING): the cancelled
    // stage row is what says the run was cancelled.
    const real = h.persistence.getRunStatus.bind(h.persistence);
    let armed = false;
    status.mockImplementation(async (ref) => {
      if (ref.id === "batch-2") armed = true;
      return ref.id === "batch-1"
        ? { status: "completed" as const }
        : { status: "pending" as const };
    });
    h.persistence.getRunStatus = async (id) => {
      const current = await real(id);
      if (armed && current === "CANCELLED") {
        armed = false;
        return "RUNNING";
      }
      return current;
    };

    await h.tick(2 * 60 * 1000);

    expect((await h.stage())?.status).toBe("CANCELLED");
    expect(h.cancelCalls).toContain("batch-2");
  });

  it("does not touch the batches when the discarded run is FAILED, not CANCELLED", async () => {
    const h = await setup("late-failed-run");
    const start = h.model.start;
    h.model.start = vi.fn(async (...args: Parameters<typeof start>) => {
      await h.persistence.updateRun(h.workflowRunId, { status: "FAILED" });
      return start(...args);
    }) as typeof start;

    const outcome = await h.execute();

    expect(outcome).toMatchObject({ ghost: true, ghostReason: "orphan" });
    expect(h.cancelCalls).toEqual([]);
  });
});

/**
 * A sweep that stops between taking hold of a submit row and its last write:
 * the process dies during the provider calls (a serverless limit is shorter
 * than the sweep budget), or the final write and the release both fail. The row
 * stays `running`, leased, with its fence, and nothing else records that it was
 * a completed step or what the provider did. Once the lease expires, every
 * reader of the row (the next sweep, the ledger reset, the submit step's own
 * re-execution) must resolve the fence, not treat the row as an ordinary reclaim.
 */
describe("a cancel sweep that was interrupted", () => {
  const LEASE_PAST = 5 * 60 * 1000;

  /** Sweep dies after its provider calls; the lease then expires. */
  async function interrupted(
    id: string,
    opts: SetupOptions = {},
    /** What the provider answers to the dying sweep (and to a repeat). */
    answer?: (h: Awaited<ReturnType<typeof setup>>) => void,
  ) {
    const h = await setup(id, { pendingPolls: 1, ...opts });
    await h.execute();
    expect((await h.stage())?.status).toBe("SUSPENDED");
    answer?.(h);
    h.die(true);
    await h.cancel();
    h.die(false);
    const held = await h.submitRow();
    // The state a dead process leaves: running, leased, fenced.
    expect(held?.status).toBe("running");
    expect(held?.leaseExpiresAt).not.toBeNull();
    expect(held?.result).toHaveProperty("cancelFence");
    await h.tick(LEASE_PAST);
    return h;
  }

  /** Redrive the run and drive it to the end. */
  async function redriveToCompletion(h: Awaited<ReturnType<typeof setup>>) {
    await h.kernel.dispatch({
      type: "run.redrive",
      workflowRunId: h.workflowRunId,
    });
    const outcome = await h.execute();
    await h.kernel.dispatch({
      type: "run.transition",
      workflowRunId: h.workflowRunId,
    });
    return outcome;
  }

  describe.each([
    ["a transport that can adopt", true],
    ["a transport that cannot adopt", false],
  ])("on %s", (_name, adoptable) => {
    it("(a) a repeated run.cancel that finds the batch ended restores the row, and a redrive completes from the stored record", async () => {
      const h = await interrupted(
        `interrupted-ended-${adoptable}`,
        { adoptable },
        (provider) => {
          // The batch finished before the cancel: nothing to cancel.
          provider.model.cancel = vi.fn(async () => ({
            outcome: "already-terminal" as const,
          }));
        },
      );

      const again = await h.cancel();
      expect(again.batches.map((b) => b.status)).toEqual(["already-terminal"]);
      const row = await h.submitRow();
      expect(row?.status).toBe("completed");
      expect(row?.leaseExpiresAt).toBeNull();
      expect(row?.result).not.toHaveProperty("cancelFence");
      expect(row?.result).not.toHaveProperty("engineCancelled");

      const outcome = await redriveToCompletion(h);

      // The batch has results: the stage collects from the recorded handle.
      expect(outcome).toMatchObject({ outcome: "completed" });
      expect(h.model.start).toHaveBeenCalledTimes(1);
      expect(h.model.adopt).not.toHaveBeenCalled();
      expect((await h.run())?.status).toBe("COMPLETED");
    });

    it("(b) a redrive with no repeated cancel resolves the fence: nothing was sent, so the run continues on the recorded batch", async () => {
      const h = await interrupted(
        `interrupted-unsent-${adoptable}`,
        { adoptable },
        (provider) => {
          // No transport in the dying process: no request left it.
          provider.setResolver(() => undefined);
        },
      );
      expect((await h.submitRow())?.result).not.toHaveProperty("cancelIntent");

      const outcome = await redriveToCompletion(h);

      expect(outcome).toMatchObject({ outcome: "completed" });
      expect(h.model.start).toHaveBeenCalledTimes(1);
      expect(h.model.adopt).not.toHaveBeenCalled();
      const row = await h.submitRow();
      expect(row?.result).not.toHaveProperty("cancelFence");
      expect(row?.result).toMatchObject({ handleId: "batch-1" });
      expect((await h.run())?.status).toBe("COMPLETED");
    });

    it("(c) a redrive after a cancel that landed before the process died replaces the batch, and never re-adopts it", async () => {
      const h = await interrupted(`interrupted-landed-${adoptable}`, {
        adoptable,
        // Gemini keeps listing the batch as running until the cancel lands.
        listsCancelledAsRunning: true,
      });
      // The cancel reached the provider before the process died.
      expect(h.cancelCalls).toEqual(["batch-1"]);

      const outcome = await redriveToCompletion(h);

      expect(outcome).toMatchObject({ outcome: "completed" });
      expect(h.model.start).toHaveBeenCalledTimes(2);
      const row = await h.submitRow();
      expect(row?.result).toMatchObject({
        handleId: "batch-2",
        generation: 1,
        cancelledBatchIds: ["batch-1"],
      });
      expect(row?.result).not.toHaveProperty("cancelFence");
      expect(h.backend.adopted()).toEqual([]);
      expect((await h.run())?.status).toBe("COMPLETED");
    });
  });

  it("when the process died with one cancel outcome unknown, a redrive completes it and replaces every batch, adopting none", async () => {
    const h = await setup("interrupted-mixed", {
      maxRequestsPerBatch: 1,
      pendingPolls: 1000,
    });
    await h.execute();
    // Batch 2 cannot be cancelled, batches 1 and 3 are; then the process dies.
    const cancel = h.model.cancel!;
    h.model.cancel = vi.fn(async (ref: EngineBatchRef) => {
      if (ref.id === "batch-2") throw new Error("HTTP 503");
      return cancel(ref);
    });
    h.die(true);
    await h.cancel();
    h.die(false);
    await h.tick(LEASE_PAST);
    h.model.cancel = cancel;

    await h.kernel.dispatch({
      type: "run.redrive",
      workflowRunId: h.workflowRunId,
    });
    await h.execute();

    // 1 and 3 were cancelled, the request for 2 may have been: it is sent
    // again (cancelled now), and all three are replaced with no search.
    expect(h.backend.adopted()).toHaveLength(0);
    expect(h.model.start).toHaveBeenCalledTimes(6);
    expect((await h.submitRow())?.result).toMatchObject({
      generation: 1,
      cancelledBatchIds: expect.arrayContaining([
        "batch-1",
        "batch-2",
        "batch-3",
      ]),
    });
  });

  it("does not guess when the cancel cannot be completed: the step fails with a WARN and keeps the fence, and a later attempt completes it", async () => {
    const h = await interrupted("interrupted-unaskable");
    const cancel = h.model.cancel!;
    h.model.cancel = vi.fn(async () => {
      throw new Error("provider unreachable");
    });
    await h.kernel.dispatch({
      type: "run.redrive",
      workflowRunId: h.workflowRunId,
    });

    await h.execute();

    expect((await h.stage())?.errorMessage).toMatch(
      /completing the cancel failed \(provider unreachable\)/,
    );
    expect(h.model.start).toHaveBeenCalledTimes(1);
    expect(h.model.adopt).not.toHaveBeenCalled();
    // The fence is kept: nothing was decided.
    expect((await h.submitRow())?.result).toHaveProperty("cancelFence");
    expect(
      h.persistence
        .getAllLogs()
        .some(
          (l) =>
            l.level === "WARN" &&
            /completing the cancel failed/.test(l.message),
        ),
    ).toBe(true);

    // The provider is reachable on the next attempt (a job retry): the
    // cancel is completed and the step is replaced, once.
    h.model.cancel = cancel;
    const outcome = await h.execute();
    await h.kernel.dispatch({
      type: "run.transition",
      workflowRunId: h.workflowRunId,
    });
    expect(outcome).toMatchObject({ outcome: "completed" });
    expect(h.model.start).toHaveBeenCalledTimes(2);
    expect((await h.submitRow())?.result).toMatchObject({
      handleId: "batch-2",
      generation: 1,
      cancelledBatchIds: ["batch-1"],
    });
    expect((await h.run())?.status).toBe("COMPLETED");
  });

  it("the ledger reset leaves the fence for the step to resolve", async () => {
    const h = await interrupted("interrupted-reset");
    const held = (await h.submitRow())!;
    await h.kernel.dispatch({
      type: "run.redrive",
      workflowRunId: h.workflowRunId,
    });

    const row = await h.submitRow();

    // Kept, still fenced, still carrying what it was held from, and its lease
    // untouched (expired, not cleared as for an ordinary reclaim): the
    // redriven stage resolves it against the provider.
    expect(row?.status).toBe("running");
    expect(row?.leaseExpiresAt).toEqual(held.leaseExpiresAt);
    expect(row?.result).toMatchObject({
      cancelFence: { heldFrom: "completed" },
    });
  });

  it("records what it resolved before it creates anything, so a crash after the replacement was created does not create another", async () => {
    const h = await interrupted("interrupted-crash-after");
    await h.kernel.dispatch({
      type: "run.redrive",
      workflowRunId: h.workflowRunId,
    });
    // The cancel had landed: the step is replaced. The process dies after the
    // provider accepted the replacement and before the ledger recorded it.
    const start = h.model.start;
    let calls = 0;
    h.model.start = vi.fn(async (...args: Parameters<typeof start>) => {
      const created = await start(...args);
      calls += 1;
      if (calls === 1) throw new Error("the process died");
      return created;
    }) as typeof start;
    await h.execute();
    expect((await h.stage())?.status).toBe("FAILED");

    // The retry searches for the step's key (excluding the cancelled batch)
    // and finds the replacement: no third batch.
    await h.execute();

    expect(h.backend.byBatch.size).toBe(2);
    expect(h.backend.adopted()).toHaveLength(1);
    expect((await h.submitRow())?.result).toMatchObject({
      handleId: "batch-2",
      cancelledBatchIds: ["batch-1"],
    });
  });

  // The ledger state after a repeated run.cancel does not depend on whether
  // the first sweep was interrupted.
  describe.each([
    [
      "cancelled",
      (h: Awaited<ReturnType<typeof setup>>) => {
        void h;
      },
    ],
    [
      "already-terminal",
      (h: Awaited<ReturnType<typeof setup>>) => {
        h.model.cancel = vi.fn(async () => ({
          outcome: "already-terminal" as const,
        }));
      },
    ],
    [
      "failed",
      (h: Awaited<ReturnType<typeof setup>>) => {
        h.model.cancel = vi.fn(async () => {
          throw new Error("HTTP 503");
        });
      },
    ],
    [
      "unavailable",
      (h: Awaited<ReturnType<typeof setup>>) => {
        h.setResolver(() => undefined);
      },
    ],
  ])("when every provider answer is %s", (outcomeName, answer) => {
    it("ends in the ledger state an uninterrupted sweep reaches", async () => {
      const finalRow = async (interrupt: boolean) => {
        const h = await setup(`interrupted-same-${outcomeName}-${interrupt}`, {
          pendingPolls: 1,
        });
        await h.execute();
        answer(h);
        if (interrupt) h.die(true);
        await h.cancel();
        h.die(false);
        await h.tick(LEASE_PAST);
        const again = await h.cancel();
        const row = (await h.submitRow())!;
        // The key and the wall-clock stamp differ between two runs.
        const {
          externalKey: _key,
          submittedAt: _at,
          ...result
        } = row.result as Record<string, unknown>;
        return {
          statuses: again.batches.map((b) => b.status),
          status: row.status,
          attempt: row.attempt,
          lease: row.leaseExpiresAt,
          error: row.error,
          result,
        };
      };

      const control = await finalRow(false);
      const afterDeath = await finalRow(true);

      expect(afterDeath).toEqual(control);
      expect(afterDeath.statuses).toEqual([outcomeName]);
      expect(afterDeath.result).not.toHaveProperty("cancelFence");
    });
  });
});

describe("batchRefsOfSubmitRow", () => {
  const stored = {
    handleId: "b1",
    refs: [REF],
    requestIds: ["a"],
    totalRequests: 1,
  };
  const row = (over: object) => ({
    kind: "run" as const,
    stepId: "extract:submit",
    result: stored as unknown,
    ...over,
  });

  it("takes a run row that is named :submit and holds a stored submit", () => {
    expect(batchRefsOfSubmitRow(row({}))).toEqual([REF]);
  });

  it("ignores rows that only look like one", () => {
    expect(batchRefsOfSubmitRow(row({ stepId: "extract:poll" }))).toEqual([]);
    expect(batchRefsOfSubmitRow(row({ kind: "wait" }))).toEqual([]);
    expect(batchRefsOfSubmitRow(row({ result: { id: "b1" } }))).toEqual([]);
    expect(batchRefsOfSubmitRow(row({ result: null }))).toEqual([]);
    expect(
      batchRefsOfSubmitRow(
        row({ result: { ...stored, refs: [{ ...REF, version: 2 }] } }),
      ),
    ).toEqual([]);
  });
});

/**
 * A failed submit row that a sweep held and released, then the writers of
 * the retry path: the redrive's ledger reset, the stage retry's
 * `reopenFailedSteps` (on the job path and the poll path) and the replay's
 * reclaim. None of them may misread what the sweep left.
 */
describe("a failed submit row a sweep held and released, then a retry or a redrive", () => {
  const attemptOf = (
    h: Awaited<ReturnType<typeof setup>>,
    id: string,
    attempt: number,
  ) =>
    h.kernel.dispatch({
      type: "job.execute",
      workflowRunId: h.workflowRunId,
      workflowId: `wf-${id}`,
      stageId: id,
      config: {},
      attempt,
      maxAttempts: 3,
    });

  /**
   * The second partition is rejected, so the row is failed with the accepted
   * partition recorded. The run is then cancelled
   * and the sweep's cancel of that partition fails, so the row is released
   * failed, with the cancel intent; then the run is redriven.
   */
  async function heldReleasedRedriven(id: string, opts: SetupOptions = {}) {
    const h = await setup(id, { maxRequestsPerBatch: 1, ...opts });
    const start = h.model.start;
    let starts = 0;
    let rejectSecond = true;
    h.model.start = vi.fn(async (...args: Parameters<typeof start>) => {
      starts += 1;
      if (rejectSecond && starts === 2) throw new Error("HTTP 503");
      return start(...args);
    }) as typeof start;
    if (opts.sleepFirst) {
      await h.execute();
      await h.tick(1_000);
    } else {
      await attemptOf(h, id, 1);
    }
    rejectSecond = false;
    // On the poll path the stage retry has already re-opened the row.
    const base = opts.sleepFirst ? "running" : "failed";
    expect((await h.submitRow())?.status).toBe(base);
    const cancel = h.model.cancel!;
    let cancelFails = true;
    h.model.cancel = vi.fn(async (ref: EngineBatchRef) => {
      if (cancelFails) throw new Error("HTTP 503");
      return cancel(ref);
    });
    await h.cancel();
    const released = (await h.submitRow())!;
    expect(released).toMatchObject({ status: base, leaseExpiresAt: null });
    expect(released.result).toMatchObject({
      partial: true,
      cancelIntent: { batchIds: ["batch-1"], from: base },
    });
    await h.kernel.dispatch({
      type: "run.redrive",
      workflowRunId: h.workflowRunId,
    });
    // The reset re-opens it as a known failure (its error kept).
    const reopened = (await h.submitRow())!;
    expect(reopened).toMatchObject({ status: "running", leaseExpiresAt: null });
    expect(reopened.error).not.toBeNull();
    return {
      h,
      reopened,
      providerRecovers: () => {
        cancelFails = false;
      },
    };
  }

  const expectReplaced = async (h: Awaited<ReturnType<typeof setup>>) => {
    const row = (await h.submitRow())!;
    expect(row.result).toMatchObject({
      generation: 1,
      cancelledBatchIds: ["batch-1"],
      refs: [
        expect.objectContaining({ id: "batch-2" }),
        expect.objectContaining({ id: "batch-3" }),
        expect.objectContaining({ id: "batch-4" }),
      ],
    });
    for (const key of ["partial", "cancelIntent", "cancelFence"]) {
      expect(row.result).not.toHaveProperty(key);
    }
    expect((await h.stage())?.status).toBe("SUSPENDED");
  };

  it("a redrive replaces the partition once the provider answers", async () => {
    const { h, providerRecovers } = await heldReleasedRedriven("held-redrive");
    providerRecovers();
    await attemptOf(h, "held-redrive", 1);
    await expectReplaced(h);
  });

  it("the job path's stage retry re-opens the row the redriven step failed, and completes the cancel", async () => {
    const { h, providerRecovers } = await heldReleasedRedriven("held-job");
    const first = await attemptOf(h, "held-job", 1);
    expect(first).toMatchObject({ outcome: "failed", willRetry: true });
    const failed = (await h.submitRow())!;
    expect(failed.status).toBe("failed");
    expect(failed.result).toMatchObject({
      cancelIntent: { batchIds: ["batch-1"] },
    });
    providerRecovers();
    await attemptOf(h, "held-job", 2);
    await expectReplaced(h);
  });

  it("the poll path's stage retry re-opens the row the redriven step failed, and completes the cancel", async () => {
    let pause = "pause";
    const { h, providerRecovers } = await heldReleasedRedriven("held-poll", {
      sleepFirst: () => pause,
    });
    pause = "pause-after-redrive";
    await h.execute();
    expect((await h.stage())?.status).toBe("SUSPENDED");
    await h.tick(1_000);
    const failed = (await h.submitRow())!;
    expect(failed).toMatchObject({ status: "running", leaseExpiresAt: null });
    expect(failed.error).not.toBeNull();
    expect(failed.result).toMatchObject({
      cancelIntent: { batchIds: ["batch-1"] },
    });
    providerRecovers();
    await h.tick(60_000);
    await expectReplaced(h);
  });
});
