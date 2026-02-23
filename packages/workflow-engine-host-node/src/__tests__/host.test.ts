/**
 * Node Host Integration Tests
 *
 * Tests the full host lifecycle using in-memory adapters: create a run,
 * start the host, verify the workflow completes end-to-end.
 */

import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { createKernel, type Kernel } from "@bratsos/workflow-engine/kernel";
import {
  FakeClock,
  InMemoryBlobStore,
  CollectingEventSink,
  NoopScheduler,
} from "@bratsos/workflow-engine/kernel/testing";
import { InMemoryWorkflowPersistence } from "@bratsos/workflow-engine/testing";
import { InMemoryJobQueue } from "@bratsos/workflow-engine/testing";
import {
  defineAsyncBatchStage,
  defineStage,
  WorkflowBuilder,
} from "@bratsos/workflow-engine";
import type { Workflow } from "@bratsos/workflow-engine";
import { createNodeHost, type NodeHost } from "../host.js";

// ============================================================================
// Test helpers
// ============================================================================

const schema = z.object({ data: z.string() });
const outputSchema = z.object({ result: z.string() });

function createPassthroughStage(id: string) {
  return defineStage({
    id,
    name: `Stage ${id}`,
    schemas: { input: schema, output: outputSchema, config: z.object({}) },
    async execute(ctx) {
      return { output: { result: ctx.input.data.toUpperCase() } };
    },
  });
}

/** Stage that chains after a passthrough stage — accepts { result } and transforms it. */
function createChainedStage(id: string) {
  return defineStage({
    id,
    name: `Stage ${id}`,
    schemas: { input: outputSchema, output: outputSchema, config: z.object({}) },
    async execute(ctx) {
      return { output: { result: ctx.input.result + "!" } };
    },
  });
}

function createSimpleWorkflow(): Workflow<any, any> {
  const stage = createPassthroughStage("stage-1");
  return new WorkflowBuilder(
    "test-workflow",
    "Test Workflow",
    "Test",
    schema,
    outputSchema,
  )
    .pipe(stage)
    .build();
}

function createTwoStageWorkflow(): Workflow<any, any> {
  const stage1 = createPassthroughStage("stage-1");
  const stage2 = createChainedStage("stage-2");
  return new WorkflowBuilder(
    "two-stage",
    "Two Stage",
    "Test",
    schema,
    outputSchema,
  )
    .pipe(stage1)
    .pipe(stage2)
    .build();
}

function createAsyncBatchWorkflow(): Workflow<any, any> {
  const stage = defineAsyncBatchStage({
    id: "batch-stage",
    name: "Batch Stage",
    mode: "async-batch",
    schemas: { input: schema, output: outputSchema, config: z.object({}) },
    async execute() {
      return {
        suspended: true,
        state: { batchId: "batch-1" },
        pollConfig: {
          pollInterval: 1,
          maxWaitTime: 60_000,
          nextPollAt: new Date(0),
        },
      };
    },
    async checkCompletion() {
      return { ready: true, output: { result: "DONE" } };
    },
  });

  return new WorkflowBuilder(
    "async-batch",
    "Async Batch",
    "Test",
    schema,
    outputSchema,
  )
    .pipe(stage)
    .build();
}

function createTestEnv(workflows: Workflow<any, any>[] = []) {
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

  return { kernel, persistence, blobStore, jobTransport, eventSink, clock };
}

/** Wait for a condition to become true, polling at `intervalMs`. */
async function waitFor(
  fn: () => Promise<boolean>,
  timeoutMs = 5_000,
  intervalMs = 50,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

// ============================================================================
// Tests
// ============================================================================

describe("NodeHost", () => {
  let host: NodeHost | null = null;

  afterEach(async () => {
    if (host) {
      await host.stop();
      host = null;
    }
  });

  it("processes a single-stage workflow end-to-end", async () => {
    const workflow = createSimpleWorkflow();
    const { kernel, persistence, jobTransport } = createTestEnv([workflow]);

    // Create a run
    await kernel.dispatch({
      type: "run.create",
      idempotencyKey: "e2e-1",
      workflowId: "test-workflow",
      input: { data: "hello" },
    });

    // Start host
    host = createNodeHost({
      kernel,
      jobTransport,
      workerId: "test-worker",
      orchestrationIntervalMs: 50,
      jobPollIntervalMs: 20,
      staleLeaseThresholdMs: 60_000,
    });
    await host.start();

    // Wait for completion
    await waitFor(async () => {
      const runs = await persistence.getRunsByStatus("COMPLETED");
      return runs.length > 0;
    });

    // Verify
    const completed = await persistence.getRunsByStatus("COMPLETED");
    expect(completed).toHaveLength(1);

    const stats = host.getStats();
    expect(stats.jobsProcessed).toBe(1);
    expect(stats.isRunning).toBe(true);
  });

  it("processes a two-stage workflow end-to-end", async () => {
    const workflow = createTwoStageWorkflow();
    const { kernel, persistence, jobTransport } = createTestEnv([workflow]);

    await kernel.dispatch({
      type: "run.create",
      idempotencyKey: "e2e-2",
      workflowId: "two-stage",
      input: { data: "hello" },
    });

    host = createNodeHost({
      kernel,
      jobTransport,
      workerId: "test-worker",
      orchestrationIntervalMs: 50,
      jobPollIntervalMs: 20,
    });
    await host.start();

    await waitFor(async () => {
      const runs = await persistence.getRunsByStatus("COMPLETED");
      return runs.length > 0;
    });

    const completed = await persistence.getRunsByStatus("COMPLETED");
    expect(completed).toHaveLength(1);

    // Both stages should have been processed
    const stats = host.getStats();
    expect(stats.jobsProcessed).toBe(2);
  });

  it("transitions runs after suspended stage resumes", async () => {
    const workflow = createAsyncBatchWorkflow();
    const { kernel, persistence, jobTransport } = createTestEnv([workflow]);

    await kernel.dispatch({
      type: "run.create",
      idempotencyKey: "async-batch-1",
      workflowId: "async-batch",
      input: { data: "hello" },
    });

    host = createNodeHost({
      kernel,
      jobTransport,
      workerId: "test-worker",
      orchestrationIntervalMs: 20,
      jobPollIntervalMs: 20,
    });
    await host.start();

    await waitFor(async () => {
      const runs = await persistence.getRunsByStatus("COMPLETED");
      return runs.length > 0;
    });

    const completed = await persistence.getRunsByStatus("COMPLETED");
    expect(completed).toHaveLength(1);
  });

  it("stops gracefully", async () => {
    const workflow = createSimpleWorkflow();
    const { kernel, jobTransport } = createTestEnv([workflow]);

    host = createNodeHost({
      kernel,
      jobTransport,
      workerId: "test-worker",
      orchestrationIntervalMs: 50,
      jobPollIntervalMs: 20,
    });

    await host.start();
    expect(host.getStats().isRunning).toBe(true);

    await host.stop();
    expect(host.getStats().isRunning).toBe(false);
    expect(host.getStats().uptimeMs).toBe(0);
  });

  it("tracks orchestration ticks", async () => {
    const { kernel, jobTransport } = createTestEnv([]);

    host = createNodeHost({
      kernel,
      jobTransport,
      workerId: "test-worker",
      orchestrationIntervalMs: 30,
      jobPollIntervalMs: 20,
    });

    await host.start();

    // Wait for a few ticks
    await new Promise((r) => setTimeout(r, 150));

    const stats = host.getStats();
    // Should have at least the immediate first tick plus a few more
    expect(stats.orchestrationTicks).toBeGreaterThanOrEqual(2);
    expect(stats.workerId).toBe("test-worker");
  });

  it("calling start() twice is safe", async () => {
    const { kernel, jobTransport } = createTestEnv([]);

    host = createNodeHost({
      kernel,
      jobTransport,
      workerId: "test-worker",
      orchestrationIntervalMs: 100,
      jobPollIntervalMs: 50,
    });

    await host.start();
    await host.start(); // should be a no-op

    expect(host.getStats().isRunning).toBe(true);
  });

  it("flushes outbox events through EventSink", async () => {
    const workflow = createSimpleWorkflow();
    const { kernel, persistence, jobTransport, eventSink } =
      createTestEnv([workflow]);

    await kernel.dispatch({
      type: "run.create",
      idempotencyKey: "flush-test",
      workflowId: "test-workflow",
      input: { data: "hello" },
    });

    host = createNodeHost({
      kernel,
      jobTransport,
      workerId: "test-worker",
      orchestrationIntervalMs: 50,
      jobPollIntervalMs: 20,
    });
    await host.start();

    // Wait for workflow to complete
    await waitFor(async () => {
      const runs = await persistence.getRunsByStatus("COMPLETED");
      return runs.length > 0;
    });

    // Give orchestration tick time to flush outbox
    await new Promise((r) => setTimeout(r, 100));

    // Events should have been flushed through EventSink
    expect(eventSink.events.length).toBeGreaterThan(0);
    const types = eventSink.events.map((e) => e.type);
    expect(types).toContain("workflow:created");
    expect(types).toContain("workflow:started");
    expect(types).toContain("workflow:completed");
  });
});
