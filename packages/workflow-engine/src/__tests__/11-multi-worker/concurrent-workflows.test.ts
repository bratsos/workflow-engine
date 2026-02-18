/**
 * Concurrent Workflows Tests (Kernel)
 *
 * Tests for running multiple workflows simultaneously using kernel dispatch.
 * Covers job queue behavior, persistence isolation, concurrent execution,
 * status filtering, error isolation, and job queue fairness.
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

function createPassthroughWorkflow(id: string) {
  const schema = z.object({ value: z.string() });
  const stage = defineStage({
    id: "process",
    name: "Process",
    schemas: { input: schema, output: schema, config: z.object({}) },
    async execute(ctx) {
      return { output: ctx.input };
    },
  });
  return new WorkflowBuilder(id, id, "Test", schema, schema)
    .pipe(stage)
    .build();
}

describe("I want to run multiple workflows concurrently", () => {
  describe("job queue with multiple workflows", () => {
    it("should queue jobs from different workflows via run.claimPending", async () => {
      // Given: Two workflows registered in kernel
      const workflowA = createPassthroughWorkflow("workflow-a");
      const workflowB = createPassthroughWorkflow("workflow-b");

      const { kernel, flush, persistence, jobTransport } = createTestKernel([workflowA, workflowB]);

      // Create runs for different workflows
      await kernel.dispatch({
        type: "run.create",
        idempotencyKey: "key-a1",
        workflowId: "workflow-a",
        input: { value: "a1" },
      });
      await kernel.dispatch({
        type: "run.create",
        idempotencyKey: "key-b1",
        workflowId: "workflow-b",
        input: { value: "b1" },
      });
      await kernel.dispatch({
        type: "run.create",
        idempotencyKey: "key-a2",
        workflowId: "workflow-a",
        input: { value: "a2" },
      });

      // When: Claim all pending runs
      await kernel.dispatch({
        type: "run.claimPending",
        workerId: "worker-1",
        maxClaims: 10,
      });

      // Then: All workflows have jobs in the queue
      const allJobs = jobTransport.getAllJobs();
      expect(allJobs).toHaveLength(3);

      const runIds = allJobs.map((j) => j.workflowRunId);
      expect(new Set(runIds).size).toBe(3);
    });

    it("should process jobs in priority order across workflows", async () => {
      // Given: Workflows with different priorities
      const workflow = createPassthroughWorkflow("priority-wf");
      const { kernel, flush, persistence, jobTransport } = createTestKernel([workflow]);

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

      // When: Claim pending (claims in priority order)
      const claimResult = await kernel.dispatch({
        type: "run.claimPending",
        workerId: "worker-1",
        maxClaims: 10,
      });

      // Then: Runs are claimed in priority order (highest first)
      expect(claimResult.claimed).toHaveLength(3);
      expect(claimResult.claimed[0]!.workflowRunId).toBe(high.workflowRunId);
      expect(claimResult.claimed[1]!.workflowRunId).toBe(medium.workflowRunId);
      expect(claimResult.claimed[2]!.workflowRunId).toBe(low.workflowRunId);
    });
  });

  describe("persistence isolation", () => {
    it("should store workflow runs independently", async () => {
      // Given: Two concurrent workflow runs
      const workflow = createPassthroughWorkflow("isolation-wf");
      const { kernel, flush, persistence } = createTestKernel([workflow]);

      const runA = await kernel.dispatch({
        type: "run.create",
        idempotencyKey: "iso-a",
        workflowId: "isolation-wf",
        input: { value: "a" },
      });
      const runB = await kernel.dispatch({
        type: "run.create",
        idempotencyKey: "iso-b",
        workflowId: "isolation-wf",
        input: { value: "b" },
      });

      // When: Update one run
      await persistence.updateRun(runA.workflowRunId, { status: "COMPLETED" });

      // Then: The other is unaffected
      const a = await persistence.getRun(runA.workflowRunId);
      const b = await persistence.getRun(runB.workflowRunId);

      expect(a?.status).toBe("COMPLETED");
      expect(b?.status).toBe("PENDING");
    });

    it("should store stages for different workflows separately", async () => {
      // Given: Stages from different workflow runs
      const workflow = createPassthroughWorkflow("stage-iso-wf");
      const { kernel, flush, persistence } = createTestKernel([workflow]);

      const runA = await kernel.dispatch({
        type: "run.create",
        idempotencyKey: "stage-a",
        workflowId: "stage-iso-wf",
        input: { value: "a" },
      });
      const runB = await kernel.dispatch({
        type: "run.create",
        idempotencyKey: "stage-b",
        workflowId: "stage-iso-wf",
        input: { value: "b" },
      });

      // Claim and execute stages for both
      await kernel.dispatch({
        type: "run.claimPending",
        workerId: "worker-1",
        maxClaims: 10,
      });

      // When: Execute stage for run A only
      await kernel.dispatch({
        type: "job.execute",
        workflowRunId: runA.workflowRunId,
        workflowId: "stage-iso-wf",
        stageId: "process",
        config: {},
      });

      // Then: Each run has its own independent stage records
      const stagesA = await persistence.getStagesByRun(runA.workflowRunId);
      const stagesB = await persistence.getStagesByRun(runB.workflowRunId);

      // A should be completed, B should still be pending
      expect(stagesA).toHaveLength(1);
      expect(stagesA[0]!.status).toBe("COMPLETED");
      expect(stagesB).toHaveLength(1);
      expect(stagesB[0]!.status).toBe("PENDING");
    });
  });

  describe("concurrent workflow execution", () => {
    it("should execute multiple workflow runs independently", async () => {
      // Given: A workflow with a stage
      const schema = z.object({ value: z.string() });
      const stage = defineStage({
        id: "process",
        name: "Process",
        schemas: { input: schema, output: schema, config: z.object({}) },
        async execute(ctx) {
          return { output: { value: ctx.input.value.toUpperCase() } };
        },
      });
      const workflow = new WorkflowBuilder("concurrent-wf", "Concurrent", "Test", schema, schema)
        .pipe(stage)
        .build();

      const { kernel, flush, persistence } = createTestKernel([workflow]);

      // Create two runs
      const run1 = await kernel.dispatch({
        type: "run.create",
        idempotencyKey: "c1",
        workflowId: "concurrent-wf",
        input: { value: "first" },
      });
      const run2 = await kernel.dispatch({
        type: "run.create",
        idempotencyKey: "c2",
        workflowId: "concurrent-wf",
        input: { value: "second" },
      });

      // Claim both
      await kernel.dispatch({
        type: "run.claimPending",
        workerId: "worker-1",
        maxClaims: 10,
      });

      // When: Execute both stages
      const result1 = await kernel.dispatch({
        type: "job.execute",
        workflowRunId: run1.workflowRunId,
        workflowId: "concurrent-wf",
        stageId: "process",
        config: {},
      });
      const result2 = await kernel.dispatch({
        type: "job.execute",
        workflowRunId: run2.workflowRunId,
        workflowId: "concurrent-wf",
        stageId: "process",
        config: {},
      });

      // Then: Both complete independently with correct outputs
      expect(result1.outcome).toBe("completed");
      expect(result1.output).toEqual({ value: "FIRST" });
      expect(result2.outcome).toBe("completed");
      expect(result2.output).toEqual({ value: "SECOND" });
    });
  });

  describe("status filtering across workflows", () => {
    it("should filter runs by status across all workflows", async () => {
      // Given: Runs in different states
      const workflowA = createPassthroughWorkflow("filter-a");
      const workflowB = createPassthroughWorkflow("filter-b");
      const { kernel, flush, persistence } = createTestKernel([workflowA, workflowB]);

      const runA1 = await kernel.dispatch({
        type: "run.create",
        idempotencyKey: "f-a1",
        workflowId: "filter-a",
        input: { value: "a1" },
      });
      const runA2 = await kernel.dispatch({
        type: "run.create",
        idempotencyKey: "f-a2",
        workflowId: "filter-a",
        input: { value: "a2" },
      });
      const runB1 = await kernel.dispatch({
        type: "run.create",
        idempotencyKey: "f-b1",
        workflowId: "filter-b",
        input: { value: "b1" },
      });

      await persistence.updateRun(runA1.workflowRunId, { status: "RUNNING" });
      await persistence.updateRun(runA2.workflowRunId, { status: "COMPLETED" });

      // When: Query by status
      const pendingRuns = await persistence.getRunsByStatus("PENDING");
      const runningRuns = await persistence.getRunsByStatus("RUNNING");
      const completedRuns = await persistence.getRunsByStatus("COMPLETED");

      // Then: Returns runs from all workflows matching the status
      expect(pendingRuns).toHaveLength(1);
      expect(pendingRuns[0]?.id).toBe(runB1.workflowRunId);

      expect(runningRuns).toHaveLength(1);
      expect(runningRuns[0]?.id).toBe(runA1.workflowRunId);

      expect(completedRuns).toHaveLength(1);
      expect(completedRuns[0]?.id).toBe(runA2.workflowRunId);
    });
  });

  describe("error isolation", () => {
    it("should isolate failures between concurrent workflow runs", async () => {
      // Given: Two workflows - one will fail
      const schema = z.object({ value: z.string() });

      const successStage = defineStage({
        id: "process",
        name: "Process",
        schemas: { input: schema, output: schema, config: z.object({}) },
        async execute(ctx) {
          return { output: ctx.input };
        },
      });

      const failStage = defineStage({
        id: "process",
        name: "Process",
        schemas: { input: schema, output: schema, config: z.object({}) },
        async execute() {
          throw new Error("Intentional failure");
        },
      });

      const successWorkflow = new WorkflowBuilder("success-wf", "Success", "Test", schema, schema)
        .pipe(successStage)
        .build();
      const failWorkflow = new WorkflowBuilder("fail-wf", "Fail", "Test", schema, schema)
        .pipe(failStage)
        .build();

      const { kernel, flush, persistence } = createTestKernel([successWorkflow, failWorkflow]);

      // Create runs
      const runSuccess = await kernel.dispatch({
        type: "run.create",
        idempotencyKey: "success",
        workflowId: "success-wf",
        input: { value: "success" },
      });
      const runFail = await kernel.dispatch({
        type: "run.create",
        idempotencyKey: "fail",
        workflowId: "fail-wf",
        input: { value: "fail" },
      });

      // Claim
      await kernel.dispatch({
        type: "run.claimPending",
        workerId: "worker-1",
        maxClaims: 10,
      });

      // When: Execute both
      const result1 = await kernel.dispatch({
        type: "job.execute",
        workflowRunId: runSuccess.workflowRunId,
        workflowId: "success-wf",
        stageId: "process",
        config: {},
      });
      const result2 = await kernel.dispatch({
        type: "job.execute",
        workflowRunId: runFail.workflowRunId,
        workflowId: "fail-wf",
        stageId: "process",
        config: {},
      });

      // Then: Success workflow completed
      expect(result1.outcome).toBe("completed");
      expect(result1.output).toEqual({ value: "success" });

      // And: Fail workflow failed (but didn't crash the other)
      expect(result2.outcome).toBe("failed");
      expect(result2.error).toBe("Intentional failure");

      // Transition both
      await kernel.dispatch({ type: "run.transition", workflowRunId: runSuccess.workflowRunId });
      await kernel.dispatch({ type: "run.transition", workflowRunId: runFail.workflowRunId });

      // Verify persistence reflects correct states
      const successRun = await persistence.getRun(runSuccess.workflowRunId);
      const failRun = await persistence.getRun(runFail.workflowRunId);
      expect(successRun?.status).toBe("COMPLETED");
      expect(failRun?.status).toBe("FAILED");
    });
  });

  describe("job queue fairness", () => {
    it("should interleave jobs from multiple workflows fairly via FIFO", async () => {
      // Given: A shared job queue used as transport
      const jobQueue = new InMemoryJobQueue("worker-1");

      // Enqueue jobs from two workflows alternately
      for (let i = 0; i < 3; i++) {
        await jobQueue.enqueue({
          workflowRunId: `workflow-a-run-${i}`,
          stageId: "stage-1",
          priority: 5,
        });
        await jobQueue.enqueue({
          workflowRunId: `workflow-b-run-${i}`,
          stageId: "stage-1",
          priority: 5,
        });
      }

      // When: Dequeue all
      const results: string[] = [];
      for (let i = 0; i < 6; i++) {
        const result = await jobQueue.dequeue();
        if (result) {
          results.push(result.workflowRunId);
          await jobQueue.complete(result.jobId);
        }
      }

      // Then: Jobs are interleaved in FIFO order (a,b,a,b,a,b)
      expect(results[0]).toBe("workflow-a-run-0");
      expect(results[1]).toBe("workflow-b-run-0");
      expect(results[2]).toBe("workflow-a-run-1");
      expect(results[3]).toBe("workflow-b-run-1");
      expect(results[4]).toBe("workflow-a-run-2");
      expect(results[5]).toBe("workflow-b-run-2");
    });
  });
});
