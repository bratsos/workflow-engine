/**
 * Worker Process Simulation Tests (Kernel)
 *
 * Tests for how worker processes interact with the kernel:
 * - Worker claiming runs via run.claimPending
 * - Worker executing jobs via job.execute
 * - Multiple workers competing for jobs
 * - Worker handling failures
 * - Worker processing suspended jobs
 *
 * Tests that relied on WorkflowRuntime polling loops are skipped since
 * those are now handled by host packages.
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
import { InMemoryWorkflowPersistence } from "../../testing/in-memory-persistence.js";
import { InMemoryJobQueue } from "../../testing/in-memory-job-queue.js";
import { defineStage } from "../../core/stage-factory.js";
import { WorkflowBuilder, type Workflow } from "../../core/workflow.js";

function createTestKernel(workflows: Workflow<any, any>[] = []) {
  const persistence = new InMemoryWorkflowPersistence();
  const blobStore = new InMemoryBlobStore();
  const jobTransport = new InMemoryJobQueue("test-worker");
  const eventSink = new CollectingEventSink();
  const scheduler = new NoopScheduler();
  const clock = new FakeClock();
  const registry = new Map<string, Workflow<any, any>>();
  for (const w of workflows) registry.set(w.id, w);
  const kernel = createKernel({
    persistence, blobStore, jobTransport, eventSink, scheduler, clock,
    registry: { getWorkflow: (id) => registry.get(id) },
  });
  const flush = () => kernel.dispatch({ type: "outbox.flush" as const });
  return { kernel, flush, persistence, blobStore, jobTransport, eventSink, scheduler, clock, registry };
}

function createSimpleWorkflow(id: string = "test-workflow") {
  const schema = z.object({ value: z.string() });
  const stage = defineStage({
    id: "process",
    name: "Process",
    schemas: { input: schema, output: schema, config: z.object({}) },
    async execute(ctx) {
      return { output: ctx.input };
    },
  });
  return new WorkflowBuilder(id, "Test", "Test", schema, schema)
    .pipe(stage)
    .build();
}

describe("I want to simulate worker process behavior", () => {
  describe("worker polling for jobs via run.claimPending", () => {
    it("should claim pending runs in priority order", async () => {
      // Given: Multiple pending runs with different priorities
      const workflow = createSimpleWorkflow("priority-wf");
      const { kernel, flush, persistence } = createTestKernel([workflow]);

      const low = await kernel.dispatch({
        type: "run.create",
        idempotencyKey: "low",
        workflowId: "priority-wf",
        input: { value: "low" },
        priority: 1,
      });
      const high = await kernel.dispatch({
        type: "run.create",
        idempotencyKey: "high",
        workflowId: "priority-wf",
        input: { value: "high" },
        priority: 10,
      });
      const medium = await kernel.dispatch({
        type: "run.create",
        idempotencyKey: "med",
        workflowId: "priority-wf",
        input: { value: "medium" },
        priority: 5,
      });

      // When: Worker claims pending runs
      const result = await kernel.dispatch({
        type: "run.claimPending",
        workerId: "worker-1",
        maxClaims: 10,
      });

      // Then: Runs are claimed in priority order (highest first)
      expect(result.claimed).toHaveLength(3);
      expect(result.claimed[0]!.workflowRunId).toBe(high.workflowRunId);
      expect(result.claimed[1]!.workflowRunId).toBe(medium.workflowRunId);
      expect(result.claimed[2]!.workflowRunId).toBe(low.workflowRunId);
    });

    it("should return empty when no pending runs", async () => {
      // Given: No pending runs
      const { kernel } = createTestKernel([]);

      // When: Worker claims
      const result = await kernel.dispatch({
        type: "run.claimPending",
        workerId: "worker-1",
        maxClaims: 10,
      });

      // Then: No runs claimed
      expect(result.claimed).toHaveLength(0);
    });

    it("should not reclaim already-claimed runs", async () => {
      // Given: A run that has been claimed
      const workflow = createSimpleWorkflow("claim-wf");
      const { kernel, persistence } = createTestKernel([workflow]);

      await kernel.dispatch({
        type: "run.create",
        idempotencyKey: "claim-1",
        workflowId: "claim-wf",
        input: { value: "test" },
      });

      // First claim
      const firstResult = await kernel.dispatch({
        type: "run.claimPending",
        workerId: "worker-1",
        maxClaims: 10,
      });
      expect(firstResult.claimed).toHaveLength(1);

      // When: Second claim attempt
      const secondResult = await kernel.dispatch({
        type: "run.claimPending",
        workerId: "worker-2",
        maxClaims: 10,
      });

      // Then: No runs available
      expect(secondResult.claimed).toHaveLength(0);
    });
  });

  describe("worker executing jobs via job.execute", () => {
    it("should execute a stage and return completed result", async () => {
      // Given: A workflow run with a claimed stage
      const schema = z.object({ value: z.string() });
      const stage = defineStage({
        id: "transform",
        name: "Transform",
        schemas: { input: schema, output: z.object({ result: z.string() }), config: z.object({}) },
        async execute(ctx) {
          return { output: { result: ctx.input.value.toUpperCase() } };
        },
      });
      const workflow = new WorkflowBuilder("exec-wf", "Test", "Test", schema, z.object({ result: z.string() }))
        .pipe(stage)
        .build();

      const { kernel, flush, persistence } = createTestKernel([workflow]);

      const createResult = await kernel.dispatch({
        type: "run.create",
        idempotencyKey: "exec-1",
        workflowId: "exec-wf",
        input: { value: "hello" },
      });
      await kernel.dispatch({
        type: "run.claimPending",
        workerId: "worker-1",
      });

      // When: Worker executes the job
      const result = await kernel.dispatch({
        type: "job.execute",
        workflowRunId: createResult.workflowRunId,
        workflowId: "exec-wf",
        stageId: "transform",
        config: {},
      });

      // Then: Stage completed
      expect(result.outcome).toBe("completed");
      expect(result.output).toEqual({ result: "HELLO" });

      // And: Stage record is updated
      const stages = await persistence.getStagesByRun(createResult.workflowRunId);
      expect(stages[0]!.status).toBe("COMPLETED");
    });

    it("should update run status on stage completion via run.transition", async () => {
      // Given: A single-stage workflow
      const workflow = createSimpleWorkflow("transition-wf");
      const { kernel, flush, persistence } = createTestKernel([workflow]);

      const createResult = await kernel.dispatch({
        type: "run.create",
        idempotencyKey: "t1",
        workflowId: "transition-wf",
        input: { value: "test" },
      });
      await kernel.dispatch({
        type: "run.claimPending",
        workerId: "worker-1",
      });

      // Execute stage
      await kernel.dispatch({
        type: "job.execute",
        workflowRunId: createResult.workflowRunId,
        workflowId: "transition-wf",
        stageId: "process",
        config: {},
      });

      // When: Transition the workflow
      const transResult = await kernel.dispatch({
        type: "run.transition",
        workflowRunId: createResult.workflowRunId,
      });

      // Then: Workflow is completed
      expect(transResult.action).toBe("completed");
      const run = await persistence.getRun(createResult.workflowRunId);
      expect(run?.status).toBe("COMPLETED");
    });

    it("should handle job payload correctly via config", async () => {
      // Given: A stage that uses config from the job
      let capturedConfig: unknown;

      const stage = defineStage({
        id: "configurable",
        name: "Configurable",
        schemas: {
          input: z.object({ value: z.string() }),
          output: z.object({ value: z.string() }),
          config: z.object({
            model: z.string().default("default"),
          }),
        },
        async execute(ctx) {
          capturedConfig = ctx.config;
          return { output: ctx.input };
        },
      });

      const schema = z.object({ value: z.string() });
      const workflow = new WorkflowBuilder("config-wf", "Test", "Test", schema, schema)
        .pipe(stage)
        .build();

      const { kernel, flush, persistence } = createTestKernel([workflow]);

      const createResult = await kernel.dispatch({
        type: "run.create",
        idempotencyKey: "cfg-1",
        workflowId: "config-wf",
        input: { value: "test" },
        config: { configurable: { model: "gpt-4" } },
      });
      await persistence.updateRun(createResult.workflowRunId, { status: "RUNNING" });
      await flush();

      // When: Execute with config
      await kernel.dispatch({
        type: "job.execute",
        workflowRunId: createResult.workflowRunId,
        workflowId: "config-wf",
        stageId: "configurable",
        config: { configurable: { model: "gpt-4" } },
      });

      // Then: Config was provided to the stage
      expect(capturedConfig).toMatchObject({ model: "gpt-4" });
    });
  });

  describe("multiple workers competing for jobs", () => {
    it("should distribute runs across workers via claimPending", async () => {
      // Given: Multiple pending runs
      const workflow = createSimpleWorkflow("distribute-wf");
      const { kernel, persistence } = createTestKernel([workflow]);

      for (let i = 0; i < 3; i++) {
        await kernel.dispatch({
          type: "run.create",
          idempotencyKey: `dist-${i}`,
          workflowId: "distribute-wf",
          input: { value: `run-${i}` },
        });
      }

      // When: Worker claims one at a time
      const claimed: string[] = [];
      for (let i = 0; i < 3; i++) {
        const result = await kernel.dispatch({
          type: "run.claimPending",
          workerId: `worker-${i}`,
          maxClaims: 1,
        });
        if (result.claimed.length > 0) {
          claimed.push(result.claimed[0]!.workflowRunId);
        }
      }

      // Then: All runs are claimed
      expect(claimed).toHaveLength(3);
      expect(new Set(claimed).size).toBe(3); // All unique
    });

    it("should ensure only one worker claims each run", async () => {
      // Given: A single pending run
      const workflow = createSimpleWorkflow("single-claim-wf");
      const { kernel } = createTestKernel([workflow]);

      await kernel.dispatch({
        type: "run.create",
        idempotencyKey: "single-1",
        workflowId: "single-claim-wf",
        input: { value: "test" },
      });

      // When: First worker claims
      const firstClaim = await kernel.dispatch({
        type: "run.claimPending",
        workerId: "worker-1",
        maxClaims: 1,
      });

      // Then: First worker gets it
      expect(firstClaim.claimed).toHaveLength(1);

      // And: Second worker gets nothing
      const secondClaim = await kernel.dispatch({
        type: "run.claimPending",
        workerId: "worker-2",
        maxClaims: 1,
      });
      expect(secondClaim.claimed).toHaveLength(0);
    });
  });

  describe("worker handling failures", () => {
    it("should handle failed stages and transition to FAILED", async () => {
      // Given: A workflow with a failing stage
      const schema = z.object({ value: z.string() });
      const failStage = defineStage({
        id: "process",
        name: "Process",
        schemas: { input: schema, output: schema, config: z.object({}) },
        async execute() {
          throw new Error("Permanent failure");
        },
      });
      const workflow = new WorkflowBuilder("fail-wf", "Fail", "Test", schema, schema)
        .pipe(failStage)
        .build();

      const { kernel, flush, persistence } = createTestKernel([workflow]);

      const createResult = await kernel.dispatch({
        type: "run.create",
        idempotencyKey: "fail-1",
        workflowId: "fail-wf",
        input: { value: "test" },
      });
      await kernel.dispatch({
        type: "run.claimPending",
        workerId: "worker-1",
      });

      // When: Stage fails
      const result = await kernel.dispatch({
        type: "job.execute",
        workflowRunId: createResult.workflowRunId,
        workflowId: "fail-wf",
        stageId: "process",
        config: {},
      });

      expect(result.outcome).toBe("failed");
      expect(result.error).toBe("Permanent failure");

      // And: Transition marks run as failed
      const transResult = await kernel.dispatch({
        type: "run.transition",
        workflowRunId: createResult.workflowRunId,
      });
      expect(transResult.action).toBe("failed");

      const run = await persistence.getRun(createResult.workflowRunId);
      expect(run?.status).toBe("FAILED");
    });

    it("should retry failed jobs automatically via job queue", async () => {
      // Given: A job configured for retries
      const jobQueue = new InMemoryJobQueue("worker-1");
      jobQueue.setDefaultMaxAttempts(3);

      const jobId = await jobQueue.enqueue({
        workflowRunId: "run-1",
        stageId: "flaky-stage",
      });

      // When: First attempt fails
      await jobQueue.dequeue();
      await jobQueue.fail(jobId, "Connection timeout", true);

      // Then: Job is back in queue for retry
      let job = jobQueue.getJob(jobId);
      expect(job?.status).toBe("PENDING");
      expect(job?.attempt).toBe(2);
      expect(job?.lastError).toBe("Connection timeout");

      // And: Can be picked up again
      const retryJob = await jobQueue.dequeue();
      expect(retryJob?.jobId).toBe(jobId);
      expect(retryJob?.attempt).toBe(2);
    });

    it("should permanently fail after max retries", async () => {
      // Given: A job with limited retries
      const jobQueue = new InMemoryJobQueue("worker-1");
      jobQueue.setDefaultMaxAttempts(2);

      const jobId = await jobQueue.enqueue({
        workflowRunId: "run-1",
        stageId: "failing-stage",
      });

      // When: Job fails twice
      await jobQueue.dequeue();
      await jobQueue.fail(jobId, "Error 1", true);
      await jobQueue.dequeue();
      await jobQueue.fail(jobId, "Error 2", true);

      // Then: Job is permanently failed
      const job = jobQueue.getJob(jobId);
      expect(job?.status).toBe("FAILED");
      expect(job?.completedAt).toBeInstanceOf(Date);
    });

    it("should fail immediately when shouldRetry is false", async () => {
      // Given: A job
      const jobQueue = new InMemoryJobQueue("worker-1");
      jobQueue.setDefaultMaxAttempts(3);

      const jobId = await jobQueue.enqueue({
        workflowRunId: "run-1",
        stageId: "stage-1",
      });

      // When: Job fails with shouldRetry=false
      await jobQueue.dequeue();
      await jobQueue.fail(jobId, "Invalid input - do not retry", false);

      // Then: Job is immediately failed
      const job = jobQueue.getJob(jobId);
      expect(job?.status).toBe("FAILED");
      expect(job?.attempt).toBe(1);
    });

    it("should recover stale jobs from crashed workers via lease.reapStale", async () => {
      // Given: A job locked by a "crashed" worker
      const workflow = createSimpleWorkflow("recovery-wf");
      const { kernel, jobTransport } = createTestKernel([workflow]);

      const jobId = await jobTransport.enqueue({
        workflowRunId: "run-1",
        stageId: "process",
      });

      // Worker takes job then "crashes"
      await jobTransport.dequeue();
      jobTransport.setJobLockedAt(jobId, new Date(Date.now() - 120000));

      // When: Kernel reaps stale leases
      const result = await kernel.dispatch({
        type: "lease.reapStale",
        staleThresholdMs: 60000,
      });

      // Then: Job is released
      expect(result.released).toBe(1);
      const job = jobTransport.getJob(jobId);
      expect(job?.status).toBe("PENDING");
      expect(job?.workerId).toBeNull();

      // And: Can be picked up by another worker
      const recoveredJob = await jobTransport.dequeue();
      expect(recoveredJob?.jobId).toBe(jobId);
    });

    it("should preserve job data through failures and retries", async () => {
      // Given: A job with specific payload
      const jobQueue = new InMemoryJobQueue("worker-1");
      jobQueue.setDefaultMaxAttempts(3);

      const payload = {
        config: { model: "gpt-4" },
        metadata: { source: "api" },
      };

      const jobId = await jobQueue.enqueue({
        workflowRunId: "run-1",
        stageId: "stage-1",
        priority: 8,
        payload,
      });

      // When: Job fails and is retried
      await jobQueue.dequeue();
      await jobQueue.fail(jobId, "Temporary error", true);

      // Then: All original data is preserved
      const retryJob = await jobQueue.dequeue();
      expect(retryJob?.payload).toEqual(payload);
      expect(retryJob?.priority).toBe(8);
      expect(retryJob?.workflowRunId).toBe("run-1");
      expect(retryJob?.stageId).toBe("stage-1");
    });
  });

  describe("worker processing suspended jobs", () => {
    it("should find suspended jobs ready to resume", async () => {
      // Given: Suspended jobs with different resume times
      const jobQueue = new InMemoryJobQueue("worker-1");

      const job1 = await jobQueue.enqueue({
        workflowRunId: "run-1",
        stageId: "batch-1",
      });
      const job2 = await jobQueue.enqueue({
        workflowRunId: "run-2",
        stageId: "batch-2",
      });

      // Process and suspend both
      await jobQueue.dequeue();
      await jobQueue.suspend(job1, new Date(Date.now() - 1000)); // Ready now
      await jobQueue.dequeue();
      await jobQueue.suspend(job2, new Date(Date.now() + 60000)); // Not ready

      // When: Check for ready suspended jobs
      const ready = await jobQueue.getSuspendedJobsReadyToPoll();

      // Then: Only the ready job is returned
      expect(ready).toHaveLength(1);
      expect(ready[0]?.jobId).toBe(job1);
      expect(ready[0]?.stageId).toBe("batch-1");
    });

    it("should allow manual resume for testing", async () => {
      // Given: A suspended job
      const jobQueue = new InMemoryJobQueue("worker-1");

      const jobId = await jobQueue.enqueue({
        workflowRunId: "run-1",
        stageId: "stage-1",
      });

      await jobQueue.dequeue();
      await jobQueue.suspend(jobId, new Date(Date.now() + 60000));

      // When: Manually resumed
      jobQueue.resumeJob(jobId);

      // Then: Job is back to pending and can be dequeued
      const job = jobQueue.getJob(jobId);
      expect(job?.status).toBe("PENDING");

      const resumed = await jobQueue.dequeue();
      expect(resumed?.jobId).toBe(jobId);
    });
  });

  describe("worker lifecycle simulation", () => {
    it("should simulate a complete worker processing cycle with kernel", async () => {
      // Given: A workflow with multiple runs
      const workflow = createSimpleWorkflow("lifecycle-wf");
      const { kernel, flush, persistence } = createTestKernel([workflow]);

      // Create multiple runs
      const runIds: string[] = [];
      for (let i = 0; i < 3; i++) {
        const result = await kernel.dispatch({
          type: "run.create",
          idempotencyKey: `lifecycle-${i}`,
          workflowId: "lifecycle-wf",
          input: { value: `item-${i}` },
        });
        runIds.push(result.workflowRunId);
      }

      // When: Worker claims and processes all runs
      const claimResult = await kernel.dispatch({
        type: "run.claimPending",
        workerId: "worker-1",
        maxClaims: 10,
      });

      expect(claimResult.claimed).toHaveLength(3);

      // Execute each claimed run's stage
      for (const claim of claimResult.claimed) {
        const result = await kernel.dispatch({
          type: "job.execute",
          workflowRunId: claim.workflowRunId,
          workflowId: "lifecycle-wf",
          stageId: "process",
          config: {},
        });
        expect(result.outcome).toBe("completed");

        // Transition
        await kernel.dispatch({
          type: "run.transition",
          workflowRunId: claim.workflowRunId,
        });
      }

      // Then: All runs are completed
      for (const runId of runIds) {
        const run = await persistence.getRun(runId);
        expect(run?.status).toBe("COMPLETED");
      }
    });

    it("should simulate worker with mixed success and failure", async () => {
      // Given: Two workflows - one succeeds, one fails
      const schema = z.object({ value: z.string() });
      const successStage = defineStage({
        id: "process",
        name: "Process",
        schemas: { input: schema, output: schema, config: z.object({}) },
        async execute(ctx) { return { output: ctx.input }; },
      });
      const failStage = defineStage({
        id: "process",
        name: "Process",
        schemas: { input: schema, output: schema, config: z.object({}) },
        async execute() { throw new Error("Stage error"); },
      });

      const successWf = new WorkflowBuilder("success-wf", "Success", "Test", schema, schema)
        .pipe(successStage)
        .build();
      const failWf = new WorkflowBuilder("fail-wf", "Fail", "Test", schema, schema)
        .pipe(failStage)
        .build();

      const { kernel, flush, persistence } = createTestKernel([successWf, failWf]);

      const run1 = await kernel.dispatch({
        type: "run.create",
        idempotencyKey: "mixed-1",
        workflowId: "success-wf",
        input: { value: "success" },
      });
      const run2 = await kernel.dispatch({
        type: "run.create",
        idempotencyKey: "mixed-2",
        workflowId: "fail-wf",
        input: { value: "fail" },
      });
      const run3 = await kernel.dispatch({
        type: "run.create",
        idempotencyKey: "mixed-3",
        workflowId: "success-wf",
        input: { value: "success2" },
      });

      // Claim all
      await kernel.dispatch({
        type: "run.claimPending",
        workerId: "worker-1",
        maxClaims: 10,
      });

      // Execute and transition all
      const execAndTransition = async (runId: string, workflowId: string) => {
        await kernel.dispatch({
          type: "job.execute",
          workflowRunId: runId,
          workflowId,
          stageId: "process",
          config: {},
        });
        await kernel.dispatch({
          type: "run.transition",
          workflowRunId: runId,
        });
      };

      await execAndTransition(run1.workflowRunId, "success-wf");
      await execAndTransition(run2.workflowRunId, "fail-wf");
      await execAndTransition(run3.workflowRunId, "success-wf");

      // Then: Check final states
      const r1 = await persistence.getRun(run1.workflowRunId);
      const r2 = await persistence.getRun(run2.workflowRunId);
      const r3 = await persistence.getRun(run3.workflowRunId);

      expect(r1?.status).toBe("COMPLETED");
      expect(r2?.status).toBe("FAILED");
      expect(r3?.status).toBe("COMPLETED");
    });
  });
});
