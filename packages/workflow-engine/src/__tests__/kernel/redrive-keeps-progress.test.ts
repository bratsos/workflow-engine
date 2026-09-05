/**
 * Resuming a run keeps the progress the resumed stage made.
 *
 * `run.redrive` used to delete the stage record it resumed from and
 * recreate it, so a stage that had completed 9 of 10 durable steps re-ran
 * all 10, and - because a step's external key is derived from the stage
 * record id - every provider-side idempotency key rotated with it. For
 * `lastFailure` and `stage` the record is now reopened in place: completed
 * step rows stay and are answered from the ledger, the record id (and so
 * every external key) is unchanged, and only the stages after the resumed
 * one are still replaced.
 */

import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineStage } from "../../core/stage-factory.js";
import { defineWorkflow } from "../../core/workflow.js";
import { SUPERSEDED_ATTEMPT_KEY } from "../../kernel/handlers/run-redrive.js";
import { InMemoryStepLedger } from "../../testing/in-memory-step-ledger.js";
import { createTestKernel } from "../utils/index.js";

const schemas = {
  input: z.object({}),
  output: z.object({ ok: z.boolean() }),
  config: z.object({}),
};

/** A stage whose second step fails until told otherwise. */
function twoStepStage(
  id: string,
  counters: { first: number; second: number },
  fail: { yes: boolean },
  seen: { externalKey?: string } = {},
) {
  return defineStage({
    id,
    name: `Stage ${id}`,
    schemas,
    async execute(ctx) {
      await ctx.step.run("first", async (step) => {
        counters.first += 1;
        seen.externalKey = step.externalKey;
        return "done";
      });
      await ctx.step.run("second", async () => {
        counters.second += 1;
        if (fail.yes) throw new Error("second step blew up");
        return "done";
      });
      return { output: { ok: true } };
    },
  });
}

function passing(id: string) {
  return defineStage({
    id,
    name: `Stage ${id}`,
    schemas,
    async execute(ctx) {
      await ctx.step.run("work", async () => "done");
      return { output: { ok: true } };
    },
  });
}

async function execute(
  kernel: ReturnType<typeof createTestKernel>["kernel"],
  workflowRunId: string,
  workflowId: string,
  stageId: string,
) {
  const result = await kernel.dispatch({
    type: "job.execute",
    workflowRunId,
    workflowId,
    stageId,
    config: {},
  });
  await kernel.dispatch({ type: "run.transition", workflowRunId });
  return result;
}

describe("run.redrive keeps durable step progress", () => {
  it("keeps completed step rows on a lastFailure redrive, so a completed step's body does not run again", async () => {
    const ledger = new InMemoryStepLedger();
    const counters = { first: 0, second: 0 };
    const fail = { yes: true };
    const workflow = defineWorkflow("redrive-keeps-steps", {
      input: z.object({}),
    })
      .pipe(twoStepStage("work", counters, fail))
      .build();
    const { kernel, persistence } = createTestKernel([workflow], {
      stepLedger: ledger,
    });

    const created = await kernel.dispatch({
      type: "run.create",
      idempotencyKey: "k1",
      workflowId: workflow.id,
      input: {},
    });
    const runId = created.workflowRunId;
    await kernel.dispatch({ type: "run.claimPending", workerId: "w1" });
    await execute(kernel, runId, workflow.id, "work");
    expect((await persistence.getRun(runId))?.status).toBe("FAILED");
    const before = await persistence.getStage(runId, "work");
    expect(before?.status).toBe("FAILED");
    expect(counters).toEqual({ first: 1, second: 1 });

    fail.yes = false;
    const result = await kernel.dispatch({
      type: "run.redrive",
      workflowRunId: runId,
      from: { kind: "lastFailure" },
    });
    expect(result.supersededStages).toEqual(["work"]);

    // The record was reopened in place: same row, next attempt, no
    // outcome left over from the attempt that failed.
    const reopened = await persistence.getStage(runId, "work");
    expect(reopened?.id).toBe(before?.id);
    expect(reopened).toMatchObject({
      status: "PENDING",
      attempt: 1,
      errorMessage: null,
      completedAt: null,
      duration: null,
      outputData: null,
    });
    expect(reopened?.version).toBeGreaterThan(before!.version);

    // The completed row survived; the failed one was dropped and will be
    // executed fresh.
    expect(await ledger.get(before!.id, "first")).toMatchObject({
      status: "completed",
      result: "done",
    });
    expect(await ledger.get(before!.id, "second")).toMatchObject({
      status: "running",
      leaseExpiresAt: null,
    });

    await execute(kernel, runId, workflow.id, "work");
    expect((await persistence.getRun(runId))?.status).toBe("COMPLETED");
    // `first` was answered from the ledger; only `second` ran again.
    expect(counters).toEqual({ first: 1, second: 2 });

    // The superseded attempt is still on the record, marked as reopened,
    // and nothing that named an external effect was abandoned.
    const archived = await kernel.annotations.list(runId, {
      key: SUPERSEDED_ATTEMPT_KEY,
    });
    expect(archived).toHaveLength(1);
    expect(archived[0].payload).toMatchObject({
      reopened: true,
      status: "FAILED",
      attempt: 0,
    });
    expect(
      (archived[0].payload as Record<string, unknown>).abandonedSteps,
    ).toBeUndefined();
    expect(
      persistence.getAllLogs().filter((log) => log.level === "WARN"),
    ).toHaveLength(0);
  });

  it("leaves a kept step's external key unchanged across the redrive", async () => {
    const ledger = new InMemoryStepLedger();
    const counters = { first: 0, second: 0 };
    const fail = { yes: true };
    const seen: { externalKey?: string } = {};
    const workflow = defineWorkflow("redrive-keeps-key", {
      input: z.object({}),
    })
      .pipe(twoStepStage("work", counters, fail, seen))
      .build();
    const { kernel, persistence } = createTestKernel([workflow], {
      stepLedger: ledger,
    });

    const created = await kernel.dispatch({
      type: "run.create",
      idempotencyKey: "k1",
      workflowId: workflow.id,
      input: {},
    });
    const runId = created.workflowRunId;
    await kernel.dispatch({ type: "run.claimPending", workerId: "w1" });
    await execute(kernel, runId, workflow.id, "work");
    const before = await persistence.getStage(runId, "work");
    const rowBefore = (await ledger.get(before!.id, "first"))!;
    const keyBefore = rowBefore.externalKey;
    expect(keyBefore).toBe(seen.externalKey);

    fail.yes = false;
    await kernel.dispatch({ type: "run.redrive", workflowRunId: runId });
    await execute(kernel, runId, workflow.id, "work");
    expect((await persistence.getRun(runId))?.status).toBe("COMPLETED");

    // Same row, same key: a provider deduping on it still recognises the
    // effect the first attempt made.
    const after = await ledger.get(before!.id, "first");
    expect(after?.externalKey).toBe(keyBefore);
    expect(after?.createdAt).toEqual(rowBefore.createdAt);
  });

  it("still replaces the stages after the resumed one", async () => {
    const ledger = new InMemoryStepLedger();
    const workflow = defineWorkflow("redrive-later-stages", {
      input: z.object({}),
    })
      .pipe(passing("a"))
      .pipe(passing("b"))
      .pipe(passing("c"))
      .build();
    const { kernel, persistence } = createTestKernel([workflow], {
      stepLedger: ledger,
    });

    const created = await kernel.dispatch({
      type: "run.create",
      idempotencyKey: "k1",
      workflowId: workflow.id,
      input: {},
    });
    const runId = created.workflowRunId;
    await kernel.dispatch({ type: "run.claimPending", workerId: "w1" });
    for (const stageId of ["a", "b", "c"]) {
      await execute(kernel, runId, workflow.id, stageId);
    }
    expect((await persistence.getRun(runId))?.status).toBe("COMPLETED");
    const b = await persistence.getStage(runId, "b");
    const c = await persistence.getStage(runId, "c");

    const result = await kernel.dispatch({
      type: "run.redrive",
      workflowRunId: runId,
      from: { kind: "stage", stageId: "b" },
    });
    expect(result.supersededStages.sort()).toEqual(["b", "c"]);

    // "b" was reopened with its ledger; "c" and its ledger are gone,
    // archived as a deleted attempt.
    expect((await persistence.getStage(runId, "b"))?.id).toBe(b?.id);
    expect(await ledger.list(b!.id)).toHaveLength(1);
    expect(await persistence.getStage(runId, "c")).toBeNull();
    expect(await ledger.list(c!.id)).toHaveLength(0);
    const archived = await kernel.annotations.list(runId, {
      key: SUPERSEDED_ATTEMPT_KEY,
    });
    expect(
      archived.map((a) => [a.scopeId, (a.payload as any).reopened]).sort(),
    ).toEqual([
      ["b", true],
      ["c", false],
    ]);

    // "a" was never touched.
    expect((await persistence.getStage(runId, "a"))?.attempt).toBe(0);
  });
});
