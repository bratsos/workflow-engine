/**
 * Workflow Error Handling Tests
 *
 * Tests for error handling during workflow execution.
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

describe("I want to handle workflow errors", () => {
  let persistence: InMemoryWorkflowPersistence;
  let aiLogger: InMemoryAICallLogger;

  beforeEach(() => {
    persistence = new InMemoryWorkflowPersistence();
    aiLogger = new InMemoryAICallLogger();
  });

  describe("stage failures", () => {
    it("should propagate stage errors to workflow level", async () => {
      // Given: A workflow with a stage that throws
      const errorStage = createErrorStage("failing-stage", "Stage exploded!");

      const workflow = new WorkflowBuilder(
        "error-workflow",
        "Error Workflow",
        "Test",
        z.object({}).passthrough(),
        z.object({}),
      )
        .pipe(errorStage)
        .build();

      await persistence.createRun({
        id: "run-error",
        workflowId: "error-workflow",
        workflowName: "Error Workflow",
        status: "PENDING",
        input: {},
      });

      const executor = new WorkflowExecutor(
        workflow,
        "run-error",
        "error-workflow",
        {
          persistence,
          aiLogger,
        },
      );

      // When: I execute
      // Then: Error is thrown
      await expect(executor.execute({}, {})).rejects.toThrow("Stage exploded!");
    });

    it("should emit workflow:failed event on error", async () => {
      // Given: A workflow with a failing stage
      const errorStage = createErrorStage("failing", "Something went wrong");

      const workflow = new WorkflowBuilder(
        "fail-event-workflow",
        "Fail Event Workflow",
        "Test",
        z.object({}).passthrough(),
        z.object({}),
      )
        .pipe(errorStage)
        .build();

      await persistence.createRun({
        id: "run-fail-event",
        workflowId: "fail-event-workflow",
        workflowName: "Fail Event Workflow",
        status: "PENDING",
        input: {},
      });

      const executor = new WorkflowExecutor(
        workflow,
        "run-fail-event",
        "fail-event-workflow",
        {
          persistence,
          aiLogger,
        },
      );

      // Collect events
      let failedEvent: { workflowRunId: string; error: string } | null = null;
      executor.on("workflow:failed", (data) => {
        failedEvent = data as { workflowRunId: string; error: string };
      });

      // When: I execute (and it fails)
      await expect(executor.execute({}, {})).rejects.toThrow();

      // Then: workflow:failed event was emitted
      expect(failedEvent).not.toBeNull();
      expect(failedEvent?.workflowRunId).toBe("run-fail-event");
      expect(failedEvent?.error).toContain("Something went wrong");
    });

    it("should emit stage:failed event on stage error", async () => {
      // Given: A workflow with a failing stage
      const errorStage = createErrorStage("stage-fail", "Stage failed");

      const workflow = new WorkflowBuilder(
        "stage-fail-event",
        "Stage Fail Event",
        "Test",
        z.object({}).passthrough(),
        z.object({}),
      )
        .pipe(errorStage)
        .build();

      await persistence.createRun({
        id: "run-stage-fail-event",
        workflowId: "stage-fail-event",
        workflowName: "Stage Fail Event",
        status: "PENDING",
        input: {},
      });

      const executor = new WorkflowExecutor(
        workflow,
        "run-stage-fail-event",
        "stage-fail-event",
        {
          persistence,
          aiLogger,
        },
      );

      // Collect events
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

      // Then: stage:failed event was emitted
      expect(stageFailedEvent).not.toBeNull();
      expect(stageFailedEvent?.stageId).toBe("stage-fail");
      expect(stageFailedEvent?.error).toContain("Stage failed");
    });
  });

  describe("persistence status updates on failure", () => {
    it("should update run status to FAILED on error", async () => {
      // Given: A failing workflow
      const errorStage = createErrorStage(
        "fail-status",
        "Failure for status test",
      );

      const workflow = new WorkflowBuilder(
        "fail-status-workflow",
        "Fail Status Workflow",
        "Test",
        z.object({}).passthrough(),
        z.object({}),
      )
        .pipe(errorStage)
        .build();

      await persistence.createRun({
        id: "run-fail-status",
        workflowId: "fail-status-workflow",
        workflowName: "Fail Status Workflow",
        status: "PENDING",
        input: {},
      });

      const executor = new WorkflowExecutor(
        workflow,
        "run-fail-status",
        "fail-status-workflow",
        {
          persistence,
          aiLogger,
        },
      );

      // When: I execute (and it fails)
      await expect(executor.execute({}, {})).rejects.toThrow();

      // Then: Run status is FAILED
      const run = await persistence.getRun("run-fail-status");
      expect(run?.status).toBe("FAILED");
      expect(run?.completedAt).toBeDefined();
    });

    it("should update stage status to FAILED on error", async () => {
      // Given: A failing workflow
      const errorStage = createErrorStage(
        "stage-fail-status",
        "Stage status failure",
      );

      const workflow = new WorkflowBuilder(
        "stage-fail-status-workflow",
        "Stage Fail Status Workflow",
        "Test",
        z.object({}).passthrough(),
        z.object({}),
      )
        .pipe(errorStage)
        .build();

      await persistence.createRun({
        id: "run-stage-fail-status",
        workflowId: "stage-fail-status-workflow",
        workflowName: "Stage Fail Status Workflow",
        status: "PENDING",
        input: {},
      });

      const executor = new WorkflowExecutor(
        workflow,
        "run-stage-fail-status",
        "stage-fail-status-workflow",
        { persistence, aiLogger },
      );

      // When: I execute (and it fails)
      await expect(executor.execute({}, {})).rejects.toThrow();

      // Then: Stage status is FAILED with error message
      const stages = await persistence.getStagesByRun(
        "run-stage-fail-status",
        {},
      );
      const uniqueStages = new Map(stages.map((s) => [s.stageId, s]));
      const failedStage = uniqueStages.get("stage-fail-status");

      expect(failedStage).toBeDefined();
      expect(failedStage?.status).toBe("FAILED");
      expect(failedStage?.errorMessage).toContain("Stage status failure");
    });
  });

  describe("partial execution failure", () => {
    it("should mark only the failing stage as failed in multi-stage workflow", async () => {
      // Given: A workflow where second stage fails
      const successStage = createPassthroughStage(
        "success-stage",
        TestSchemas.string,
      );
      const errorStage = defineStage({
        id: "error-stage",
        name: "Error Stage",
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
        "partial-fail",
        "Partial Fail Workflow",
        "Test",
        TestSchemas.string,
        TestSchemas.string,
      )
        .pipe(successStage)
        .pipe(errorStage)
        .build();

      await persistence.createRun({
        id: "run-partial-fail",
        workflowId: "partial-fail",
        workflowName: "Partial Fail Workflow",
        status: "PENDING",
        input: { value: "test" },
      });

      const executor = new WorkflowExecutor(
        workflow,
        "run-partial-fail",
        "partial-fail",
        {
          persistence,
          aiLogger,
        },
      );

      // When: I execute (and it fails)
      await expect(executor.execute({ value: "test" }, {})).rejects.toThrow(
        "Second stage failed",
      );

      // Then: First stage is COMPLETED, second is FAILED
      const stages = await persistence.getStagesByRun("run-partial-fail", {});
      const uniqueStages = new Map(stages.map((s) => [s.stageId, s]));

      const firstStage = uniqueStages.get("success-stage");
      const secondStage = uniqueStages.get("error-stage");

      expect(firstStage?.status).toBe("COMPLETED");
      expect(secondStage?.status).toBe("FAILED");
    });

    it("should not execute stages after a failure", async () => {
      // Given: A workflow with 3 stages where the 2nd fails
      const tracker: string[] = [];

      const stage1 = defineStage({
        id: "stage-1",
        name: "Stage 1",
        schemas: {
          input: TestSchemas.string,
          output: TestSchemas.string,
          config: z.object({}),
        },
        async execute(ctx) {
          tracker.push("stage-1");
          return { output: ctx.input };
        },
      });

      const stage2 = defineStage({
        id: "stage-2",
        name: "Stage 2",
        schemas: {
          input: TestSchemas.string,
          output: TestSchemas.string,
          config: z.object({}),
        },
        async execute() {
          tracker.push("stage-2");
          throw new Error("Stage 2 failed");
        },
      });

      const stage3 = defineStage({
        id: "stage-3",
        name: "Stage 3",
        schemas: {
          input: TestSchemas.string,
          output: TestSchemas.string,
          config: z.object({}),
        },
        async execute(ctx) {
          tracker.push("stage-3");
          return { output: ctx.input };
        },
      });

      const workflow = new WorkflowBuilder(
        "stop-on-fail",
        "Stop On Fail Workflow",
        "Test",
        TestSchemas.string,
        TestSchemas.string,
      )
        .pipe(stage1)
        .pipe(stage2)
        .pipe(stage3)
        .build();

      await persistence.createRun({
        id: "run-stop-on-fail",
        workflowId: "stop-on-fail",
        workflowName: "Stop On Fail Workflow",
        status: "PENDING",
        input: { value: "test" },
      });

      const executor = new WorkflowExecutor(
        workflow,
        "run-stop-on-fail",
        "stop-on-fail",
        {
          persistence,
          aiLogger,
        },
      );

      // When: I execute (and it fails)
      await expect(executor.execute({ value: "test" }, {})).rejects.toThrow();

      // Then: Stage 3 was never executed
      expect(tracker).toEqual(["stage-1", "stage-2"]);
      expect(tracker).not.toContain("stage-3");
    });
  });

  describe("input validation errors", () => {
    it("should throw on invalid stage input", async () => {
      // Given: A stage that requires specific input
      const strictStage = defineStage({
        id: "strict-input",
        name: "Strict Input Stage",
        schemas: {
          input: z.object({ required: z.string() }),
          output: z.object({ result: z.string() }),
          config: z.object({}),
        },
        async execute(ctx) {
          return { output: { result: ctx.input.required } };
        },
      });

      const workflow = new WorkflowBuilder(
        "input-validation",
        "Input Validation",
        "Test",
        z.object({ required: z.string() }),
        z.object({ result: z.string() }),
      )
        .pipe(strictStage)
        .build();

      await persistence.createRun({
        id: "run-input-validation",
        workflowId: "input-validation",
        workflowName: "Input Validation",
        status: "PENDING",
        input: {}, // Missing required field
      });

      const executor = new WorkflowExecutor(
        workflow,
        "run-input-validation",
        "input-validation",
        {
          persistence,
          aiLogger,
        },
      );

      // When: I execute with invalid input
      // Then: Throws validation error
      await expect(executor.execute({}, {})).rejects.toThrow();
    });
  });

  describe("config validation errors", () => {
    it("should fail before execution with invalid config", async () => {
      // Given: A stage requiring specific config
      const tracker: string[] = [];

      const configStage = defineStage({
        id: "config-required",
        name: "Config Required Stage",
        schemas: {
          input: TestSchemas.string,
          output: TestSchemas.string,
          config: z.object({
            model: z.string(),
          }),
        },
        async execute(ctx) {
          tracker.push("executed");
          return { output: ctx.input };
        },
      });

      const workflow = new WorkflowBuilder(
        "config-validation",
        "Config Validation",
        "Test",
        TestSchemas.string,
        TestSchemas.string,
      )
        .pipe(configStage)
        .build();

      await persistence.createRun({
        id: "run-config-validation",
        workflowId: "config-validation",
        workflowName: "Config Validation",
        status: "PENDING",
        input: { value: "test" },
      });

      const executor = new WorkflowExecutor(
        workflow,
        "run-config-validation",
        "config-validation",
        {
          persistence,
          aiLogger,
        },
      );

      // When: I execute with missing config
      // Then: Throws before stage executes
      await expect(
        executor.execute({ value: "test" }, { "config-required": {} }),
      ).rejects.toThrow(/config validation failed/i);

      // Stage should not have been executed
      expect(tracker).toHaveLength(0);
    });
  });
});
