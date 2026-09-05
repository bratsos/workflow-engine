/**
 * Re-running a terminally failed stage must not destroy a live external
 * effect.
 *
 * `job.execute` used to clear a FAILED stage's whole step ledger so the new
 * attempt would start clean. That also deleted the row holding an in-flight
 * batch's handle and — since 1.0.0-alpha.9 — its external key, so a stage
 * that failed terminally while a batch was still being processed and still
 * being billed lost the only record of it. Nobody could find it afterwards.
 *
 * The clean start is now reached by re-opening those rows instead of
 * deleting them: the body runs again exactly as a deleted row would have
 * made it, but it is told `isReclaim`, so a body that names its effect
 * re-adopts the one that already exists rather than creating a second.
 */

import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineStage } from "../../core/stage-factory.js";
import { WorkflowBuilder } from "../../core/workflow.js";
import { InMemoryStepLedger } from "../../testing/in-memory-step-ledger.js";
import { createTestKernel } from "../utils/index.js";

const outputSchema = z.object({ handleId: z.string() });

describe("re-running a failed stage", () => {
  it("re-opens the rows naming an external effect and clears the rest", async () => {
    const ledger = new InMemoryStepLedger();
    const submits: { externalKey: string; isReclaim: boolean }[] = [];
    const stage = defineStage({
      id: "submit-and-poll",
      name: "Submit and poll",
      schemas: {
        input: z.object({}),
        output: outputSchema,
        config: z.object({}),
      },
      async execute(ctx) {
        const handle = await ctx.step.run("submit", async (step) => {
          submits.push({
            externalKey: step.externalKey,
            isReclaim: step.isReclaim,
          });
          // A real body would look for an existing effect under the key
          // when isReclaim is set; this one just records that it was told.
          return { handleId: `batch-${submits.length}` };
        });
        await ctx.step.waitFor("poll", {
          poll: async () => ({ ready: false }),
          ready: (value) => value.ready,
          every: 1_000,
          timeout: 10_000,
        });
        return { output: handle };
      },
    });
    const workflow = new WorkflowBuilder(
      "reset-wf",
      "Reset",
      "test",
      z.object({}),
      outputSchema,
    )
      .pipe(stage)
      .build();
    const { kernel, persistence, clock } = createTestKernel([workflow], {
      stepLedger: ledger,
    });
    const created = await kernel.dispatch({
      type: "run.create",
      idempotencyKey: "reset-run",
      workflowId: workflow.id,
      input: {},
    });
    await kernel.dispatch({ type: "run.claimPending", workerId: "worker" });
    const execute = () =>
      kernel.dispatch({
        type: "job.execute",
        workflowRunId: created.workflowRunId,
        workflowId: workflow.id,
        stageId: stage.id,
        config: {},
      });

    await execute();
    const stageRecord = await persistence.getStage(
      created.workflowRunId,
      stage.id,
    );
    const submitBefore = await ledger.get(stageRecord!.id, "submit");
    const pollBefore = await ledger.get(stageRecord!.id, "poll");
    expect(submitBefore).toMatchObject({ status: "completed" });
    expect(submitBefore?.externalKey).toEqual(expect.any(String));
    expect(pollBefore).toMatchObject({ status: "pending" });

    // However the stage got there — attempts exhausted, a deterministic
    // throw — it is terminal, and executing it again starts a new attempt.
    await persistence.updateStage(stageRecord!.id, {
      status: "FAILED",
      errorMessage: "attempts exhausted",
    });

    clock.advance(1_000);
    await execute();

    const submitAfter = await ledger.get(stageRecord!.id, "submit");
    const pollAfter = await ledger.get(stageRecord!.id, "poll");

    // The row survived: same row, same external key, never deleted and
    // re-created.
    expect(submitAfter?.createdAt).toEqual(submitBefore?.createdAt);
    expect(submitAfter?.externalKey).toBe(submitBefore?.externalKey);

    // It re-ran, and it knew an earlier execution may have created the
    // effect — the only thing that lets a body re-adopt rather than pay
    // for a second batch.
    expect(submits).toEqual([
      { externalKey: submitBefore!.externalKey, isReclaim: false },
      { externalKey: submitBefore!.externalKey, isReclaim: true },
    ]);
    expect(submitAfter?.attempt).toBe(2);

    // The wait row held only a deadline, so it was cleared and re-derived
    // against the clock as it now stands.
    expect(pollAfter?.deadlineAt?.getTime()).toBeGreaterThan(
      pollBefore!.deadlineAt!.getTime(),
    );
  });

  it("still clears everything when no row names an external effect", async () => {
    const ledger = new InMemoryStepLedger();
    let calls = 0;
    const stage = defineStage({
      id: "wait-only",
      name: "Wait only",
      schemas: {
        input: z.object({}),
        output: z.object({ ok: z.boolean() }),
        config: z.object({}),
      },
      async execute(ctx) {
        calls++;
        await ctx.step.waitFor("poll", {
          poll: async () => ({ ready: false }),
          ready: (value) => value.ready,
          every: 1_000,
          timeout: 10_000,
        });
        return { output: { ok: true } };
      },
    });
    const workflow = new WorkflowBuilder(
      "reset-wait-wf",
      "Reset wait",
      "test",
      z.object({}),
      z.object({ ok: z.boolean() }),
    )
      .pipe(stage)
      .build();
    const { kernel, persistence, clock } = createTestKernel([workflow], {
      stepLedger: ledger,
    });
    const created = await kernel.dispatch({
      type: "run.create",
      idempotencyKey: "reset-wait-run",
      workflowId: workflow.id,
      input: {},
    });
    await kernel.dispatch({ type: "run.claimPending", workerId: "worker" });
    const execute = () =>
      kernel.dispatch({
        type: "job.execute",
        workflowRunId: created.workflowRunId,
        workflowId: workflow.id,
        stageId: stage.id,
        config: {},
      });

    await execute();
    const stageRecord = await persistence.getStage(
      created.workflowRunId,
      stage.id,
    );
    const before = await ledger.get(stageRecord!.id, "poll");
    await persistence.updateStage(stageRecord!.id, {
      status: "FAILED",
      errorMessage: "attempts exhausted",
    });

    clock.advance(1_000);
    await execute();

    expect(calls).toBe(2);
    const after = await ledger.get(stageRecord!.id, "poll");
    expect(after?.deadlineAt?.getTime()).toBeGreaterThan(
      before!.deadlineAt!.getTime(),
    );
  });
});
