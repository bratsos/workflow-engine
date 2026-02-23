/**
 * Kernel Tests: run.create command
 *
 * Tests for creating workflow runs via the kernel dispatch interface.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { defineStage } from "../../core/stage-factory.js";
import type { Workflow } from "../../core/workflow.js";
import { WorkflowBuilder } from "../../core/workflow.js";
import { createKernel, type Kernel } from "../../kernel/kernel.js";
import {
  CollectingEventSink,
  FakeClock,
  InMemoryBlobStore,
  NoopScheduler,
} from "../../kernel/testing/index.js";
import { InMemoryJobQueue } from "../../testing/in-memory-job-queue.js";
import { InMemoryWorkflowPersistence } from "../../testing/in-memory-persistence.js";

// Helper: create a simple passthrough stage
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

// Helper: create a simple workflow with one stage
function createSimpleWorkflow(id: string = "test-workflow") {
  const schema = z.object({ data: z.string() });
  const stage = createPassthroughStage("stage-1", schema);
  return new WorkflowBuilder(id, "Test Workflow", "Test", schema, schema)
    .pipe(stage)
    .build();
}

// Helper: create a two-stage workflow
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

describe("kernel: run.create", () => {
  it("creates a workflow run with valid input", async () => {
    const workflow = createSimpleWorkflow();
    const { kernel, flush, persistence, eventSink } = createTestKernel([
      workflow,
    ]);

    const result = await kernel.dispatch({
      type: "run.create",
      idempotencyKey: "key-1",
      workflowId: "test-workflow",
      input: { data: "hello" },
    });

    expect(result.workflowRunId).toBeDefined();
    expect(result.status).toBe("PENDING");

    // Verify persistence
    const run = await persistence.getRun(result.workflowRunId);
    expect(run).not.toBeNull();
    expect(run!.workflowId).toBe("test-workflow");
    expect(run!.status).toBe("PENDING");
    expect(run!.input).toEqual({ data: "hello" });

    // Verify event emitted
    await flush();
    expect(eventSink.events).toHaveLength(1);
    expect(eventSink.events[0]!.type).toBe("workflow:created");
  });

  it("throws on missing workflow", async () => {
    const { kernel } = createTestKernel([]);

    await expect(
      kernel.dispatch({
        type: "run.create",
        idempotencyKey: "key-1",
        workflowId: "nonexistent",
        input: { data: "hello" },
      }),
    ).rejects.toThrow("not found in registry");
  });

  it("throws on invalid input", async () => {
    const workflow = createSimpleWorkflow();
    const { kernel } = createTestKernel([workflow]);

    await expect(
      kernel.dispatch({
        type: "run.create",
        idempotencyKey: "key-1",
        workflowId: "test-workflow",
        input: { wrong: 123 },
      }),
    ).rejects.toThrow("Invalid workflow input");
  });

  it("merges default config with provided config", async () => {
    const workflow = createSimpleWorkflow();
    const { kernel, persistence } = createTestKernel([workflow]);

    const result = await kernel.dispatch({
      type: "run.create",
      idempotencyKey: "key-1",
      workflowId: "test-workflow",
      input: { data: "hello" },
      config: { "stage-1": { verbose: true } },
    });

    const run = await persistence.getRun(result.workflowRunId);
    expect(run!.config).toBeDefined();
  });

  it("uses custom priority", async () => {
    const workflow = createSimpleWorkflow();
    const { kernel, persistence } = createTestKernel([workflow]);

    const result = await kernel.dispatch({
      type: "run.create",
      idempotencyKey: "key-1",
      workflowId: "test-workflow",
      input: { data: "hello" },
      priority: 10,
    });

    const run = await persistence.getRun(result.workflowRunId);
    expect(run!.priority).toBe(10);
  });

  it("defaults priority to 5", async () => {
    const workflow = createSimpleWorkflow();
    const { kernel, persistence } = createTestKernel([workflow]);

    const result = await kernel.dispatch({
      type: "run.create",
      idempotencyKey: "key-1",
      workflowId: "test-workflow",
      input: { data: "hello" },
    });

    const run = await persistence.getRun(result.workflowRunId);
    expect(run!.priority).toBe(5);
  });

  it("passes metadata through", async () => {
    const workflow = createSimpleWorkflow();
    const { kernel } = createTestKernel([workflow]);

    const result = await kernel.dispatch({
      type: "run.create",
      idempotencyKey: "key-1",
      workflowId: "test-workflow",
      input: { data: "hello" },
      metadata: { requestedBy: "user-123" },
    });

    expect(result.workflowRunId).toBeDefined();
  });
});
