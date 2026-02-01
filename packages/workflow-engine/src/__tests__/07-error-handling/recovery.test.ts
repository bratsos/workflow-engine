/**
 * Error Recovery Tests
 *
 * Tests for workflow recovery after failures.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { WorkflowExecutor } from "../../core/executor.js";
import { defineStage } from "../../core/stage-factory.js";
import { WorkflowBuilder } from "../../core/workflow.js";
import {
  InMemoryAICallLogger,
  InMemoryWorkflowPersistence,
  TestSchemas,
} from "../utils/index.js";

describe("I want to recover from workflow failures", () => {
  let persistence: InMemoryWorkflowPersistence;
  let aiLogger: InMemoryAICallLogger;

  beforeEach(() => {
    persistence = new InMemoryWorkflowPersistence();
    aiLogger = new InMemoryAICallLogger();
  });

  describe("preserving completed outputs", () => {
    it("should preserve completed stage outputs on failure", async () => {
      // Given: A workflow where the second stage fails
      const stage1Output = { value: "stage1-output" };

      const stage1 = defineStage({
        id: "preserve-stage-1",
        name: "Stage 1",
        schemas: {
          input: TestSchemas.string,
          output: TestSchemas.string,
          config: z.object({}),
        },
        async execute() {
          return { output: stage1Output };
        },
      });

      const stage2 = defineStage({
        id: "preserve-stage-2",
        name: "Stage 2",
        schemas: {
          input: TestSchemas.string,
          output: TestSchemas.string,
          config: z.object({}),
        },
        async execute() {
          throw new Error("Stage 2 failed");
        },
      });

      const workflow = new WorkflowBuilder(
        "preserve-outputs-workflow",
        "Preserve Outputs Workflow",
        "Test",
        TestSchemas.string,
        TestSchemas.string,
      )
        .pipe(stage1)
        .pipe(stage2)
        .build();

      await persistence.createRun({
        id: "run-preserve-outputs",
        workflowId: "preserve-outputs-workflow",
        workflowName: "Preserve Outputs Workflow",
        status: "PENDING",
        input: { value: "initial" },
      });

      const executor = new WorkflowExecutor(
        workflow,
        "run-preserve-outputs",
        "preserve-outputs-workflow",
        { persistence, aiLogger },
      );

      // When: I execute (and it fails)
      await expect(
        executor.execute({ value: "initial" }, {}),
      ).rejects.toThrow();

      // Then: Stage 1's output is preserved
      const stages = await persistence.getStagesByRun(
        "run-preserve-outputs",
        {},
      );
      const uniqueStages = new Map(stages.map((s) => [s.stageId, s]));
      const completedStage = uniqueStages.get("preserve-stage-1");

      expect(completedStage).toBeDefined();
      expect(completedStage?.status).toBe("COMPLETED");

      // Output is stored as an artifact reference
      const outputRef = completedStage?.outputData as { _artifactKey?: string };
      expect(outputRef?._artifactKey).toBeDefined();

      // Load the actual output from artifact storage
      const actualOutput = await persistence.loadArtifact(
        "run-preserve-outputs",
        outputRef._artifactKey!,
      );
      expect(actualOutput).toEqual(stage1Output);
    });

    it("should preserve multiple completed stage outputs before failure", async () => {
      // Given: A 4-stage workflow where stage 3 fails
      const outputs: Record<string, { value: string }> = {
        "multi-stage-1": { value: "output-1" },
        "multi-stage-2": { value: "output-2" },
      };

      const createSuccessStage = (id: string) =>
        defineStage({
          id,
          name: `Stage ${id}`,
          schemas: {
            input: TestSchemas.string,
            output: TestSchemas.string,
            config: z.object({}),
          },
          async execute() {
            return { output: outputs[id] };
          },
        });

      const failingStage = defineStage({
        id: "multi-stage-3",
        name: "Stage 3",
        schemas: {
          input: TestSchemas.string,
          output: TestSchemas.string,
          config: z.object({}),
        },
        async execute() {
          throw new Error("Stage 3 failed");
        },
      });

      const stage4 = defineStage({
        id: "multi-stage-4",
        name: "Stage 4",
        schemas: {
          input: TestSchemas.string,
          output: TestSchemas.string,
          config: z.object({}),
        },
        async execute(ctx) {
          return { output: ctx.input };
        },
      });

      const workflow = new WorkflowBuilder(
        "multi-preserve-workflow",
        "Multi Preserve Workflow",
        "Test",
        TestSchemas.string,
        TestSchemas.string,
      )
        .pipe(createSuccessStage("multi-stage-1"))
        .pipe(createSuccessStage("multi-stage-2"))
        .pipe(failingStage)
        .pipe(stage4)
        .build();

      await persistence.createRun({
        id: "run-multi-preserve",
        workflowId: "multi-preserve-workflow",
        workflowName: "Multi Preserve Workflow",
        status: "PENDING",
        input: { value: "initial" },
      });

      const executor = new WorkflowExecutor(
        workflow,
        "run-multi-preserve",
        "multi-preserve-workflow",
        { persistence, aiLogger },
      );

      // When: I execute (and it fails)
      await expect(
        executor.execute({ value: "initial" }, {}),
      ).rejects.toThrow();

      // Then: Stages 1 and 2 outputs are preserved
      const stages = await persistence.getStagesByRun("run-multi-preserve", {});
      const uniqueStages = new Map(stages.map((s) => [s.stageId, s]));

      // Stage 1 is completed with output preserved as artifact
      expect(uniqueStages.get("multi-stage-1")?.status).toBe("COMPLETED");
      const stage1Ref = uniqueStages.get("multi-stage-1")?.outputData as {
        _artifactKey?: string;
      };
      expect(stage1Ref?._artifactKey).toBeDefined();
      const stage1Output = await persistence.loadArtifact(
        "run-multi-preserve",
        stage1Ref._artifactKey!,
      );
      expect(stage1Output).toEqual(outputs["multi-stage-1"]);

      // Stage 2 is completed with output preserved as artifact
      expect(uniqueStages.get("multi-stage-2")?.status).toBe("COMPLETED");
      const stage2Ref = uniqueStages.get("multi-stage-2")?.outputData as {
        _artifactKey?: string;
      };
      expect(stage2Ref?._artifactKey).toBeDefined();
      const stage2Output = await persistence.loadArtifact(
        "run-multi-preserve",
        stage2Ref._artifactKey!,
      );
      expect(stage2Output).toEqual(outputs["multi-stage-2"]);

      expect(uniqueStages.get("multi-stage-3")?.status).toBe("FAILED");
      expect(uniqueStages.get("multi-stage-4")).toBeUndefined(); // Never executed
    });
  });

  describe("retry from failed stage", () => {
    it("should allow retry from failed stage using resume", async () => {
      // Given: A workflow with a stage that fails on first run but succeeds on retry
      let attemptCount = 0;

      const stage1 = defineStage({
        id: "retry-stage-1",
        name: "Stage 1",
        schemas: {
          input: TestSchemas.string,
          output: TestSchemas.string,
          config: z.object({}),
        },
        async execute(ctx) {
          return { output: { value: "stage1-done" } };
        },
      });

      const stage2 = defineStage({
        id: "retry-stage-2",
        name: "Stage 2",
        schemas: {
          input: TestSchemas.string,
          output: TestSchemas.string,
          config: z.object({}),
        },
        async execute(ctx) {
          attemptCount++;
          if (attemptCount === 1) {
            throw new Error("First attempt fails");
          }
          return { output: { value: "retry-success" } };
        },
      });

      const workflow = new WorkflowBuilder(
        "retry-workflow",
        "Retry Workflow",
        "Test",
        TestSchemas.string,
        TestSchemas.string,
      )
        .pipe(stage1)
        .pipe(stage2)
        .build();

      await persistence.createRun({
        id: "run-retry",
        workflowId: "retry-workflow",
        workflowName: "Retry Workflow",
        status: "PENDING",
        input: { value: "initial" },
      });

      // First execution - fails
      const executor1 = new WorkflowExecutor(
        workflow,
        "run-retry",
        "retry-workflow",
        {
          persistence,
          aiLogger,
        },
      );

      await expect(executor1.execute({ value: "initial" }, {})).rejects.toThrow(
        "First attempt fails",
      );

      // Verify failed state
      const runAfterFail = await persistence.getRun("run-retry");
      expect(runAfterFail?.status).toBe("FAILED");

      // Reset run status to allow retry
      await persistence.updateRun("run-retry", { status: "RUNNING" });

      // When: I create a new executor and resume
      const executor2 = new WorkflowExecutor(
        workflow,
        "run-retry",
        "retry-workflow",
        {
          persistence,
          aiLogger,
        },
      );

      const result = await executor2.execute(
        { value: "initial" },
        {},
        { resume: true },
      );

      // Then: Workflow completes successfully
      expect(result).toEqual({ value: "retry-success" });
      expect(attemptCount).toBe(2); // Stage 2 was retried

      // And: Run status is updated
      const runAfterRetry = await persistence.getRun("run-retry");
      expect(runAfterRetry?.status).toBe("COMPLETED");
    });

    it("should not re-execute completed stages on retry", async () => {
      // Given: A workflow where we track execution
      const executionLog: string[] = [];

      const stage1 = defineStage({
        id: "no-reexec-stage-1",
        name: "Stage 1",
        schemas: {
          input: TestSchemas.string,
          output: TestSchemas.string,
          config: z.object({}),
        },
        async execute() {
          executionLog.push("stage-1");
          return { output: { value: "stage1-output" } };
        },
      });

      let stage2Attempts = 0;
      const stage2 = defineStage({
        id: "no-reexec-stage-2",
        name: "Stage 2",
        schemas: {
          input: TestSchemas.string,
          output: TestSchemas.string,
          config: z.object({}),
        },
        async execute() {
          stage2Attempts++;
          executionLog.push(`stage-2-attempt-${stage2Attempts}`);
          if (stage2Attempts === 1) {
            throw new Error("First attempt fails");
          }
          return { output: { value: "stage2-output" } };
        },
      });

      const stage3 = defineStage({
        id: "no-reexec-stage-3",
        name: "Stage 3",
        schemas: {
          input: TestSchemas.string,
          output: TestSchemas.string,
          config: z.object({}),
        },
        async execute() {
          executionLog.push("stage-3");
          return { output: { value: "stage3-output" } };
        },
      });

      const workflow = new WorkflowBuilder(
        "no-reexec-workflow",
        "No Re-execution Workflow",
        "Test",
        TestSchemas.string,
        TestSchemas.string,
      )
        .pipe(stage1)
        .pipe(stage2)
        .pipe(stage3)
        .build();

      await persistence.createRun({
        id: "run-no-reexec",
        workflowId: "no-reexec-workflow",
        workflowName: "No Re-execution Workflow",
        status: "PENDING",
        input: { value: "initial" },
      });

      // First execution - fails at stage 2
      const executor1 = new WorkflowExecutor(
        workflow,
        "run-no-reexec",
        "no-reexec-workflow",
        {
          persistence,
          aiLogger,
        },
      );

      await expect(
        executor1.execute({ value: "initial" }, {}),
      ).rejects.toThrow();

      // Clear log to track retry execution
      const firstRunLog = [...executionLog];
      executionLog.length = 0;

      // Reset run status
      await persistence.updateRun("run-no-reexec", { status: "RUNNING" });

      // When: I resume
      const executor2 = new WorkflowExecutor(
        workflow,
        "run-no-reexec",
        "no-reexec-workflow",
        {
          persistence,
          aiLogger,
        },
      );

      await executor2.execute({ value: "initial" }, {}, { resume: true });

      // Then: Stage 1 was executed only in first run
      expect(firstRunLog).toContain("stage-1");
      expect(executionLog).not.toContain("stage-1");

      // And: Stage 2 was retried, stage 3 executed
      expect(executionLog).toContain("stage-2-attempt-2");
      expect(executionLog).toContain("stage-3");
    });

    it("should use output from last completed stage when retrying", async () => {
      // Given: A workflow where stage 1 transforms input
      const stage1 = defineStage({
        id: "output-chain-stage-1",
        name: "Stage 1",
        schemas: {
          input: TestSchemas.string,
          output: TestSchemas.string,
          config: z.object({}),
        },
        async execute(ctx) {
          return { output: { value: ctx.input.value.toUpperCase() } };
        },
      });

      let receivedInput: any = null;
      let attempts = 0;

      const stage2 = defineStage({
        id: "output-chain-stage-2",
        name: "Stage 2",
        schemas: {
          input: TestSchemas.string,
          output: TestSchemas.string,
          config: z.object({}),
        },
        async execute(ctx) {
          attempts++;
          receivedInput = ctx.input;
          if (attempts === 1) {
            throw new Error("First attempt fails");
          }
          return { output: { value: `processed-${ctx.input.value}` } };
        },
      });

      const workflow = new WorkflowBuilder(
        "output-chain-workflow",
        "Output Chain Workflow",
        "Test",
        TestSchemas.string,
        TestSchemas.string,
      )
        .pipe(stage1)
        .pipe(stage2)
        .build();

      await persistence.createRun({
        id: "run-output-chain",
        workflowId: "output-chain-workflow",
        workflowName: "Output Chain Workflow",
        status: "PENDING",
        input: { value: "hello" },
      });

      // First execution - fails
      const executor1 = new WorkflowExecutor(
        workflow,
        "run-output-chain",
        "output-chain-workflow",
        {
          persistence,
          aiLogger,
        },
      );

      await expect(executor1.execute({ value: "hello" }, {})).rejects.toThrow();

      // Reset for retry
      await persistence.updateRun("run-output-chain", { status: "RUNNING" });
      receivedInput = null;

      // When: I resume
      const executor2 = new WorkflowExecutor(
        workflow,
        "run-output-chain",
        "output-chain-workflow",
        {
          persistence,
          aiLogger,
        },
      );

      const result = await executor2.execute(
        { value: "hello" },
        {},
        { resume: true },
      );

      // Then: Stage 2 received the transformed output from stage 1
      expect(receivedInput).toEqual({ value: "HELLO" }); // Uppercase from stage 1
      expect(result).toEqual({ value: "processed-HELLO" });
    });
  });

  describe("recovery state", () => {
    it("should maintain workflow context after recovery", async () => {
      // Given: A workflow that uses workflowContext
      let stage2Context: Record<string, unknown> | undefined;
      let attempts = 0;

      const stage1 = defineStage({
        id: "context-stage-1",
        name: "Stage 1",
        schemas: {
          input: TestSchemas.string,
          output: TestSchemas.string,
          config: z.object({}),
        },
        async execute(ctx) {
          return { output: { value: "stage1-data" } };
        },
      });

      const stage2 = defineStage({
        id: "context-stage-2",
        name: "Stage 2",
        schemas: {
          input: TestSchemas.string,
          output: TestSchemas.string,
          config: z.object({}),
        },
        async execute(ctx) {
          attempts++;
          stage2Context = ctx.workflowContext;
          if (attempts === 1) {
            throw new Error("First attempt fails");
          }
          return { output: { value: "stage2-data" } };
        },
      });

      const workflow = new WorkflowBuilder(
        "context-workflow",
        "Context Workflow",
        "Test",
        TestSchemas.string,
        TestSchemas.string,
      )
        .pipe(stage1)
        .pipe(stage2)
        .build();

      await persistence.createRun({
        id: "run-context",
        workflowId: "context-workflow",
        workflowName: "Context Workflow",
        status: "PENDING",
        input: { value: "initial" },
      });

      // First execution - fails
      const executor1 = new WorkflowExecutor(
        workflow,
        "run-context",
        "context-workflow",
        {
          persistence,
          aiLogger,
        },
      );

      await expect(
        executor1.execute({ value: "initial" }, {}),
      ).rejects.toThrow();

      // Reset for retry
      await persistence.updateRun("run-context", { status: "RUNNING" });
      stage2Context = undefined;

      // When: I resume
      const executor2 = new WorkflowExecutor(
        workflow,
        "run-context",
        "context-workflow",
        {
          persistence,
          aiLogger,
        },
      );

      await executor2.execute({ value: "initial" }, {}, { resume: true });

      // Then: Stage 2 has access to stage 1's output via workflowContext
      expect(stage2Context).toBeDefined();
      expect(stage2Context?.["context-stage-1"]).toEqual({
        value: "stage1-data",
      });
    });
  });
});
