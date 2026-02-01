/**
 * Async-Batch Stage Definition Tests
 *
 * Tests for defining stages that suspend for long-running batch operations.
 */

import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { CheckCompletionContext, StageContext } from "../../core/stage.js";
import { defineAsyncBatchStage } from "../../core/stage-factory.js";
import { TestSchemas } from "../utils/index.js";

describe("I want to define async-batch stages", () => {
  describe("stage creation", () => {
    it("should create a stage with mode: 'async-batch'", () => {
      // Given: defineAsyncBatchStage({ mode: "async-batch", ... })
      const stage = defineAsyncBatchStage({
        id: "batch-stage",
        name: "Batch Stage",
        mode: "async-batch",
        schemas: {
          input: TestSchemas.string,
          output: z.object({ results: z.array(z.string()) }),
          config: z.object({}),
        },
        async execute(ctx) {
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
          };
        },
        async checkCompletion() {
          return { ready: true, output: { results: ["done"] } };
        },
      });

      // Then: Stage.mode is "async-batch"
      expect(stage.mode).toBe("async-batch");
      expect(stage.id).toBe("batch-stage");
    });

    it("should have checkCompletion function defined", () => {
      // Given: Async-batch stage definition
      const stage = defineAsyncBatchStage({
        id: "check-stage",
        name: "Check Stage",
        mode: "async-batch",
        schemas: {
          input: TestSchemas.string,
          output: z.object({ done: z.boolean() }),
          config: z.object({}),
        },
        async execute() {
          const now = new Date();
          return {
            suspended: true,
            state: {
              batchId: "batch-456",
              submittedAt: now.toISOString(),
              pollInterval: 1000,
              maxWaitTime: 30000,
            },
            pollConfig: {
              pollInterval: 1000,
              maxWaitTime: 30000,
              nextPollAt: new Date(now.getTime() + 1000),
            },
          };
        },
        async checkCompletion() {
          return { ready: true, output: { done: true } };
        },
      });

      // Then: checkCompletion is defined
      expect(stage.checkCompletion).toBeDefined();
      expect(typeof stage.checkCompletion).toBe("function");
    });
  });

  describe("suspended result", () => {
    it("should return suspended: true with state", async () => {
      // Given: Stage that returns suspended result
      const stage = defineAsyncBatchStage({
        id: "suspend-stage",
        name: "Suspend Stage",
        mode: "async-batch",
        schemas: {
          input: TestSchemas.string,
          output: z.object({ result: z.string() }),
          config: z.object({}),
        },
        async execute() {
          const now = new Date();
          return {
            suspended: true,
            state: {
              batchId: "my-batch-id",
              submittedAt: now.toISOString(),
              pollInterval: 10000,
              maxWaitTime: 120000,
              metadata: { customField: "value" },
            },
            pollConfig: {
              pollInterval: 10000,
              maxWaitTime: 120000,
              nextPollAt: new Date(now.getTime() + 10000),
            },
          };
        },
        async checkCompletion() {
          return { ready: true, output: { result: "completed" } };
        },
      });

      // When: Executed
      const mockContext = createMockContext({
        stageId: "suspend-stage",
        stageName: "Suspend Stage",
        input: { value: "test" },
      });

      const result = await stage.execute(mockContext);

      // Then: Returns { suspended: true, state: {...}, pollConfig: {...} }
      expect("suspended" in result).toBe(true);
      if ("suspended" in result) {
        expect(result.suspended).toBe(true);
        expect(result.state).toBeDefined();
        expect(result.state.batchId).toBe("my-batch-id");
        expect(result.state.pollInterval).toBe(10000);
        expect(result.state.maxWaitTime).toBe(120000);
      }
    });

    it("should include poll configuration", async () => {
      // Given: Stage with poll config
      const stage = defineAsyncBatchStage({
        id: "poll-config-stage",
        name: "Poll Config Stage",
        mode: "async-batch",
        schemas: {
          input: TestSchemas.string,
          output: z.object({ result: z.string() }),
          config: z.object({}),
        },
        async execute() {
          const now = new Date();
          const nextPoll = new Date(now.getTime() + 30000);
          return {
            suspended: true,
            state: {
              batchId: "poll-batch",
              submittedAt: now.toISOString(),
              pollInterval: 30000,
              maxWaitTime: 300000,
            },
            pollConfig: {
              pollInterval: 30000,
              maxWaitTime: 300000,
              nextPollAt: nextPoll,
            },
          };
        },
        async checkCompletion() {
          return { ready: true, output: { result: "done" } };
        },
      });

      // When: Returns suspended result
      const mockContext = createMockContext({
        stageId: "poll-config-stage",
        stageName: "Poll Config Stage",
        input: { value: "test" },
      });

      const result = await stage.execute(mockContext);

      // Then: pollConfig has pollInterval, maxWaitTime, nextPollAt
      if ("suspended" in result) {
        expect(result.pollConfig).toBeDefined();
        expect(result.pollConfig.pollInterval).toBe(30000);
        expect(result.pollConfig.maxWaitTime).toBe(300000);
        expect(result.pollConfig.nextPollAt).toBeInstanceOf(Date);
      }
    });

    it("should return output when resuming", async () => {
      // Given: Stage that checks resumeState
      const stage = defineAsyncBatchStage({
        id: "resume-stage",
        name: "Resume Stage",
        mode: "async-batch",
        schemas: {
          input: TestSchemas.string,
          output: z.object({ finalResult: z.string() }),
          config: z.object({}),
        },
        async execute(ctx) {
          // If resuming, return the final output
          if (ctx.resumeState) {
            return {
              output: {
                finalResult: `Completed batch ${ctx.resumeState.batchId}`,
              },
            };
          }

          // First run - suspend
          const now = new Date();
          return {
            suspended: true,
            state: {
              batchId: "resume-batch-123",
              submittedAt: now.toISOString(),
              pollInterval: 5000,
              maxWaitTime: 60000,
            },
            pollConfig: {
              pollInterval: 5000,
              maxWaitTime: 60000,
              nextPollAt: new Date(now.getTime() + 5000),
            },
          };
        },
        async checkCompletion() {
          return {
            ready: true,
            output: { finalResult: "from checkCompletion" },
          };
        },
      });

      // When: Executed with resumeState
      const mockContext = createMockContext({
        stageId: "resume-stage",
        stageName: "Resume Stage",
        input: { value: "test" },
        resumeState: {
          batchId: "resume-batch-123",
          submittedAt: new Date().toISOString(),
          pollInterval: 5000,
          maxWaitTime: 60000,
        },
      });

      const result = await stage.execute(mockContext);

      // Then: Returns output (not suspended)
      expect("output" in result).toBe(true);
      if ("output" in result) {
        expect(result.output.finalResult).toBe(
          "Completed batch resume-batch-123",
        );
      }
    });
  });

  describe("checkCompletion", () => {
    it("should return ready: true when complete", async () => {
      // Given: checkCompletion that detects completion
      const stage = defineAsyncBatchStage({
        id: "ready-stage",
        name: "Ready Stage",
        mode: "async-batch",
        schemas: {
          input: TestSchemas.string,
          output: z.object({ data: z.array(z.number()) }),
          config: z.object({}),
        },
        async execute() {
          const now = new Date();
          return {
            suspended: true,
            state: {
              batchId: "ready-batch",
              submittedAt: now.toISOString(),
              pollInterval: 1000,
              maxWaitTime: 30000,
            },
            pollConfig: {
              pollInterval: 1000,
              maxWaitTime: 30000,
              nextPollAt: new Date(now.getTime() + 1000),
            },
          };
        },
        async checkCompletion() {
          // Simulate completed batch
          return {
            ready: true,
            output: { data: [1, 2, 3, 4, 5] },
          };
        },
      });

      // When: Called with completed state
      const checkContext = createCheckContext({
        stageId: "ready-stage",
        config: {},
      });

      const result = await stage.checkCompletion!(
        {
          batchId: "ready-batch",
          submittedAt: new Date().toISOString(),
          pollInterval: 1000,
          maxWaitTime: 30000,
        },
        checkContext,
      );

      // Then: Returns { ready: true }
      expect(result.ready).toBe(true);
      if (result.ready && "output" in result) {
        expect(result.output).toEqual({ data: [1, 2, 3, 4, 5] });
      }
    });

    it("should return ready: false with nextCheckIn", async () => {
      // Given: checkCompletion for incomplete job
      let checkCount = 0;

      const stage = defineAsyncBatchStage({
        id: "not-ready-stage",
        name: "Not Ready Stage",
        mode: "async-batch",
        schemas: {
          input: TestSchemas.string,
          output: z.object({ result: z.string() }),
          config: z.object({}),
        },
        async execute() {
          const now = new Date();
          return {
            suspended: true,
            state: {
              batchId: "pending-batch",
              submittedAt: now.toISOString(),
              pollInterval: 5000,
              maxWaitTime: 60000,
            },
            pollConfig: {
              pollInterval: 5000,
              maxWaitTime: 60000,
              nextPollAt: new Date(now.getTime() + 5000),
            },
          };
        },
        async checkCompletion() {
          checkCount++;
          // Not ready yet
          return {
            ready: false,
            nextCheckIn: 30000, // Check again in 30 seconds
          };
        },
      });

      // When: Called
      const checkContext = createCheckContext({
        stageId: "not-ready-stage",
        config: {},
      });

      const result = await stage.checkCompletion!(
        {
          batchId: "pending-batch",
          submittedAt: new Date().toISOString(),
          pollInterval: 5000,
          maxWaitTime: 60000,
        },
        checkContext,
      );

      // Then: Returns { ready: false, nextCheckIn: 30000 }
      expect(result.ready).toBe(false);
      if (!result.ready) {
        expect(result.nextCheckIn).toBe(30000);
      }
    });

    it("should return error on failure", async () => {
      // Given: checkCompletion detecting failure
      const stage = defineAsyncBatchStage({
        id: "error-stage",
        name: "Error Stage",
        mode: "async-batch",
        schemas: {
          input: TestSchemas.string,
          output: z.object({ result: z.string() }),
          config: z.object({}),
        },
        async execute() {
          const now = new Date();
          return {
            suspended: true,
            state: {
              batchId: "failed-batch",
              submittedAt: now.toISOString(),
              pollInterval: 1000,
              maxWaitTime: 30000,
            },
            pollConfig: {
              pollInterval: 1000,
              maxWaitTime: 30000,
              nextPollAt: new Date(now.getTime() + 1000),
            },
          };
        },
        async checkCompletion() {
          // Batch job failed
          return {
            ready: true,
            error: "Batch job failed: API rate limit exceeded",
          };
        },
      });

      // When: Called
      const checkContext = createCheckContext({
        stageId: "error-stage",
        config: {},
      });

      const result = await stage.checkCompletion!(
        {
          batchId: "failed-batch",
          submittedAt: new Date().toISOString(),
          pollInterval: 1000,
          maxWaitTime: 30000,
        },
        checkContext,
      );

      // Then: Returns { ready: true, error: "Job failed" }
      expect(result.ready).toBe(true);
      if (result.ready && "error" in result) {
        expect(result.error).toBe("Batch job failed: API rate limit exceeded");
      }
    });

    it("should receive context with workflowRunId and config", async () => {
      // Given: checkCompletion that uses context
      let capturedContext: CheckCompletionContext<{ apiKey: string }> | null =
        null;

      const stage = defineAsyncBatchStage({
        id: "context-check-stage",
        name: "Context Check Stage",
        mode: "async-batch",
        schemas: {
          input: TestSchemas.string,
          output: z.object({ result: z.string() }),
          config: z.object({ apiKey: z.string() }),
        },
        async execute() {
          const now = new Date();
          return {
            suspended: true,
            state: {
              batchId: "context-batch",
              submittedAt: now.toISOString(),
              pollInterval: 1000,
              maxWaitTime: 30000,
            },
            pollConfig: {
              pollInterval: 1000,
              maxWaitTime: 30000,
              nextPollAt: new Date(now.getTime() + 1000),
            },
          };
        },
        async checkCompletion(_state, ctx) {
          capturedContext = ctx;
          return { ready: true, output: { result: "done" } };
        },
      });

      // When: Called with context
      const checkContext = createCheckContext({
        stageId: "context-check-stage",
        config: { apiKey: "secret-key" },
        workflowRunId: "run-abc-123",
      });

      await stage.checkCompletion!(
        {
          batchId: "context-batch",
          submittedAt: new Date().toISOString(),
          pollInterval: 1000,
          maxWaitTime: 30000,
        },
        checkContext as CheckCompletionContext<{ apiKey: string }>,
      );

      // Then: Context includes workflowRunId and config
      expect(capturedContext).toBeDefined();
      expect(capturedContext?.workflowRunId).toBe("run-abc-123");
      expect(capturedContext?.config).toEqual({ apiKey: "secret-key" });
    });
  });

  describe("stage with dependencies", () => {
    it("should support dependencies in async-batch stages", () => {
      // Given: Async-batch stage with dependencies
      const stage = defineAsyncBatchStage({
        id: "dependent-batch",
        name: "Dependent Batch",
        dependencies: ["prep-stage", "data-stage"],
        mode: "async-batch",
        schemas: {
          input: TestSchemas.string,
          output: z.object({ result: z.string() }),
          config: z.object({}),
        },
        async execute() {
          const now = new Date();
          return {
            suspended: true,
            state: {
              batchId: "dep-batch",
              submittedAt: now.toISOString(),
              pollInterval: 1000,
              maxWaitTime: 30000,
            },
            pollConfig: {
              pollInterval: 1000,
              maxWaitTime: 30000,
              nextPollAt: new Date(now.getTime() + 1000),
            },
          };
        },
        async checkCompletion() {
          return { ready: true, output: { result: "done" } };
        },
      });

      // Then: Dependencies are preserved
      expect(stage.dependencies).toEqual(["prep-stage", "data-stage"]);
    });
  });
});

// ============================================================================
// Helper Functions
// ============================================================================

function createMockContext(options: {
  stageId: string;
  stageName: string;
  input: unknown;
  resumeState?: {
    batchId: string;
    submittedAt: string;
    pollInterval: number;
    maxWaitTime: number;
    metadata?: Record<string, unknown>;
  };
}): StageContext<unknown, Record<string, never>, Record<string, unknown>> {
  return {
    workflowRunId: "run-1",
    stageRecordId: "stage-record-1",
    stageId: options.stageId,
    stageName: options.stageName,
    stageNumber: 0,
    input: options.input,
    config: {},
    workflowContext: {},
    resumeState: options.resumeState,
    onProgress: () => {},
    log: () => {},
    storage: {
      save: async () => {},
      load: async () => null,
      exists: async () => false,
      delete: async () => {},
      getStageKey: () => "key",
    },
  };
}

function createCheckContext(options: {
  stageId: string;
  config: Record<string, unknown>;
  workflowRunId?: string;
}): CheckCompletionContext<Record<string, unknown>> {
  return {
    workflowRunId: options.workflowRunId ?? "run-1",
    stageId: options.stageId,
    config: options.config,
    log: () => {},
    storage: {
      save: async () => {},
      load: async () => null,
      exists: async () => false,
      delete: async () => {},
      getStageKey: () => "key",
    },
  };
}
