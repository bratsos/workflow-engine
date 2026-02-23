/**
 * Async Batch Failure Tests (kernel version)
 *
 * Tests for failure handling in async-batch stages using kernel dispatch().
 *
 * Covers:
 * - checkCompletion error results via stage.pollSuspended
 * - Thrown exceptions in execute / checkCompletion
 * - Partial failure handling
 * - Failure propagation in multi-stage workflows
 * - Workflow/stage status updates on failure
 */

import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  defineAsyncBatchStage,
  defineStage,
} from "../../core/stage-factory.js";
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

describe("I want to handle failures in async-batch stages", () => {
  describe("checkCompletion error handling via stage.pollSuspended", () => {
    it("should fail stage and run when checkCompletion returns an error", async () => {
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
        async execute() {
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
          };
        },
        async checkCompletion() {
          return { ready: false, error: errorMessage };
        },
      });

      const workflow = new WorkflowBuilder(
        "error-check",
        "Error Check Workflow",
        "Test",
        z.object({}).passthrough(),
        z.object({ result: z.string() }),
      )
        .pipe(asyncStage)
        .build();

      const { kernel, flush, persistence, clock } = createTestKernel([
        workflow,
      ]);

      // Create and claim run
      const createResult = await kernel.dispatch({
        type: "run.create",
        idempotencyKey: "err-1",
        workflowId: "error-check",
        input: {},
      });
      await kernel.dispatch({ type: "run.claimPending", workerId: "w" });
      await flush();

      // Execute stage -> suspends
      const execResult = await kernel.dispatch({
        type: "job.execute",
        workflowRunId: createResult.workflowRunId,
        workflowId: "error-check",
        stageId: "error-check-stage",
        config: {},
      });
      expect(execResult.outcome).toBe("suspended");

      // Make poll eligible
      const stages = await persistence.getStagesByRun(
        createResult.workflowRunId,
      );
      await persistence.updateStage(stages[0]!.id, {
        nextPollAt: new Date(clock.now().getTime() - 1000),
      });

      // Poll -> checkCompletion returns error
      const pollResult = await kernel.dispatch({ type: "stage.pollSuspended" });
      expect(pollResult.failed).toBe(1);

      // Stage should be FAILED
      const updatedStages = await persistence.getStagesByRun(
        createResult.workflowRunId,
      );
      expect(updatedStages[0]!.status).toBe("FAILED");
      expect(updatedStages[0]!.errorMessage).toBe(errorMessage);

      // Run should be FAILED
      const run = await persistence.getRun(createResult.workflowRunId);
      expect(run!.status).toBe("FAILED");
    });

    it("should handle different error types in checkCompletion", async () => {
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
        async execute() {
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
          };
        },
        async checkCompletion() {
          const errors: Record<string, string> = {
            timeout: "Batch job timed out after 5 minutes",
            invalid_input: "Invalid input data: missing required field 'id'",
            quota_exceeded: "API quota exceeded, try again later",
            partial_failure: "5 of 100 items failed to process",
          };
          return { ready: false, error: errors[errorType] };
        },
      });

      // Test each error type via separate kernel instances
      for (const type of [
        "timeout",
        "invalid_input",
        "quota_exceeded",
        "partial_failure",
      ]) {
        errorType = type;

        const workflow = new WorkflowBuilder(
          "multi-error",
          "Multi Error Workflow",
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
          idempotencyKey: `multi-err-${type}`,
          workflowId: "multi-error",
          input: {},
        });
        await kernel.dispatch({ type: "run.claimPending", workerId: "w" });
        await flush();

        await kernel.dispatch({
          type: "job.execute",
          workflowRunId: createResult.workflowRunId,
          workflowId: "multi-error",
          stageId: "multi-error-stage",
          config: {},
        });

        const stages = await persistence.getStagesByRun(
          createResult.workflowRunId,
        );
        await persistence.updateStage(stages[0]!.id, {
          nextPollAt: new Date(clock.now().getTime() - 1000),
        });

        const pollResult = await kernel.dispatch({
          type: "stage.pollSuspended",
        });
        expect(pollResult.failed).toBe(1);

        const updatedStages = await persistence.getStagesByRun(
          createResult.workflowRunId,
        );
        const errorMsg = updatedStages[0]!.errorMessage!;

        expect(errorMsg).toContain(
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
      const asyncStage = defineAsyncBatchStage({
        id: "throw-stage",
        name: "Throw Stage",
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
          };
        },
        async checkCompletion() {
          throw new Error("Network error: Connection refused");
        },
      });

      const workflow = new WorkflowBuilder(
        "throw-check",
        "Throw Check Workflow",
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
        idempotencyKey: "throw-1",
        workflowId: "throw-check",
        input: {},
      });
      await kernel.dispatch({ type: "run.claimPending", workerId: "w" });
      await flush();

      await kernel.dispatch({
        type: "job.execute",
        workflowRunId: createResult.workflowRunId,
        workflowId: "throw-check",
        stageId: "throw-stage",
        config: {},
      });

      const stages = await persistence.getStagesByRun(
        createResult.workflowRunId,
      );
      await persistence.updateStage(stages[0]!.id, {
        nextPollAt: new Date(clock.now().getTime() - 1000),
      });

      // Poll -> checkCompletion throws
      const pollResult = await kernel.dispatch({ type: "stage.pollSuspended" });
      expect(pollResult.failed).toBe(1);

      const updatedStages = await persistence.getStagesByRun(
        createResult.workflowRunId,
      );
      expect(updatedStages[0]!.status).toBe("FAILED");
      expect(updatedStages[0]!.errorMessage).toBe(
        "Network error: Connection refused",
      );

      const run = await persistence.getRun(createResult.workflowRunId);
      expect(run!.status).toBe("FAILED");
    });
  });

  describe("failure during execute phase", () => {
    it("should handle error thrown during initial execute", async () => {
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

      const { kernel, flush, persistence } = createTestKernel([workflow]);

      const createResult = await kernel.dispatch({
        type: "run.create",
        idempotencyKey: "init-err-1",
        workflowId: "init-error",
        input: {},
      });
      await kernel.dispatch({ type: "run.claimPending", workerId: "w" });
      await flush();

      // Execute -> throws
      const result = await kernel.dispatch({
        type: "job.execute",
        workflowRunId: createResult.workflowRunId,
        workflowId: "init-error",
        stageId: "init-error-stage",
        config: {},
      });

      expect(result.outcome).toBe("failed");
      expect(result.error).toBe(
        "Failed to submit batch job: Invalid credentials",
      );

      // Stage should be FAILED
      const stages = await persistence.getStagesByRun(
        createResult.workflowRunId,
      );
      expect(stages[0]!.status).toBe("FAILED");
      expect(stages[0]!.errorMessage).toContain("Invalid credentials");
    });
  });

  describe("partial failure handling", () => {
    it("should handle partial success via checkCompletion returning output", async () => {
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
              z.object({ itemId: z.string(), error: z.string() }),
            ),
          }),
          config: z.object({}),
        },
        async execute() {
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
          };
        },
        async checkCompletion() {
          return {
            ready: true,
            output: {
              successCount: 8,
              failureCount: 2,
              results: ["r1", "r2", "r3", "r4", "r5", "r6", "r7", "r8"],
              errors: [
                { itemId: "item9", error: "Processing timeout" },
                { itemId: "item10", error: "Invalid format" },
              ],
            },
          };
        },
      });

      const workflow = new WorkflowBuilder(
        "partial-success",
        "Partial Success Workflow",
        "Test",
        z.object({}).passthrough(),
        z.object({
          successCount: z.number(),
          failureCount: z.number(),
          results: z.array(z.string()),
          errors: z.array(z.object({ itemId: z.string(), error: z.string() })),
        }),
      )
        .pipe(asyncStage)
        .build();

      const { kernel, flush, persistence, blobStore, clock } = createTestKernel(
        [workflow],
      );

      const createResult = await kernel.dispatch({
        type: "run.create",
        idempotencyKey: "partial-1",
        workflowId: "partial-success",
        input: {},
      });
      await kernel.dispatch({ type: "run.claimPending", workerId: "w" });
      await flush();

      await kernel.dispatch({
        type: "job.execute",
        workflowRunId: createResult.workflowRunId,
        workflowId: "partial-success",
        stageId: "partial-success-stage",
        config: {},
      });

      const stages = await persistence.getStagesByRun(
        createResult.workflowRunId,
      );
      await persistence.updateStage(stages[0]!.id, {
        nextPollAt: new Date(clock.now().getTime() - 1000),
      });

      // Poll -> checkCompletion returns partial success output
      const pollResult = await kernel.dispatch({ type: "stage.pollSuspended" });
      expect(pollResult.resumed).toBe(1);
      expect(pollResult.failed).toBe(0);

      // Stage should be COMPLETED with output stored in blobStore
      const updatedStages = await persistence.getStagesByRun(
        createResult.workflowRunId,
      );
      expect(updatedStages[0]!.status).toBe("COMPLETED");
      expect(blobStore.size()).toBeGreaterThan(0);
    });

    it("should allow workflow to continue after partial failure if output is valid", async () => {
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
        async execute() {
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
          };
        },
        async checkCompletion() {
          return {
            ready: true,
            output: { processed: ["a", "b", "c"], hadErrors: true },
          };
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

      const { kernel, flush, persistence, clock } = createTestKernel([
        workflow,
      ]);

      const createResult = await kernel.dispatch({
        type: "run.create",
        idempotencyKey: "partial-cont-1",
        workflowId: "partial-continue",
        input: { items: ["a", "b", "c", "d", "e"] },
      });
      await kernel.dispatch({ type: "run.claimPending", workerId: "w" });
      await flush();

      // Execute first stage -> suspends
      const execResult = await kernel.dispatch({
        type: "job.execute",
        workflowRunId: createResult.workflowRunId,
        workflowId: "partial-continue",
        stageId: "partial-continue",
        config: {},
      });
      expect(execResult.outcome).toBe("suspended");

      // Make poll eligible
      const stages = await persistence.getStagesByRun(
        createResult.workflowRunId,
      );
      await persistence.updateStage(stages[0]!.id, {
        nextPollAt: new Date(clock.now().getTime() - 1000),
      });

      // Poll -> checkCompletion returns ready with partial results
      const pollResult = await kernel.dispatch({ type: "stage.pollSuspended" });
      expect(pollResult.resumed).toBe(1);

      // Transition to next stage group
      const transResult = await kernel.dispatch({
        type: "run.transition",
        workflowRunId: createResult.workflowRunId,
      });
      expect(transResult.action).toBe("advanced");

      // Execute second stage
      const execResult2 = await kernel.dispatch({
        type: "job.execute",
        workflowRunId: createResult.workflowRunId,
        workflowId: "partial-continue",
        stageId: "after-partial",
        config: {},
      });
      expect(execResult2.outcome).toBe("completed");
      expect(execResult2.output).toEqual({
        finalCount: 3,
        hadPriorErrors: true,
      });
    });
  });

  describe("failure propagation in multi-stage workflows", () => {
    it("should not execute subsequent stages after async-batch failure", async () => {
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
        async execute() {
          executedStages.push("failing-async-execute");
          throw new Error("Batch job failed permanently");
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

      const { kernel, flush, persistence } = createTestKernel([workflow]);

      const createResult = await kernel.dispatch({
        type: "run.create",
        idempotencyKey: "fail-prop-1",
        workflowId: "fail-propagation",
        input: {},
      });
      await kernel.dispatch({ type: "run.claimPending", workerId: "w" });
      await flush();

      // Execute first stage -> fails immediately
      const result = await kernel.dispatch({
        type: "job.execute",
        workflowRunId: createResult.workflowRunId,
        workflowId: "fail-propagation",
        stageId: "failing-async",
        config: {},
      });
      expect(result.outcome).toBe("failed");
      expect(result.error).toBe("Batch job failed permanently");

      // Transition should detect failure
      const transResult = await kernel.dispatch({
        type: "run.transition",
        workflowRunId: createResult.workflowRunId,
      });
      expect(transResult.action).toBe("failed");

      // Second stage was never executed
      expect(executedStages).toContain("failing-async-execute");
      expect(executedStages).not.toContain("after-fail-execute");

      // Run is FAILED
      const run = await persistence.getRun(createResult.workflowRunId);
      expect(run!.status).toBe("FAILED");
    });
  });

  describe("error state in workflow run", () => {
    it("should update workflow status to FAILED on async-batch checkCompletion error", async () => {
      const asyncStage = defineAsyncBatchStage({
        id: "status-fail-stage",
        name: "Status Fail Stage",
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
          };
        },
        async checkCompletion() {
          throw new Error("Stage execution failed");
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

      const { kernel, flush, persistence, clock } = createTestKernel([
        workflow,
      ]);

      const createResult = await kernel.dispatch({
        type: "run.create",
        idempotencyKey: "status-fail-1",
        workflowId: "status-fail",
        input: {},
      });
      await kernel.dispatch({ type: "run.claimPending", workerId: "w" });
      await flush();

      // Execute -> suspends
      const execResult = await kernel.dispatch({
        type: "job.execute",
        workflowRunId: createResult.workflowRunId,
        workflowId: "status-fail",
        stageId: "status-fail-stage",
        config: {},
      });
      expect(execResult.outcome).toBe("suspended");

      // Verify SUSPENDED status via stage record
      const stagesBefore = await persistence.getStagesByRun(
        createResult.workflowRunId,
      );
      expect(stagesBefore[0]!.status).toBe("SUSPENDED");

      // Make poll eligible
      await persistence.updateStage(stagesBefore[0]!.id, {
        nextPollAt: new Date(clock.now().getTime() - 1000),
      });

      // Poll -> checkCompletion throws
      const pollResult = await kernel.dispatch({ type: "stage.pollSuspended" });
      expect(pollResult.failed).toBe(1);

      // Run should be FAILED
      const run = await persistence.getRun(createResult.workflowRunId);
      expect(run!.status).toBe("FAILED");
    });

    it("should record error details in stage record", async () => {
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
        async execute() {
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
          };
        },
        async checkCompletion() {
          throw new Error(specificError);
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

      const { kernel, flush, persistence, clock } = createTestKernel([
        workflow,
      ]);

      const createResult = await kernel.dispatch({
        type: "run.create",
        idempotencyKey: "err-det-1",
        workflowId: "error-details",
        input: {},
      });
      await kernel.dispatch({ type: "run.claimPending", workerId: "w" });
      await flush();

      // Execute -> suspends
      await kernel.dispatch({
        type: "job.execute",
        workflowRunId: createResult.workflowRunId,
        workflowId: "error-details",
        stageId: "error-details-stage",
        config: {},
      });

      const stages = await persistence.getStagesByRun(
        createResult.workflowRunId,
      );
      await persistence.updateStage(stages[0]!.id, {
        nextPollAt: new Date(clock.now().getTime() - 1000),
      });

      // Poll -> checkCompletion throws
      await kernel.dispatch({ type: "stage.pollSuspended" });

      // Stage record should have error details
      const updatedStages = await persistence.getStagesByRun(
        createResult.workflowRunId,
      );
      const failedStage = updatedStages.find(
        (s) => s.stageId === "error-details-stage" && s.status === "FAILED",
      );
      expect(failedStage).toBeDefined();
      expect(failedStage?.errorMessage).toContain(specificError);
    });
  });
});
