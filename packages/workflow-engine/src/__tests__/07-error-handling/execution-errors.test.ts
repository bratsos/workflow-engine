/**
 * Execution Error Tests
 *
 * Tests for error handling during stage execution, rewritten to use kernel dispatch().
 */

import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineStage } from "../../core/stage-factory.js";
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

const StringSchema = z.object({ value: z.string() });

describe("I want to handle execution errors properly", () => {
  describe("catching stage errors", () => {
    it("should catch stage execution errors", async () => {
      // Given: A workflow with a stage that throws
      const errorStage = defineStage({
        id: "error-stage",
        name: "Error Stage",
        schemas: {
          input: z.object({}).passthrough(),
          output: z.object({}),
          config: z.object({}),
        },
        async execute() {
          throw new Error("Something went wrong!");
        },
      });

      const workflow = new WorkflowBuilder(
        "error-catch-workflow",
        "Error Catch Workflow",
        "Test",
        z.object({}).passthrough(),
        z.object({}),
      )
        .pipe(errorStage)
        .build();

      const { kernel, flush, persistence } = createTestKernel([workflow]);

      const createResult = await kernel.dispatch({
        type: "run.create",
        idempotencyKey: "key-error-catch",
        workflowId: "error-catch-workflow",
        input: {},
      });

      await persistence.updateRun(createResult.workflowRunId, {
        status: "RUNNING",
      });
      await flush();

      // When: I execute
      const result = await kernel.dispatch({
        type: "job.execute",
        workflowRunId: createResult.workflowRunId,
        workflowId: "error-catch-workflow",
        stageId: "error-stage",
        config: {},
      });

      // Then: Error is caught and returned as a failed outcome
      expect(result.outcome).toBe("failed");
      expect(result.error).toContain("Something went wrong!");
    });

    it("should catch async errors in stage execution", async () => {
      // Given: A stage that throws asynchronously
      const asyncErrorStage = defineStage({
        id: "async-error-stage",
        name: "Async Error Stage",
        schemas: {
          input: z.object({}).passthrough(),
          output: z.object({}),
          config: z.object({}),
        },
        async execute() {
          await new Promise((resolve) => setTimeout(resolve, 10));
          throw new Error("Async error occurred");
        },
      });

      const workflow = new WorkflowBuilder(
        "async-error-workflow",
        "Async Error Workflow",
        "Test",
        z.object({}).passthrough(),
        z.object({}),
      )
        .pipe(asyncErrorStage)
        .build();

      const { kernel, flush, persistence } = createTestKernel([workflow]);

      const createResult = await kernel.dispatch({
        type: "run.create",
        idempotencyKey: "key-async-error",
        workflowId: "async-error-workflow",
        input: {},
      });

      await persistence.updateRun(createResult.workflowRunId, {
        status: "RUNNING",
      });
      await flush();

      // When: I execute
      const result = await kernel.dispatch({
        type: "job.execute",
        workflowRunId: createResult.workflowRunId,
        workflowId: "async-error-workflow",
        stageId: "async-error-stage",
        config: {},
      });

      // Then: Async error is caught
      expect(result.outcome).toBe("failed");
      expect(result.error).toContain("Async error occurred");
    });
  });

  describe("error context", () => {
    it("should include stageId in stage:failed event", async () => {
      // Given: A workflow with a failing stage
      const failingStage = defineStage({
        id: "failing-stage-with-id",
        name: "Failing Stage",
        schemas: {
          input: z.object({}).passthrough(),
          output: z.object({}),
          config: z.object({}),
        },
        async execute() {
          throw new Error("Stage specific failure");
        },
      });

      const workflow = new WorkflowBuilder(
        "stage-id-error-workflow",
        "Stage ID Error Workflow",
        "Test",
        z.object({}).passthrough(),
        z.object({}),
      )
        .pipe(failingStage)
        .build();

      const { kernel, flush, persistence, eventSink } = createTestKernel([
        workflow,
      ]);

      const createResult = await kernel.dispatch({
        type: "run.create",
        idempotencyKey: "key-stage-id-error",
        workflowId: "stage-id-error-workflow",
        input: {},
      });

      await persistence.updateRun(createResult.workflowRunId, {
        status: "RUNNING",
      });
      await flush();
      eventSink.clear();

      // When: I execute
      const result = await kernel.dispatch({
        type: "job.execute",
        workflowRunId: createResult.workflowRunId,
        workflowId: "stage-id-error-workflow",
        stageId: "failing-stage-with-id",
        config: {},
      });

      expect(result.outcome).toBe("failed");

      // Then: stage:failed event contains stageId
      await flush();
      const failedEvents = eventSink.getByType("stage:failed");
      expect(failedEvents).toHaveLength(1);
      expect(failedEvents[0]!.stageId).toBe("failing-stage-with-id");
      expect(failedEvents[0]!.error).toContain("Stage specific failure");
    });

    it("should preserve error message from thrown error", async () => {
      // Given: A stage that throws with a specific error
      const stackTraceStage = defineStage({
        id: "stack-trace-stage",
        name: "Stack Trace Stage",
        schemas: {
          input: z.object({}).passthrough(),
          output: z.object({}),
          config: z.object({}),
        },
        async execute() {
          const innerFunction = () => {
            throw new Error("Deep nested error");
          };
          innerFunction();
        },
      });

      const workflow = new WorkflowBuilder(
        "stack-trace-workflow",
        "Stack Trace Workflow",
        "Test",
        z.object({}).passthrough(),
        z.object({}),
      )
        .pipe(stackTraceStage)
        .build();

      const { kernel, flush, persistence } = createTestKernel([workflow]);

      const createResult = await kernel.dispatch({
        type: "run.create",
        idempotencyKey: "key-stack-trace",
        workflowId: "stack-trace-workflow",
        input: {},
      });

      await persistence.updateRun(createResult.workflowRunId, {
        status: "RUNNING",
      });
      await flush();

      // When: I execute
      const result = await kernel.dispatch({
        type: "job.execute",
        workflowRunId: createResult.workflowRunId,
        workflowId: "stack-trace-workflow",
        stageId: "stack-trace-stage",
        config: {},
      });

      // Then: Error message is preserved
      expect(result.outcome).toBe("failed");
      expect(result.error).toBe("Deep nested error");
    });
  });

  describe("workflow status on failure", () => {
    it("should set workflow status to FAILED after run.transition", async () => {
      // Given: A workflow that will fail
      const failingStage = defineStage({
        id: "status-fail-stage",
        name: "Status Fail Stage",
        schemas: {
          input: z.object({}).passthrough(),
          output: z.object({}),
          config: z.object({}),
        },
        async execute() {
          throw new Error("Workflow failure");
        },
      });

      const workflow = new WorkflowBuilder(
        "status-fail-workflow",
        "Status Fail Workflow",
        "Test",
        z.object({}).passthrough(),
        z.object({}),
      )
        .pipe(failingStage)
        .build();

      const { kernel, flush, persistence } = createTestKernel([workflow]);

      const createResult = await kernel.dispatch({
        type: "run.create",
        idempotencyKey: "key-status-fail",
        workflowId: "status-fail-workflow",
        input: {},
      });

      await persistence.updateRun(createResult.workflowRunId, {
        status: "RUNNING",
      });
      await flush();

      // When: Stage fails
      const execResult = await kernel.dispatch({
        type: "job.execute",
        workflowRunId: createResult.workflowRunId,
        workflowId: "status-fail-workflow",
        stageId: "status-fail-stage",
        config: {},
      });

      expect(execResult.outcome).toBe("failed");

      // Then: run.transition marks the run as FAILED
      const transitionResult = await kernel.dispatch({
        type: "run.transition",
        workflowRunId: createResult.workflowRunId,
      });

      expect(transitionResult.action).toBe("failed");

      const run = await persistence.getRun(createResult.workflowRunId);
      expect(run?.status).toBe("FAILED");
    });

    it("should set completedAt timestamp on failure", async () => {
      // Given: A failing workflow
      const failingStage = defineStage({
        id: "timestamp-fail-stage",
        name: "Timestamp Fail Stage",
        schemas: {
          input: z.object({}).passthrough(),
          output: z.object({}),
          config: z.object({}),
        },
        async execute() {
          throw new Error("Failure for timestamp");
        },
      });

      const workflow = new WorkflowBuilder(
        "timestamp-fail-workflow",
        "Timestamp Fail Workflow",
        "Test",
        z.object({}).passthrough(),
        z.object({}),
      )
        .pipe(failingStage)
        .build();

      const { kernel, flush, persistence } = createTestKernel([workflow]);

      const createResult = await kernel.dispatch({
        type: "run.create",
        idempotencyKey: "key-timestamp-fail",
        workflowId: "timestamp-fail-workflow",
        input: {},
      });

      await persistence.updateRun(createResult.workflowRunId, {
        status: "RUNNING",
      });
      await flush();

      // When: Stage fails and run.transition fires
      await kernel.dispatch({
        type: "job.execute",
        workflowRunId: createResult.workflowRunId,
        workflowId: "timestamp-fail-workflow",
        stageId: "timestamp-fail-stage",
        config: {},
      });

      await kernel.dispatch({
        type: "run.transition",
        workflowRunId: createResult.workflowRunId,
      });

      // Then: completedAt is set
      const run = await persistence.getRun(createResult.workflowRunId);
      expect(run?.status).toBe("FAILED");
      expect(run?.completedAt).toBeDefined();
    });

    it("should set stage status to FAILED with error message", async () => {
      // Given: A failing workflow
      const specificErrorStage = defineStage({
        id: "specific-error-stage",
        name: "Specific Error Stage",
        schemas: {
          input: z.object({}).passthrough(),
          output: z.object({}),
          config: z.object({}),
        },
        async execute() {
          throw new Error("Specific error message for testing");
        },
      });

      const workflow = new WorkflowBuilder(
        "stage-error-msg-workflow",
        "Stage Error Message Workflow",
        "Test",
        z.object({}).passthrough(),
        z.object({}),
      )
        .pipe(specificErrorStage)
        .build();

      const { kernel, flush, persistence } = createTestKernel([workflow]);

      const createResult = await kernel.dispatch({
        type: "run.create",
        idempotencyKey: "key-stage-error-msg",
        workflowId: "stage-error-msg-workflow",
        input: {},
      });

      await persistence.updateRun(createResult.workflowRunId, {
        status: "RUNNING",
      });
      await flush();

      // When: I execute (and it fails)
      const result = await kernel.dispatch({
        type: "job.execute",
        workflowRunId: createResult.workflowRunId,
        workflowId: "stage-error-msg-workflow",
        stageId: "specific-error-stage",
        config: {},
      });

      expect(result.outcome).toBe("failed");

      // Then: Stage has FAILED status with error message
      const stages = await persistence.getStagesByRun(
        createResult.workflowRunId,
      );
      const failedStage = stages.find(
        (s) => s.stageId === "specific-error-stage",
      );

      expect(failedStage).toBeDefined();
      expect(failedStage?.status).toBe("FAILED");
      expect(failedStage?.errorMessage).toContain(
        "Specific error message for testing",
      );
    });
  });

  describe("multi-stage error handling", () => {
    it("should only fail the stage that threw, not previous stages", async () => {
      // Given: A workflow with multiple stages where the second fails
      const successStage = defineStage({
        id: "success-first",
        name: "Success First",
        schemas: {
          input: StringSchema,
          output: StringSchema,
          config: z.object({}),
        },
        async execute(ctx) {
          return { output: ctx.input };
        },
      });

      const failStage = defineStage({
        id: "fail-second",
        name: "Fail Second",
        schemas: {
          input: StringSchema,
          output: StringSchema,
          config: z.object({}),
        },
        async execute() {
          throw new Error("Second stage failed");
        },
      });

      const workflow = new WorkflowBuilder(
        "multi-stage-error-workflow",
        "Multi Stage Error Workflow",
        "Test",
        StringSchema,
        StringSchema,
      )
        .pipe(successStage)
        .pipe(failStage)
        .build();

      const { kernel, flush, persistence } = createTestKernel([workflow]);

      const createResult = await kernel.dispatch({
        type: "run.create",
        idempotencyKey: "key-multi-stage-error",
        workflowId: "multi-stage-error-workflow",
        input: { value: "test" },
      });

      await persistence.updateRun(createResult.workflowRunId, {
        status: "RUNNING",
      });
      await flush();

      // Execute stage 1 successfully
      const result1 = await kernel.dispatch({
        type: "job.execute",
        workflowRunId: createResult.workflowRunId,
        workflowId: "multi-stage-error-workflow",
        stageId: "success-first",
        config: {},
      });
      expect(result1.outcome).toBe("completed");

      // Execute stage 2 (fails)
      const result2 = await kernel.dispatch({
        type: "job.execute",
        workflowRunId: createResult.workflowRunId,
        workflowId: "multi-stage-error-workflow",
        stageId: "fail-second",
        config: {},
      });
      expect(result2.outcome).toBe("failed");

      // Then: First stage is COMPLETED, second is FAILED
      const stages = await persistence.getStagesByRun(
        createResult.workflowRunId,
      );
      const stageMap = new Map(stages.map((s) => [s.stageId, s]));

      expect(stageMap.get("success-first")?.status).toBe("COMPLETED");
      expect(stageMap.get("fail-second")?.status).toBe("FAILED");
    });

    it("should not execute stages after failure (kernel does not auto-advance)", async () => {
      // Given: A 3-stage workflow where stage 2 fails
      const executionOrder: string[] = [];

      const stage1 = defineStage({
        id: "exec-stage-1",
        name: "Stage 1",
        schemas: {
          input: StringSchema,
          output: StringSchema,
          config: z.object({}),
        },
        async execute(ctx) {
          executionOrder.push("stage-1");
          return { output: ctx.input };
        },
      });

      const stage2 = defineStage({
        id: "exec-stage-2",
        name: "Stage 2",
        schemas: {
          input: StringSchema,
          output: StringSchema,
          config: z.object({}),
        },
        async execute() {
          executionOrder.push("stage-2");
          throw new Error("Stage 2 exploded");
        },
      });

      const stage3 = defineStage({
        id: "exec-stage-3",
        name: "Stage 3",
        schemas: {
          input: StringSchema,
          output: StringSchema,
          config: z.object({}),
        },
        async execute(ctx) {
          executionOrder.push("stage-3");
          return { output: ctx.input };
        },
      });

      const workflow = new WorkflowBuilder(
        "exec-order-workflow",
        "Execution Order Workflow",
        "Test",
        StringSchema,
        StringSchema,
      )
        .pipe(stage1)
        .pipe(stage2)
        .pipe(stage3)
        .build();

      const { kernel, flush, persistence } = createTestKernel([workflow]);

      const createResult = await kernel.dispatch({
        type: "run.create",
        idempotencyKey: "key-exec-order",
        workflowId: "exec-order-workflow",
        input: { value: "test" },
      });

      await persistence.updateRun(createResult.workflowRunId, {
        status: "RUNNING",
      });
      await flush();

      // Execute stage 1
      await kernel.dispatch({
        type: "job.execute",
        workflowRunId: createResult.workflowRunId,
        workflowId: "exec-order-workflow",
        stageId: "exec-stage-1",
        config: {},
      });

      // Execute stage 2 (fails)
      await kernel.dispatch({
        type: "job.execute",
        workflowRunId: createResult.workflowRunId,
        workflowId: "exec-order-workflow",
        stageId: "exec-stage-2",
        config: {},
      });

      // run.transition marks the run as FAILED, so stage 3 is never enqueued
      const transitionResult = await kernel.dispatch({
        type: "run.transition",
        workflowRunId: createResult.workflowRunId,
      });

      expect(transitionResult.action).toBe("failed");

      // Then: Stage 3 was never executed
      expect(executionOrder).toEqual(["stage-1", "stage-2"]);
      expect(executionOrder).not.toContain("stage-3");
    });
  });

  describe("error events", () => {
    it("should emit workflow:failed event on error via run.transition", async () => {
      // Given: A failing workflow
      const errorStage = defineStage({
        id: "event-error-stage",
        name: "Event Error Stage",
        schemas: {
          input: z.object({}).passthrough(),
          output: z.object({}),
          config: z.object({}),
        },
        async execute() {
          throw new Error("Error for event test");
        },
      });

      const workflow = new WorkflowBuilder(
        "workflow-failed-event",
        "Workflow Failed Event",
        "Test",
        z.object({}).passthrough(),
        z.object({}),
      )
        .pipe(errorStage)
        .build();

      const { kernel, flush, persistence, eventSink } = createTestKernel([
        workflow,
      ]);

      const createResult = await kernel.dispatch({
        type: "run.create",
        idempotencyKey: "key-workflow-failed-event",
        workflowId: "workflow-failed-event",
        input: {},
      });

      await persistence.updateRun(createResult.workflowRunId, {
        status: "RUNNING",
      });
      await flush();
      eventSink.clear();

      // When: Stage fails
      await kernel.dispatch({
        type: "job.execute",
        workflowRunId: createResult.workflowRunId,
        workflowId: "workflow-failed-event",
        stageId: "event-error-stage",
        config: {},
      });

      // Flush stage events (stage:started, stage:failed)
      await flush();
      eventSink.clear();

      // Then: run.transition emits workflow:failed
      await kernel.dispatch({
        type: "run.transition",
        workflowRunId: createResult.workflowRunId,
      });

      await flush();
      const workflowFailedEvents = eventSink.getByType("workflow:failed");
      expect(workflowFailedEvents).toHaveLength(1);
      expect(workflowFailedEvents[0]!.workflowRunId).toBe(
        createResult.workflowRunId,
      );
      expect(workflowFailedEvents[0]!.error).toContain("Error for event test");
    });
  });
});
