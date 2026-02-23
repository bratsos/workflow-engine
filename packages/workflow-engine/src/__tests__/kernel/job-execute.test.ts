import { beforeEach, describe, expect, it } from "vitest";
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

describe("kernel: job.execute", () => {
  it("executes a sync stage end-to-end", async () => {
    const schema = z.object({ data: z.string() });
    const stage = defineStage({
      id: "transform",
      name: "Transform",
      schemas: {
        input: schema,
        output: z.object({ result: z.string() }),
        config: z.object({}),
      },
      async execute(ctx) {
        return { output: { result: ctx.input.data.toUpperCase() } };
      },
    });

    const workflow = new WorkflowBuilder(
      "test-workflow",
      "Test",
      "Test",
      schema,
      z.object({ result: z.string() }),
    )
      .pipe(stage)
      .build();

    const { kernel, flush, persistence, blobStore, eventSink } =
      createTestKernel([workflow]);

    // Create and claim a run
    const createResult = await kernel.dispatch({
      type: "run.create",
      idempotencyKey: "key-1",
      workflowId: "test-workflow",
      input: { data: "hello" },
    });

    await persistence.updateRun(createResult.workflowRunId, {
      status: "RUNNING",
    });
    await flush();
    eventSink.clear();

    // Execute the stage
    const result = await kernel.dispatch({
      type: "job.execute",
      workflowRunId: createResult.workflowRunId,
      workflowId: "test-workflow",
      stageId: "transform",
      config: {},
    });

    expect(result.outcome).toBe("completed");
    expect(result.output).toEqual({ result: "HELLO" });

    // Verify stage record
    const stages = await persistence.getStagesByRun(createResult.workflowRunId);
    expect(stages).toHaveLength(1);
    expect(stages[0]!.status).toBe("COMPLETED");

    // Verify events
    await flush();
    const startedEvents = eventSink.getByType("stage:started");
    expect(startedEvents).toHaveLength(1);
    const completedEvents = eventSink.getByType("stage:completed");
    expect(completedEvents).toHaveLength(1);

    // Verify output was stored in blobStore (not persistence artifacts)
    expect(blobStore.size()).toBe(1);

    const finalRun = await persistence.getRun(createResult.workflowRunId);
    expect(finalRun!.version).toBeGreaterThanOrEqual(1);
  });

  it("handles a failed stage", async () => {
    const schema = z.object({ data: z.string() });
    const stage = defineStage({
      id: "failing",
      name: "Failing Stage",
      schemas: { input: schema, output: schema, config: z.object({}) },
      async execute() {
        throw new Error("Stage execution failed");
      },
    });

    const workflow = new WorkflowBuilder(
      "test-workflow",
      "Test",
      "Test",
      schema,
      schema,
    )
      .pipe(stage)
      .build();

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
    await flush();
    eventSink.clear();

    const result = await kernel.dispatch({
      type: "job.execute",
      workflowRunId: createResult.workflowRunId,
      workflowId: "test-workflow",
      stageId: "failing",
      config: {},
    });

    expect(result.outcome).toBe("failed");
    expect(result.error).toBe("Stage execution failed");

    // Verify stage record
    const stages = await persistence.getStagesByRun(createResult.workflowRunId);
    expect(stages[0]!.status).toBe("FAILED");

    // Verify events
    await flush();
    const failedEvents = eventSink.getByType("stage:failed");
    expect(failedEvents).toHaveLength(1);
  });

  it("handles a suspended stage", async () => {
    const schema = z.object({ data: z.string() });
    const stage = defineAsyncBatchStage({
      id: "suspending",
      name: "Suspending Stage",
      mode: "async-batch",
      schemas: {
        input: schema,
        output: z.object({ result: z.string() }),
        config: z.object({}),
      },
      async execute(ctx) {
        return {
          suspended: true,
          state: {
            batchId: "batch-123",
            submittedAt: new Date().toISOString(),
            pollInterval: 60000,
            maxWaitTime: 3600000,
          },
          pollConfig: {
            pollInterval: 60000,
            maxWaitTime: 3600000,
            nextPollAt: new Date(Date.now() + 60000),
          },
        };
      },
      async checkCompletion(state) {
        return { ready: true, output: { result: "done" } };
      },
    });

    const workflow = new WorkflowBuilder(
      "test-workflow",
      "Test",
      "Test",
      schema,
      z.object({ result: z.string() }),
    )
      .pipe(stage)
      .build();

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
    eventSink.clear();

    const result = await kernel.dispatch({
      type: "job.execute",
      workflowRunId: createResult.workflowRunId,
      workflowId: "test-workflow",
      stageId: "suspending",
      config: {},
    });

    expect(result.outcome).toBe("suspended");
    expect(result.nextPollAt).toBeDefined();

    // Verify stage record
    const stages = await persistence.getStagesByRun(createResult.workflowRunId);
    expect(stages[0]!.status).toBe("SUSPENDED");
    expect(stages[0]!.suspendedState).toBeDefined();
  });

  it("throws on missing workflow", async () => {
    const { kernel } = createTestKernel([]);

    await expect(
      kernel.dispatch({
        type: "job.execute",
        workflowRunId: "run-1",
        workflowId: "nonexistent",
        stageId: "stage-1",
        config: {},
      }),
    ).rejects.toThrow("not found in registry");
  });

  it("validates input against stage schema", async () => {
    const inputSchema = z.object({ number: z.number() });
    const stage = defineStage({
      id: "strict",
      name: "Strict",
      schemas: {
        input: inputSchema,
        output: inputSchema,
        config: z.object({}),
      },
      async execute(ctx) {
        return { output: ctx.input };
      },
    });

    const workflow = new WorkflowBuilder(
      "test-workflow",
      "Test",
      "Test",
      inputSchema,
      inputSchema,
    )
      .pipe(stage)
      .build();

    const { kernel, persistence } = createTestKernel([workflow]);

    // Create run with wrong input type
    const run = await persistence.createRun({
      workflowId: "test-workflow",
      workflowName: "Test",
      workflowType: "test-workflow",
      input: { number: "not-a-number" }, // Wrong type
    });

    await persistence.updateRun(run.id, { status: "RUNNING" });

    const result = await kernel.dispatch({
      type: "job.execute",
      workflowRunId: run.id,
      workflowId: "test-workflow",
      stageId: "strict",
      config: {},
    });

    expect(result.outcome).toBe("failed");
  });
});
