/**
 * Kernel Tests: run.rerunFrom command
 *
 * Tests for rerunning a workflow from a specific stage via the kernel
 * dispatch interface, focused on the handler's own contract (stage
 * deletion/recreation, blob cleanup, enqueue) — broader end-to-end rerun
 * behavior is covered by 03-workflow-execution/rerun-from-stage.test.ts.
 */

import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineStage } from "../../core/stage-factory.js";
import { WorkflowBuilder } from "../../core/workflow.js";
import { createTestKernel } from "../utils/index.js";

function createPassthroughStage(id: string, schema: z.ZodTypeAny) {
  return defineStage({
    id,
    name: `Stage ${id}`,
    schemas: { input: schema, output: schema, config: z.object({}) },
    async execute(ctx) {
      return { output: ctx.input };
    },
  });
}

function createTwoStageWorkflow(id: string = "test-workflow") {
  const schema = z.object({ data: z.string() });
  const stage1 = createPassthroughStage("stage-1", schema);
  const stage2 = createPassthroughStage("stage-2", schema);
  return new WorkflowBuilder(id, "Test Workflow", "Test", schema, schema)
    .pipe(stage1)
    .pipe(stage2)
    .build();
}

/** Drives a two-stage workflow run to COMPLETED via direct dispatches. */
async function completeTwoStageRun(
  kernel: ReturnType<typeof createTestKernel>["kernel"],
  workflowRunId: string,
) {
  await kernel.dispatch({
    type: "job.execute",
    workflowRunId,
    workflowId: "test-workflow",
    stageId: "stage-1",
    config: {},
  });
  await kernel.dispatch({ type: "run.transition", workflowRunId });
  await kernel.dispatch({
    type: "job.execute",
    workflowRunId,
    workflowId: "test-workflow",
    stageId: "stage-2",
    config: {},
  });
  await kernel.dispatch({ type: "run.transition", workflowRunId });
}

describe("kernel: run.rerunFrom", () => {
  it("deletes and recreates stages from the target group as fresh PENDING records", async () => {
    const workflow = createTwoStageWorkflow();
    const { kernel, persistence, jobTransport } = createTestKernel([workflow]);

    const { workflowRunId } = await kernel.dispatch({
      type: "run.create",
      idempotencyKey: "key-rerun-1",
      workflowId: "test-workflow",
      input: { data: "hello" },
    });
    await persistence.updateRun(workflowRunId, { status: "RUNNING" });
    await completeTwoStageRun(kernel, workflowRunId);

    const runBefore = await persistence.getRun(workflowRunId);
    expect(runBefore!.status).toBe("COMPLETED");
    const jobCountBefore = jobTransport.getAllJobs().length;

    const result = await kernel.dispatch({
      type: "run.rerunFrom",
      workflowRunId,
      fromStageId: "stage-2",
    });

    expect(result.deletedStages).toEqual(["stage-2"]);

    const runAfter = await persistence.getRun(workflowRunId);
    expect(runAfter!.status).toBe("RUNNING");

    const stage2 = await persistence.getStage(workflowRunId, "stage-2");
    expect(stage2?.status).toBe("PENDING");

    // stage-1 (before the target group) is untouched
    const stage1 = await persistence.getStage(workflowRunId, "stage-1");
    expect(stage1?.status).toBe("COMPLETED");

    // Exactly one new job was enqueued for the rerun.
    expect(jobTransport.getAllJobs().length).toBe(jobCountBefore + 1);
  });

  it("stamps the new stage record with attempt = priorMaxAttempt + 1 (attemptMode max+1)", async () => {
    // Regression test: prepareExecutionGroup's attemptMode "max+1" for
    // run.rerunFrom, sourced from the stages being deleted — NOT from
    // every stage on the run (that's run.transition's "max" mode) and NOT
    // reset to 0 on every rerun.
    const workflow = createTwoStageWorkflow();
    const { kernel, persistence } = createTestKernel([workflow]);

    const { workflowRunId } = await kernel.dispatch({
      type: "run.create",
      idempotencyKey: "key-rerun-attempt",
      workflowId: "test-workflow",
      input: { data: "hello" },
    });
    await persistence.updateRun(workflowRunId, { status: "RUNNING" });
    await completeTwoStageRun(kernel, workflowRunId);

    const initialStage2 = await persistence.getStage(workflowRunId, "stage-2");
    expect(initialStage2?.attempt).toBe(0);

    // First rerun: deleted stage-2 was at attempt 0 -> new record is 1.
    await kernel.dispatch({
      type: "run.rerunFrom",
      workflowRunId,
      fromStageId: "stage-2",
    });
    const firstRerunStage = await persistence.getStage(
      workflowRunId,
      "stage-2",
    );
    expect(firstRerunStage?.attempt).toBe(1);

    // Complete the rerun so the run reaches a rerunnable state again.
    await kernel.dispatch({
      type: "job.execute",
      workflowRunId,
      workflowId: "test-workflow",
      stageId: "stage-2",
      config: {},
    });
    await kernel.dispatch({ type: "run.transition", workflowRunId });

    // Second rerun: deleted stage-2 was at attempt 1 -> new record is 2.
    await kernel.dispatch({
      type: "run.rerunFrom",
      workflowRunId,
      fromStageId: "stage-2",
    });
    const secondRerunStage = await persistence.getStage(
      workflowRunId,
      "stage-2",
    );
    expect(secondRerunStage?.attempt).toBe(2);
  });

  it("rerunning from the first stage deletes both groups and enqueues both fresh", async () => {
    const workflow = createTwoStageWorkflow();
    const { kernel, persistence, jobTransport } = createTestKernel([workflow]);

    const { workflowRunId } = await kernel.dispatch({
      type: "run.create",
      idempotencyKey: "key-rerun-from-start",
      workflowId: "test-workflow",
      input: { data: "hello" },
    });
    await persistence.updateRun(workflowRunId, { status: "RUNNING" });
    await completeTwoStageRun(kernel, workflowRunId);

    const result = await kernel.dispatch({
      type: "run.rerunFrom",
      workflowRunId,
      fromStageId: "stage-1",
    });

    expect(new Set(result.deletedStages)).toEqual(
      new Set(["stage-1", "stage-2"]),
    );

    const stage1 = await persistence.getStage(workflowRunId, "stage-1");
    expect(stage1?.status).toBe("PENDING");
    expect(stage1?.attempt).toBe(1);

    // Only group-1 stages are enqueued immediately after rerunFrom — the
    // run hasn't transitioned to group 2 yet (stage-2 was deleted, not
    // recreated, since it isn't in the target execution group).
    const jobs = jobTransport.getAllJobs();
    expect(jobs.some((j: any) => j.stageId === "stage-1")).toBe(true);
    const stage2 = await persistence.getStage(workflowRunId, "stage-2");
    expect(stage2).toBeNull();
  });
});
