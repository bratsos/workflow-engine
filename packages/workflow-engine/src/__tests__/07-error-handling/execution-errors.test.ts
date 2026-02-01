/**
 * Execution Error Tests
 *
 * Tests for error handling during stage execution.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { WorkflowExecutor } from "../../core/executor.js";
import { defineStage } from "../../core/stage-factory.js";
import { WorkflowBuilder } from "../../core/workflow.js";
import {
  createErrorStage,
  createPassthroughStage,
  InMemoryAICallLogger,
  InMemoryWorkflowPersistence,
  TestSchemas,
} from "../utils/index.js";

describe("I want to handle execution errors properly", () => {
  let persistence: InMemoryWorkflowPersistence;
  let aiLogger: InMemoryAICallLogger;

  beforeEach(() => {
    persistence = new InMemoryWorkflowPersistence();
    aiLogger = new InMemoryAICallLogger();
  });

  describe("catching stage errors", () => {
    it("should catch stage execution errors", async () => {
      // Given: A workflow with a stage that throws
      const errorStage = createErrorStage(
        "error-stage",
        "Something went wrong!",
      );

      const workflow = new WorkflowBuilder(
        "error-catch-workflow",
        "Error Catch Workflow",
        "Test",
        z.object({}).passthrough(),
        z.object({}),
      )
        .pipe(errorStage)
        .build();

      await persistence.createRun({
        id: "run-error-catch",
        workflowId: "error-catch-workflow",
        workflowName: "Error Catch Workflow",
        status: "PENDING",
        input: {},
      });

      const executor = new WorkflowExecutor(
        workflow,
        "run-error-catch",
        "error-catch-workflow",
        { persistence, aiLogger },
      );

      // When: I execute
      // Then: Error is caught and propagated
      await expect(executor.execute({}, {})).rejects.toThrow(
        "Something went wrong!",
      );
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

      await persistence.createRun({
        id: "run-async-error",
        workflowId: "async-error-workflow",
        workflowName: "Async Error Workflow",
        status: "PENDING",
        input: {},
      });

      const executor = new WorkflowExecutor(
        workflow,
        "run-async-error",
        "async-error-workflow",
        { persistence, aiLogger },
      );

      // When: I execute
      // Then: Async error is caught
      await expect(executor.execute({}, {})).rejects.toThrow(
        "Async error occurred",
      );
    });
  });

  describe("error context", () => {
    it("should include stageId in error context via events", async () => {
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

      await persistence.createRun({
        id: "run-stage-id-error",
        workflowId: "stage-id-error-workflow",
        workflowName: "Stage ID Error Workflow",
        status: "PENDING",
        input: {},
      });

      const executor = new WorkflowExecutor(
        workflow,
        "run-stage-id-error",
        "stage-id-error-workflow",
        { persistence, aiLogger },
      );

      // Collect stage:failed events
      let stageFailedEvent: {
        stageId: string;
        stageName: string;
        error: string;
      } | null = null;
      executor.on("stage:failed", (data) => {
        stageFailedEvent = data as {
          stageId: string;
          stageName: string;
          error: string;
        };
      });

      // When: I execute
      await expect(executor.execute({}, {})).rejects.toThrow();

      // Then: Stage failed event contains stageId
      expect(stageFailedEvent).not.toBeNull();
      expect(stageFailedEvent?.stageId).toBe("failing-stage-with-id");
      expect(stageFailedEvent?.error).toContain("Stage specific failure");
    });

    it("should preserve error stack trace", async () => {
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
          // Create a nested call to ensure stack trace
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

      await persistence.createRun({
        id: "run-stack-trace",
        workflowId: "stack-trace-workflow",
        workflowName: "Stack Trace Workflow",
        status: "PENDING",
        input: {},
      });

      const executor = new WorkflowExecutor(
        workflow,
        "run-stack-trace",
        "stack-trace-workflow",
        { persistence, aiLogger },
      );

      // When: I execute and catch the error
      let caughtError: Error | null = null;
      try {
        await executor.execute({}, {});
      } catch (error) {
        caughtError = error as Error;
      }

      // Then: Error has stack trace
      expect(caughtError).not.toBeNull();
      expect(caughtError?.stack).toBeDefined();
      expect(caughtError?.stack).toContain("Error");
      expect(caughtError?.message).toBe("Deep nested error");
    });
  });

  describe("workflow status on failure", () => {
    it("should set workflow status to FAILED", async () => {
      // Given: A workflow that will fail
      const failingStage = createErrorStage(
        "status-fail-stage",
        "Workflow failure",
      );

      const workflow = new WorkflowBuilder(
        "status-fail-workflow",
        "Status Fail Workflow",
        "Test",
        z.object({}).passthrough(),
        z.object({}),
      )
        .pipe(failingStage)
        .build();

      await persistence.createRun({
        id: "run-status-fail",
        workflowId: "status-fail-workflow",
        workflowName: "Status Fail Workflow",
        status: "PENDING",
        input: {},
      });

      const executor = new WorkflowExecutor(
        workflow,
        "run-status-fail",
        "status-fail-workflow",
        { persistence, aiLogger },
      );

      // When: I execute (and it fails)
      await expect(executor.execute({}, {})).rejects.toThrow();

      // Then: Workflow status is FAILED
      const run = await persistence.getRun("run-status-fail");
      expect(run?.status).toBe("FAILED");
    });

    it("should set completedAt timestamp on failure", async () => {
      // Given: A failing workflow
      const failingStage = createErrorStage(
        "timestamp-fail-stage",
        "Failure for timestamp",
      );

      const workflow = new WorkflowBuilder(
        "timestamp-fail-workflow",
        "Timestamp Fail Workflow",
        "Test",
        z.object({}).passthrough(),
        z.object({}),
      )
        .pipe(failingStage)
        .build();

      const beforeExecution = new Date();

      await persistence.createRun({
        id: "run-timestamp-fail",
        workflowId: "timestamp-fail-workflow",
        workflowName: "Timestamp Fail Workflow",
        status: "PENDING",
        input: {},
      });

      const executor = new WorkflowExecutor(
        workflow,
        "run-timestamp-fail",
        "timestamp-fail-workflow",
        { persistence, aiLogger },
      );

      // When: I execute (and it fails)
      await expect(executor.execute({}, {})).rejects.toThrow();

      // Then: completedAt is set
      const run = await persistence.getRun("run-timestamp-fail");
      expect(run?.completedAt).toBeDefined();
      expect(new Date(run!.completedAt!).getTime()).toBeGreaterThanOrEqual(
        beforeExecution.getTime(),
      );
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

      await persistence.createRun({
        id: "run-stage-error-msg",
        workflowId: "stage-error-msg-workflow",
        workflowName: "Stage Error Message Workflow",
        status: "PENDING",
        input: {},
      });

      const executor = new WorkflowExecutor(
        workflow,
        "run-stage-error-msg",
        "stage-error-msg-workflow",
        { persistence, aiLogger },
      );

      // When: I execute (and it fails)
      await expect(executor.execute({}, {})).rejects.toThrow();

      // Then: Stage has FAILED status with error message
      const stages = await persistence.getStagesByRun(
        "run-stage-error-msg",
        {},
      );
      const uniqueStages = new Map(stages.map((s) => [s.stageId, s]));
      const failedStage = uniqueStages.get("specific-error-stage");

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
      const successStage = createPassthroughStage(
        "success-first",
        TestSchemas.string,
      );
      const failStage = defineStage({
        id: "fail-second",
        name: "Fail Second",
        schemas: {
          input: TestSchemas.string,
          output: TestSchemas.string,
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
        TestSchemas.string,
        TestSchemas.string,
      )
        .pipe(successStage)
        .pipe(failStage)
        .build();

      await persistence.createRun({
        id: "run-multi-stage-error",
        workflowId: "multi-stage-error-workflow",
        workflowName: "Multi Stage Error Workflow",
        status: "PENDING",
        input: { value: "test" },
      });

      const executor = new WorkflowExecutor(
        workflow,
        "run-multi-stage-error",
        "multi-stage-error-workflow",
        { persistence, aiLogger },
      );

      // When: I execute (and it fails)
      await expect(executor.execute({ value: "test" }, {})).rejects.toThrow();

      // Then: First stage is COMPLETED, second is FAILED
      const stages = await persistence.getStagesByRun(
        "run-multi-stage-error",
        {},
      );
      const uniqueStages = new Map(stages.map((s) => [s.stageId, s]));

      expect(uniqueStages.get("success-first")?.status).toBe("COMPLETED");
      expect(uniqueStages.get("fail-second")?.status).toBe("FAILED");
    });

    it("should not execute stages after failure", async () => {
      // Given: A 3-stage workflow where stage 2 fails
      const executionOrder: string[] = [];

      const stage1 = defineStage({
        id: "exec-stage-1",
        name: "Stage 1",
        schemas: {
          input: TestSchemas.string,
          output: TestSchemas.string,
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
          input: TestSchemas.string,
          output: TestSchemas.string,
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
          input: TestSchemas.string,
          output: TestSchemas.string,
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
        TestSchemas.string,
        TestSchemas.string,
      )
        .pipe(stage1)
        .pipe(stage2)
        .pipe(stage3)
        .build();

      await persistence.createRun({
        id: "run-exec-order",
        workflowId: "exec-order-workflow",
        workflowName: "Execution Order Workflow",
        status: "PENDING",
        input: { value: "test" },
      });

      const executor = new WorkflowExecutor(
        workflow,
        "run-exec-order",
        "exec-order-workflow",
        { persistence, aiLogger },
      );

      // When: I execute
      await expect(executor.execute({ value: "test" }, {})).rejects.toThrow();

      // Then: Stage 3 was never executed
      expect(executionOrder).toEqual(["stage-1", "stage-2"]);
      expect(executionOrder).not.toContain("stage-3");
    });
  });

  describe("error events", () => {
    it("should emit workflow:failed event on error", async () => {
      // Given: A failing workflow
      const errorStage = createErrorStage(
        "event-error-stage",
        "Error for event test",
      );

      const workflow = new WorkflowBuilder(
        "workflow-failed-event",
        "Workflow Failed Event",
        "Test",
        z.object({}).passthrough(),
        z.object({}),
      )
        .pipe(errorStage)
        .build();

      await persistence.createRun({
        id: "run-workflow-failed-event",
        workflowId: "workflow-failed-event",
        workflowName: "Workflow Failed Event",
        status: "PENDING",
        input: {},
      });

      const executor = new WorkflowExecutor(
        workflow,
        "run-workflow-failed-event",
        "workflow-failed-event",
        { persistence, aiLogger },
      );

      // Collect events
      let workflowFailedEvent: { workflowRunId: string; error: string } | null =
        null;
      executor.on("workflow:failed", (data) => {
        workflowFailedEvent = data as { workflowRunId: string; error: string };
      });

      // When: I execute (and it fails)
      await expect(executor.execute({}, {})).rejects.toThrow();

      // Then: workflow:failed event was emitted
      expect(workflowFailedEvent).not.toBeNull();
      expect(workflowFailedEvent?.workflowRunId).toBe(
        "run-workflow-failed-event",
      );
      expect(workflowFailedEvent?.error).toContain("Error for event test");
    });
  });
});
