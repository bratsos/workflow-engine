/**
 * Kernel Tests: command idempotency
 *
 * Commands with an `idempotencyKey` are deduplicated: replaying the same
 * command returns the cached result without re-executing the handler.
 * Keys are scoped to commandType so the same string can be used across
 * different command types without collision.
 */

import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createKernel } from "../../kernel/kernel.js";
import { IdempotencyInProgressError } from "../../kernel/errors.js";
import {
  FakeClock,
  InMemoryBlobStore,
  CollectingEventSink,
  NoopScheduler,
} from "../../kernel/testing/index.js";
import { InMemoryWorkflowPersistence } from "../../testing/in-memory-persistence.js";
import { InMemoryJobQueue } from "../../testing/in-memory-job-queue.js";
import { defineStage } from "../../core/stage-factory.js";
import { WorkflowBuilder, type Workflow } from "../../core/workflow.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("kernel: idempotency", () => {
  it("run.create with same idempotencyKey returns cached result", async () => {
    const workflow = createSimpleWorkflow();
    const { kernel, persistence } = createTestKernel([workflow]);

    const result1 = await kernel.dispatch({
      type: "run.create",
      idempotencyKey: "key-1",
      workflowId: "test-workflow",
      input: { data: "hello" },
    });

    const result2 = await kernel.dispatch({
      type: "run.create",
      idempotencyKey: "key-1",
      workflowId: "test-workflow",
      input: { data: "hello" },
    });

    // Same cached result
    expect(result1.workflowRunId).toBe(result2.workflowRunId);
    expect(result1.status).toBe(result2.status);

    // Only one run was actually created
    const allRuns = persistence.getAllRuns();
    expect(allRuns).toHaveLength(1);
  });

  it("run.create with different key creates a new run", async () => {
    const workflow = createSimpleWorkflow();
    const { kernel } = createTestKernel([workflow]);

    const result1 = await kernel.dispatch({
      type: "run.create",
      idempotencyKey: "key-1",
      workflowId: "test-workflow",
      input: { data: "hello" },
    });

    const result2 = await kernel.dispatch({
      type: "run.create",
      idempotencyKey: "key-2",
      workflowId: "test-workflow",
      input: { data: "hello" },
    });

    expect(result1.workflowRunId).not.toBe(result2.workflowRunId);
  });

  it("job.execute with same idempotencyKey returns cached result", async () => {
    const schema = z.object({ data: z.string() });
    const stage = defineStage({
      id: "transform",
      name: "Transform",
      schemas: { input: schema, output: z.object({ result: z.string() }), config: z.object({}) },
      async execute(ctx) {
        return { output: { result: ctx.input.data.toUpperCase() } };
      },
    });

    const workflow = new WorkflowBuilder(
      "test-workflow", "Test", "Test",
      schema,
      z.object({ result: z.string() }),
    ).pipe(stage).build();

    const { kernel, persistence, eventSink } = createTestKernel([workflow]);

    // Create and manually move to RUNNING
    const createResult = await kernel.dispatch({
      type: "run.create",
      idempotencyKey: "create-for-job-idem",
      workflowId: "test-workflow",
      input: { data: "hello" },
    });
    await persistence.updateRun(createResult.workflowRunId, { status: "RUNNING" });
    eventSink.clear();

    // Execute with an idempotency key
    const result1 = await kernel.dispatch({
      type: "job.execute",
      idempotencyKey: "job-key-1",
      workflowRunId: createResult.workflowRunId,
      workflowId: "test-workflow",
      stageId: "transform",
      config: {},
    });

    // Execute again with the same key
    const result2 = await kernel.dispatch({
      type: "job.execute",
      idempotencyKey: "job-key-1",
      workflowRunId: createResult.workflowRunId,
      workflowId: "test-workflow",
      stageId: "transform",
      config: {},
    });

    // Both results are identical (cached)
    expect(result1.outcome).toBe("completed");
    expect(result2.outcome).toBe("completed");
    expect(result1.output).toEqual(result2.output);
    expect(result1.output).toEqual({ result: "HELLO" });
  });

  it("job.execute without idempotencyKey always executes", async () => {
    const schema = z.object({ data: z.string() });
    let executionCount = 0;
    const stage = defineStage({
      id: "counting",
      name: "Counting",
      schemas: { input: schema, output: z.object({ count: z.number() }), config: z.object({}) },
      async execute() {
        executionCount++;
        return { output: { count: executionCount } };
      },
    });

    const workflow = new WorkflowBuilder(
      "test-workflow", "Test", "Test",
      schema,
      z.object({ count: z.number() }),
    ).pipe(stage).build();

    const { kernel, persistence, eventSink } = createTestKernel([workflow]);

    const createResult = await kernel.dispatch({
      type: "run.create",
      idempotencyKey: "create-for-no-idem",
      workflowId: "test-workflow",
      input: { data: "hello" },
    });
    await persistence.updateRun(createResult.workflowRunId, { status: "RUNNING" });
    eventSink.clear();

    // First execution (no idempotency key)
    const result1 = await kernel.dispatch({
      type: "job.execute",
      workflowRunId: createResult.workflowRunId,
      workflowId: "test-workflow",
      stageId: "counting",
      config: {},
    });
    expect(result1.outcome).toBe("completed");
    expect(executionCount).toBe(1);

    // Second execution without idempotency key -- the stage is already COMPLETED
    // so the handler runs again (not cached) but may fail since the stage is done.
    // The key assertion is that the handler actually ran (executionCount incremented
    // or an error was produced), NOT that a cached result was returned.
    const result2 = await kernel.dispatch({
      type: "job.execute",
      workflowRunId: createResult.workflowRunId,
      workflowId: "test-workflow",
      stageId: "counting",
      config: {},
    });

    // The handler was invoked again (not cached). It may complete or fail
    // depending on whether the handler allows re-execution of a completed stage.
    // Either way execution count went up, proving no caching happened.
    expect(executionCount).toBe(2);
  });

  it("idempotency key is scoped to commandType", async () => {
    const schema = z.object({ data: z.string() });
    const stage = defineStage({
      id: "transform",
      name: "Transform",
      schemas: { input: schema, output: z.object({ result: z.string() }), config: z.object({}) },
      async execute(ctx) {
        return { output: { result: ctx.input.data.toUpperCase() } };
      },
    });

    const workflow = new WorkflowBuilder(
      "test-workflow", "Test", "Test",
      schema,
      z.object({ result: z.string() }),
    ).pipe(stage).build();

    const { kernel, persistence, eventSink } = createTestKernel([workflow]);

    // Dispatch run.create with key "shared-key"
    const createResult = await kernel.dispatch({
      type: "run.create",
      idempotencyKey: "shared-key",
      workflowId: "test-workflow",
      input: { data: "hello" },
    });
    expect(createResult.workflowRunId).toBeDefined();

    // Set up the run for job execution
    await persistence.updateRun(createResult.workflowRunId, { status: "RUNNING" });
    eventSink.clear();

    // Dispatch job.execute with the SAME key "shared-key"
    const jobResult = await kernel.dispatch({
      type: "job.execute",
      idempotencyKey: "shared-key",
      workflowRunId: createResult.workflowRunId,
      workflowId: "test-workflow",
      stageId: "transform",
      config: {},
    });

    // Both commands executed -- idempotency did NOT interfere between types
    expect(createResult.status).toBe("PENDING");
    expect(jobResult.outcome).toBe("completed");
    expect(jobResult.output).toEqual({ result: "HELLO" });
  });

  it("outbox events are NOT duplicated on idempotent replay", async () => {
    const workflow = createSimpleWorkflow();
    const { kernel, flush } = createTestKernel([workflow]);

    // First dispatch produces outbox events
    await kernel.dispatch({
      type: "run.create",
      idempotencyKey: "key-1",
      workflowId: "test-workflow",
      input: { data: "hello" },
    });

    // Flush publishes 1 event
    const flush1 = await flush();
    expect(flush1.published).toBe(1);

    // Replay the same command (idempotent -- returns cached, no new events)
    await kernel.dispatch({
      type: "run.create",
      idempotencyKey: "key-1",
      workflowId: "test-workflow",
      input: { data: "hello" },
    });

    // Second flush should find nothing new
    const flush2 = await flush();
    expect(flush2.published).toBe(0);
  });

  it("rejects commands when the same idempotency key is already in progress", async () => {
    const workflow = createSimpleWorkflow();
    const { kernel, persistence } = createTestKernel([workflow]);

    const acquired = await persistence.acquireIdempotencyKey(
      "in-progress-key",
      "run.create",
    );
    expect(acquired.status).toBe("acquired");

    await expect(
      kernel.dispatch({
        type: "run.create",
        idempotencyKey: "in-progress-key",
        workflowId: "test-workflow",
        input: { data: "hello" },
      }),
    ).rejects.toBeInstanceOf(IdempotencyInProgressError);
  });

  it("releases idempotency key when handler throws", async () => {
    const workflow = createSimpleWorkflow();
    const { kernel, registry } = createTestKernel([]);

    await expect(
      kernel.dispatch({
        type: "run.create",
        idempotencyKey: "release-key",
        workflowId: "test-workflow",
        input: { data: "hello" },
      }),
    ).rejects.toThrow();

    registry.set(workflow.id, workflow);

    const result = await kernel.dispatch({
      type: "run.create",
      idempotencyKey: "release-key",
      workflowId: "test-workflow",
      input: { data: "hello" },
    });
    expect(result.status).toBe("PENDING");
  });

  it("does not persist outbox events when command handler throws", async () => {
    const { kernel } = createTestKernel([]);

    await expect(
      kernel.dispatch({
        type: "run.create",
        idempotencyKey: "no-outbox-on-error",
        workflowId: "missing-workflow",
        input: { data: "hello" },
      }),
    ).rejects.toThrow();

    const flushed = await kernel.dispatch({ type: "outbox.flush" });
    expect(flushed.published).toBe(0);
  });
});
