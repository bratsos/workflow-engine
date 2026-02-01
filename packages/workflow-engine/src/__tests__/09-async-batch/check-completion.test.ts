/**
 * Async Batch Check Completion Tests
 *
 * Tests for polling mechanics and completion checking.
 *
 * Note: Basic checkCompletion returning ready/not-ready is covered in 02-stage-definition/async-batch-stages.test.ts
 * This file focuses on:
 * - Polling configuration and timing
 * - Max wait time handling
 * - State management during polling
 * - Progressive state updates
 * - nextCheckIn overrides
 */

import { describe, it, expect, beforeEach } from "vitest";
import { z } from "zod";
import { WorkflowBuilder } from "../../core/workflow.js";
import { WorkflowExecutor } from "../../core/executor.js";
import { defineAsyncBatchStage } from "../../core/stage-factory.js";
import {
  InMemoryWorkflowPersistence,
  InMemoryAICallLogger,
  TestSchemas,
} from "../utils/index.js";
import type { SimpleSuspendedResult } from "../../core/stage-factory.js";
import type { CompletionCheckResult } from "../../core/types.js";

describe("I want to poll async-batch stages for completion", () => {
  let persistence: InMemoryWorkflowPersistence;
  let aiLogger: InMemoryAICallLogger;

  beforeEach(() => {
    persistence = new InMemoryWorkflowPersistence();
    aiLogger = new InMemoryAICallLogger();
  });

  describe("poll configuration", () => {
    it("should use pollInterval from suspended state", async () => {
      // Given: Stage with specific poll interval
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
        async execute(ctx) {
          if (ctx.resumeState) {
            return { output: { done: true } };
          }
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
          } as SimpleSuspendedResult;
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

      await persistence.createRun({
        id: "run-poll-config",
        workflowId: "poll-config",
        workflowName: "Poll Config Workflow",
        status: "PENDING",
        input: {},
      });

      // When: Execute and suspend
      const executor = new WorkflowExecutor(
        workflow,
        "run-poll-config",
        "poll-config",
        {
          persistence,
          aiLogger,
        },
      );
      await executor.execute({}, {});

      // Then: Stage record has correct poll config
      const stages = await persistence.getStagesByRun("run-poll-config", {});
      const stage = stages.find((s) => s.stageId === "poll-interval-stage");

      expect(stage?.suspendedState).toBeDefined();
      const suspendedState = stage?.suspendedState as { pollInterval: number };
      expect(suspendedState.pollInterval).toBe(pollInterval);
    });

    it("should store nextPollAt time for orchestrator", async () => {
      // Given: Stage that suspends
      const now = new Date();
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
        async execute(ctx) {
          if (ctx.resumeState) {
            return { output: { done: true } };
          }
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
          } as SimpleSuspendedResult;
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

      await persistence.createRun({
        id: "run-next-poll",
        workflowId: "next-poll",
        workflowName: "Next Poll Workflow",
        status: "PENDING",
        input: {},
      });

      // When: Execute and suspend
      const executor = new WorkflowExecutor(
        workflow,
        "run-next-poll",
        "next-poll",
        {
          persistence,
          aiLogger,
        },
      );
      await executor.execute({}, {});

      // Then: Stage record has nextPollAt set
      const stages = await persistence.getStagesByRun("run-next-poll", {});
      const stage = stages.find((s) => s.stageId === "next-poll-stage");

      expect(stage?.nextPollAt).toBeDefined();
      expect(stage?.nextPollAt).toBeInstanceOf(Date);
    });

    it("should store maxWaitTime for timeout detection", async () => {
      // Given: Stage with specific max wait time
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
        async execute(ctx) {
          if (ctx.resumeState) {
            return { output: { done: true } };
          }
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
          } as SimpleSuspendedResult;
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

      await persistence.createRun({
        id: "run-max-wait",
        workflowId: "max-wait",
        workflowName: "Max Wait Workflow",
        status: "PENDING",
        input: {},
      });

      // When: Execute and suspend
      const executor = new WorkflowExecutor(
        workflow,
        "run-max-wait",
        "max-wait",
        {
          persistence,
          aiLogger,
        },
      );
      await executor.execute({}, {});

      // Then: Suspended state has maxWaitTime
      const stages = await persistence.getStagesByRun("run-max-wait", {});
      const stage = stages.find((s) => s.stageId === "max-wait-stage");
      const suspendedState = stage?.suspendedState as { maxWaitTime: number };

      expect(suspendedState.maxWaitTime).toBe(maxWaitTime);
    });
  });

  describe("checkCompletion behavior", () => {
    it("should allow checkCompletion to override next poll interval", async () => {
      // Given: Stage where checkCompletion returns custom nextCheckIn
      let checkCount = 0;
      const customIntervals = [1000, 2000, 5000]; // Escalating intervals

      const asyncStage = defineAsyncBatchStage({
        id: "override-interval",
        name: "Override Interval Stage",
        mode: "async-batch",
        schemas: {
          input: z.object({}).passthrough(),
          output: z.object({ count: z.number() }),
          config: z.object({}),
        },
        async execute(ctx) {
          if (ctx.resumeState) {
            return { output: { count: checkCount } };
          }
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
          } as SimpleSuspendedResult;
        },
        async checkCompletion(): Promise<
          CompletionCheckResult<{ count: number }>
        > {
          checkCount++;
          if (checkCount >= 3) {
            return { ready: true, output: { count: checkCount } };
          }
          // Return increasing intervals
          return {
            ready: false,
            nextCheckIn: customIntervals[checkCount - 1],
          };
        },
      });

      // When: checkCompletion is called multiple times
      const state = {
        batchId: "batch-override",
        submittedAt: new Date().toISOString(),
        pollInterval: 500,
        maxWaitTime: 60000,
      };

      const context = {
        workflowRunId: "run-1",
        stageId: "override-interval",
        config: {},
        log: () => {},
        storage: {
          save: async () => {},
          load: async () => null,
          exists: async () => false,
          delete: async () => {},
          getStageKey: () => "key",
        },
      };

      // First check
      const result1 = await asyncStage.checkCompletion!(state, context);
      expect(result1.ready).toBe(false);
      expect(result1.nextCheckIn).toBe(1000);

      // Second check
      const result2 = await asyncStage.checkCompletion!(state, context);
      expect(result2.ready).toBe(false);
      expect(result2.nextCheckIn).toBe(2000);

      // Third check - ready
      const result3 = await asyncStage.checkCompletion!(state, context);
      expect(result3.ready).toBe(true);
    });

    it("should provide state and context to checkCompletion", async () => {
      // Given: Stage that captures checkCompletion arguments
      let capturedState: unknown = null;
      let capturedContext: unknown = null;

      const asyncStage = defineAsyncBatchStage({
        id: "capture-args",
        name: "Capture Args Stage",
        mode: "async-batch",
        schemas: {
          input: z.object({}).passthrough(),
          output: z.object({ done: z.boolean() }),
          config: z.object({ apiEndpoint: z.string() }),
        },
        async execute(ctx) {
          if (ctx.resumeState) {
            return { output: { done: true } };
          }
          const now = new Date();
          return {
            suspended: true,
            state: {
              batchId: "batch-capture",
              submittedAt: now.toISOString(),
              pollInterval: 1000,
              maxWaitTime: 60000,
              metadata: {
                originalInput: { test: "data" },
              },
            },
            pollConfig: {
              pollInterval: 1000,
              maxWaitTime: 60000,
              nextPollAt: new Date(now.getTime() + 1000),
            },
          } as SimpleSuspendedResult;
        },
        async checkCompletion(state, ctx) {
          capturedState = state;
          capturedContext = ctx;
          return { ready: true, output: { done: true } };
        },
      });

      // When: checkCompletion is called
      const state = {
        batchId: "batch-capture",
        submittedAt: new Date().toISOString(),
        pollInterval: 1000,
        maxWaitTime: 60000,
        metadata: { originalInput: { test: "data" } },
      };

      const context = {
        workflowRunId: "run-capture",
        stageId: "capture-args",
        config: { apiEndpoint: "https://api.example.com" },
        log: () => {},
        storage: {
          save: async () => {},
          load: async () => null,
          exists: async () => false,
          delete: async () => {},
          getStageKey: () => "key",
        },
      };

      await asyncStage.checkCompletion!(state, context);

      // Then: State and context were provided
      expect(capturedState).toEqual(state);
      expect((capturedContext as { workflowRunId: string }).workflowRunId).toBe(
        "run-capture",
      );
      expect(
        (capturedContext as { config: { apiEndpoint: string } }).config
          .apiEndpoint,
      ).toBe("https://api.example.com");
    });

    it("should track progress through multiple completion checks", async () => {
      // Given: Stage that tracks progress through checks
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
        async execute(ctx) {
          if (ctx.resumeState) {
            return { output: { checksPerformed: checkHistory.length } };
          }
          checkHistory = []; // Reset
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
          } as SimpleSuspendedResult;
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

      // Perform multiple checks
      const state = {
        batchId: "batch-progress",
        submittedAt: new Date().toISOString(),
        pollInterval: 100,
        maxWaitTime: 60000,
      };

      const context = {
        workflowRunId: "run-1",
        stageId: "progress-track",
        config: {},
        log: () => {},
        storage: {
          save: async () => {},
          load: async () => null,
          exists: async () => false,
          delete: async () => {},
          getStageKey: () => "key",
        },
      };

      // First 3 checks - not ready
      for (let i = 0; i < 3; i++) {
        const result = await asyncStage.checkCompletion!(state, context);
        expect(result.ready).toBe(false);
      }

      // Complete and final check
      isComplete = true;
      const finalResult = await asyncStage.checkCompletion!(state, context);

      // Then: All checks were tracked
      expect(finalResult.ready).toBe(true);
      expect(checkHistory).toHaveLength(4);
      expect(checkHistory[0].checkNumber).toBe(1);
      expect(checkHistory[3].checkNumber).toBe(4);
    });
  });

  describe("completion with output", () => {
    it("should return output from checkCompletion when ready", async () => {
      // Given: Stage where checkCompletion produces output
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
        async execute(ctx) {
          if (ctx.resumeState) {
            return { output: batchResults };
          }
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
          } as SimpleSuspendedResult;
        },
        async checkCompletion() {
          return {
            ready: true,
            output: batchResults,
          };
        },
      });

      // When: checkCompletion returns ready with output
      const state = {
        batchId: "batch-output",
        submittedAt: new Date().toISOString(),
        pollInterval: 1000,
        maxWaitTime: 60000,
      };

      const context = {
        workflowRunId: "run-1",
        stageId: "output-stage",
        config: {},
        log: () => {},
        storage: {
          save: async () => {},
          load: async () => null,
          exists: async () => false,
          delete: async () => {},
          getStageKey: () => "key",
        },
      };

      const result = await asyncStage.checkCompletion!(state, context);

      // Then: Output matches expected batch results
      expect(result.ready).toBe(true);
      expect(result.output).toEqual(batchResults);
    });

    it("should include metrics in checkCompletion result when available", async () => {
      // Given: Stage that returns metrics with completion
      const asyncStage = defineAsyncBatchStage({
        id: "metrics-stage",
        name: "Metrics Stage",
        mode: "async-batch",
        schemas: {
          input: z.object({}).passthrough(),
          output: z.object({ done: z.boolean() }),
          config: z.object({}),
        },
        async execute(ctx) {
          if (ctx.resumeState) {
            return { output: { done: true } };
          }
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
          } as SimpleSuspendedResult;
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

      // When: checkCompletion returns with metrics
      const state = {
        batchId: "batch-metrics",
        submittedAt: new Date().toISOString(),
        pollInterval: 1000,
        maxWaitTime: 60000,
      };

      const context = {
        workflowRunId: "run-1",
        stageId: "metrics-stage",
        config: {},
        log: () => {},
        storage: {
          save: async () => {},
          load: async () => null,
          exists: async () => false,
          delete: async () => {},
          getStageKey: () => "key",
        },
      };

      const result = await asyncStage.checkCompletion!(state, context);

      // Then: Metrics are included
      expect(result.ready).toBe(true);
      expect(result.metrics).toBeDefined();
      expect(result.metrics?.itemsProcessed).toBe(100);
      expect(result.metrics?.totalTokens).toBe(50000);
    });
  });

  describe("state persistence during polling", () => {
    it("should preserve batchId across multiple checks", async () => {
      // Given: Stage that validates batchId consistency
      const expectedBatchId = "batch-consistent-123";
      const receivedBatchIds: string[] = [];

      const asyncStage = defineAsyncBatchStage({
        id: "consistent-batch",
        name: "Consistent Batch Stage",
        mode: "async-batch",
        schemas: {
          input: z.object({}).passthrough(),
          output: z.object({ done: z.boolean() }),
          config: z.object({}),
        },
        async execute(ctx) {
          if (ctx.resumeState) {
            return { output: { done: true } };
          }
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
          } as SimpleSuspendedResult;
        },
        async checkCompletion(state) {
          receivedBatchIds.push(state.batchId);
          if (receivedBatchIds.length >= 3) {
            return { ready: true, output: { done: true } };
          }
          return { ready: false };
        },
      });

      // When: Multiple checks with same state
      const state = {
        batchId: expectedBatchId,
        submittedAt: new Date().toISOString(),
        pollInterval: 100,
        maxWaitTime: 60000,
      };

      const context = {
        workflowRunId: "run-1",
        stageId: "consistent-batch",
        config: {},
        log: () => {},
        storage: {
          save: async () => {},
          load: async () => null,
          exists: async () => false,
          delete: async () => {},
          getStageKey: () => "key",
        },
      };

      for (let i = 0; i < 3; i++) {
        await asyncStage.checkCompletion!(state, context);
      }

      // Then: All checks received same batchId
      expect(receivedBatchIds).toHaveLength(3);
      expect(receivedBatchIds.every((id) => id === expectedBatchId)).toBe(true);
    });

    it("should preserve submittedAt timestamp for timeout calculation", async () => {
      // Given: Stage that tracks submission time
      const submittedAt = new Date(Date.now() - 60000).toISOString(); // 1 minute ago
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
        async execute(ctx) {
          if (ctx.resumeState) {
            return { output: { done: true } };
          }
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
          } as SimpleSuspendedResult;
        },
        async checkCompletion(state) {
          receivedSubmittedAt = state.submittedAt;
          return { ready: true, output: { done: true } };
        },
      });

      // When: checkCompletion is called
      const state = {
        batchId: "batch-timestamp",
        submittedAt,
        pollInterval: 1000,
        maxWaitTime: 300000,
      };

      const context = {
        workflowRunId: "run-1",
        stageId: "timestamp-stage",
        config: {},
        log: () => {},
        storage: {
          save: async () => {},
          load: async () => null,
          exists: async () => false,
          delete: async () => {},
          getStageKey: () => "key",
        },
      };

      await asyncStage.checkCompletion!(state, context);

      // Then: Original submittedAt is preserved
      expect(receivedSubmittedAt).toBe(submittedAt);
    });
  });
});
