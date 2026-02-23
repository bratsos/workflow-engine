/**
 * Serverless Host Integration Tests
 *
 * Tests the serverless host with explicit step-by-step invocations —
 * no background loops, matching the serverless execution model.
 */

import { describe, expect, it } from "vitest";
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
import {
  createServerlessHost,
  type JobMessage,
  type ServerlessHost,
} from "../host.js";

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

const failSchema = z.object({ data: z.string() });
const failOutputSchema = z.object({ result: z.string() });

function createFailingStage(id: string) {
  return defineStage({
    id,
    name: `Stage ${id}`,
    schemas: { input: failSchema, output: failOutputSchema, config: z.object({}) },
    async execute() {
      throw new Error("Stage exploded");
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

function createFailingWorkflow(): Workflow<any, any> {
  const stage = createFailingStage("stage-1");
  return new WorkflowBuilder(
    "failing-workflow",
    "Failing Workflow",
    "Test",
    failSchema,
    failOutputSchema,
  )
    .pipe(stage)
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

/** Dequeue a job and convert it to a JobMessage for the serverless host. */
async function dequeueAsMessage(
  jobTransport: InMemoryJobQueue,
): Promise<JobMessage | null> {
  const job = await jobTransport.dequeue();
  if (!job) return null;
  return {
    jobId: job.jobId,
    workflowRunId: job.workflowRunId,
    workflowId: job.workflowId,
    stageId: job.stageId,
    attempt: job.attempt,
    maxAttempts: job.maxAttempts,
    payload: job.payload,
  };
}

// ============================================================================
// Tests
// ============================================================================

describe("ServerlessHost", () => {
  it("processes a single-stage workflow end-to-end", async () => {
    const workflow = createSimpleWorkflow();
    const { kernel, persistence, jobTransport } = createTestEnv([workflow]);

    const host = createServerlessHost({
      kernel,
      jobTransport,
      workerId: "test-worker",
    });

    // 1. Create a run
    await kernel.dispatch({
      type: "run.create",
      idempotencyKey: "e2e-1",
      workflowId: "test-workflow",
      input: { data: "hello" },
    });

    // 2. Maintenance tick claims the run and enqueues stage-1 job
    const tick = await host.runMaintenanceTick();
    expect(tick.claimed).toBe(1);

    // 3. Dequeue and process the job
    const msg = await dequeueAsMessage(jobTransport);
    expect(msg).not.toBeNull();
    expect(msg!.stageId).toBe("stage-1");

    const result = await host.handleJob(msg!);
    expect(result.outcome).toBe("completed");

    // 4. Run is COMPLETED
    const completed = await persistence.getRunsByStatus("COMPLETED");
    expect(completed).toHaveLength(1);
  });

  it("processes a two-stage workflow end-to-end", async () => {
    const workflow = createTwoStageWorkflow();
    const { kernel, persistence, jobTransport } = createTestEnv([workflow]);

    const host = createServerlessHost({
      kernel,
      jobTransport,
      workerId: "test-worker",
    });

    await kernel.dispatch({
      type: "run.create",
      idempotencyKey: "e2e-2",
      workflowId: "two-stage",
      input: { data: "hello" },
    });

    // Tick → claims run, enqueues stage-1
    await host.runMaintenanceTick();

    // Process stage-1 (handleJob dispatches run.transition which enqueues stage-2)
    const msg1 = await dequeueAsMessage(jobTransport);
    expect(msg1!.stageId).toBe("stage-1");
    const r1 = await host.handleJob(msg1!);
    expect(r1.outcome).toBe("completed");

    // Process stage-2 (already enqueued by run.transition inside handleJob)
    const msg2 = await dequeueAsMessage(jobTransport);
    expect(msg2).not.toBeNull();
    expect(msg2!.stageId).toBe("stage-2");
    const r2 = await host.handleJob(msg2!);
    expect(r2.outcome).toBe("completed");

    // Run is COMPLETED
    const completed = await persistence.getRunsByStatus("COMPLETED");
    expect(completed).toHaveLength(1);
  });

  it("returns structured maintenance tick results", async () => {
    const workflow = createSimpleWorkflow();
    const { kernel, jobTransport } = createTestEnv([workflow]);

    const host = createServerlessHost({
      kernel,
      jobTransport,
      workerId: "test-worker",
    });

    // Create two pending runs
    await kernel.dispatch({
      type: "run.create",
      idempotencyKey: "tick-1",
      workflowId: "test-workflow",
      input: { data: "a" },
    });
    await kernel.dispatch({
      type: "run.create",
      idempotencyKey: "tick-2",
      workflowId: "test-workflow",
      input: { data: "b" },
    });

    const tick = await host.runMaintenanceTick();
    expect(tick.claimed).toBe(2);
    expect(tick.suspendedChecked).toBe(0);
    expect(tick.staleReleased).toBe(0);
    expect(tick.eventsFlushed).toBeGreaterThanOrEqual(0);
  });

  it("returns failed outcome for a throwing stage", async () => {
    const workflow = createFailingWorkflow();
    const { kernel, jobTransport } = createTestEnv([workflow]);

    const host = createServerlessHost({
      kernel,
      jobTransport,
      workerId: "test-worker",
    });

    await kernel.dispatch({
      type: "run.create",
      idempotencyKey: "fail-1",
      workflowId: "failing-workflow",
      input: { data: "boom" },
    });

    await host.runMaintenanceTick();

    const msg = await dequeueAsMessage(jobTransport);
    expect(msg).not.toBeNull();

    const result = await host.handleJob(msg!);
    expect(result.outcome).toBe("failed");
    expect(result.error).toBe("Stage exploded");
  });

  it("transitions runs after suspended stage resumes during maintenance", async () => {
    const workflow = createAsyncBatchWorkflow();
    const { kernel, persistence, jobTransport } = createTestEnv([workflow]);

    const host = createServerlessHost({
      kernel,
      jobTransport,
      workerId: "test-worker",
    });

    await kernel.dispatch({
      type: "run.create",
      idempotencyKey: "async-batch-1",
      workflowId: "async-batch",
      input: { data: "hello" },
    });

    await host.runMaintenanceTick(); // claim + enqueue
    await host.processAvailableJobs(); // execute => suspended
    await host.runMaintenanceTick(); // poll + transition

    const completed = await persistence.getRunsByStatus("COMPLETED");
    expect(completed).toHaveLength(1);
  });

  it("processAvailableJobs completes a single-stage workflow", async () => {
    const workflow = createSimpleWorkflow();
    const { kernel, persistence, jobTransport } = createTestEnv([workflow]);

    const host = createServerlessHost({
      kernel,
      jobTransport,
      workerId: "test-worker",
    });

    await kernel.dispatch({
      type: "run.create",
      idempotencyKey: "paj-1",
      workflowId: "test-workflow",
      input: { data: "hello" },
    });

    // Maintenance tick claims and enqueues
    await host.runMaintenanceTick();

    // processAvailableJobs dequeues and executes — no manual dequeue needed
    const result = await host.processAvailableJobs();
    expect(result.processed).toBe(1);
    expect(result.succeeded).toBe(1);
    expect(result.failed).toBe(0);

    const completed = await persistence.getRunsByStatus("COMPLETED");
    expect(completed).toHaveLength(1);
  });

  it("processAvailableJobs completes a two-stage workflow across invocations", async () => {
    const workflow = createTwoStageWorkflow();
    const { kernel, persistence, jobTransport } = createTestEnv([workflow]);

    const host = createServerlessHost({
      kernel,
      jobTransport,
      workerId: "test-worker",
    });

    await kernel.dispatch({
      type: "run.create",
      idempotencyKey: "paj-2",
      workflowId: "two-stage",
      input: { data: "hello" },
    });

    await host.runMaintenanceTick();

    // Invocation 1: processes stage-1 (enqueues stage-2 via run.transition)
    const r1 = await host.processAvailableJobs();
    expect(r1.processed).toBe(1);
    expect(r1.succeeded).toBe(1);

    // Invocation 2: processes stage-2
    const r2 = await host.processAvailableJobs();
    expect(r2.processed).toBe(1);
    expect(r2.succeeded).toBe(1);

    const completed = await persistence.getRunsByStatus("COMPLETED");
    expect(completed).toHaveLength(1);
  });

  it("processAvailableJobs respects maxJobs limit", async () => {
    const workflow = createSimpleWorkflow();
    const { kernel, jobTransport } = createTestEnv([workflow]);

    const host = createServerlessHost({
      kernel,
      jobTransport,
      workerId: "test-worker",
    });

    // Create 3 runs
    for (let i = 0; i < 3; i++) {
      await kernel.dispatch({
        type: "run.create",
        idempotencyKey: `limit-${i}`,
        workflowId: "test-workflow",
        input: { data: `item-${i}` },
      });
    }

    await host.runMaintenanceTick();

    // Only process 2 of 3
    const result = await host.processAvailableJobs({ maxJobs: 2 });
    expect(result.processed).toBe(2);

    // 1 job still pending
    const remaining = jobTransport.getJobsByStatus("PENDING");
    expect(remaining).toHaveLength(1);
  });

  it("processAvailableJobs returns zero when queue is empty", async () => {
    const { kernel, jobTransport } = createTestEnv([]);

    const host = createServerlessHost({
      kernel,
      jobTransport,
      workerId: "test-worker",
    });

    const result = await host.processAvailableJobs();
    expect(result.processed).toBe(0);
    expect(result.succeeded).toBe(0);
    expect(result.failed).toBe(0);
  });

  it("flushes outbox events through EventSink", async () => {
    const workflow = createSimpleWorkflow();
    const { kernel, persistence, jobTransport, eventSink } =
      createTestEnv([workflow]);

    const host = createServerlessHost({
      kernel,
      jobTransport,
      workerId: "test-worker",
    });

    await kernel.dispatch({
      type: "run.create",
      idempotencyKey: "flush-1",
      workflowId: "test-workflow",
      input: { data: "hello" },
    });

    // Tick 1: claim + flush (publishes workflow:created + workflow:started)
    await host.runMaintenanceTick();

    // Process the job
    const msg = await dequeueAsMessage(jobTransport);
    await host.handleJob(msg!);

    // Tick 2: flush remaining events (stage + workflow completion)
    const tick2 = await host.runMaintenanceTick();
    expect(tick2.eventsFlushed).toBeGreaterThan(0);

    // Verify events reached the sink
    const types = eventSink.events.map((e) => e.type);
    expect(types).toContain("workflow:created");
    expect(types).toContain("workflow:started");
    expect(types).toContain("workflow:completed");
  });
});
