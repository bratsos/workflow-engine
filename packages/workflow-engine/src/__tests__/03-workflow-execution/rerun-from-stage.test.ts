/**
 * Rerun From Stage Tests
 *
 * Tests for the ability to rerun a workflow starting from a specific stage,
 * skipping earlier stages and using their persisted outputs.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { WorkflowExecutor } from "../../core/executor.js";
import { defineStage } from "../../core/stage-factory.js";
import { WorkflowBuilder } from "../../core/workflow.js";
import {
  InMemoryAICallLogger,
  InMemoryWorkflowPersistence,
} from "../utils/index.js";

describe("I want to rerun a workflow from a specific stage", () => {
  let persistence: InMemoryWorkflowPersistence;
  let aiLogger: InMemoryAICallLogger;

  // Track execution order
  let executionOrder: string[] = [];

  // Define test stages
  const stage1 = defineStage({
    id: "stage-1",
    name: "Stage 1",
    schemas: {
      input: z.object({ value: z.number() }),
      output: z.object({ value: z.number() }),
      config: z.object({}),
    },
    execute: async (ctx) => {
      executionOrder.push("stage-1");
      return { output: { value: ctx.input.value * 2 } };
    },
  });

  const stage2 = defineStage({
    id: "stage-2",
    name: "Stage 2",
    schemas: {
      input: z.object({ value: z.number() }),
      output: z.object({ value: z.number() }),
      config: z.object({}),
    },
    execute: async (ctx) => {
      executionOrder.push("stage-2");
      return { output: { value: ctx.input.value + 10 } };
    },
  });

  const stage3 = defineStage({
    id: "stage-3",
    name: "Stage 3",
    schemas: {
      input: z.object({ value: z.number() }),
      output: z.object({ value: z.number() }),
      config: z.object({}),
    },
    execute: async (ctx) => {
      executionOrder.push("stage-3");
      return { output: { value: ctx.input.value * 3 } };
    },
  });

  const stage4 = defineStage({
    id: "stage-4",
    name: "Stage 4",
    schemas: {
      input: z.object({ value: z.number() }),
      output: z.object({ result: z.string() }),
      config: z.object({}),
    },
    execute: async (ctx) => {
      executionOrder.push("stage-4");
      return { output: { result: `Final: ${ctx.input.value}` } };
    },
  });

  beforeEach(() => {
    persistence = new InMemoryWorkflowPersistence();
    aiLogger = new InMemoryAICallLogger();
    executionOrder = [];
  });

  describe("basic rerun functionality", () => {
    it("should rerun from stage 3 after a complete run, skipping stages 1 and 2", async () => {
      // Given: A 4-stage sequential workflow
      const workflow = new WorkflowBuilder(
        "rerun-test",
        "Rerun Test Workflow",
        "Test",
        z.object({ value: z.number() }),
        z.object({ result: z.string() }),
      )
        .pipe(stage1)
        .pipe(stage2)
        .pipe(stage3)
        .pipe(stage4)
        .build();

      // First: Run the workflow completely
      await persistence.createRun({
        id: "run-rerun-1",
        workflowId: "rerun-test",
        workflowName: "Rerun Test Workflow",
        status: "PENDING",
        input: { value: 5 },
      });

      const executor1 = new WorkflowExecutor(
        workflow,
        "run-rerun-1",
        "rerun-test",
        { persistence, aiLogger },
      );

      const firstResult = await executor1.execute({ value: 5 }, {});

      // Verify first run executed all stages
      expect(executionOrder).toEqual([
        "stage-1",
        "stage-2",
        "stage-3",
        "stage-4",
      ]);
      // value: 5 -> *2 -> 10 -> +10 -> 20 -> *3 -> 60 -> "Final: 60"
      expect(firstResult).toEqual({ result: "Final: 60" });

      // Reset execution tracking
      executionOrder = [];

      // When: Rerun from stage 3
      const executor2 = new WorkflowExecutor(
        workflow,
        "run-rerun-1",
        "rerun-test",
        { persistence, aiLogger },
      );

      const rerunResult = await executor2.execute(
        { value: 5 }, // Original input (not used when fromStage is set)
        {},
        { fromStage: "stage-3" },
      );

      // Then: Only stages 3 and 4 were executed
      expect(executionOrder).toEqual(["stage-3", "stage-4"]);

      // And: The result is the same (using persisted stage-2 output as input to stage-3)
      // Stage 2 output was { value: 20 }, so stage-3 gets 20, outputs 60, stage-4 outputs "Final: 60"
      expect(rerunResult).toEqual({ result: "Final: 60" });
    });

    it("should rerun from stage 2 and execute stages 2, 3, 4", async () => {
      // Given: A 4-stage workflow that has been run
      const workflow = new WorkflowBuilder(
        "rerun-test-2",
        "Rerun Test Workflow 2",
        "Test",
        z.object({ value: z.number() }),
        z.object({ result: z.string() }),
      )
        .pipe(stage1)
        .pipe(stage2)
        .pipe(stage3)
        .pipe(stage4)
        .build();

      await persistence.createRun({
        id: "run-rerun-2",
        workflowId: "rerun-test-2",
        workflowName: "Rerun Test Workflow 2",
        status: "PENDING",
        input: { value: 10 },
      });

      // First run
      const executor1 = new WorkflowExecutor(
        workflow,
        "run-rerun-2",
        "rerun-test-2",
        { persistence, aiLogger },
      );

      await executor1.execute({ value: 10 }, {});
      // value: 10 -> *2 -> 20 -> +10 -> 30 -> *3 -> 90 -> "Final: 90"

      executionOrder = [];

      // When: Rerun from stage 2
      const executor2 = new WorkflowExecutor(
        workflow,
        "run-rerun-2",
        "rerun-test-2",
        { persistence, aiLogger },
      );

      const rerunResult = await executor2.execute(
        { value: 10 },
        {},
        { fromStage: "stage-2" },
      );

      // Then: Stages 2, 3, 4 were executed
      expect(executionOrder).toEqual(["stage-2", "stage-3", "stage-4"]);

      // Stage-1 output was { value: 20 }
      // Stage-2: 20 + 10 = 30
      // Stage-3: 30 * 3 = 90
      // Stage-4: "Final: 90"
      expect(rerunResult).toEqual({ result: "Final: 90" });
    });

    it("should rerun from stage 1 (first stage) using workflow input", async () => {
      // Given: A workflow that has been run
      const workflow = new WorkflowBuilder(
        "rerun-test-3",
        "Rerun Test Workflow 3",
        "Test",
        z.object({ value: z.number() }),
        z.object({ result: z.string() }),
      )
        .pipe(stage1)
        .pipe(stage2)
        .pipe(stage3)
        .pipe(stage4)
        .build();

      await persistence.createRun({
        id: "run-rerun-3",
        workflowId: "rerun-test-3",
        workflowName: "Rerun Test Workflow 3",
        status: "PENDING",
        input: { value: 7 },
      });

      // First run
      const executor1 = new WorkflowExecutor(
        workflow,
        "run-rerun-3",
        "rerun-test-3",
        { persistence, aiLogger },
      );

      await executor1.execute({ value: 7 }, {});

      executionOrder = [];

      // When: Rerun from stage 1
      const executor2 = new WorkflowExecutor(
        workflow,
        "run-rerun-3",
        "rerun-test-3",
        { persistence, aiLogger },
      );

      const rerunResult = await executor2.execute(
        { value: 7 },
        {},
        { fromStage: "stage-1" },
      );

      // Then: All stages were executed (fresh run)
      expect(executionOrder).toEqual([
        "stage-1",
        "stage-2",
        "stage-3",
        "stage-4",
      ]);

      // value: 7 -> *2 -> 14 -> +10 -> 24 -> *3 -> 72 -> "Final: 72"
      expect(rerunResult).toEqual({ result: "Final: 72" });
    });
  });

  describe("error handling", () => {
    it("should throw error when stage does not exist", async () => {
      // Given: A workflow
      const workflow = new WorkflowBuilder(
        "rerun-error-1",
        "Rerun Error Test",
        "Test",
        z.object({ value: z.number() }),
        z.object({ result: z.string() }),
      )
        .pipe(stage1)
        .pipe(stage4)
        .build();

      await persistence.createRun({
        id: "run-error-1",
        workflowId: "rerun-error-1",
        workflowName: "Rerun Error Test",
        status: "PENDING",
        input: { value: 5 },
      });

      const executor = new WorkflowExecutor(
        workflow,
        "run-error-1",
        "rerun-error-1",
        { persistence, aiLogger },
      );

      // When/Then: Attempting to rerun from non-existent stage throws
      await expect(
        executor.execute({ value: 5 }, {}, { fromStage: "non-existent-stage" }),
      ).rejects.toThrow('Stage "non-existent-stage" not found in workflow');
    });

    it("should throw error when previous stages have not been executed", async () => {
      // Given: A workflow that has NOT been run yet
      const workflow = new WorkflowBuilder(
        "rerun-error-2",
        "Rerun Error Test 2",
        "Test",
        z.object({ value: z.number() }),
        z.object({ result: z.string() }),
      )
        .pipe(stage1)
        .pipe(stage2)
        .pipe(stage3)
        .pipe(stage4)
        .build();

      await persistence.createRun({
        id: "run-error-2",
        workflowId: "rerun-error-2",
        workflowName: "Rerun Error Test 2",
        status: "PENDING",
        input: { value: 5 },
      });

      const executor = new WorkflowExecutor(
        workflow,
        "run-error-2",
        "rerun-error-2",
        { persistence, aiLogger },
      );

      // When/Then: Attempting to rerun from stage 3 without prior execution throws
      await expect(
        executor.execute({ value: 5 }, {}, { fromStage: "stage-3" }),
      ).rejects.toThrow(
        'Cannot rerun from stage "stage-3": no completed stages found before execution group',
      );
    });
  });

  describe("workflow context", () => {
    it("should have access to previous stage outputs in workflowContext", async () => {
      // Given: A stage that accesses workflowContext
      let capturedContext: Record<string, unknown> | undefined;

      const contextAccessStage = defineStage({
        id: "context-stage",
        name: "Context Access Stage",
        schemas: {
          input: z.object({ value: z.number() }),
          output: z.object({ combined: z.number() }),
          config: z.object({}),
        },
        execute: async (ctx) => {
          executionOrder.push("context-stage");
          capturedContext = ctx.workflowContext;

          // Access stage-1 output from context
          const stage1Output = ctx.workflowContext["stage-1"] as
            | { value: number }
            | undefined;
          const combined = ctx.input.value + (stage1Output?.value ?? 0);

          return { output: { combined } };
        },
      });

      const workflow = new WorkflowBuilder(
        "context-test",
        "Context Test Workflow",
        "Test",
        z.object({ value: z.number() }),
        z.object({ combined: z.number() }),
      )
        .pipe(stage1)
        .pipe(stage2)
        .pipe(contextAccessStage)
        .build();

      await persistence.createRun({
        id: "run-context",
        workflowId: "context-test",
        workflowName: "Context Test Workflow",
        status: "PENDING",
        input: { value: 5 },
      });

      // First: Run completely
      const executor1 = new WorkflowExecutor(
        workflow,
        "run-context",
        "context-test",
        { persistence, aiLogger },
      );

      await executor1.execute({ value: 5 }, {});
      // value: 5 -> stage-1: 10 -> stage-2: 20 -> context-stage: 20 + 10 = 30

      executionOrder = [];
      capturedContext = undefined;

      // When: Rerun from context-stage
      const executor2 = new WorkflowExecutor(
        workflow,
        "run-context",
        "context-test",
        { persistence, aiLogger },
      );

      const result = await executor2.execute(
        { value: 5 },
        {},
        { fromStage: "context-stage" },
      );

      // Then: workflowContext contains outputs from stage-1 and stage-2
      expect(capturedContext).toBeDefined();
      expect(capturedContext!["stage-1"]).toEqual({ value: 10 });
      expect(capturedContext!["stage-2"]).toEqual({ value: 20 });

      // And: Result is correct
      expect(result).toEqual({ combined: 30 });
    });
  });

  describe("stage records cleanup", () => {
    it("should delete stage records for rerun stages", async () => {
      // Given: A workflow that has been run
      const workflow = new WorkflowBuilder(
        "cleanup-test",
        "Cleanup Test Workflow",
        "Test",
        z.object({ value: z.number() }),
        z.object({ result: z.string() }),
      )
        .pipe(stage1)
        .pipe(stage2)
        .pipe(stage3)
        .pipe(stage4)
        .build();

      await persistence.createRun({
        id: "run-cleanup",
        workflowId: "cleanup-test",
        workflowName: "Cleanup Test Workflow",
        status: "PENDING",
        input: { value: 5 },
      });

      // First run
      const executor1 = new WorkflowExecutor(
        workflow,
        "run-cleanup",
        "cleanup-test",
        { persistence, aiLogger },
      );

      await executor1.execute({ value: 5 }, {});

      // Verify all stages exist
      let stages = await persistence.getStagesByRun("run-cleanup", {});
      expect(stages.length).toBe(4);

      // When: Rerun from stage 3
      const executor2 = new WorkflowExecutor(
        workflow,
        "run-cleanup",
        "cleanup-test",
        { persistence, aiLogger },
      );

      await executor2.execute({ value: 5 }, {}, { fromStage: "stage-3" });

      // Then: Stage records for stage-3 and stage-4 were recreated
      stages = await persistence.getStagesByRun("run-cleanup", {});

      // All 4 stages should exist (stages 1-2 preserved, 3-4 recreated)
      expect(stages.length).toBe(4);

      // Stages 1 and 2 should still have COMPLETED status
      const stage1Record = stages.find((s) => s.stageId === "stage-1");
      const stage2Record = stages.find((s) => s.stageId === "stage-2");
      expect(stage1Record?.status).toBe("COMPLETED");
      expect(stage2Record?.status).toBe("COMPLETED");

      // Stages 3 and 4 should be newly completed
      const stage3Record = stages.find((s) => s.stageId === "stage-3");
      const stage4Record = stages.find((s) => s.stageId === "stage-4");
      expect(stage3Record?.status).toBe("COMPLETED");
      expect(stage4Record?.status).toBe("COMPLETED");
    });
  });
});
