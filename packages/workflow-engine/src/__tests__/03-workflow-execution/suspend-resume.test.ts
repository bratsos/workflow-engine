/**
 * Workflow Suspend/Resume Tests (Kernel)
 *
 * Tests for async-batch stages that suspend and resume execution
 * via kernel dispatch. Uses job.execute -> check outcome === "suspended"
 * -> stage.pollSuspended -> job.execute (resumed).
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
import { defineStage, defineAsyncBatchStage } from "../../core/stage-factory.js";
import type { SimpleSuspendedResult } from "../../core/stage-factory.js";
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

describe("I want to handle workflow suspension and resumption", () => {
  describe("stage suspension", () => {
    it("should suspend workflow when stage returns SuspendedResult", async () => {
      // Given: A workflow with an async-batch stage that suspends
      const suspendingStage = defineAsyncBatchStage({
        id: "batch-stage",
        name: "Batch Stage",
        mode: "async-batch",
        schemas: {
          input: z.object({}).passthrough(),
          output: z.object({ result: z.string() }),
          config: z.object({}),
        },
        async execute(ctx) {
          if (ctx.resumeState) {
            return { output: { result: "completed" } };
          }
          const now = new Date();
          return {
            suspended: true,
            state: {
              batchId: "batch-123",
              submittedAt: now.toISOString(),
              pollInterval: 5000,
              maxWaitTime: 60000,
            },
            pollConfig: {
              pollInterval: 5000,
              maxWaitTime: 60000,
              nextPollAt: new Date(now.getTime() + 5000),
            },
          } as SimpleSuspendedResult;
        },
        async checkCompletion() {
          return { ready: true, output: { result: "completed" } };
        },
      });

      const workflow = new WorkflowBuilder(
        "suspend-workflow",
        "Suspend Workflow",
        "Test",
        z.object({}).passthrough(),
        z.object({ result: z.string() }),
      )
        .pipe(suspendingStage)
        .build();

      const { kernel, flush } = createTestKernel([workflow]);

      const { workflowRunId } = await kernel.dispatch({
        type: "run.create",
        idempotencyKey: "key-1",
        workflowId: "suspend-workflow",
        input: {},
      });

      await kernel.dispatch({ type: "run.claimPending", workerId: "worker-1" });

      // When: I execute
      const result = await kernel.dispatch({
        type: "job.execute",
        workflowRunId,
        workflowId: "suspend-workflow",
        stageId: "batch-stage",
        config: {},
      });

      // Then: Returns "suspended" outcome
      expect(result.outcome).toBe("suspended");
    });

    it("should emit stage:suspended event", async () => {
      // Given: A suspending stage
      const suspendingStage = defineAsyncBatchStage({
        id: "event-stage",
        name: "Event Stage",
        mode: "async-batch",
        schemas: {
          input: z.object({}).passthrough(),
          output: z.object({ done: z.boolean() }),
          config: z.object({}),
        },
        async execute(ctx) {
          if (ctx.resumeState) return { output: { done: true } };
          const now = new Date();
          return {
            suspended: true,
            state: {
              batchId: "batch-event",
              submittedAt: now.toISOString(),
              pollInterval: 1000,
              maxWaitTime: 30000,
            },
            pollConfig: {
              pollInterval: 1000,
              maxWaitTime: 30000,
              nextPollAt: new Date(now.getTime() + 1000),
            },
          } as SimpleSuspendedResult;
        },
        async checkCompletion() {
          return { ready: true, output: { done: true } };
        },
      });

      const workflow = new WorkflowBuilder(
        "suspend-event",
        "Suspend Event Workflow",
        "Test",
        z.object({}).passthrough(),
        z.object({ done: z.boolean() }),
      )
        .pipe(suspendingStage)
        .build();

      const { kernel, flush, eventSink } = createTestKernel([workflow]);

      const { workflowRunId } = await kernel.dispatch({
        type: "run.create",
        idempotencyKey: "key-1",
        workflowId: "suspend-event",
        input: {},
      });

      await kernel.dispatch({ type: "run.claimPending", workerId: "worker-1" });
      await flush();
      eventSink.clear();

      // When: I execute
      await kernel.dispatch({
        type: "job.execute",
        workflowRunId,
        workflowId: "suspend-event",
        stageId: "event-stage",
        config: {},
      });

      await flush();

      // Then: stage:suspended event was emitted
      const suspendedEvents = eventSink.getByType("stage:suspended");
      expect(suspendedEvents).toHaveLength(1);
      expect((suspendedEvents[0] as any).stageId).toBe("event-stage");
      expect((suspendedEvents[0] as any).nextPollAt).toBeDefined();
    });

    it("should update stage record with suspended state", async () => {
      // Given: A suspending stage with specific state
      const suspendingStage = defineAsyncBatchStage({
        id: "state-stage",
        name: "State Stage",
        mode: "async-batch",
        schemas: {
          input: z.object({}).passthrough(),
          output: z.object({ data: z.string() }),
          config: z.object({}),
        },
        async execute(ctx) {
          if (ctx.resumeState) {
            return { output: { data: "resumed" } };
          }

          const now = new Date();
          return {
            suspended: true,
            state: {
              batchId: "my-batch-id",
              submittedAt: now.toISOString(),
              pollInterval: 5000,
              maxWaitTime: 300000,
              metadata: { customField: "custom-value" },
            },
            pollConfig: {
              pollInterval: 5000,
              maxWaitTime: 300000,
              nextPollAt: new Date(now.getTime() + 5000),
            },
          } as SimpleSuspendedResult;
        },
        async checkCompletion() {
          return { ready: true, output: { data: "complete" } };
        },
      });

      const workflow = new WorkflowBuilder(
        "suspend-state",
        "Suspend State Workflow",
        "Test",
        z.object({}).passthrough(),
        z.object({ data: z.string() }),
      )
        .pipe(suspendingStage)
        .build();

      const { kernel, flush, persistence } = createTestKernel([workflow]);

      const { workflowRunId } = await kernel.dispatch({
        type: "run.create",
        idempotencyKey: "key-1",
        workflowId: "suspend-state",
        input: {},
      });

      await kernel.dispatch({ type: "run.claimPending", workerId: "worker-1" });

      // When: I execute
      await kernel.dispatch({
        type: "job.execute",
        workflowRunId,
        workflowId: "suspend-state",
        stageId: "state-stage",
        config: {},
      });

      // Then: Stage record has suspended state
      const stages = await persistence.getStagesByRun(workflowRunId);
      const uniqueStages = new Map(stages.map((s) => [s.stageId, s]));
      const stage = uniqueStages.get("state-stage");

      expect(stage?.status).toBe("SUSPENDED");
      expect(stage?.suspendedState).toBeDefined();

      const state = stage?.suspendedState as Record<string, unknown>;
      expect(state.batchId).toBe("my-batch-id");
      expect(state.metadata).toEqual({ customField: "custom-value" });
    });
  });

  describe("workflow resumption", () => {
    it("should resume suspended workflow via stage.pollSuspended", async () => {
      // Given: A previously suspended workflow that is now ready to complete
      const suspendingStage = defineAsyncBatchStage({
        id: "resume-stage",
        name: "Resume Stage",
        mode: "async-batch",
        schemas: {
          input: z.object({}).passthrough(),
          output: z.object({ result: z.string() }),
          config: z.object({}),
        },
        async execute(ctx) {
          if (ctx.resumeState) {
            return { output: { result: "workflow-completed" } };
          }
          const now = new Date();
          return {
            suspended: true,
            state: {
              batchId: "resume-batch",
              submittedAt: now.toISOString(),
              pollInterval: 100,
              maxWaitTime: 10000,
            },
            pollConfig: {
              pollInterval: 100,
              maxWaitTime: 10000,
              nextPollAt: new Date(now.getTime() + 100),
            },
          } as SimpleSuspendedResult;
        },
        async checkCompletion() {
          return { ready: true, output: { result: "from-check" } };
        },
      });

      const workflow = new WorkflowBuilder(
        "resume-workflow",
        "Resume Workflow",
        "Test",
        z.object({}).passthrough(),
        z.object({ result: z.string() }),
      )
        .pipe(suspendingStage)
        .build();

      const { kernel, flush, persistence, clock } = createTestKernel([workflow]);

      // 1. Create and suspend the workflow
      const { workflowRunId } = await kernel.dispatch({
        type: "run.create",
        idempotencyKey: "key-1",
        workflowId: "resume-workflow",
        input: {},
      });

      await kernel.dispatch({ type: "run.claimPending", workerId: "worker-1" });

      const suspendResult = await kernel.dispatch({
        type: "job.execute",
        workflowRunId,
        workflowId: "resume-workflow",
        stageId: "resume-stage",
        config: {},
      });
      expect(suspendResult.outcome).toBe("suspended");

      // 2. Set nextPollAt to the past so pollSuspended picks it up
      const stages = await persistence.getStagesByRun(workflowRunId);
      await persistence.updateStage(stages[0]!.id, {
        nextPollAt: new Date(clock.now().getTime() - 1000),
      });

      // 3. Poll suspended stages -- checkCompletion returns ready
      const pollResult = await kernel.dispatch({
        type: "stage.pollSuspended",
      });

      expect(pollResult.resumed).toBe(1);

      // 4. The stage should now be COMPLETED
      const updatedStages = await persistence.getStagesByRun(workflowRunId);
      const resumedStage = updatedStages.find(s => s.stageId === "resume-stage");
      expect(resumedStage?.status).toBe("COMPLETED");

      // 5. Transition to complete the workflow
      await kernel.dispatch({ type: "run.transition", workflowRunId });
      await flush();

      const run = await persistence.getRun(workflowRunId);
      expect(run?.status).toBe("COMPLETED");
    });

    it("should continue with stages after resumed stage completes", async () => {
      // Given: A workflow with suspend stage followed by normal stage
      const executionOrder: string[] = [];

      const suspendStage = defineAsyncBatchStage({
        id: "first-suspend",
        name: "First Suspend",
        mode: "async-batch",
        schemas: {
          input: z.object({ value: z.string() }),
          output: z.object({ value: z.string() }),
          config: z.object({}),
        },
        async execute(ctx) {
          executionOrder.push("first-execute");

          if (ctx.resumeState) {
            executionOrder.push("first-resume");
            return { output: ctx.input };
          }

          const now = new Date();
          return {
            suspended: true,
            state: {
              batchId: "batch-first",
              submittedAt: now.toISOString(),
              pollInterval: 100,
              maxWaitTime: 10000,
            },
            pollConfig: {
              pollInterval: 100,
              maxWaitTime: 10000,
              nextPollAt: new Date(now.getTime() + 100),
            },
          } as SimpleSuspendedResult;
        },
        async checkCompletion() {
          return { ready: true, output: { value: "from-poll" } };
        },
      });

      const secondStage = defineStage({
        id: "second-stage",
        name: "Stage second-stage",
        schemas: {
          input: z.object({ value: z.string() }),
          output: z.object({ value: z.string() }),
          config: z.object({}),
        },
        async execute(ctx) {
          executionOrder.push("second-execute");
          return { output: ctx.input };
        },
      });

      const workflow = new WorkflowBuilder(
        "multi-resume",
        "Multi Resume Workflow",
        "Test",
        z.object({ value: z.string() }),
        z.object({ value: z.string() }),
      )
        .pipe(suspendStage)
        .pipe(secondStage)
        .build();

      const { kernel, flush, persistence, clock } = createTestKernel([workflow]);

      // 1. Create and suspend
      const { workflowRunId } = await kernel.dispatch({
        type: "run.create",
        idempotencyKey: "key-1",
        workflowId: "multi-resume",
        input: { value: "test-data" },
      });

      await kernel.dispatch({ type: "run.claimPending", workerId: "worker-1" });

      const suspendResult = await kernel.dispatch({
        type: "job.execute",
        workflowRunId,
        workflowId: "multi-resume",
        stageId: "first-suspend",
        config: {},
      });
      expect(suspendResult.outcome).toBe("suspended");
      expect(executionOrder).toEqual(["first-execute"]);

      // 2. Poll to complete the suspended stage
      const stages = await persistence.getStagesByRun(workflowRunId);
      const suspendedStage = stages.find(s => s.stageId === "first-suspend");
      await persistence.updateStage(suspendedStage!.id, {
        nextPollAt: new Date(clock.now().getTime() - 1000),
      });

      await kernel.dispatch({ type: "stage.pollSuspended" });

      // 3. Transition to advance to next stage
      await kernel.dispatch({ type: "run.transition", workflowRunId });

      // 4. Execute second stage
      const r2 = await kernel.dispatch({
        type: "job.execute",
        workflowRunId,
        workflowId: "multi-resume",
        stageId: "second-stage",
        config: {},
      });
      expect(r2.outcome).toBe("completed");

      // 5. Complete workflow
      await kernel.dispatch({ type: "run.transition", workflowRunId });
      await flush();

      expect(executionOrder).toContain("second-execute");

      const run = await persistence.getRun(workflowRunId);
      expect(run?.status).toBe("COMPLETED");
    });
  });

  describe("suspension in multi-stage workflows", () => {
    it("should preserve completed stages when suspending", async () => {
      // Given: A workflow where second stage suspends
      const firstStage = defineStage({
        id: "first-done",
        name: "Stage first-done",
        schemas: {
          input: z.object({ value: z.string() }),
          output: z.object({ value: z.string() }),
          config: z.object({}),
        },
        async execute(ctx) { return { output: ctx.input }; },
      });

      const secondSuspend = defineAsyncBatchStage({
        id: "second-suspend",
        name: "Second Suspend",
        mode: "async-batch",
        schemas: {
          input: z.object({ value: z.string() }),
          output: z.object({ value: z.string() }),
          config: z.object({}),
        },
        async execute(ctx) {
          if (ctx.resumeState) return { output: { value: "suspended-output" } };
          const now = new Date();
          return {
            suspended: true,
            state: {
              batchId: "batch-second",
              submittedAt: now.toISOString(),
              pollInterval: 1000,
              maxWaitTime: 60000,
            },
            pollConfig: {
              pollInterval: 1000,
              maxWaitTime: 60000,
              nextPollAt: new Date(now.getTime() + 1000),
            },
          } as SimpleSuspendedResult;
        },
        async checkCompletion() {
          return { ready: true, output: { value: "suspended-output" } };
        },
      });

      const workflow = new WorkflowBuilder(
        "partial-suspend",
        "Partial Suspend Workflow",
        "Test",
        z.object({ value: z.string() }),
        z.object({ value: z.string() }),
      )
        .pipe(firstStage)
        .pipe(secondSuspend)
        .build();

      const { kernel, flush, persistence } = createTestKernel([workflow]);

      const { workflowRunId } = await kernel.dispatch({
        type: "run.create",
        idempotencyKey: "key-1",
        workflowId: "partial-suspend",
        input: { value: "input" },
      });

      await kernel.dispatch({ type: "run.claimPending", workerId: "worker-1" });

      // Execute first stage (completes)
      await kernel.dispatch({
        type: "job.execute",
        workflowRunId,
        workflowId: "partial-suspend",
        stageId: "first-done",
        config: {},
      });

      // Transition to second stage
      await kernel.dispatch({ type: "run.transition", workflowRunId });

      // Execute second stage (suspends)
      const result = await kernel.dispatch({
        type: "job.execute",
        workflowRunId,
        workflowId: "partial-suspend",
        stageId: "second-suspend",
        config: {},
      });

      expect(result.outcome).toBe("suspended");

      // Then: First stage is completed, second is suspended
      const stages = await persistence.getStagesByRun(workflowRunId);
      const uniqueStages = new Map(stages.map((s) => [s.stageId, s]));

      expect(uniqueStages.get("first-done")?.status).toBe("COMPLETED");
      expect(uniqueStages.get("second-suspend")?.status).toBe("SUSPENDED");
    });
  });

  describe("parallel stage suspension", () => {
    it("should suspend when any parallel stage suspends", async () => {
      // Given: Parallel stages where one suspends
      const normalStage = defineStage({
        id: "parallel-normal",
        name: "Parallel Normal",
        schemas: {
          input: z.object({ value: z.string() }),
          output: z.object({ value: z.string() }),
          config: z.object({}),
        },
        async execute(ctx) { return { output: ctx.input }; },
      });

      const suspendStage = defineAsyncBatchStage({
        id: "parallel-suspend",
        name: "Parallel Suspend",
        mode: "async-batch",
        schemas: {
          input: z.object({ value: z.string() }),
          output: z.object({ value: z.string() }),
          config: z.object({}),
        },
        async execute(ctx) {
          if (ctx.resumeState) return { output: { value: "suspended" } };
          const now = new Date();
          return {
            suspended: true,
            state: {
              batchId: "batch-parallel",
              submittedAt: now.toISOString(),
              pollInterval: 1000,
              maxWaitTime: 60000,
            },
            pollConfig: {
              pollInterval: 1000,
              maxWaitTime: 60000,
              nextPollAt: new Date(now.getTime() + 1000),
            },
          } as SimpleSuspendedResult;
        },
        async checkCompletion() {
          return { ready: true, output: { value: "suspended" } };
        },
      });

      const workflow = new WorkflowBuilder(
        "parallel-with-suspend",
        "Parallel With Suspend",
        "Test",
        z.object({ value: z.string() }),
        z.any(),
      )
        .parallel([normalStage, suspendStage])
        .build();

      const { kernel, flush, persistence } = createTestKernel([workflow]);

      const { workflowRunId } = await kernel.dispatch({
        type: "run.create",
        idempotencyKey: "key-1",
        workflowId: "parallel-with-suspend",
        input: { value: "test" },
      });

      await kernel.dispatch({ type: "run.claimPending", workerId: "worker-1" });

      // Execute normal stage (completes)
      const rNormal = await kernel.dispatch({
        type: "job.execute",
        workflowRunId,
        workflowId: "parallel-with-suspend",
        stageId: "parallel-normal",
        config: {},
      });
      expect(rNormal.outcome).toBe("completed");

      // Execute suspend stage (suspends)
      const rSuspend = await kernel.dispatch({
        type: "job.execute",
        workflowRunId,
        workflowId: "parallel-with-suspend",
        stageId: "parallel-suspend",
        config: {},
      });
      expect(rSuspend.outcome).toBe("suspended");

      // Transition should noop because a stage is still SUSPENDED (active)
      const transition = await kernel.dispatch({ type: "run.transition", workflowRunId });
      expect(transition.action).toBe("noop");

      // Run should still be RUNNING (not completed)
      const run = await persistence.getRun(workflowRunId);
      expect(run?.status).toBe("RUNNING");
    });
  });
});
