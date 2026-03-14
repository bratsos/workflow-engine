import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  defineAsyncBatchStage,
  defineStage,
} from "../../core/stage-factory.js";
import { type Workflow, WorkflowBuilder } from "../../core/workflow.js";
import { createKernel, type Kernel } from "../../kernel/kernel.js";
import {
  CollectingEventSink,
  FakeClock,
  InMemoryBlobStore,
  NoopScheduler,
} from "../../kernel/testing/index.js";
import { StaleVersionError } from "../../persistence/interface.js";
import { InMemoryJobQueue } from "../../testing/in-memory-job-queue.js";
import { InMemoryWorkflowPersistence } from "../../testing/in-memory-persistence.js";

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

function createTestKernel(workflows: Workflow<any, any>[] = []) {
  const persistence = new InMemoryWorkflowPersistence();
  const blobStore = new InMemoryBlobStore();
  const jobTransport = new InMemoryJobQueue("test-worker");
  const eventSink = new CollectingEventSink();
  const scheduler = new NoopScheduler();
  const clock = new FakeClock();

  const registry = new Map<string, Workflow<any, any>>();
  for (const w of workflows) {
    registry.set(w.id, w);
  }

  const kernel = createKernel({
    persistence,
    blobStore,
    jobTransport,
    eventSink,
    scheduler,
    clock,
    registry: { getWorkflow: (id) => registry.get(id) },
  });

  const flush = () => kernel.dispatch({ type: "outbox.flush" as const });
  return {
    kernel,
    flush,
    persistence,
    blobStore,
    jobTransport,
    eventSink,
    scheduler,
    clock,
    registry,
  };
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
});
