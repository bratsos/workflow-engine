import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { createKernel, type Kernel } from "../../kernel/kernel.js";
import {
  FakeClock,
  InMemoryBlobStore,
  CollectingEventSink,
  NoopScheduler,
} from "../../kernel/testing/index.js";
import { InMemoryWorkflowPersistence } from "../../testing/in-memory-persistence.js";
import { InMemoryJobQueue } from "../../testing/in-memory-job-queue.js";
import { defineStage, defineAsyncBatchStage } from "../../core/stage-factory.js";
import { WorkflowBuilder, type Workflow } from "../../core/workflow.js";

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
  return { kernel, flush, persistence, blobStore, jobTransport, eventSink, scheduler, clock, registry };
}

describe("kernel: stage.pollSuspended", () => {
  it("resumes a completed suspended stage", async () => {
    const schema = z.object({ data: z.string() });
    let pollCount = 0;

    const stage = defineAsyncBatchStage({
      id: "batch-stage",
      name: "Batch Stage",
      mode: "async-batch",
      schemas: { input: schema, output: z.object({ result: z.string() }), config: z.object({}) },
      async execute() {
        return {
          suspended: true,
          state: {
            batchId: "batch-1",
            submittedAt: new Date().toISOString(),
            pollInterval: 1000,
            maxWaitTime: 60000,
          },
          pollConfig: {
            pollInterval: 1000,
            maxWaitTime: 60000,
            nextPollAt: new Date(Date.now() + 1000),
          },
        };
      },
      async checkCompletion() {
        pollCount++;
        return { ready: true, output: { result: "batch completed" } };
      },
    });

    const workflow = new WorkflowBuilder(
      "test-workflow", "Test", "Test",
      schema,
      z.object({ result: z.string() }),
    ).pipe(stage).build();

    const { kernel, persistence, blobStore, clock, eventSink } = createTestKernel([workflow]);

    // Create run and a suspended stage
    const run = await persistence.createRun({
      workflowId: "test-workflow",
      workflowName: "Test",
      workflowType: "test-workflow",
      input: { data: "hello" },
    });

    await persistence.updateRun(run.id, { status: "RUNNING" });

    await persistence.createStage({
      workflowRunId: run.id,
      stageId: "batch-stage",
      stageName: "Batch Stage",
      stageNumber: 1,
      executionGroup: 1,
      status: "SUSPENDED",
      startedAt: clock.now(),
    });

    // Set the stage's nextPollAt to be in the past
    const stages = await persistence.getStagesByRun(run.id);
    await persistence.updateStage(stages[0]!.id, {
      suspendedState: { batchId: "batch-1", submittedAt: new Date().toISOString(), pollInterval: 1000, maxWaitTime: 60000 },
      nextPollAt: new Date(clock.now().getTime() - 1000),
      pollInterval: 1000,
    });

    eventSink.clear();

    const result = await kernel.dispatch({
      type: "stage.pollSuspended",
    });

    expect(result.checked).toBe(1);
    expect(result.resumed).toBe(1);
    expect(result.failed).toBe(0);
    expect(pollCount).toBe(1);

    // Verify stage is now completed
    const updatedStages = await persistence.getStagesByRun(run.id);
    expect(updatedStages[0]!.status).toBe("COMPLETED");

    // Verify output was stored in blobStore
    expect(blobStore.size()).toBeGreaterThan(0);
  });

  it("completes stage when checkCompletion returns ready without output", async () => {
    const schema = z.object({ data: z.string() });

    const stage = defineAsyncBatchStage({
      id: "batch-stage",
      name: "Batch Stage",
      mode: "async-batch",
      schemas: {
        input: schema,
        output: z.object({ result: z.string().optional() }),
        config: z.object({}),
      },
      async execute() {
        return {
          suspended: true,
          state: { batchId: "batch-1" },
          pollConfig: {
            pollInterval: 1000,
            maxWaitTime: 60000,
            nextPollAt: new Date(Date.now() + 1000),
          },
        };
      },
      async checkCompletion() {
        return { ready: true };
      },
    });

    const workflow = new WorkflowBuilder(
      "test-workflow",
      "Test",
      "Test",
      schema,
      z.object({ result: z.string().optional() }),
    )
      .pipe(stage)
      .build();

    const { kernel, persistence, clock } = createTestKernel([workflow]);

    const run = await persistence.createRun({
      workflowId: "test-workflow",
      workflowName: "Test",
      workflowType: "test-workflow",
      input: { data: "hello" },
    });

    await persistence.updateRun(run.id, { status: "RUNNING" });

    await persistence.createStage({
      workflowRunId: run.id,
      stageId: "batch-stage",
      stageName: "Batch Stage",
      stageNumber: 1,
      executionGroup: 1,
      status: "SUSPENDED",
      startedAt: clock.now(),
    });

    const stages = await persistence.getStagesByRun(run.id);
    await persistence.updateStage(stages[0]!.id, {
      suspendedState: { batchId: "batch-1" },
      nextPollAt: new Date(clock.now().getTime() - 1000),
      pollInterval: 1000,
    });

    const result = await kernel.dispatch({ type: "stage.pollSuspended" });

    expect(result.checked).toBe(1);
    expect(result.resumed).toBe(1);
    expect(result.resumedWorkflowRunIds).toEqual([run.id]);

    const updatedStage = await persistence.getStage(run.id, "batch-stage");
    expect(updatedStage?.status).toBe("COMPLETED");
    expect(updatedStage?.nextPollAt).toBeNull();
  });

  it("reschedules when not ready", async () => {
    const schema = z.object({ data: z.string() });

    const stage = defineAsyncBatchStage({
      id: "batch-stage",
      name: "Batch Stage",
      mode: "async-batch",
      schemas: { input: schema, output: z.object({ result: z.string() }), config: z.object({}) },
      async execute() {
        return {
          suspended: true,
          state: { batchId: "batch-1", submittedAt: new Date().toISOString(), pollInterval: 5000, maxWaitTime: 60000 },
          pollConfig: { pollInterval: 5000, maxWaitTime: 60000, nextPollAt: new Date(Date.now() + 5000) },
        };
      },
      async checkCompletion() {
        return { ready: false, nextCheckIn: 30000 };
      },
    });

    const workflow = new WorkflowBuilder(
      "test-workflow", "Test", "Test", schema, z.object({ result: z.string() }),
    ).pipe(stage).build();

    const { kernel, persistence, clock } = createTestKernel([workflow]);

    const run = await persistence.createRun({
      workflowId: "test-workflow",
      workflowName: "Test",
      workflowType: "test-workflow",
      input: { data: "hello" },
    });

    await persistence.updateRun(run.id, { status: "RUNNING" });

    await persistence.createStage({
      workflowRunId: run.id,
      stageId: "batch-stage",
      stageName: "Batch Stage",
      stageNumber: 1,
      executionGroup: 1,
      status: "SUSPENDED",
      startedAt: clock.now(),
    });

    const stages = await persistence.getStagesByRun(run.id);
    await persistence.updateStage(stages[0]!.id, {
      suspendedState: { batchId: "batch-1", submittedAt: new Date().toISOString(), pollInterval: 5000, maxWaitTime: 60000 },
      nextPollAt: new Date(clock.now().getTime() - 1000),
      pollInterval: 5000,
    });

    const result = await kernel.dispatch({
      type: "stage.pollSuspended",
    });

    expect(result.checked).toBe(1);
    expect(result.resumed).toBe(0);

    // Stage should still be suspended with updated nextPollAt
    const updatedStages = await persistence.getStagesByRun(run.id);
    expect(updatedStages[0]!.status).toBe("SUSPENDED");
    expect(updatedStages[0]!.nextPollAt).toBeDefined();
  });

  it("returns zeros when no suspended stages", async () => {
    const { kernel } = createTestKernel([]);

    const result = await kernel.dispatch({
      type: "stage.pollSuspended",
    });

    expect(result.checked).toBe(0);
    expect(result.resumed).toBe(0);
    expect(result.failed).toBe(0);
  });

  it("handles checkCompletion error", async () => {
    const schema = z.object({ data: z.string() });

    const stage = defineAsyncBatchStage({
      id: "batch-stage",
      name: "Batch Stage",
      mode: "async-batch",
      schemas: { input: schema, output: z.object({ result: z.string() }), config: z.object({}) },
      async execute() {
        return {
          suspended: true,
          state: { batchId: "batch-1", submittedAt: new Date().toISOString(), pollInterval: 1000, maxWaitTime: 60000 },
          pollConfig: { pollInterval: 1000, maxWaitTime: 60000, nextPollAt: new Date(Date.now() + 1000) },
        };
      },
      async checkCompletion() {
        return { ready: false, error: "Provider API unavailable" };
      },
    });

    const workflow = new WorkflowBuilder(
      "test-workflow", "Test", "Test", schema, z.object({ result: z.string() }),
    ).pipe(stage).build();

    const { kernel, persistence, clock } = createTestKernel([workflow]);

    const run = await persistence.createRun({
      workflowId: "test-workflow",
      workflowName: "Test",
      workflowType: "test-workflow",
      input: { data: "hello" },
    });

    await persistence.updateRun(run.id, { status: "RUNNING" });

    await persistence.createStage({
      workflowRunId: run.id,
      stageId: "batch-stage",
      stageName: "Batch Stage",
      stageNumber: 1,
      executionGroup: 1,
      status: "SUSPENDED",
      startedAt: clock.now(),
    });

    const stages = await persistence.getStagesByRun(run.id);
    await persistence.updateStage(stages[0]!.id, {
      suspendedState: { batchId: "batch-1", submittedAt: new Date().toISOString(), pollInterval: 1000, maxWaitTime: 60000 },
      nextPollAt: new Date(clock.now().getTime() - 1000),
    });

    const result = await kernel.dispatch({
      type: "stage.pollSuspended",
    });

    expect(result.failed).toBe(1);

    // Stage should be failed
    const updatedStages = await persistence.getStagesByRun(run.id);
    expect(updatedStages[0]!.status).toBe("FAILED");

    // Run should be failed
    const updatedRun = await persistence.getRun(run.id);
    expect(updatedRun!.status).toBe("FAILED");
  });
});
