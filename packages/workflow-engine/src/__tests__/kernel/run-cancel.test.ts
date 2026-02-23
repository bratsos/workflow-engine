/**
 * Kernel Tests: run.cancel command
 *
 * Tests for cancelling workflow runs via the kernel dispatch interface.
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

describe("kernel: run.cancel", () => {
  it("cancels a running workflow", async () => {
    const workflow = createSimpleWorkflow();
    const { kernel, flush, persistence, eventSink } = createTestKernel([
      workflow,
    ]);

    // Create a run
    const createResult = await kernel.dispatch({
      type: "run.create",
      idempotencyKey: "key-1",
      workflowId: "test-workflow",
      input: { data: "hello" },
    });
    await flush();
    eventSink.clear();

    // Update to RUNNING
    await persistence.updateRun(createResult.workflowRunId, {
      status: "RUNNING",
    });

    // Cancel
    const result = await kernel.dispatch({
      type: "run.cancel",
      workflowRunId: createResult.workflowRunId,
      reason: "user requested",
    });

    expect(result.cancelled).toBe(true);

    // Verify persistence
    const run = await persistence.getRun(createResult.workflowRunId);
    expect(run!.status).toBe("CANCELLED");

    // Verify event
    await flush();
    expect(eventSink.events).toHaveLength(1);
    expect(eventSink.events[0]!.type).toBe("workflow:cancelled");
  });

  it("returns cancelled=false for already completed workflow", async () => {
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
      type: "run.cancel",
      workflowRunId: createResult.workflowRunId,
    });

    expect(result.cancelled).toBe(false);
  });

  it("returns cancelled=false for non-existent run", async () => {
    const { kernel } = createTestKernel([]);

    const result = await kernel.dispatch({
      type: "run.cancel",
      workflowRunId: "nonexistent",
    });

    expect(result.cancelled).toBe(false);
  });

  it("can cancel a pending workflow", async () => {
    const workflow = createSimpleWorkflow();
    const { kernel, persistence } = createTestKernel([workflow]);

    const createResult = await kernel.dispatch({
      type: "run.create",
      idempotencyKey: "key-1",
      workflowId: "test-workflow",
      input: { data: "hello" },
    });

    const result = await kernel.dispatch({
      type: "run.cancel",
      workflowRunId: createResult.workflowRunId,
    });

    expect(result.cancelled).toBe(true);
    const run = await persistence.getRun(createResult.workflowRunId);
    expect(run!.status).toBe("CANCELLED");
  });
});
