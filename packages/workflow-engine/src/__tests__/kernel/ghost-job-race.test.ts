/**
 * The two ghost-job outcomes, at the host seam.
 *
 * `job.execute` returns `ghost: true` whenever the run it was handed is
 * not RUNNING, but the two reasons need opposite handling and used to be
 * collapsed into one terminal "discard it" path:
 *
 *  - `ghostReason: "orphan"` — the run is CANCELLED/COMPLETED/FAILED.
 *    Retrying can only fail again, so the job is failed terminally.
 *  - `ghostReason: "race"` — the run is still PENDING, i.e. the job was
 *    dequeued before the claim that enqueued it committed. Nothing else
 *    re-enqueues it, so discarding it wedged the run RUNNING with no job
 *    until `run.reapStuck` swept it minutes later. It must be
 *    re-delivered.
 */

import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineStage } from "../../core/stage-factory.js";
import { WorkflowBuilder } from "../../core/workflow.js";
import { executeJobWithHeartbeat } from "../../kernel/helpers/host-support.js";
import { createTestKernel } from "../utils/index.js";

const schema = z.object({ data: z.string() });

function createWorkflow(id: string) {
  const stage = defineStage({
    id: "stage-1",
    name: "Stage 1",
    schemas: { input: schema, output: schema, config: z.object({}) },
    async execute(ctx) {
      return { output: ctx.input };
    },
  });
  return new WorkflowBuilder(id, "Ghost Race", "Ghost race", schema, schema)
    .pipe(stage)
    .build();
}

describe("ghost jobs at the host seam", () => {
  it("re-delivers a job that was dequeued ahead of its claim", async () => {
    const workflow = createWorkflow("ghost-race");
    const { kernel, jobTransport } = createTestKernel([workflow]);

    const created = await kernel.dispatch({
      type: "run.create",
      idempotencyKey: "race-1",
      workflowId: workflow.id,
      input: { data: "hello" },
    });
    // Enqueue a job by hand for a run that is still PENDING — exactly what
    // a job loop used to see between the in-transaction enqueue and the
    // claim's commit.
    const jobId = await jobTransport.enqueue({
      workflowRunId: created.workflowRunId,
      workflowId: workflow.id,
      stageId: "stage-1",
      payload: { config: {} },
    });
    const job = await jobTransport.dequeue();

    const outcome = await executeJobWithHeartbeat(kernel, {
      jobTransport,
      job: {
        jobId: job!.jobId,
        workflowRunId: job!.workflowRunId,
        workflowId: job!.workflowId,
        stageId: job!.stageId,
        attempt: job!.attempt,
        maxAttempts: job!.maxAttempts,
        payload: job!.payload,
      },
    });

    expect(outcome.outcome).toBe("failed");
    expect(outcome.willRetry).toBe(true);
    // The transport put the row back to PENDING, so the run gets its job
    // once the claim commits instead of wedging RUNNING with none.
    const [row] = await jobTransport.getJobsByWorkflowRun(
      created.workflowRunId,
    );
    expect(row!.id).toBe(jobId);
    expect(row!.status).toBe("PENDING");
  });

  it("fails a job whose run is already terminal, without re-delivering it", async () => {
    const workflow = createWorkflow("ghost-orphan");
    const { kernel, jobTransport, persistence } = createTestKernel([workflow]);

    const created = await kernel.dispatch({
      type: "run.create",
      idempotencyKey: "orphan-1",
      workflowId: workflow.id,
      input: { data: "hello" },
    });
    await kernel.dispatch({ type: "run.claimPending", workerId: "worker-1" });
    const job = await jobTransport.dequeue();
    await kernel.dispatch({
      type: "run.cancel",
      workflowRunId: created.workflowRunId,
    });

    const outcome = await executeJobWithHeartbeat(kernel, {
      jobTransport,
      job: {
        jobId: job!.jobId,
        workflowRunId: job!.workflowRunId,
        workflowId: job!.workflowId,
        stageId: job!.stageId,
        attempt: job!.attempt,
        maxAttempts: job!.maxAttempts,
        payload: job!.payload,
      },
    });

    expect(outcome.outcome).toBe("failed");
    expect(outcome.willRetry).toBe(false);
    const [row] = await jobTransport.getJobsByWorkflowRun(
      created.workflowRunId,
    );
    expect(row!.status).toBe("FAILED");
    // A cancelled run is not re-opened by the orphan path.
    const run = await persistence.getRun(created.workflowRunId);
    expect(run?.status).toBe("CANCELLED");
  });

  it("stops re-delivering a racing job once its attempt budget is spent", async () => {
    const workflow = createWorkflow("ghost-race-budget");
    const { kernel, jobTransport } = createTestKernel([workflow]);

    const created = await kernel.dispatch({
      type: "run.create",
      idempotencyKey: "race-budget-1",
      workflowId: workflow.id,
      input: { data: "hello" },
    });
    await jobTransport.enqueue({
      workflowRunId: created.workflowRunId,
      workflowId: workflow.id,
      stageId: "stage-1",
      payload: { config: {} },
    });

    // The run never leaves PENDING, so every re-delivery races again.
    let outcome!: Awaited<ReturnType<typeof executeJobWithHeartbeat>>;
    for (let i = 0; i < 3; i++) {
      const job = await jobTransport.dequeue();
      expect(job).not.toBeNull();
      outcome = await executeJobWithHeartbeat(kernel, {
        jobTransport,
        job: {
          jobId: job!.jobId,
          workflowRunId: job!.workflowRunId,
          workflowId: job!.workflowId,
          stageId: job!.stageId,
          attempt: job!.attempt,
          maxAttempts: job!.maxAttempts,
          payload: job!.payload,
        },
      });
    }

    expect(outcome.willRetry).toBe(false);
    const [row] = await jobTransport.getJobsByWorkflowRun(
      created.workflowRunId,
    );
    expect(row!.status).toBe("FAILED");
  });
});
