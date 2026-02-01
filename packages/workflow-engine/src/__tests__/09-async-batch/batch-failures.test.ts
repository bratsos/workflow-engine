/**
 * Async Batch Failure Tests
 *
 * Tests for failure handling in async-batch stages.
 *
 * Note: Basic error return from checkCompletion is covered in 02-stage-definition/async-batch-stages.test.ts
 * This file focuses on:
 * - Failure propagation in workflows
 * - Partial failure handling
 * - Error recovery patterns
 * - Failure during different phases (initiate, check, resume)
 */

import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { WorkflowExecutor } from "../../core/executor.js";
import type { SimpleSuspendedResult } from "../../core/stage-factory.js";
import {
  defineAsyncBatchStage,
  defineStage,
} from "../../core/stage-factory.js";
import type { CompletionCheckResult } from "../../core/types.js";
import { WorkflowBuilder } from "../../core/workflow.js";
import {
  createFailingSuspendStage,
  InMemoryAICallLogger,
  InMemoryWorkflowPersistence,
  TestSchemas,
} from "../utils/index.js";

describe("I want to handle failures in async-batch stages", () => {
  let persistence: InMemoryWorkflowPersistence;
  let aiLogger: InMemoryAICallLogger;

  beforeEach(() => {
    persistence = new InMemoryWorkflowPersistence();
    aiLogger = new InMemoryAICallLogger();
  });

  describe("checkCompletion error handling", () => {
    it("should return error message from checkCompletion", async () => {
      // Given: Stage where checkCompletion returns an error
      const errorMessage = "Batch processing failed: API rate limit exceeded";

      const asyncStage = defineAsyncBatchStage({
        id: "error-check-stage",
        name: "Error Check Stage",
        mode: "async-batch",
        schemas: {
          input: z.object({}).passthrough(),
          output: z.object({ result: z.string() }),
          config: z.object({}),
        },
        async execute(ctx) {
          if (ctx.resumeState) {
            return { output: { result: "resumed" } };
          }
          const now = new Date();
          return {
            suspended: true,
            state: {
              batchId: "batch-error",
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
          CompletionCheckResult<{ result: string }>
        > {
          return {
            ready: true,
            error: errorMessage,
          };
        },
      });

      // When: checkCompletion is called
      const state = {
        batchId: "batch-error",
        submittedAt: new Date().toISOString(),
        pollInterval: 1000,
        maxWaitTime: 60000,
      };

      const context = {
        workflowRunId: "run-1",
        stageId: "error-check-stage",
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

      // Then: Error is returned
      expect(result.ready).toBe(true);
      expect(result.error).toBe(errorMessage);
      expect(result.output).toBeUndefined();
    });

    it("should handle different error types in checkCompletion", async () => {
      // Given: Stage that can return various error types
      let errorType = "timeout";

      const asyncStage = defineAsyncBatchStage({
        id: "multi-error-stage",
        name: "Multi Error Stage",
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
              batchId: "batch-multi",
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
          const errors: Record<string, string> = {
            timeout: "Batch job timed out after 5 minutes",
            invalid_input: "Invalid input data: missing required field 'id'",
            quota_exceeded: "API quota exceeded, try again later",
            partial_failure: "5 of 100 items failed to process",
          };

          return {
            ready: true,
            error: errors[errorType],
          };
        },
      });

      const state = {
        batchId: "batch-multi",
        submittedAt: new Date().toISOString(),
        pollInterval: 1000,
        maxWaitTime: 60000,
      };

      const context = {
        workflowRunId: "run-1",
        stageId: "multi-error-stage",
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

      // Test different error types
      for (const type of [
        "timeout",
        "invalid_input",
        "quota_exceeded",
        "partial_failure",
      ]) {
        errorType = type;
        const result = await asyncStage.checkCompletion!(state, context);
        expect(result.error).toContain(
          type === "timeout"
            ? "timed out"
            : type.includes("quota")
              ? "quota"
              : type.includes("invalid")
                ? "Invalid"
                : "failed",
        );
      }
    });

    it("should handle thrown exceptions in checkCompletion", async () => {
      // Given: Stage where checkCompletion throws
      const asyncStage = defineAsyncBatchStage({
        id: "throw-stage",
        name: "Throw Stage",
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
              batchId: "batch-throw",
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
          throw new Error("Network error: Connection refused");
        },
      });

      // When: checkCompletion throws
      const state = {
        batchId: "batch-throw",
        submittedAt: new Date().toISOString(),
        pollInterval: 1000,
        maxWaitTime: 60000,
      };

      const context = {
        workflowRunId: "run-1",
        stageId: "throw-stage",
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

      // Then: Exception is thrown
      await expect(asyncStage.checkCompletion!(state, context)).rejects.toThrow(
        "Network error: Connection refused",
      );
    });
  });

  describe("failure during execute phase", () => {
    it("should handle error thrown during initial execute", async () => {
      // Given: Stage that throws during initial execute
      const asyncStage = defineAsyncBatchStage({
        id: "init-error-stage",
        name: "Init Error Stage",
        mode: "async-batch",
        schemas: {
          input: z.object({}).passthrough(),
          output: z.object({ done: z.boolean() }),
          config: z.object({}),
        },
        async execute() {
          throw new Error("Failed to submit batch job: Invalid credentials");
        },
        async checkCompletion() {
          return { ready: true, output: { done: true } };
        },
      });

      const workflow = new WorkflowBuilder(
        "init-error",
        "Init Error Workflow",
        "Test",
        z.object({}).passthrough(),
        z.object({ done: z.boolean() }),
      )
        .pipe(asyncStage)
        .build();

      await persistence.createRun({
        id: "run-init-error",
        workflowId: "init-error",
        workflowName: "Init Error Workflow",
        status: "PENDING",
        input: {},
      });

      const executor = new WorkflowExecutor(
        workflow,
        "run-init-error",
        "init-error",
        {
          persistence,
          aiLogger,
        },
      );

      // When: Execute throws
      // Then: Error is propagated
      await expect(executor.execute({}, {})).rejects.toThrow(
        "Failed to submit batch job: Invalid credentials",
      );
    });

    it("should handle error thrown during resume execute", async () => {
      // Given: Stage that throws during resume
      let hasResumed = false;

      const asyncStage = defineAsyncBatchStage({
        id: "resume-error-stage",
        name: "Resume Error Stage",
        mode: "async-batch",
        schemas: {
          input: z.object({}).passthrough(),
          output: z.object({ done: z.boolean() }),
          config: z.object({}),
        },
        async execute(ctx) {
          if (ctx.resumeState) {
            hasResumed = true;
            throw new Error("Failed to fetch batch results: Job expired");
          }
          const now = new Date();
          return {
            suspended: true,
            state: {
              batchId: "batch-resume-error",
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
          return { ready: true, output: { done: true } };
        },
      });

      const workflow = new WorkflowBuilder(
        "resume-error",
        "Resume Error Workflow",
        "Test",
        z.object({}).passthrough(),
        z.object({ done: z.boolean() }),
      )
        .pipe(asyncStage)
        .build();

      await persistence.createRun({
        id: "run-resume-error",
        workflowId: "resume-error",
        workflowName: "Resume Error Workflow",
        status: "PENDING",
        input: {},
      });

      // Suspend first
      const executor1 = new WorkflowExecutor(
        workflow,
        "run-resume-error",
        "resume-error",
        {
          persistence,
          aiLogger,
        },
      );
      await executor1.execute({}, {});

      // Mark ready for resume
      const stages = await persistence.getStagesByRun("run-resume-error", {});
      const stage = stages.find((s) => s.stageId === "resume-error-stage");
      if (stage) {
        await persistence.updateStage(stage.id, {
          nextPollAt: new Date(Date.now() - 1000),
        });
      }

      // When: Resume throws
      const executor2 = new WorkflowExecutor(
        workflow,
        "run-resume-error",
        "resume-error",
        {
          persistence,
          aiLogger,
        },
      );

      // Then: Error is propagated during resume
      await expect(executor2.execute({}, {}, { resume: true })).rejects.toThrow(
        "Failed to fetch batch results: Job expired",
      );
      expect(hasResumed).toBe(true);
    });
  });

  describe("partial failure handling", () => {
    it("should handle partial success with error details", async () => {
      // Given: Stage that returns partial success
      const asyncStage = defineAsyncBatchStage({
        id: "partial-success-stage",
        name: "Partial Success Stage",
        mode: "async-batch",
        schemas: {
          input: z.object({}).passthrough(),
          output: z.object({
            successCount: z.number(),
            failureCount: z.number(),
            results: z.array(z.string()),
            errors: z.array(
              z.object({
                itemId: z.string(),
                error: z.string(),
              }),
            ),
          }),
          config: z.object({}),
        },
        async execute(ctx) {
          if (ctx.resumeState) {
            return {
              output: {
                successCount: 8,
                failureCount: 2,
                results: [
                  "result1",
                  "result2",
                  "result3",
                  "result4",
                  "result5",
                  "result6",
                  "result7",
                  "result8",
                ],
                errors: [
                  { itemId: "item9", error: "Processing timeout" },
                  { itemId: "item10", error: "Invalid format" },
                ],
              },
            };
          }
          const now = new Date();
          return {
            suspended: true,
            state: {
              batchId: "batch-partial",
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
            output: {
              successCount: 8,
              failureCount: 2,
              results: [
                "result1",
                "result2",
                "result3",
                "result4",
                "result5",
                "result6",
                "result7",
                "result8",
              ],
              errors: [
                { itemId: "item9", error: "Processing timeout" },
                { itemId: "item10", error: "Invalid format" },
              ],
            },
          };
        },
      });

      // When: checkCompletion returns partial success
      const state = {
        batchId: "batch-partial",
        submittedAt: new Date().toISOString(),
        pollInterval: 1000,
        maxWaitTime: 60000,
      };

      const context = {
        workflowRunId: "run-1",
        stageId: "partial-success-stage",
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

      // Then: Both successes and failures are captured
      expect(result.ready).toBe(true);
      expect(result.output?.successCount).toBe(8);
      expect(result.output?.failureCount).toBe(2);
      expect(result.output?.results).toHaveLength(8);
      expect(result.output?.errors).toHaveLength(2);
    });

    it("should allow workflow to continue after partial failure if output is valid", async () => {
      // Given: Workflow with partial failure that still produces valid output
      const asyncStage = defineAsyncBatchStage({
        id: "partial-continue",
        name: "Partial Continue Stage",
        mode: "async-batch",
        schemas: {
          input: z.object({ items: z.array(z.string()) }),
          output: z.object({
            processed: z.array(z.string()),
            hadErrors: z.boolean(),
          }),
          config: z.object({}),
        },
        async execute(ctx) {
          if (ctx.resumeState) {
            // Some items failed but we still have results
            return {
              output: {
                processed: ctx.input.items.slice(0, 3), // Only first 3 succeeded
                hadErrors: true,
              },
            };
          }
          const now = new Date();
          return {
            suspended: true,
            state: {
              batchId: "batch-continue",
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
          return { ready: true };
        },
      });

      const nextStage = defineStage({
        id: "after-partial",
        name: "After Partial Stage",
        schemas: {
          input: z.object({
            processed: z.array(z.string()),
            hadErrors: z.boolean(),
          }),
          output: z.object({
            finalCount: z.number(),
            hadPriorErrors: z.boolean(),
          }),
          config: z.object({}),
        },
        async execute(ctx) {
          return {
            output: {
              finalCount: ctx.input.processed.length,
              hadPriorErrors: ctx.input.hadErrors,
            },
          };
        },
      });

      const workflow = new WorkflowBuilder(
        "partial-continue",
        "Partial Continue Workflow",
        "Test",
        z.object({ items: z.array(z.string()) }),
        z.object({ finalCount: z.number(), hadPriorErrors: z.boolean() }),
      )
        .pipe(asyncStage)
        .pipe(nextStage)
        .build();

      await persistence.createRun({
        id: "run-partial-continue",
        workflowId: "partial-continue",
        workflowName: "Partial Continue Workflow",
        status: "PENDING",
        input: { items: ["a", "b", "c", "d", "e"] },
      });

      // Execute and suspend
      const executor1 = new WorkflowExecutor(
        workflow,
        "run-partial-continue",
        "partial-continue",
        { persistence, aiLogger },
      );
      await executor1.execute({ items: ["a", "b", "c", "d", "e"] }, {});

      // Resume
      const stages = await persistence.getStagesByRun(
        "run-partial-continue",
        {},
      );
      const stage = stages.find((s) => s.stageId === "partial-continue");
      if (stage) {
        await persistence.updateStage(stage.id, {
          nextPollAt: new Date(Date.now() - 1000),
        });
      }

      const executor2 = new WorkflowExecutor(
        workflow,
        "run-partial-continue",
        "partial-continue",
        { persistence, aiLogger },
      );
      const result = await executor2.execute(
        { items: ["a", "b", "c", "d", "e"] },
        {},
        { resume: true },
      );

      // Then: Workflow completed with partial results
      expect(result).toEqual({
        finalCount: 3,
        hadPriorErrors: true,
      });
    });
  });

  describe("failure propagation in multi-stage workflows", () => {
    it("should not execute subsequent stages after async-batch failure", async () => {
      // Given: Workflow where async-batch fails
      const executedStages: string[] = [];

      const asyncStage = defineAsyncBatchStage({
        id: "failing-async",
        name: "Failing Async Stage",
        mode: "async-batch",
        schemas: {
          input: z.object({}).passthrough(),
          output: z.object({ done: z.boolean() }),
          config: z.object({}),
        },
        async execute(ctx) {
          executedStages.push("failing-async-execute");
          if (ctx.resumeState) {
            executedStages.push("failing-async-resume");
            throw new Error("Batch job failed permanently");
          }
          const now = new Date();
          return {
            suspended: true,
            state: {
              batchId: "batch-fail-prop",
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
          return { ready: true };
        },
      });

      const nextStage = defineStage({
        id: "after-fail",
        name: "After Fail Stage",
        schemas: {
          input: z.object({ done: z.boolean() }),
          output: z.object({ completed: z.boolean() }),
          config: z.object({}),
        },
        async execute() {
          executedStages.push("after-fail-execute");
          return { output: { completed: true } };
        },
      });

      const workflow = new WorkflowBuilder(
        "fail-propagation",
        "Fail Propagation Workflow",
        "Test",
        z.object({}).passthrough(),
        z.object({ completed: z.boolean() }),
      )
        .pipe(asyncStage)
        .pipe(nextStage)
        .build();

      await persistence.createRun({
        id: "run-fail-prop",
        workflowId: "fail-propagation",
        workflowName: "Fail Propagation Workflow",
        status: "PENDING",
        input: {},
      });

      // Execute and suspend
      const executor1 = new WorkflowExecutor(
        workflow,
        "run-fail-prop",
        "fail-propagation",
        {
          persistence,
          aiLogger,
        },
      );
      await executor1.execute({}, {});

      // Resume (will fail)
      const stages = await persistence.getStagesByRun("run-fail-prop", {});
      const stage = stages.find((s) => s.stageId === "failing-async");
      if (stage) {
        await persistence.updateStage(stage.id, {
          nextPollAt: new Date(Date.now() - 1000),
        });
      }

      const executor2 = new WorkflowExecutor(
        workflow,
        "run-fail-prop",
        "fail-propagation",
        {
          persistence,
          aiLogger,
        },
      );

      // When: Resume fails
      await expect(executor2.execute({}, {}, { resume: true })).rejects.toThrow(
        "Batch job failed permanently",
      );

      // Then: Subsequent stage was not executed
      expect(executedStages).toContain("failing-async-execute");
      expect(executedStages).toContain("failing-async-resume");
      expect(executedStages).not.toContain("after-fail-execute");
    });
  });

  describe("using createFailingSuspendStage helper", () => {
    it("should fail after configured number of checks", async () => {
      // Given: Stage that fails after 2 checks
      const failingStage = createFailingSuspendStage("fail-after-checks", {
        errorMessage: "Batch processing failed after retries",
        failAfterChecks: 2,
      });

      // When: Multiple checks are performed
      const state = {
        batchId: "batch-fail-after-checks",
        submittedAt: new Date().toISOString(),
        pollInterval: 1000,
        maxWaitTime: 60000,
      };

      const context = {
        workflowRunId: "run-1",
        stageId: "fail-after-checks",
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

      // First check - not ready yet
      const result1 = await failingStage.checkCompletion!(state, context);
      expect(result1.ready).toBe(false);

      // Second check - fails
      const result2 = await failingStage.checkCompletion!(state, context);
      expect(result2.ready).toBe(true);
      expect(result2.error).toBe("Batch processing failed after retries");
    });

    it("should use default error message when not specified", async () => {
      // Given: Stage with default error message
      const failingStage = createFailingSuspendStage("default-error", {
        failAfterChecks: 1,
      });

      // When: Check fails
      const state = {
        batchId: "batch-default-error",
        submittedAt: new Date().toISOString(),
        pollInterval: 1000,
        maxWaitTime: 60000,
      };

      const context = {
        workflowRunId: "run-1",
        stageId: "default-error",
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

      const result = await failingStage.checkCompletion!(state, context);

      // Then: Uses default error message
      expect(result.error).toBe("Batch job failed");
    });
  });

  describe("error state in workflow run", () => {
    it("should update workflow status to FAILED on async-batch error", async () => {
      // Given: Stage that fails
      const asyncStage = defineAsyncBatchStage({
        id: "status-fail-stage",
        name: "Status Fail Stage",
        mode: "async-batch",
        schemas: {
          input: z.object({}).passthrough(),
          output: z.object({ done: z.boolean() }),
          config: z.object({}),
        },
        async execute(ctx) {
          if (ctx.resumeState) {
            throw new Error("Stage execution failed");
          }
          const now = new Date();
          return {
            suspended: true,
            state: {
              batchId: "batch-status",
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
          return { ready: true };
        },
      });

      const workflow = new WorkflowBuilder(
        "status-fail",
        "Status Fail Workflow",
        "Test",
        z.object({}).passthrough(),
        z.object({ done: z.boolean() }),
      )
        .pipe(asyncStage)
        .build();

      await persistence.createRun({
        id: "run-status-fail",
        workflowId: "status-fail",
        workflowName: "Status Fail Workflow",
        status: "PENDING",
        input: {},
      });

      // Suspend
      const executor1 = new WorkflowExecutor(
        workflow,
        "run-status-fail",
        "status-fail",
        {
          persistence,
          aiLogger,
        },
      );
      await executor1.execute({}, {});

      // Verify suspended status
      const runBefore = await persistence.getRun("run-status-fail");
      expect(runBefore?.status).toBe("SUSPENDED");

      // Resume (will fail)
      const stages = await persistence.getStagesByRun("run-status-fail", {});
      const stage = stages.find((s) => s.stageId === "status-fail-stage");
      if (stage) {
        await persistence.updateStage(stage.id, {
          nextPollAt: new Date(Date.now() - 1000),
        });
      }

      const executor2 = new WorkflowExecutor(
        workflow,
        "run-status-fail",
        "status-fail",
        {
          persistence,
          aiLogger,
        },
      );

      try {
        await executor2.execute({}, {}, { resume: true });
      } catch {
        // Expected to fail
      }

      // Then: Run status is FAILED
      const runAfter = await persistence.getRun("run-status-fail");
      expect(runAfter?.status).toBe("FAILED");
    });

    it("should record error details in stage record", async () => {
      // Given: Stage that fails with specific error
      const specificError = "Detailed error: item 42 had invalid format";

      const asyncStage = defineAsyncBatchStage({
        id: "error-details-stage",
        name: "Error Details Stage",
        mode: "async-batch",
        schemas: {
          input: z.object({}).passthrough(),
          output: z.object({ done: z.boolean() }),
          config: z.object({}),
        },
        async execute(ctx) {
          if (ctx.resumeState) {
            throw new Error(specificError);
          }
          const now = new Date();
          return {
            suspended: true,
            state: {
              batchId: "batch-details",
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
          return { ready: true };
        },
      });

      const workflow = new WorkflowBuilder(
        "error-details",
        "Error Details Workflow",
        "Test",
        z.object({}).passthrough(),
        z.object({ done: z.boolean() }),
      )
        .pipe(asyncStage)
        .build();

      await persistence.createRun({
        id: "run-error-details",
        workflowId: "error-details",
        workflowName: "Error Details Workflow",
        status: "PENDING",
        input: {},
      });

      // Suspend
      const executor1 = new WorkflowExecutor(
        workflow,
        "run-error-details",
        "error-details",
        {
          persistence,
          aiLogger,
        },
      );
      await executor1.execute({}, {});

      // Resume (will fail)
      const stages = await persistence.getStagesByRun("run-error-details", {});
      const stage = stages.find((s) => s.stageId === "error-details-stage");
      if (stage) {
        await persistence.updateStage(stage.id, {
          nextPollAt: new Date(Date.now() - 1000),
        });
      }

      const executor2 = new WorkflowExecutor(
        workflow,
        "run-error-details",
        "error-details",
        {
          persistence,
          aiLogger,
        },
      );

      try {
        await executor2.execute({}, {}, { resume: true });
      } catch {
        // Expected
      }

      // Then: Stage record contains error
      const stagesAfter = await persistence.getStagesByRun(
        "run-error-details",
        {},
      );
      const failedStage = stagesAfter.find(
        (s) => s.stageId === "error-details-stage" && s.status === "FAILED",
      );

      expect(failedStage).toBeDefined();
      expect(failedStage?.errorMessage).toContain(specificError);
    });
  });
});
