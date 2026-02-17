/**
 * Kernel Tests: outbox.flush command
 *
 * Tests for the transactional outbox pattern: events are written to an
 * outbox during command dispatch and only published to EventSink when
 * `outbox.flush` is dispatched.
 */

import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createKernel } from "../../kernel/kernel.js";
import {
  FakeClock,
  InMemoryBlobStore,
  CollectingEventSink,
  NoopScheduler,
} from "../../kernel/testing/index.js";
import { definePlugin, createPluginRunner } from "../../kernel/plugins.js";
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

function createTestKernelWithPlugins(
  workflows: Workflow<any, any>[] = [],
  plugins: ReturnType<typeof definePlugin>[] = [],
  maxRetries = 3,
) {
  const persistence = new InMemoryWorkflowPersistence();
  const blobStore = new InMemoryBlobStore();
  const jobTransport = new InMemoryJobQueue("test-worker");
  const eventSink = createPluginRunner({ plugins, maxRetries });
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

describe("kernel: outbox.flush", () => {
  it("events are written to outbox after dispatch, not emitted directly", async () => {
    const workflow = createSimpleWorkflow();
    const { kernel, flush, eventSink } = createTestKernel([workflow]);

    await kernel.dispatch({
      type: "run.create",
      idempotencyKey: "outbox-1",
      workflowId: "test-workflow",
      input: { data: "hello" },
    });

    // Events went to the outbox, NOT directly to EventSink
    expect(eventSink.events).toHaveLength(0);

    // Flushing publishes them
    await flush();
    expect(eventSink.events).toHaveLength(1);
    expect(eventSink.events[0]!.type).toBe("workflow:created");
  });

  it("outbox.flush publishes events to EventSink", async () => {
    const workflow = createSimpleWorkflow();
    const { kernel, flush, eventSink } = createTestKernel([workflow]);

    await kernel.dispatch({
      type: "run.create",
      idempotencyKey: "outbox-2",
      workflowId: "test-workflow",
      input: { data: "hello" },
    });

    const result1 = await flush();
    expect(result1.published).toBe(1);
    expect(eventSink.events).toHaveLength(1);
    expect(eventSink.events[0]!.type).toBe("workflow:created");

    // Second flush has nothing left to publish
    const result2 = await flush();
    expect(result2.published).toBe(0);
  });

  it("flush respects maxEvents limit", async () => {
    const workflow = createSimpleWorkflow();
    const { kernel, eventSink } = createTestKernel([workflow]);

    // Create two separate runs (two outbox events)
    await kernel.dispatch({
      type: "run.create",
      idempotencyKey: "outbox-3a",
      workflowId: "test-workflow",
      input: { data: "first" },
    });

    await kernel.dispatch({
      type: "run.create",
      idempotencyKey: "outbox-3b",
      workflowId: "test-workflow",
      input: { data: "second" },
    });

    // Flush with limit of 1
    const result1 = await kernel.dispatch({
      type: "outbox.flush" as const,
      maxEvents: 1,
    });
    expect(result1.published).toBe(1);
    expect(eventSink.events).toHaveLength(1);

    // Flush again picks up the remaining event
    const result2 = await kernel.dispatch({
      type: "outbox.flush" as const,
      maxEvents: 1,
    });
    expect(result2.published).toBe(1);
    expect(eventSink.events).toHaveLength(2);
  });

  it("second flush returns 0 after all events published", async () => {
    const workflow = createSimpleWorkflow();
    const { kernel, flush } = createTestKernel([workflow]);

    await kernel.dispatch({
      type: "run.create",
      idempotencyKey: "outbox-4",
      workflowId: "test-workflow",
      input: { data: "hello" },
    });

    const result1 = await flush();
    expect(result1.published).toBe(1);

    const result2 = await flush();
    expect(result2.published).toBe(0);
  });

  it("events have correct per-run monotonic sequences", async () => {
    const workflow = createSimpleWorkflow();
    const { kernel, flush, eventSink } = createTestKernel([workflow]);

    // Create a run (produces workflow:created)
    const createResult = await kernel.dispatch({
      type: "run.create",
      idempotencyKey: "outbox-5",
      workflowId: "test-workflow",
      input: { data: "hello" },
    });

    // Claim the run (produces workflow:started)
    await kernel.dispatch({
      type: "run.claimPending",
      workerId: "test-worker",
    });

    // Flush all events
    await flush();

    // Both events should have arrived in order: created then started
    expect(eventSink.events.length).toBeGreaterThanOrEqual(2);
    expect(eventSink.events[0]!.type).toBe("workflow:created");
    expect(eventSink.events[1]!.type).toBe("workflow:started");

    // Both events reference the same run
    expect(eventSink.events[0]!.workflowRunId).toBe(createResult.workflowRunId);
    expect(eventSink.events[1]!.workflowRunId).toBe(createResult.workflowRunId);
  });

  it("events from multiple runs have independent sequences", async () => {
    const workflow = createSimpleWorkflow();
    const { kernel, flush, eventSink } = createTestKernel([workflow]);

    const result1 = await kernel.dispatch({
      type: "run.create",
      idempotencyKey: "outbox-6a",
      workflowId: "test-workflow",
      input: { data: "first" },
    });

    const result2 = await kernel.dispatch({
      type: "run.create",
      idempotencyKey: "outbox-6b",
      workflowId: "test-workflow",
      input: { data: "second" },
    });

    const flushResult = await flush();
    expect(flushResult.published).toBe(2);

    // Both events are workflow:created
    expect(eventSink.events).toHaveLength(2);
    expect(eventSink.events[0]!.type).toBe("workflow:created");
    expect(eventSink.events[1]!.type).toBe("workflow:created");

    // They reference different runs
    const runIds = eventSink.events.map((e) => e.workflowRunId);
    expect(runIds).toContain(result1.workflowRunId);
    expect(runIds).toContain(result2.workflowRunId);
    expect(result1.workflowRunId).not.toBe(result2.workflowRunId);
  });

  it("retries event on next flush when plugin handler throws", async () => {
    let callCount = 0;
    const plugin = definePlugin({
      id: "flaky-plugin",
      name: "Flaky Plugin",
      on: ["workflow:created"],
      handle: async () => {
        callCount++;
        if (callCount === 1) throw new Error("transient failure");
      },
    });

    const workflow = createSimpleWorkflow();
    const { kernel, flush } = createTestKernelWithPlugins([workflow], [plugin]);

    await kernel.dispatch({
      type: "run.create",
      idempotencyKey: "retry-1",
      workflowId: "test-workflow",
      input: { data: "hello" },
    });

    // First flush: plugin throws, event stays unpublished
    const result1 = await flush();
    expect(result1.published).toBe(0);
    expect(callCount).toBe(1);

    // Second flush: plugin succeeds
    const result2 = await flush();
    expect(result2.published).toBe(1);
    expect(callCount).toBe(2);
  });

  it("moves event to DLQ after maxRetries exhausted", async () => {
    const plugin = definePlugin({
      id: "always-fails",
      name: "Always Fails",
      on: ["workflow:created"],
      handle: async () => {
        throw new Error("permanent failure");
      },
    });

    const workflow = createSimpleWorkflow();
    const { kernel, flush } = createTestKernelWithPlugins(
      [workflow],
      [plugin],
      2, // maxRetries = 2
    );

    await kernel.dispatch({
      type: "run.create",
      idempotencyKey: "dlq-1",
      workflowId: "test-workflow",
      input: { data: "hello" },
    });

    // Flush 1: fails, retryCount -> 1
    await flush();
    // Flush 2: fails, retryCount -> 2, moved to DLQ
    await flush();

    // Flush 3: no events left (DLQ events are excluded)
    const result3 = await flush();
    expect(result3.published).toBe(0);
  });

  it("published count reflects only successfully published events", async () => {
    const plugin = definePlugin({
      id: "always-fails",
      name: "Always Fails",
      on: ["workflow:created"],
      handle: async () => {
        throw new Error("fail");
      },
    });

    const workflow = createSimpleWorkflow();
    const { kernel, flush } = createTestKernelWithPlugins([workflow], [plugin]);

    await kernel.dispatch({
      type: "run.create",
      idempotencyKey: "count-1",
      workflowId: "test-workflow",
      input: { data: "hello" },
    });

    const result = await flush();
    expect(result.published).toBe(0);
  });
});
