/**
 * Serverless Host Integration Tests
 *
 * Tests the serverless host with explicit step-by-step invocations —
 * no background loops, matching the serverless execution model.
 */

import type { Workflow } from "@bratsos/workflow-engine";
import { defineStage, WorkflowBuilder } from "@bratsos/workflow-engine";
import {
  createKernel,
  type MaintenanceTickCounts,
} from "@bratsos/workflow-engine/kernel";
import {
  CollectingEventSink,
  FakeClock,
  InMemoryBlobStore,
} from "@bratsos/workflow-engine/kernel/testing";
import {
  InMemoryJobQueue,
  InMemoryStepLedger,
  InMemoryWorkflowPersistence,
} from "@bratsos/workflow-engine/testing";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createServerlessHost, type JobMessage } from "../host.js";

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
    schemas: {
      input: outputSchema,
      output: outputSchema,
      config: z.object({}),
    },
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
    schemas: {
      input: failSchema,
      output: failOutputSchema,
      config: z.object({}),
    },
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
  const stage = defineStage({
    id: "batch-stage",
    name: "Batch Stage",
    mode: "async-batch",
    schemas: { input: schema, output: outputSchema, config: z.object({}) },
    async execute() {
      return {
        suspended: true,
        state: {
          batchId: "batch-1",
          submittedAt: new Date(0).toISOString(),
          pollInterval: 1,
          maxWaitTime: 60_000,
        },
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

function createTestEnv(
  workflows: Workflow<any, any>[] = [],
  extra: { stepLedger?: InMemoryStepLedger } = {},
) {
  const persistence = new InMemoryWorkflowPersistence();
  const blobStore = new InMemoryBlobStore();
  const jobTransport = new InMemoryJobQueue("test-worker");
  const eventSink = new CollectingEventSink();
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
    clock,
    registry: { getWorkflow: (id) => registry.get(id) },
    ...extra,
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
  it("flushes at the end of maintenance and job processing invocations", async () => {
    const { kernel, jobTransport } = createTestEnv();
    const flush = vi.spyOn(kernel, "flush");
    const host = createServerlessHost({
      kernel,
      jobTransport,
      workerId: "test-worker",
    });
    await host.runMaintenanceTick();
    await host.processAvailableJobs();
    expect(flush).toHaveBeenCalledTimes(2);
  });

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

  it("purges finished runs past the retention age only when retention is set", async () => {
    const workflow = createSimpleWorkflow();
    const { kernel, persistence, jobTransport } = createTestEnv([workflow]);
    const hostWithoutRetention = createServerlessHost({
      kernel,
      jobTransport,
      workerId: "test-worker",
    });
    const host = createServerlessHost({
      kernel,
      jobTransport,
      workerId: "test-worker",
      retention: { olderThanMs: 0 },
    });

    const { workflowRunId } = await kernel.dispatch({
      type: "run.create",
      idempotencyKey: "retention-1",
      workflowId: "test-workflow",
      input: { data: "hello" },
    });
    await hostWithoutRetention.runMaintenanceTick();
    const msg = await dequeueAsMessage(jobTransport);
    await host.handleJob(msg!);
    expect((await persistence.getRun(workflowRunId))?.status).toBe("COMPLETED");

    // Off by default: the finished run survives a tick without retention.
    const untouched = await hostWithoutRetention.runMaintenanceTick();
    expect(untouched.purged).toBe(0);
    expect(await persistence.getRun(workflowRunId)).not.toBeNull();

    // Opted in: the same tick deletes it and reports the count.
    const tick = await host.runMaintenanceTick();
    expect(tick.purged).toBe(1);
    expect(await persistence.getRun(workflowRunId)).toBeNull();
    expect(await persistence.getStagesByRun(workflowRunId)).toEqual([]);
  });

  it("re-enqueues a failed stage with attempts left and completes the run on the retry", async () => {
    let calls = 0;
    const flaky = defineStage({
      id: "flaky",
      name: "Flaky",
      schemas: { input: schema, output: outputSchema, config: z.object({}) },
      async execute(ctx) {
        calls++;
        if (calls === 1) throw new Error("transient failure");
        return { output: { result: ctx.input.data.toUpperCase() } };
      },
    });
    const workflow = new WorkflowBuilder(
      "flaky-wf",
      "Flaky",
      "Test",
      schema,
      outputSchema,
    )
      .pipe(flaky)
      .build();
    const { kernel, persistence, jobTransport, eventSink } = createTestEnv([
      workflow,
    ]);
    const host = createServerlessHost({
      kernel,
      jobTransport,
      workerId: "test-worker",
    });
    const created = await kernel.dispatch({
      type: "run.create",
      idempotencyKey: "flaky-1",
      workflowId: "flaky-wf",
      input: { data: "hello" },
    });
    await host.runMaintenanceTick();

    const first = await host.handleJob((await dequeueAsMessage(jobTransport))!);
    expect(first.outcome).toBe("failed");
    // Retry pending: the stage is not FAILED and the run is still RUNNING.
    const [afterFirst] = await persistence.getStagesByRun(
      created.workflowRunId,
    );
    expect(afterFirst).toMatchObject({
      status: "PENDING",
      errorMessage: "transient failure",
    });
    expect((await persistence.getRun(created.workflowRunId))?.status).toBe(
      "RUNNING",
    );

    // The transport re-queued the job (attempt 2) without any maintenance.
    const retry = await dequeueAsMessage(jobTransport);
    expect(retry).toMatchObject({ stageId: "flaky", attempt: 2 });
    const second = await host.handleJob(retry!);
    expect(second.outcome).toBe("completed");
    expect(calls).toBe(2);
    const run = await persistence.getRun(created.workflowRunId);
    expect(run?.status).toBe("COMPLETED");
    expect(run?.output).toEqual({ result: "HELLO" });
    // Events for the completed run were published by handleJob itself.
    expect(eventSink.events.some((e) => e.type === "workflow:completed")).toBe(
      true,
    );
  });

  it("reports the retry contract on the job result for a push transport to act on", async () => {
    const workflow = createFailingWorkflow();
    const { kernel, jobTransport } = createTestEnv([workflow]);
    jobTransport.setDefaultMaxAttempts(3);
    const host = createServerlessHost({
      kernel,
      jobTransport,
      workerId: "test-worker",
    });
    await kernel.dispatch({
      type: "run.create",
      idempotencyKey: "retry-contract-1",
      workflowId: "failing-workflow",
      input: { data: "boom" },
    });
    await host.runMaintenanceTick();

    const first = await host.handleJob((await dequeueAsMessage(jobTransport))!);
    // Attempts left: the consumer must redeliver after the backoff.
    expect(first).toEqual({
      outcome: "failed",
      error: "Stage exploded",
      willRetry: true,
      attempt: 1,
      maxAttempts: 3,
      retryDelayMs: 2_000,
    });

    const second = await host.handleJob(
      (await dequeueAsMessage(jobTransport))!,
    );
    expect(second).toMatchObject({
      willRetry: true,
      attempt: 2,
      retryDelayMs: 4_000,
    });
    const third = await host.handleJob((await dequeueAsMessage(jobTransport))!);
    // Budget exhausted: settled, acknowledge.
    expect(third).toEqual({
      outcome: "failed",
      error: "Stage exploded",
      willRetry: false,
      attempt: 3,
      maxAttempts: 3,
    });
  });

  it("rejects a malformed job message as a dead job instead of throwing", async () => {
    const workflow = createSimpleWorkflow();
    const { kernel, jobTransport, persistence } = createTestEnv([workflow]);
    const host = createServerlessHost({
      kernel,
      jobTransport,
      workerId: "test-worker",
    });
    const created = await kernel.dispatch({
      type: "run.create",
      idempotencyKey: "malformed-1",
      workflowId: "test-workflow",
      input: { data: "hello" },
    });
    await host.runMaintenanceTick();
    const msg = (await dequeueAsMessage(jobTransport))!;

    // No payload: previously a TypeError from inside job.execute.
    const noPayload = await host.handleJob({
      ...msg,
      payload: undefined as unknown as Record<string, unknown>,
    });
    expect(noPayload).toMatchObject({
      outcome: "failed",
      dead: true,
      error: expect.stringContaining("Invalid job message: payload"),
    });
    // The job row was failed and acknowledged, the stage untouched.
    expect(jobTransport.getJobsByStatus("FAILED")).toHaveLength(1);
    const [stage] = await persistence.getStagesByRun(created.workflowRunId);
    expect(stage?.status).toBe("PENDING");

    // No workflowId: previously "Workflow undefined not found".
    const noWorkflow = await host.handleJob({
      ...msg,
      workflowId: undefined as unknown as string,
    });
    expect(noWorkflow).toMatchObject({
      outcome: "failed",
      dead: true,
      error: expect.stringContaining("workflowId"),
    });
  });

  it("finalises the job row when a suspended stage fails for good from the poll path", async () => {
    let attempts = 0;
    const flaky = defineStage({
      id: "flaky-step",
      name: "Flaky Step",
      schemas: { input: schema, output: outputSchema, config: z.object({}) },
      async execute(ctx) {
        const value = await ctx.step.run(
          "call",
          async () => {
            attempts++;
            throw new Error(`upstream down (${attempts})`);
          },
          { retries: 1, retryDelayMs: 1_000 },
        );
        return { output: { result: String(value) } };
      },
    });
    const workflow = new WorkflowBuilder(
      "flaky-step-wf",
      "Flaky Step",
      "Test",
      schema,
      outputSchema,
    )
      .pipe(flaky)
      .build();
    const { kernel, persistence, jobTransport, clock } = createTestEnv(
      [workflow],
      { stepLedger: new InMemoryStepLedger() },
    );
    const host = createServerlessHost({
      kernel,
      jobTransport,
      workerId: "test-worker",
    });
    const created = await kernel.dispatch({
      type: "run.create",
      idempotencyKey: "flaky-step-1",
      workflowId: "flaky-step-wf",
      input: { data: "x" },
    });
    await host.runMaintenanceTick();

    // The step retry suspends the stage (and the job row).
    const first = await host.handleJob((await dequeueAsMessage(jobTransport))!);
    expect(first.outcome).toBe("suspended");
    expect(jobTransport.getJobsByStatus("SUSPENDED")).toHaveLength(1);

    // The retry runs inside stage.pollSuspended and spends the step's own
    // retries; the stage is then retried with the attempts its job has left.
    clock.advance(2_000);
    const tick = await host.runMaintenanceTick();
    expect(tick.suspendedChecked).toBe(1);
    expect(attempts).toBe(2);
    expect((await persistence.getRun(created.workflowRunId))?.status).toBe(
      "RUNNING",
    );
    expect(jobTransport.getJobsByStatus("SUSPENDED")).toHaveLength(1);

    // Each remaining attempt runs the step once more; the last fails for good.
    for (let i = 0; i < 2; i++) {
      clock.advance(10_000);
      await host.runMaintenanceTick();
    }
    expect(attempts).toBe(4);
    expect((await persistence.getRun(created.workflowRunId))?.status).toBe(
      "FAILED",
    );
    const [stage] = await persistence.getStagesByRun(created.workflowRunId);
    expect(stage?.status).toBe("FAILED");
    // The job row does not stay SUSPENDED with completedAt null.
    expect(jobTransport.getJobsByStatus("SUSPENDED")).toHaveLength(0);
    const [job] = jobTransport.getJobsByStatus("FAILED");
    expect(job).toMatchObject({
      stageId: "flaky-step",
      lastError: "upstream down (4)",
    });
    expect(job?.completedAt).toBeInstanceOf(Date);
  });

  it("fails the run immediately with the stage error when no attempts remain", async () => {
    const workflow = createFailingWorkflow();
    const { kernel, persistence, jobTransport, eventSink } = createTestEnv([
      workflow,
    ]);
    jobTransport.setDefaultMaxAttempts(1);
    const host = createServerlessHost({
      kernel,
      jobTransport,
      workerId: "test-worker",
    });
    const created = await kernel.dispatch({
      type: "run.create",
      idempotencyKey: "fail-terminal-1",
      workflowId: "failing-workflow",
      input: { data: "boom" },
    });
    await host.runMaintenanceTick();

    const result = await host.handleJob(
      (await dequeueAsMessage(jobTransport))!,
    );

    expect(result.outcome).toBe("failed");
    // No maintenance tick, no reapStuck: the run is FAILED right away.
    const run = await persistence.getRun(created.workflowRunId);
    expect(run?.status).toBe("FAILED");
    const [stageRecord] = await persistence.getStagesByRun(
      created.workflowRunId,
    );
    expect(stageRecord).toMatchObject({
      status: "FAILED",
      errorMessage: "Stage exploded",
    });
    const failedEvent = eventSink.events.find(
      (e) => e.type === "workflow:failed",
    );
    expect((failedEvent as { error?: string } | undefined)?.error).toBe(
      "Stage exploded",
    );
  });

  it("ends a job redelivered after its stage failed for good without running the stage again", async () => {
    let receipts = 0;
    const stage = defineStage({
      id: "stage-1",
      name: "Stage 1",
      schemas: { input: schema, output: outputSchema, config: z.object({}) },
      async execute(ctx) {
        await ctx.step.run("receipt", async () => ++receipts);
        throw new Error("provider unavailable");
      },
    });
    const workflow = new WorkflowBuilder(
      "receipt-wf",
      "Receipt",
      "Test",
      schema,
      outputSchema,
    )
      .pipe(stage)
      .build();
    const { kernel, persistence, jobTransport, eventSink } = createTestEnv(
      [workflow],
      { stepLedger: new InMemoryStepLedger() },
    );
    jobTransport.setDefaultMaxAttempts(1);
    const host = createServerlessHost({
      kernel,
      jobTransport,
      workerId: "test-worker",
    });
    const created = await kernel.dispatch({
      type: "run.create",
      idempotencyKey: "redelivered-1",
      workflowId: "receipt-wf",
      input: { data: "hello" },
    });
    await host.runMaintenanceTick();

    // The only attempt fails the stage for good; the worker dies before it
    // acknowledges the job, so the lease is reaped and the job delivered again.
    const first = (await dequeueAsMessage(jobTransport))!;
    await kernel.dispatch({
      type: "job.execute",
      workflowRunId: first.workflowRunId,
      workflowId: first.workflowId,
      stageId: first.stageId,
      config: {},
      attempt: first.attempt,
      maxAttempts: first.maxAttempts,
    });
    await jobTransport.releaseStaleJobs(-1);
    const stagesBefore = await persistence.getStagesByRun(
      created.workflowRunId,
    );
    expect(stagesBefore).toMatchObject([{ status: "FAILED" }]);
    const again = (await dequeueAsMessage(jobTransport))!;
    expect(again).toMatchObject({ attempt: 2, maxAttempts: 1 });

    const result = await host.handleJob(again);

    expect(result).toMatchObject({
      outcome: "failed",
      error: "provider unavailable",
      willRetry: false,
    });
    expect(receipts).toBe(1);
    expect(await persistence.getStagesByRun(created.workflowRunId)).toEqual(
      stagesBefore,
    );
    expect((await persistence.getRun(created.workflowRunId))?.status).toBe(
      "FAILED",
    );
    expect(
      eventSink.events.filter((e) => e.type === "stage:started"),
    ).toHaveLength(1);
    expect(
      eventSink.events.filter((e) => e.type === "workflow:failed"),
    ).toHaveLength(1);
  });

  it("publishes a completed run's events from handleJob without a maintenance tick", async () => {
    const workflow = createSimpleWorkflow();
    const { kernel, jobTransport, eventSink } = createTestEnv([workflow]);
    const host = createServerlessHost({
      kernel,
      jobTransport,
      workerId: "test-worker",
    });
    await kernel.dispatch({
      type: "run.create",
      idempotencyKey: "flush-after-job-1",
      workflowId: "test-workflow",
      input: { data: "hello" },
    });
    await host.runMaintenanceTick();
    eventSink.clear();

    await host.handleJob((await dequeueAsMessage(jobTransport))!);

    expect(eventSink.events.map((e) => e.type)).toEqual(
      expect.arrayContaining(["stage:completed", "workflow:completed"]),
    );
  });

  it("treats a job for a run that no longer exists as dead without throwing", async () => {
    const workflow = createSimpleWorkflow();
    const { kernel, jobTransport } = createTestEnv([workflow]);
    const host = createServerlessHost({
      kernel,
      jobTransport,
      workerId: "test-worker",
    });
    // An orphan queue row: its run was deleted.
    await jobTransport.enqueueParallel([
      {
        workflowRunId: "run-that-does-not-exist",
        workflowId: "test-workflow",
        stageId: "stage-1",
        payload: {},
      },
    ]);

    const result = await host.processAvailableJobs({ maxJobs: 5 });

    expect(result).toEqual({ processed: 1, succeeded: 0, failed: 1 });
    // The dead job was acknowledged: nothing is left to dequeue.
    expect(await jobTransport.dequeue()).toBeNull();
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

  it("processAvailableJobs runs every job it dequeues without checking the storage again", async () => {
    const workflow = createSimpleWorkflow();
    const { kernel, persistence, jobTransport } = createTestEnv([workflow]);
    const host = createServerlessHost({
      kernel,
      jobTransport,
      workerId: "test-worker",
    });
    await kernel.dispatch({
      type: "run.create",
      idempotencyKey: "paj-check",
      workflowId: "test-workflow",
      input: { data: "hello" },
    });
    await host.runMaintenanceTick();
    // Passes once, then refuses: a check made after the dequeue would throw
    // with the job claimed and its attempt counted.
    let checks = 0;
    (jobTransport as any).verifyStorage = async () => {
      if (++checks > 1) throw new Error("refused after the dequeue");
    };
    await expect(host.processAvailableJobs()).resolves.toMatchObject({
      processed: 1,
      succeeded: 1,
    });
    expect(checks).toBe(1);
    expect(await persistence.getRunsByStatus("COMPLETED")).toHaveLength(1);
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
    const { kernel, persistence, jobTransport, eventSink } = createTestEnv([
      workflow,
    ]);

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

    // handleJob already flushed the completion events itself, so the next
    // tick finds nothing left to publish.
    const tick2 = await host.runMaintenanceTick();
    expect(tick2.eventsFlushed).toBe(0);

    // Verify events reached the sink
    const types = eventSink.events.map((e) => e.type);
    expect(types).toContain("workflow:created");
    expect(types).toContain("workflow:started");
    expect(types).toContain("workflow:completed");
  });
  it("calls onTick with the counts the tick returns", async () => {
    const workflow = createSimpleWorkflow();
    const { kernel, jobTransport } = createTestEnv([workflow]);
    const seen: MaintenanceTickCounts[] = [];
    const host = createServerlessHost({
      kernel,
      jobTransport,
      workerId: "test-worker",
      onTick: (counts) => {
        seen.push(counts);
      },
    });
    await kernel.dispatch({
      type: "run.create",
      idempotencyKey: "on-tick-1",
      workflowId: workflow.id,
      input: { data: "hello" },
    });

    const tick = await host.runMaintenanceTick();
    await host.runMaintenanceTick();

    expect(tick.claimed).toBe(1);
    expect(seen).toHaveLength(2);
    expect(seen[0]).toEqual(tick);
    expect(seen[1]?.claimed).toBe(0);
  });

  it("logs a hook that throws or rejects and still returns the counts", async () => {
    const { kernel, jobTransport } = createTestEnv([]);
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      let calls = 0;
      const host = createServerlessHost({
        kernel,
        jobTransport,
        workerId: "test-worker",
        onTick: async () => {
          calls++;
          if (calls === 1) throw new Error("hook threw");
          return Promise.reject(new Error("hook rejected"));
        },
      });

      const first = await host.runMaintenanceTick();
      const second = await host.runMaintenanceTick();

      expect(first.claimed).toBe(0);
      expect(second.claimed).toBe(0);
      expect(calls).toBe(2);
      const messages = logged.mock.calls.map((args) => String(args[1]));
      expect(messages).toContain("Error: hook threw");
      expect(messages).toContain("Error: hook rejected");
    } finally {
      logged.mockRestore();
    }
  });

  it("returns the counts after onTickTimeoutMs (default 5 s) when a hook never settles", async () => {
    const { kernel, jobTransport } = createTestEnv([]);
    const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.useFakeTimers();
    try {
      let calls = 0;
      const host = createServerlessHost({
        kernel,
        jobTransport,
        workerId: "test-worker",
        onTick: () => {
          calls++;
          return new Promise<void>(() => {});
        },
      });
      let result:
        | Awaited<ReturnType<typeof host.runMaintenanceTick>>
        | undefined;
      const ticking = host.runMaintenanceTick().then((counts) => {
        result = counts;
      });

      await vi.advanceTimersByTimeAsync(4_999);
      expect(calls).toBe(1);
      expect(result).toBeUndefined();
      expect(warned).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      await ticking;
      expect(result?.claimed).toBe(0);
      expect(String(warned.mock.calls[0]?.[0])).toContain(
        "onTick hook did not settle within 5000 ms",
      );
      expect(warned).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
      warned.mockRestore();
    }
  });

  it("uses onTickTimeoutMs as the bound", async () => {
    const { kernel, jobTransport } = createTestEnv([]);
    const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const host = createServerlessHost({
        kernel,
        jobTransport,
        workerId: "test-worker",
        onTickTimeoutMs: 30,
        onTick: () => new Promise<void>(() => {}),
      });
      const started = Date.now();
      const counts = await host.runMaintenanceTick();
      expect(Date.now() - started).toBeLessThan(2_000);
      expect(counts.claimed).toBe(0);
      expect(warned).toHaveBeenCalledTimes(1);
    } finally {
      warned.mockRestore();
    }
  });

  // Every option that reaches setTimeout or setInterval is checked at
  // construction: Infinity, NaN, zero, a negative number or more than 2**31 - 1
  // would otherwise become a 1 ms timer (or none).
  for (const option of [
    "onTickTimeoutMs",
    "outboxFlushTimeoutMs",
    "jobHeartbeatIntervalMs",
  ] as const) {
    it(`rejects ${option} when a timer cannot honour it`, () => {
      const { kernel, jobTransport } = createTestEnv([]);
      const create = (value: unknown) =>
        createServerlessHost({
          kernel,
          jobTransport,
          workerId: "test-worker",
          [option]: value,
        });
      for (const bad of [
        Infinity,
        -Infinity,
        NaN,
        0,
        -5,
        0.5,
        2 ** 31,
        "5000",
      ]) {
        expect(() => create(bad), `${option}: ${String(bad)}`).toThrow(
          new RegExp(`${option} must be a number of milliseconds`),
        );
      }
      expect(() => create(1)).not.toThrow();
      expect(() => create(2 ** 31 - 1)).not.toThrow();
    });
  }

  it("rejects an onTick that is not a function", () => {
    const { kernel, jobTransport } = createTestEnv([]);
    for (const [bad, message] of [
      ["x", "x"],
      [5, "5"],
      [{}, "[object Object]"],
      [Object.create(null), "Unprintable error"],
    ]) {
      expect(
        () =>
          createServerlessHost({
            kernel,
            jobTransport,
            workerId: "test-worker",
            onTick: bad as never,
          }),
        message,
      ).toThrow(new TypeError(`onTick must be a function, got ${message}.`));
    }
  });

  it("refuses every entry point when the storage is refused, and recovers when it is not", async () => {
    const { kernel, jobTransport } = createTestEnv([]);
    // What the SQLite adapters throw for a file another Prisma major wrote.
    const refusal = Object.assign(new Error("a foreign SQLite file"), {
      code: "SQLITE_DATE_STORAGE_MISMATCH",
    });
    let refusing = true;
    (jobTransport as any).verifyStorage = async () => {
      if (refusing) throw refusal;
    };
    const dispatched = vi.spyOn(kernel, "dispatch");
    const host = createServerlessHost({
      kernel,
      jobTransport,
      workerId: "test-worker",
    });

    await expect(host.runMaintenanceTick()).rejects.toBe(refusal);
    await expect(host.processAvailableJobs()).rejects.toBe(refusal);
    await expect(
      host.handleJob({
        jobId: "j",
        workflowRunId: "r",
        workflowId: "w",
        stageId: "s",
        attempt: 1,
        payload: {},
      }),
    ).rejects.toBe(refusal);
    expect(dispatched).not.toHaveBeenCalled();

    // The check is asked again on every call.
    refusing = false;
    await expect(host.runMaintenanceTick()).resolves.toMatchObject({
      claimed: 0,
    });
    expect(dispatched).toHaveBeenCalled();
  });

  it("dispatches nothing until the storage check settles, and checks again on every call", async () => {
    const { kernel, jobTransport } = createTestEnv([]);
    const gates: { settle: (error?: Error) => void }[] = [];
    (jobTransport as any).verifyStorage = () =>
      new Promise<void>((resolve, reject) => {
        gates.push({ settle: (error) => (error ? reject(error) : resolve()) });
      });
    const dispatched = vi.spyOn(kernel, "dispatch");
    const host = createServerlessHost({
      kernel,
      jobTransport,
      workerId: "test-worker",
    });

    // A check that fails late: the tick rejects and nothing was dispatched.
    const failing = host.runMaintenanceTick();
    await vi.waitFor(() => expect(gates).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 20));
    expect(dispatched).not.toHaveBeenCalled();
    const refusal = new Error("refused");
    gates[0].settle(refusal);
    await expect(failing).rejects.toBe(refusal);
    expect(dispatched).not.toHaveBeenCalled();

    // A check that passes late: the tick runs only then.
    const passing = host.runMaintenanceTick();
    await vi.waitFor(() => expect(gates).toHaveLength(2));
    expect(dispatched).not.toHaveBeenCalled();
    gates[1].settle();
    await passing;
    expect(dispatched).toHaveBeenCalled();

    // The host remembers nothing: the next call asks the transport again (the
    // Prisma queue answers from its own memo once the check was conclusive).
    const third = host.runMaintenanceTick();
    await vi.waitFor(() => expect(gates).toHaveLength(3));
    gates[2].settle();
    await third;
  });

  it("gives the hook its own copy of the counts", async () => {
    const { kernel, jobTransport } = createTestEnv([]);
    const host = createServerlessHost({
      kernel,
      jobTransport,
      workerId: "test-worker",
      onTick: (counts) => {
        counts.claimed = 99;
        counts.eventSinkStatus = "degraded";
      },
    });

    const counts = await host.runMaintenanceTick();

    expect(counts.claimed).toBe(0);
    expect(counts.eventSinkStatus).toBe("healthy");
  });
});
