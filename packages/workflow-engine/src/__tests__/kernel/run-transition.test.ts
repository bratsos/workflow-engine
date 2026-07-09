import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { defineStage } from "../../core/stage-factory.js";
import { WorkflowBuilder } from "../../core/workflow.js";
import { StaleVersionError } from "../../persistence/interface.js";
import {
  createTestKernel,
  InMemoryWorkflowPersistence,
} from "../utils/index.js";

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

function createTwoStageWorkflow(id: string = "test-workflow") {
  const schema = z.object({ data: z.string() });
  const stage1 = createPassthroughStage("stage-1", schema);
  const stage2 = createPassthroughStage("stage-2", schema);
  return new WorkflowBuilder(id, "Test Workflow", "Test", schema, schema)
    .pipe(stage1)
    .pipe(stage2)
    .build();
}

describe("kernel: run.transition", () => {
  it("returns noop for non-existent run", async () => {
    const { kernel } = createTestKernel([]);

    const result = await kernel.dispatch({
      type: "run.transition",
      workflowRunId: "nonexistent",
    });

    expect(result.action).toBe("noop");
  });

  it("returns noop for completed run", async () => {
    const workflow = createSimpleWorkflow();
    const { kernel, persistence } = createTestKernel([workflow]);

    const createResult = await kernel.dispatch({
      type: "run.create",
      idempotencyKey: "key-1",
      workflowId: "test-workflow",
      input: { data: "hello" },
    });

    await persistence.updateRun(createResult.workflowRunId, {
      status: "COMPLETED",
    });

    const result = await kernel.dispatch({
      type: "run.transition",
      workflowRunId: createResult.workflowRunId,
    });

    expect(result.action).toBe("noop");
  });

  it("returns noop when active stages exist", async () => {
    const workflow = createTwoStageWorkflow();
    const { kernel, persistence } = createTestKernel([workflow]);

    const createResult = await kernel.dispatch({
      type: "run.create",
      idempotencyKey: "key-1",
      workflowId: "test-workflow",
      input: { data: "hello" },
    });

    await persistence.updateRun(createResult.workflowRunId, {
      status: "RUNNING",
    });

    // Create a RUNNING stage
    await persistence.createStage({
      workflowRunId: createResult.workflowRunId,
      stageId: "stage-1",
      stageName: "Stage stage-1",
      stageNumber: 1,
      executionGroup: 1,
      status: "RUNNING",
    });

    const result = await kernel.dispatch({
      type: "run.transition",
      workflowRunId: createResult.workflowRunId,
    });

    expect(result.action).toBe("noop");
  });

  it("advances to next stage group when current group is complete", async () => {
    const workflow = createTwoStageWorkflow();
    const { kernel, persistence, jobTransport, eventSink } = createTestKernel([
      workflow,
    ]);

    const createResult = await kernel.dispatch({
      type: "run.create",
      idempotencyKey: "key-1",
      workflowId: "test-workflow",
      input: { data: "hello" },
    });

    await persistence.updateRun(createResult.workflowRunId, {
      status: "RUNNING",
    });

    // Create a COMPLETED stage for group 1
    await persistence.createStage({
      workflowRunId: createResult.workflowRunId,
      stageId: "stage-1",
      stageName: "Stage stage-1",
      stageNumber: 1,
      executionGroup: 1,
      status: "COMPLETED",
    });

    eventSink.clear();

    const result = await kernel.dispatch({
      type: "run.transition",
      workflowRunId: createResult.workflowRunId,
    });

    expect(result.action).toBe("advanced");

    // Verify next stage was created
    const stages = await persistence.getStagesByRun(createResult.workflowRunId);
    const stage2 = stages.find((s) => s.stageId === "stage-2");
    expect(stage2).toBeDefined();
    expect(stage2!.status).toBe("PENDING");

    // Verify job was enqueued
    expect(jobTransport.getAllJobs()).toHaveLength(1);
  });

  it("propagates the run's max existing stage attempt to a newly-created downstream group", async () => {
    // Regression test: prepareExecutionGroup's attemptMode "max" for
    // run.transition. Simulates group 1 having already been bumped to
    // attempt 2 by a prior run.rerunFrom — the newly-created group-2 stage
    // must inherit that same attempt (not reset to 0), so annotations from
    // this rerun span share one attempt value.
    const workflow = createTwoStageWorkflow();
    const { kernel, persistence } = createTestKernel([workflow]);

    const createResult = await kernel.dispatch({
      type: "run.create",
      idempotencyKey: "key-attempt-propagation",
      workflowId: "test-workflow",
      input: { data: "hello" },
    });

    await persistence.updateRun(createResult.workflowRunId, {
      status: "RUNNING",
    });

    await persistence.createStage({
      workflowRunId: createResult.workflowRunId,
      stageId: "stage-1",
      stageName: "Stage stage-1",
      stageNumber: 1,
      executionGroup: 1,
      status: "COMPLETED",
      attempt: 2,
    });

    const result = await kernel.dispatch({
      type: "run.transition",
      workflowRunId: createResult.workflowRunId,
    });

    expect(result.action).toBe("advanced");

    const stages = await persistence.getStagesByRun(createResult.workflowRunId);
    const stage2 = stages.find((s) => s.stageId === "stage-2");
    expect(stage2).toBeDefined();
    expect(stage2!.attempt).toBe(2);
  });

  it("completes the workflow when all stages are done", async () => {
    const workflow = createSimpleWorkflow();
    const { kernel, flush, persistence, eventSink } = createTestKernel([
      workflow,
    ]);

    const createResult = await kernel.dispatch({
      type: "run.create",
      idempotencyKey: "key-1",
      workflowId: "test-workflow",
      input: { data: "hello" },
    });

    await persistence.updateRun(createResult.workflowRunId, {
      status: "RUNNING",
    });

    // Mark stage as completed
    await persistence.createStage({
      workflowRunId: createResult.workflowRunId,
      stageId: "stage-1",
      stageName: "Stage stage-1",
      stageNumber: 1,
      executionGroup: 1,
      status: "COMPLETED",
    });

    await flush();
    eventSink.clear();

    const result = await kernel.dispatch({
      type: "run.transition",
      workflowRunId: createResult.workflowRunId,
    });

    expect(result.action).toBe("completed");

    // Verify run is completed
    const run = await persistence.getRun(createResult.workflowRunId);
    expect(run!.status).toBe("COMPLETED");

    // Verify event
    await flush();
    const completedEvents = eventSink.getByType("workflow:completed");
    expect(completedEvents).toHaveLength(1);
  });

  it("marks workflow as failed when a stage failed", async () => {
    const workflow = createSimpleWorkflow();
    const { kernel, persistence, eventSink } = createTestKernel([workflow]);

    const createResult = await kernel.dispatch({
      type: "run.create",
      idempotencyKey: "key-1",
      workflowId: "test-workflow",
      input: { data: "hello" },
    });

    await persistence.updateRun(createResult.workflowRunId, {
      status: "RUNNING",
    });

    // Mark stage as failed
    await persistence.createStage({
      workflowRunId: createResult.workflowRunId,
      stageId: "stage-1",
      stageName: "Stage stage-1",
      stageNumber: 1,
      executionGroup: 1,
      status: "FAILED",
    });

    eventSink.clear();

    const result = await kernel.dispatch({
      type: "run.transition",
      workflowRunId: createResult.workflowRunId,
    });

    expect(result.action).toBe("failed");

    const run = await persistence.getRun(createResult.workflowRunId);
    expect(run!.status).toBe("FAILED");
  });

  it("handles pre-existing stages in execution group (idempotent)", async () => {
    const workflow = createTwoStageWorkflow();
    const { kernel, persistence, jobTransport } = createTestKernel([workflow]);

    // Create a run and set it to RUNNING
    const createResult = await kernel.dispatch({
      type: "run.create",
      idempotencyKey: "key-1",
      workflowId: "test-workflow",
      input: { data: "hello" },
    });

    await persistence.updateRun(createResult.workflowRunId, {
      status: "RUNNING",
    });

    // Complete stage-1 in group 1
    await persistence.createStage({
      workflowRunId: createResult.workflowRunId,
      stageId: "stage-1",
      stageName: "Stage stage-1",
      stageNumber: 1,
      executionGroup: 1,
      status: "COMPLETED",
    });

    // Spy on upsertStage to verify the handler uses it (not createStage)
    const upsertSpy = vi.spyOn(persistence, "upsertStage");
    const createSpy = vi.spyOn(persistence, "createStage");

    // Transition should advance to group 2 using upsertStage
    const result = await kernel.dispatch({
      type: "run.transition",
      workflowRunId: createResult.workflowRunId,
    });

    expect(result.action).toBe("advanced");

    // The handler should use upsertStage, NOT createStage, to avoid P2002
    expect(upsertSpy).toHaveBeenCalled();
    // createStage may be called internally by upsertStage, but the handler
    // itself should not call it directly for stage creation
    const upsertCalls = upsertSpy.mock.calls;
    expect(upsertCalls.length).toBeGreaterThanOrEqual(1);
    expect(upsertCalls[0][0]).toMatchObject({
      workflowRunId: createResult.workflowRunId,
      stageId: "stage-2",
    });

    // Verify stage-2 was created via upsert
    const stages = await persistence.getStagesByRun(createResult.workflowRunId);
    const stage2 = stages.find((s) => s.stageId === "stage-2");
    expect(stage2).toBeDefined();
    expect(stage2!.status).toBe("PENDING");

    // Verify a job was enqueued for stage-2
    expect(jobTransport.getAllJobs().length).toBeGreaterThanOrEqual(1);
    const stage2Job = jobTransport
      .getAllJobs()
      .find((j: any) => j.stageId === "stage-2");
    expect(stage2Job).toBeDefined();
  });

  it("returns noop when another transition already claimed the run", async () => {
    const workflow = createTwoStageWorkflow();
    const { kernel, persistence, jobTransport } = createTestKernel([workflow]);

    const createResult = await kernel.dispatch({
      type: "run.create",
      idempotencyKey: "key-stale-transition",
      workflowId: "test-workflow",
      input: { data: "hello" },
    });

    await persistence.updateRun(createResult.workflowRunId, {
      status: "RUNNING",
    });
    await persistence.createStage({
      workflowRunId: createResult.workflowRunId,
      stageId: "stage-1",
      stageName: "Stage stage-1",
      stageNumber: 1,
      executionGroup: 1,
      status: "COMPLETED",
    });

    const updateRunSpy = vi.spyOn(persistence, "updateRun");
    updateRunSpy.mockImplementation(async (id, data) => {
      if (
        id === createResult.workflowRunId &&
        data.expectedVersion !== undefined &&
        data.status === undefined &&
        data.output === undefined
      ) {
        throw new StaleVersionError(
          "WorkflowRun",
          id,
          data.expectedVersion,
          data.expectedVersion + 1,
        );
      }

      return InMemoryWorkflowPersistence.prototype.updateRun.call(
        persistence,
        id,
        data,
      );
    });

    const result = await kernel.dispatch({
      type: "run.transition",
      workflowRunId: createResult.workflowRunId,
    });

    expect(result.action).toBe("noop");
    expect(jobTransport.getAllJobs()).toHaveLength(0);
  });

  describe("parallel-group retry race", () => {
    it("does not kill the run when a sibling completes while a FAILED stage still has a retry queued", async () => {
      const schema = z.object({ data: z.string() });
      const stageA = createPassthroughStage("stage-a", schema);
      const stageB = createPassthroughStage("stage-b", schema);
      const workflow = new WorkflowBuilder(
        "parallel-retry",
        "Test",
        "Test",
        schema,
        z.any(),
      )
        .parallel([stageA, stageB])
        .build();

      const { kernel, persistence, jobTransport } = createTestKernel([
        workflow,
      ]);

      const { workflowRunId } = await kernel.dispatch({
        type: "run.create",
        idempotencyKey: "key-parallel-retry",
        workflowId: "parallel-retry",
        input: { data: "hello" },
      });
      await kernel.dispatch({ type: "run.claimPending", workerId: "worker-1" });

      // Target "stage-a" specifically. dequeue() picks whichever PENDING
      // job comes first, so drain the queue until we get stage-a's job
      // (attempt is incremented as a side effect, as a real host's
      // dequeue would do before reporting failure).
      const targetStageId = "stage-a";
      const otherStageId = "stage-b";
      let dequeuedTarget = await jobTransport.dequeue();
      if (dequeuedTarget!.stageId !== targetStageId) {
        dequeuedTarget = await jobTransport.dequeue();
      }
      expect(dequeuedTarget!.stageId).toBe(targetStageId);
      const targetJobId = dequeuedTarget!.jobId;

      // Stage A's job fails and the host requeues it for retry (shouldRetry:
      // true) — jobTransport.fail() puts it back to PENDING with attempt > 0.
      // The stage record itself is FAILED — that's what job-execute always
      // writes on a stage-body throw, retryable or not.
      await kernel.dispatch({
        type: "job.execute",
        workflowRunId,
        workflowId: "parallel-retry",
        stageId: targetStageId,
        config: {},
      });
      // Simulate a failure directly on the stage record + requeue the job,
      // mirroring what job-execute + a retrying host would produce.
      await persistence.updateStageByRunAndStageId(
        workflowRunId,
        targetStageId,
        {
          status: "FAILED",
          errorMessage: "transient error",
        },
      );
      await jobTransport.fail(targetJobId, "transient error", true);

      // Sibling stage completes normally.
      const execResult = await kernel.dispatch({
        type: "job.execute",
        workflowRunId,
        workflowId: "parallel-retry",
        stageId: otherStageId,
        config: {},
      });
      expect(execResult.outcome).toBe("completed");

      // The sibling's run.transition dispatch must NOT kill the run — the
      // failed stage's retry is still queued (PENDING, attempt > 0).
      const transitionAfterSiblingComplete = await kernel.dispatch({
        type: "run.transition",
        workflowRunId,
      });
      expect(transitionAfterSiblingComplete.action).toBe("noop");

      const runAfterSibling = await persistence.getRun(workflowRunId);
      expect(runAfterSibling!.status).toBe("RUNNING");

      // Now the retry runs and succeeds.
      const retryResult = await kernel.dispatch({
        type: "job.execute",
        workflowRunId,
        workflowId: "parallel-retry",
        stageId: targetStageId,
        config: {},
      });
      expect(retryResult.outcome).toBe("completed");
      await jobTransport.complete(targetJobId);

      const finalTransition = await kernel.dispatch({
        type: "run.transition",
        workflowRunId,
      });
      expect(finalTransition.action).toBe("completed");
    });

    it("fails the run once the FAILED stage's retry is exhausted (job itself FAILED)", async () => {
      const schema = z.object({ data: z.string() });
      const stageA = createPassthroughStage("stage-a", schema);
      const stageB = createPassthroughStage("stage-b", schema);
      const workflow = new WorkflowBuilder(
        "parallel-retry-exhausted",
        "Test",
        "Test",
        schema,
        z.any(),
      )
        .parallel([stageA, stageB])
        .build();

      const { kernel, persistence, jobTransport } = createTestKernel([
        workflow,
      ]);

      const { workflowRunId } = await kernel.dispatch({
        type: "run.create",
        idempotencyKey: "key-parallel-retry-2",
        workflowId: "parallel-retry-exhausted",
        input: { data: "hello" },
      });
      await kernel.dispatch({ type: "run.claimPending", workerId: "worker-1" });

      const dequeuedA = await jobTransport.dequeue();
      const targetStageId = dequeuedA!.stageId;
      const otherStageId = targetStageId === "stage-a" ? "stage-b" : "stage-a";

      await persistence.updateStageByRunAndStageId(
        workflowRunId,
        targetStageId,
        {
          status: "FAILED",
          errorMessage: "permanent error",
        },
      );
      // No retry — job fails terminally (shouldRetry: false, the default).
      await jobTransport.fail(dequeuedA!.jobId, "permanent error");

      const dequeuedOther = await jobTransport.dequeue();
      await kernel.dispatch({
        type: "job.execute",
        workflowRunId,
        workflowId: "parallel-retry-exhausted",
        stageId: otherStageId,
        config: {},
      });
      await jobTransport.complete(dequeuedOther!.jobId);

      const transition = await kernel.dispatch({
        type: "run.transition",
        workflowRunId,
      });
      expect(transition.action).toBe("failed");

      const run = await persistence.getRun(workflowRunId);
      expect(run!.status).toBe("FAILED");
    });
  });
});
