/**
 * Async Batch Check Completion Tests (kernel version)
 *
 * Tests for polling mechanics and completion checking via kernel dispatch().
 *
 * Covers:
 * - Poll configuration (pollInterval, nextPollAt, maxWaitTime)
 * - checkCompletion behavior (escalating intervals, state/context args, progress tracking)
 * - Completion with output (output storage, metrics)
 * - State persistence during polling (batchId consistency, timestamp preservation)
 */

import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineAsyncBatchStage } from "../../core/stage-factory.js";
import type { CompletionCheckResult } from "../../core/types.js";
import { type Workflow, WorkflowBuilder } from "../../core/workflow.js";
import { createKernel } from "../../kernel/kernel.js";
import {
  CollectingEventSink,
  FakeClock,
  InMemoryBlobStore,
  NoopScheduler,
} from "../../kernel/testing/index.js";
import { InMemoryJobQueue } from "../../testing/in-memory-job-queue.js";
import { InMemoryWorkflowPersistence } from "../../testing/in-memory-persistence.js";

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

describe("I want to poll async-batch stages for completion", () => {
  describe("poll configuration", () => {
    it("should use pollInterval from suspended state", async () => {
      const pollInterval = 5000;

      const asyncStage = defineAsyncBatchStage({
        id: "poll-interval-stage",
        name: "Poll Interval Stage",
        mode: "async-batch",
        schemas: {
          input: z.object({}).passthrough(),
          output: z.object({ done: z.boolean() }),
          config: z.object({}),
        },
        async execute() {
          const now = new Date();
          return {
            suspended: true,
            state: {
              batchId: "batch-poll",
              submittedAt: now.toISOString(),
              pollInterval,
              maxWaitTime: 60000,
            },
            pollConfig: {
              pollInterval,
              maxWaitTime: 60000,
              nextPollAt: new Date(now.getTime() + pollInterval),
            },
          };
        },
        async checkCompletion() {
          return { ready: true, output: { done: true } };
        },
      });

      const workflow = new WorkflowBuilder(
        "poll-config",
        "Poll Config Workflow",
        "Test",
        z.object({}).passthrough(),
        z.object({ done: z.boolean() }),
      )
        .pipe(asyncStage)
        .build();

      const { kernel, flush, persistence } = createTestKernel([workflow]);

      const createResult = await kernel.dispatch({
        type: "run.create",
        idempotencyKey: "poll-1",
        workflowId: "poll-config",
        input: {},
      });
      await kernel.dispatch({ type: "run.claimPending", workerId: "w" });
      await flush();

      // Execute -> suspends
      await kernel.dispatch({
        type: "job.execute",
        workflowRunId: createResult.workflowRunId,
        workflowId: "poll-config",
        stageId: "poll-interval-stage",
        config: {},
      });

      // Verify stage record has correct pollInterval in suspendedState
      const stages = await persistence.getStagesByRun(
        createResult.workflowRunId,
      );
      const stage = stages.find((s) => s.stageId === "poll-interval-stage");
      expect(stage?.suspendedState).toBeDefined();
      const suspendedState = stage?.suspendedState as { pollInterval: number };
      expect(suspendedState.pollInterval).toBe(pollInterval);
    });

    it("should store nextPollAt time in stage record", async () => {
      const pollInterval = 3000;

      const asyncStage = defineAsyncBatchStage({
        id: "next-poll-stage",
        name: "Next Poll Stage",
        mode: "async-batch",
        schemas: {
          input: z.object({}).passthrough(),
          output: z.object({ done: z.boolean() }),
          config: z.object({}),
        },
        async execute() {
          const now = new Date();
          return {
            suspended: true,
            state: {
              batchId: "batch-next",
              submittedAt: now.toISOString(),
              pollInterval,
              maxWaitTime: 60000,
            },
            pollConfig: {
              pollInterval,
              maxWaitTime: 60000,
              nextPollAt: new Date(now.getTime() + pollInterval),
            },
          };
        },
        async checkCompletion() {
          return { ready: true, output: { done: true } };
        },
      });

      const workflow = new WorkflowBuilder(
        "next-poll",
        "Next Poll Workflow",
        "Test",
        z.object({}).passthrough(),
        z.object({ done: z.boolean() }),
      )
        .pipe(asyncStage)
        .build();

      const { kernel, flush, persistence } = createTestKernel([workflow]);

      const createResult = await kernel.dispatch({
        type: "run.create",
        idempotencyKey: "next-poll-1",
        workflowId: "next-poll",
        input: {},
      });
      await kernel.dispatch({ type: "run.claimPending", workerId: "w" });
      await flush();

      await kernel.dispatch({
        type: "job.execute",
        workflowRunId: createResult.workflowRunId,
        workflowId: "next-poll",
        stageId: "next-poll-stage",
        config: {},
      });

      const stages = await persistence.getStagesByRun(
        createResult.workflowRunId,
      );
      const stage = stages.find((s) => s.stageId === "next-poll-stage");
      expect(stage?.nextPollAt).toBeDefined();
      expect(stage?.nextPollAt).toBeInstanceOf(Date);
    });

    it("should store maxWaitTime in suspended state", async () => {
      const maxWaitTime = 300000; // 5 minutes

      const asyncStage = defineAsyncBatchStage({
        id: "max-wait-stage",
        name: "Max Wait Stage",
        mode: "async-batch",
        schemas: {
          input: z.object({}).passthrough(),
          output: z.object({ done: z.boolean() }),
          config: z.object({}),
        },
        async execute() {
          const now = new Date();
          return {
            suspended: true,
            state: {
              batchId: "batch-max",
              submittedAt: now.toISOString(),
              pollInterval: 5000,
              maxWaitTime,
            },
            pollConfig: {
              pollInterval: 5000,
              maxWaitTime,
              nextPollAt: new Date(now.getTime() + 5000),
            },
          };
        },
        async checkCompletion() {
          return { ready: true, output: { done: true } };
        },
      });

      const workflow = new WorkflowBuilder(
        "max-wait",
        "Max Wait Workflow",
        "Test",
        z.object({}).passthrough(),
        z.object({ done: z.boolean() }),
      )
        .pipe(asyncStage)
        .build();

      const { kernel, flush, persistence } = createTestKernel([workflow]);

      const createResult = await kernel.dispatch({
        type: "run.create",
        idempotencyKey: "max-wait-1",
        workflowId: "max-wait",
        input: {},
      });
      await kernel.dispatch({ type: "run.claimPending", workerId: "w" });
      await flush();

      await kernel.dispatch({
        type: "job.execute",
        workflowRunId: createResult.workflowRunId,
        workflowId: "max-wait",
        stageId: "max-wait-stage",
        config: {},
      });

      const stages = await persistence.getStagesByRun(
        createResult.workflowRunId,
      );
      const stage = stages.find((s) => s.stageId === "max-wait-stage");
      const suspendedState = stage?.suspendedState as { maxWaitTime: number };
      expect(suspendedState.maxWaitTime).toBe(maxWaitTime);
    });
  });

  describe("checkCompletion behavior", () => {
    it("should reschedule with custom nextCheckIn when not ready", async () => {
      let checkCount = 0;
      const customIntervals = [1000, 2000, 5000];

      const asyncStage = defineAsyncBatchStage({
        id: "override-interval",
        name: "Override Interval Stage",
        mode: "async-batch",
        schemas: {
          input: z.object({}).passthrough(),
          output: z.object({ count: z.number() }),
          config: z.object({}),
        },
        async execute() {
          const now = new Date();
          return {
            suspended: true,
            state: {
              batchId: "batch-override",
              submittedAt: now.toISOString(),
              pollInterval: 500,
              maxWaitTime: 60000,
            },
            pollConfig: {
              pollInterval: 500,
              maxWaitTime: 60000,
              nextPollAt: new Date(now.getTime() + 500),
            },
          };
        },
        async checkCompletion(): Promise<
          CompletionCheckResult<{ count: number }>
        > {
          checkCount++;
          if (checkCount >= 3) {
            return { ready: true, output: { count: checkCount } };
          }
          return { ready: false, nextCheckIn: customIntervals[checkCount - 1] };
        },
      });

      const workflow = new WorkflowBuilder(
        "override",
        "Override Workflow",
        "Test",
        z.object({}).passthrough(),
        z.object({ count: z.number() }),
      )
        .pipe(asyncStage)
        .build();

      const { kernel, flush, persistence, clock } = createTestKernel([
        workflow,
      ]);

      const createResult = await kernel.dispatch({
        type: "run.create",
        idempotencyKey: "override-1",
        workflowId: "override",
        input: {},
      });
      await kernel.dispatch({ type: "run.claimPending", workerId: "w" });
      await flush();

      await kernel.dispatch({
        type: "job.execute",
        workflowRunId: createResult.workflowRunId,
        workflowId: "override",
        stageId: "override-interval",
        config: {},
      });

      // First poll: not ready, nextCheckIn = 1000
      let stages = await persistence.getStagesByRun(createResult.workflowRunId);
      await persistence.updateStage(stages[0]!.id, {
        nextPollAt: new Date(clock.now().getTime() - 1000),
      });

      let pollResult = await kernel.dispatch({ type: "stage.pollSuspended" });
      expect(pollResult.resumed).toBe(0);
      expect(checkCount).toBe(1);

      // Verify nextPollAt was updated (not null means rescheduled)
      stages = await persistence.getStagesByRun(createResult.workflowRunId);
      expect(stages[0]!.status).toBe("SUSPENDED");
      expect(stages[0]!.nextPollAt).toBeDefined();

      // Second poll: not ready, nextCheckIn = 2000
      await persistence.updateStage(stages[0]!.id, {
        nextPollAt: new Date(clock.now().getTime() - 1000),
      });

      pollResult = await kernel.dispatch({ type: "stage.pollSuspended" });
      expect(pollResult.resumed).toBe(0);
      expect(checkCount).toBe(2);

      // Third poll: ready
      stages = await persistence.getStagesByRun(createResult.workflowRunId);
      await persistence.updateStage(stages[0]!.id, {
        nextPollAt: new Date(clock.now().getTime() - 1000),
      });

      pollResult = await kernel.dispatch({ type: "stage.pollSuspended" });
      expect(pollResult.resumed).toBe(1);
      expect(checkCount).toBe(3);

      stages = await persistence.getStagesByRun(createResult.workflowRunId);
      expect(stages[0]!.status).toBe("COMPLETED");
    });

    it("should track progress through multiple completion checks", async () => {
      let checkHistory: Array<{ checkNumber: number; timestamp: number }> = [];
      let isComplete = false;

      const asyncStage = defineAsyncBatchStage({
        id: "progress-track",
        name: "Progress Track Stage",
        mode: "async-batch",
        schemas: {
          input: z.object({}).passthrough(),
          output: z.object({ checksPerformed: z.number() }),
          config: z.object({}),
        },
        async execute() {
          checkHistory = [];
          const now = new Date();
          return {
            suspended: true,
            state: {
              batchId: "batch-progress",
              submittedAt: now.toISOString(),
              pollInterval: 100,
              maxWaitTime: 60000,
            },
            pollConfig: {
              pollInterval: 100,
              maxWaitTime: 60000,
              nextPollAt: new Date(now.getTime() + 100),
            },
          };
        },
        async checkCompletion() {
          checkHistory.push({
            checkNumber: checkHistory.length + 1,
            timestamp: Date.now(),
          });
          if (isComplete) {
            return {
              ready: true,
              output: { checksPerformed: checkHistory.length },
            };
          }
          return { ready: false, nextCheckIn: 100 };
        },
      });

      const workflow = new WorkflowBuilder(
        "progress",
        "Progress Workflow",
        "Test",
        z.object({}).passthrough(),
        z.object({ checksPerformed: z.number() }),
      )
        .pipe(asyncStage)
        .build();

      const { kernel, flush, persistence, clock } = createTestKernel([
        workflow,
      ]);

      const createResult = await kernel.dispatch({
        type: "run.create",
        idempotencyKey: "progress-1",
        workflowId: "progress",
        input: {},
      });
      await kernel.dispatch({ type: "run.claimPending", workerId: "w" });
      await flush();

      await kernel.dispatch({
        type: "job.execute",
        workflowRunId: createResult.workflowRunId,
        workflowId: "progress",
        stageId: "progress-track",
        config: {},
      });

      // Poll 3 times: not ready
      for (let i = 0; i < 3; i++) {
        const stages = await persistence.getStagesByRun(
          createResult.workflowRunId,
        );
        await persistence.updateStage(stages[0]!.id, {
          nextPollAt: new Date(clock.now().getTime() - 1000),
        });
        const result = await kernel.dispatch({ type: "stage.pollSuspended" });
        expect(result.resumed).toBe(0);
      }

      // Mark complete and poll once more
      isComplete = true;
      const stages = await persistence.getStagesByRun(
        createResult.workflowRunId,
      );
      await persistence.updateStage(stages[0]!.id, {
        nextPollAt: new Date(clock.now().getTime() - 1000),
      });

      const finalResult = await kernel.dispatch({
        type: "stage.pollSuspended",
      });
      expect(finalResult.resumed).toBe(1);

      expect(checkHistory).toHaveLength(4);
      expect(checkHistory[0].checkNumber).toBe(1);
      expect(checkHistory[3].checkNumber).toBe(4);
    });
  });

  describe("completion with output", () => {
    it("should store output from checkCompletion in blobStore when ready", async () => {
      const batchResults = {
        processedItems: 150,
        successCount: 148,
        errorCount: 2,
        outputData: ["item1", "item2", "item3"],
      };

      const asyncStage = defineAsyncBatchStage({
        id: "output-stage",
        name: "Output Stage",
        mode: "async-batch",
        schemas: {
          input: z.object({}).passthrough(),
          output: z.object({
            processedItems: z.number(),
            successCount: z.number(),
            errorCount: z.number(),
            outputData: z.array(z.string()),
          }),
          config: z.object({}),
        },
        async execute() {
          const now = new Date();
          return {
            suspended: true,
            state: {
              batchId: "batch-output",
              submittedAt: now.toISOString(),
              pollInterval: 1000,
              maxWaitTime: 60000,
            },
            pollConfig: {
              pollInterval: 1000,
              maxWaitTime: 60000,
              nextPollAt: new Date(now.getTime() + 1000),
            },
          };
        },
        async checkCompletion() {
          return { ready: true, output: batchResults };
        },
      });

      const workflow = new WorkflowBuilder(
        "output-wf",
        "Output Workflow",
        "Test",
        z.object({}).passthrough(),
        z.object({
          processedItems: z.number(),
          successCount: z.number(),
          errorCount: z.number(),
          outputData: z.array(z.string()),
        }),
      )
        .pipe(asyncStage)
        .build();

      const { kernel, flush, persistence, blobStore, clock } = createTestKernel(
        [workflow],
      );

      const createResult = await kernel.dispatch({
        type: "run.create",
        idempotencyKey: "output-1",
        workflowId: "output-wf",
        input: {},
      });
      await kernel.dispatch({ type: "run.claimPending", workerId: "w" });
      await flush();

      await kernel.dispatch({
        type: "job.execute",
        workflowRunId: createResult.workflowRunId,
        workflowId: "output-wf",
        stageId: "output-stage",
        config: {},
      });

      const stages = await persistence.getStagesByRun(
        createResult.workflowRunId,
      );
      await persistence.updateStage(stages[0]!.id, {
        nextPollAt: new Date(clock.now().getTime() - 1000),
      });

      const pollResult = await kernel.dispatch({ type: "stage.pollSuspended" });
      expect(pollResult.resumed).toBe(1);

      // Verify stage COMPLETED and output stored in blobStore
      const updatedStages = await persistence.getStagesByRun(
        createResult.workflowRunId,
      );
      expect(updatedStages[0]!.status).toBe("COMPLETED");
      expect(blobStore.size()).toBeGreaterThan(0);
    });

    it("should include metrics in stage record when checkCompletion returns them", async () => {
      const asyncStage = defineAsyncBatchStage({
        id: "metrics-stage",
        name: "Metrics Stage",
        mode: "async-batch",
        schemas: {
          input: z.object({}).passthrough(),
          output: z.object({ done: z.boolean() }),
          config: z.object({}),
        },
        async execute() {
          const now = new Date();
          return {
            suspended: true,
            state: {
              batchId: "batch-metrics",
              submittedAt: now.toISOString(),
              pollInterval: 1000,
              maxWaitTime: 60000,
            },
            pollConfig: {
              pollInterval: 1000,
              maxWaitTime: 60000,
              nextPollAt: new Date(now.getTime() + 1000),
            },
          };
        },
        async checkCompletion(): Promise<
          CompletionCheckResult<{ done: boolean }>
        > {
          return {
            ready: true,
            output: { done: true },
            metrics: {
              startTime: Date.now() - 5000,
              endTime: Date.now(),
              duration: 5000,
              itemsProcessed: 100,
              totalTokens: 50000,
            },
          };
        },
      });

      const workflow = new WorkflowBuilder(
        "metrics-wf",
        "Metrics Workflow",
        "Test",
        z.object({}).passthrough(),
        z.object({ done: z.boolean() }),
      )
        .pipe(asyncStage)
        .build();

      const { kernel, flush, persistence, clock } = createTestKernel([
        workflow,
      ]);

      const createResult = await kernel.dispatch({
        type: "run.create",
        idempotencyKey: "metrics-1",
        workflowId: "metrics-wf",
        input: {},
      });
      await kernel.dispatch({ type: "run.claimPending", workerId: "w" });
      await flush();

      await kernel.dispatch({
        type: "job.execute",
        workflowRunId: createResult.workflowRunId,
        workflowId: "metrics-wf",
        stageId: "metrics-stage",
        config: {},
      });

      const stages = await persistence.getStagesByRun(
        createResult.workflowRunId,
      );
      await persistence.updateStage(stages[0]!.id, {
        nextPollAt: new Date(clock.now().getTime() - 1000),
      });

      await kernel.dispatch({ type: "stage.pollSuspended" });

      const updatedStages = await persistence.getStagesByRun(
        createResult.workflowRunId,
      );
      expect(updatedStages[0]!.status).toBe("COMPLETED");
      const metrics = updatedStages[0]!.metrics as any;
      expect(metrics).toBeDefined();
      expect(metrics.itemsProcessed).toBe(100);
      expect(metrics.totalTokens).toBe(50000);
    });
  });

  describe("state persistence during polling", () => {
    it("should preserve batchId in suspendedState across polls", async () => {
      const expectedBatchId = "batch-consistent-123";
      const receivedBatchIds: string[] = [];
      let readyCount = 0;

      const asyncStage = defineAsyncBatchStage({
        id: "consistent-batch",
        name: "Consistent Batch Stage",
        mode: "async-batch",
        schemas: {
          input: z.object({}).passthrough(),
          output: z.object({ done: z.boolean() }),
          config: z.object({}),
        },
        async execute() {
          const now = new Date();
          return {
            suspended: true,
            state: {
              batchId: expectedBatchId,
              submittedAt: now.toISOString(),
              pollInterval: 100,
              maxWaitTime: 60000,
            },
            pollConfig: {
              pollInterval: 100,
              maxWaitTime: 60000,
              nextPollAt: new Date(now.getTime() + 100),
            },
          };
        },
        async checkCompletion(state) {
          receivedBatchIds.push(state.batchId);
          readyCount++;
          if (readyCount >= 3) {
            return { ready: true, output: { done: true } };
          }
          return { ready: false };
        },
      });

      const workflow = new WorkflowBuilder(
        "consistent",
        "Consistent Workflow",
        "Test",
        z.object({}).passthrough(),
        z.object({ done: z.boolean() }),
      )
        .pipe(asyncStage)
        .build();

      const { kernel, flush, persistence, clock } = createTestKernel([
        workflow,
      ]);

      const createResult = await kernel.dispatch({
        type: "run.create",
        idempotencyKey: "consistent-1",
        workflowId: "consistent",
        input: {},
      });
      await kernel.dispatch({ type: "run.claimPending", workerId: "w" });
      await flush();

      await kernel.dispatch({
        type: "job.execute",
        workflowRunId: createResult.workflowRunId,
        workflowId: "consistent",
        stageId: "consistent-batch",
        config: {},
      });

      // Poll 3 times
      for (let i = 0; i < 3; i++) {
        const stages = await persistence.getStagesByRun(
          createResult.workflowRunId,
        );
        await persistence.updateStage(stages[0]!.id, {
          nextPollAt: new Date(clock.now().getTime() - 1000),
        });
        await kernel.dispatch({ type: "stage.pollSuspended" });
      }

      // All checks received same batchId
      expect(receivedBatchIds).toHaveLength(3);
      expect(receivedBatchIds.every((id) => id === expectedBatchId)).toBe(true);
    });

    it("should preserve submittedAt timestamp across polls", async () => {
      const submittedAt = new Date(Date.now() - 60000).toISOString();
      let receivedSubmittedAt: string | undefined;

      const asyncStage = defineAsyncBatchStage({
        id: "timestamp-stage",
        name: "Timestamp Stage",
        mode: "async-batch",
        schemas: {
          input: z.object({}).passthrough(),
          output: z.object({ done: z.boolean() }),
          config: z.object({}),
        },
        async execute() {
          const now = new Date();
          return {
            suspended: true,
            state: {
              batchId: "batch-timestamp",
              submittedAt,
              pollInterval: 1000,
              maxWaitTime: 300000,
            },
            pollConfig: {
              pollInterval: 1000,
              maxWaitTime: 300000,
              nextPollAt: new Date(now.getTime() + 1000),
            },
          };
        },
        async checkCompletion(state) {
          receivedSubmittedAt = state.submittedAt;
          return { ready: true, output: { done: true } };
        },
      });

      const workflow = new WorkflowBuilder(
        "timestamp",
        "Timestamp Workflow",
        "Test",
        z.object({}).passthrough(),
        z.object({ done: z.boolean() }),
      )
        .pipe(asyncStage)
        .build();

      const { kernel, flush, persistence, clock } = createTestKernel([
        workflow,
      ]);

      const createResult = await kernel.dispatch({
        type: "run.create",
        idempotencyKey: "ts-1",
        workflowId: "timestamp",
        input: {},
      });
      await kernel.dispatch({ type: "run.claimPending", workerId: "w" });
      await flush();

      await kernel.dispatch({
        type: "job.execute",
        workflowRunId: createResult.workflowRunId,
        workflowId: "timestamp",
        stageId: "timestamp-stage",
        config: {},
      });

      const stages = await persistence.getStagesByRun(
        createResult.workflowRunId,
      );
      await persistence.updateStage(stages[0]!.id, {
        nextPollAt: new Date(clock.now().getTime() - 1000),
      });

      await kernel.dispatch({ type: "stage.pollSuspended" });

      expect(receivedSubmittedAt).toBe(submittedAt);
    });
  });
});
