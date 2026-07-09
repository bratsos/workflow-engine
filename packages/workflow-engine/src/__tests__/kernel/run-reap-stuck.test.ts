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

function createSimpleWorkflow(id: string = "test-workflow") {
  const schema = z.object({ data: z.string() });
  const stage = createPassthroughStage("stage-1", schema);
  return new WorkflowBuilder(id, "Test Workflow", "Test", schema, schema)
    .pipe(stage)
    .build();
}

// Every kernel in this file is created with `clockStart: new Date()` so the
// FakeClock aligns with the real `new Date()` timestamps InMemoryWorkflowPersistence
// stamps on records -- otherwise `run.reapStuck`'s elapsed-time math would
// compare a fixed 2025-01-01 clock against real "now" timestamps.

describe("kernel: run.reapStuck", () => {
  it("marks stuck RUNNING run as FAILED when no activity past threshold", async () => {
    const workflow = createSimpleWorkflow();
    const { kernel, persistence, clock } = createTestKernel([workflow], {
      clockStart: new Date(),
    });

    await kernel.dispatch({
      type: "run.create",
      idempotencyKey: "key-1",
      workflowId: "test-workflow",
      input: { data: "hello" },
    });
    await kernel.dispatch({ type: "run.claimPending", workerId: "w1" });

    // Advance clock past stuck threshold
    clock.advance(10 * 60 * 1000); // 10 minutes

    const result = await kernel.dispatch({
      type: "run.reapStuck",
      stuckThresholdMs: 5 * 60 * 1000,
    });

    expect(result.failed).toBe(1);

    const failedRuns = await persistence.getRunsByStatus("FAILED");
    expect(failedRuns).toHaveLength(1);
    expect((failedRuns[0]!.output as any).error.code).toBe("STUCK_RUN_REAPED");
  });

  it("does not reap runs with recent activity", async () => {
    const workflow = createSimpleWorkflow();
    const { kernel, clock } = createTestKernel([workflow], {
      clockStart: new Date(),
    });

    await kernel.dispatch({
      type: "run.create",
      idempotencyKey: "key-1",
      workflowId: "test-workflow",
      input: { data: "hello" },
    });
    await kernel.dispatch({ type: "run.claimPending", workerId: "w1" });

    // Only advance 1 minute (below 5min threshold)
    clock.advance(60 * 1000);

    const result = await kernel.dispatch({
      type: "run.reapStuck",
      stuckThresholdMs: 5 * 60 * 1000,
    });

    expect(result.failed).toBe(0);
    expect(result.transitioned).toBe(0);
  });

  it("does not reap PENDING or COMPLETED runs", async () => {
    const workflow = createSimpleWorkflow();
    const { kernel, clock } = createTestKernel([workflow], {
      clockStart: new Date(),
    });

    // Create a run that stays PENDING (never claimed)
    await kernel.dispatch({
      type: "run.create",
      idempotencyKey: "key-1",
      workflowId: "test-workflow",
      input: { data: "hello" },
    });

    clock.advance(10 * 60 * 1000);

    const result = await kernel.dispatch({
      type: "run.reapStuck",
      stuckThresholdMs: 5 * 60 * 1000,
    });

    // PENDING runs should NOT be reaped
    expect(result.failed).toBe(0);
  });

  it("skips reaping a run that recovered between query and update", async () => {
    const workflow = createSimpleWorkflow();
    const { kernel, persistence, jobTransport, clock } = createTestKernel(
      [workflow],
      { clockStart: new Date() },
    );

    const { workflowRunId } = await kernel.dispatch({
      type: "run.create",
      idempotencyKey: "key-1",
      workflowId: "test-workflow",
      input: { data: "hello" },
    });
    await kernel.dispatch({ type: "run.claimPending", workerId: "w1" });

    // Execute the job so the run completes (recovers)
    const job = await jobTransport.dequeue();
    await kernel.dispatch({
      type: "job.execute",
      workflowRunId: job!.workflowRunId,
      workflowId: job!.workflowId,
      stageId: job!.stageId,
      config: {},
    });
    await jobTransport.complete(job!.jobId);
    await kernel.dispatch({ type: "run.transition", workflowRunId });

    // Now the run is COMPLETED — advance clock and try to reap
    clock.advance(10 * 60 * 1000);

    // Simulate race: getStuckRuns might return this run (in real code,
    // the query filters by RUNNING, but the status guard provides defense-in-depth)
    const result = await kernel.dispatch({
      type: "run.reapStuck",
      stuckThresholdMs: 5 * 60 * 1000,
    });

    expect(result.failed).toBe(0);
    const run = await persistence.getRun(workflowRunId);
    expect(run!.status).toBe("COMPLETED");
  });

  it("reports transitioned equal to failed (the only transition it performs)", async () => {
    const workflow = createSimpleWorkflow();
    const { kernel, clock } = createTestKernel([workflow], {
      clockStart: new Date(),
    });

    await kernel.dispatch({
      type: "run.create",
      idempotencyKey: "key-1",
      workflowId: "test-workflow",
      input: { data: "hello" },
    });
    await kernel.dispatch({ type: "run.claimPending", workerId: "w1" });

    clock.advance(10 * 60 * 1000);

    const result = await kernel.dispatch({
      type: "run.reapStuck",
      stuckThresholdMs: 5 * 60 * 1000,
    });

    expect(result.failed).toBe(1);
    expect(result.transitioned).toBe(1);
  });

  it("does not double-reap when a concurrent updateRun changed the version first (version guard)", async () => {
    const workflow = createSimpleWorkflow();
    const { kernel, persistence, clock } = createTestKernel([workflow], {
      clockStart: new Date(),
    });

    const { workflowRunId } = await kernel.dispatch({
      type: "run.create",
      idempotencyKey: "key-race",
      workflowId: "test-workflow",
      input: { data: "hello" },
    });
    await kernel.dispatch({ type: "run.claimPending", workerId: "w1" });

    clock.advance(10 * 60 * 1000);

    // Simulate a second host's reaper winning the race: it bumps the
    // run's version out from under the query snapshot used below.
    const runBeforeRace = await persistence.getRun(workflowRunId);
    await persistence.updateRun(workflowRunId, {
      expectedVersion: runBeforeRace!.version,
      status: "FAILED",
      completedAt: clock.now(),
    });

    const result = await kernel.dispatch({
      type: "run.reapStuck",
      stuckThresholdMs: 5 * 60 * 1000,
    });

    // The run is already FAILED (status guard), so this host's reap is a
    // no-op — it must not throw or double-count.
    expect(result.failed).toBe(0);
    expect(result.transitioned).toBe(0);
  });

  it("re-enqueues a PENDING stage with no matching job instead of failing the run (enqueue-outside-tx recovery)", async () => {
    const workflow = createSimpleWorkflow();
    const { kernel, persistence, jobTransport, clock } = createTestKernel(
      [workflow],
      { clockStart: new Date() },
    );

    const { workflowRunId } = await kernel.dispatch({
      type: "run.create",
      idempotencyKey: "key-recovery",
      workflowId: "test-workflow",
      input: { data: "hello" },
    });
    await kernel.dispatch({ type: "run.claimPending", workerId: "w1" });

    // Simulate the enqueue-outside-the-transaction race: the stage
    // record is PENDING but its job never made it into the queue (e.g.
    // the process crashed after the DB transaction committed but before
    // jobTransport.enqueueParallel ran).
    jobTransport.clear();
    expect(jobTransport.getAllJobs()).toHaveLength(0);

    clock.advance(10 * 60 * 1000);

    const result = await kernel.dispatch({
      type: "run.reapStuck",
      stuckThresholdMs: 5 * 60 * 1000,
    });

    // Recovered, not reaped.
    expect(result.failed).toBe(0);
    expect(result.transitioned).toBe(0);

    const run = await persistence.getRun(workflowRunId);
    expect(run!.status).toBe("RUNNING");

    // A fresh job was enqueued for the orphaned PENDING stage.
    const jobs = jobTransport.getAllJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.workflowRunId).toBe(workflowRunId);
    expect(jobs[0]!.status).toBe("PENDING");
  });
});
