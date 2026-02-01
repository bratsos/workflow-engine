/**
 * Workflow Suspend/Resume Tests
 *
 * Tests for async-batch stages that suspend and resume execution.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { z } from "zod";
import { WorkflowBuilder } from "../../core/workflow.js";
import { WorkflowExecutor } from "../../core/executor.js";
import { defineAsyncBatchStage } from "../../core/stage-factory.js";
import {
  InMemoryWorkflowPersistence,
  InMemoryAICallLogger,
  createPassthroughStage,
  createSuspendingStage,
  TestSchemas,
} from "../utils/index.js";
import type { SimpleSuspendedResult } from "../../core/stage-factory.js";

describe("I want to handle workflow suspension and resumption", () => {
  let persistence: InMemoryWorkflowPersistence;
  let aiLogger: InMemoryAICallLogger;

  beforeEach(() => {
    persistence = new InMemoryWorkflowPersistence();
    aiLogger = new InMemoryAICallLogger();
  });

  describe("stage suspension", () => {
    it("should suspend workflow when stage returns SuspendedResult", async () => {
      // Given: A workflow with an async-batch stage that suspends
      const suspendingStage = createSuspendingStage(
        "batch-stage",
        z.object({ result: z.string() }),
        {
          batchId: "batch-123",
          pollInterval: 5000,
          maxWaitTime: 60000,
          getOutput: () => ({ result: "completed" }),
        },
      );

      const workflow = new WorkflowBuilder(
        "suspend-workflow",
        "Suspend Workflow",
        "Test",
        z.object({}).passthrough(),
        z.object({ result: z.string() }),
      )
        .pipe(suspendingStage)
        .build();

      await persistence.createRun({
        id: "run-suspend",
        workflowId: "suspend-workflow",
        workflowName: "Suspend Workflow",
        status: "PENDING",
        input: {},
      });

      const executor = new WorkflowExecutor(
        workflow,
        "run-suspend",
        "suspend-workflow",
        {
          persistence,
          aiLogger,
        },
      );

      // When: I execute
      const result = await executor.execute({}, {});

      // Then: Returns "suspended"
      expect(result).toBe("suspended");
    });

    it("should emit stage:suspended event", async () => {
      // Given: A suspending stage
      const suspendingStage = createSuspendingStage(
        "event-stage",
        z.object({ done: z.boolean() }),
        {
          pollInterval: 1000,
          maxWaitTime: 30000,
          getOutput: () => ({ done: true }),
        },
      );

      const workflow = new WorkflowBuilder(
        "suspend-event",
        "Suspend Event Workflow",
        "Test",
        z.object({}).passthrough(),
        z.object({ done: z.boolean() }),
      )
        .pipe(suspendingStage)
        .build();

      await persistence.createRun({
        id: "run-suspend-event",
        workflowId: "suspend-event",
        workflowName: "Suspend Event Workflow",
        status: "PENDING",
        input: {},
      });

      const executor = new WorkflowExecutor(
        workflow,
        "run-suspend-event",
        "suspend-event",
        {
          persistence,
          aiLogger,
        },
      );

      // Collect events
      let suspendedEvent: {
        stageId: string;
        stageName: string;
        resumeAt: Date;
      } | null = null;
      executor.on("stage:suspended", (data) => {
        suspendedEvent = data as {
          stageId: string;
          stageName: string;
          resumeAt: Date;
        };
      });

      // When: I execute
      await executor.execute({}, {});

      // Then: stage:suspended event was emitted
      expect(suspendedEvent).not.toBeNull();
      expect(suspendedEvent?.stageId).toBe("event-stage");
      expect(suspendedEvent?.resumeAt).toBeInstanceOf(Date);
    });

    it("should update workflow run status to SUSPENDED", async () => {
      // Given: A suspending stage
      const suspendingStage = createSuspendingStage(
        "status-stage",
        z.object({ value: z.number() }),
        {
          getOutput: () => ({ value: 42 }),
        },
      );

      const workflow = new WorkflowBuilder(
        "suspend-status",
        "Suspend Status Workflow",
        "Test",
        z.object({}).passthrough(),
        z.object({ value: z.number() }),
      )
        .pipe(suspendingStage)
        .build();

      await persistence.createRun({
        id: "run-suspend-status",
        workflowId: "suspend-status",
        workflowName: "Suspend Status Workflow",
        status: "PENDING",
        input: {},
      });

      const executor = new WorkflowExecutor(
        workflow,
        "run-suspend-status",
        "suspend-status",
        {
          persistence,
          aiLogger,
        },
      );

      // When: I execute
      await executor.execute({}, {});

      // Then: Run status is SUSPENDED
      const run = await persistence.getRun("run-suspend-status");
      expect(run?.status).toBe("SUSPENDED");
    });

    it("should update stage record with suspended state", async () => {
      // Given: A suspending stage with specific state
      const suspendingStage = defineAsyncBatchStage({
        id: "state-stage",
        name: "State Stage",
        mode: "async-batch",
        schemas: {
          input: z.object({}).passthrough(),
          output: z.object({ data: z.string() }),
          config: z.object({}),
        },
        async execute(ctx) {
          if (ctx.resumeState) {
            return { output: { data: "resumed" } };
          }

          const now = new Date();
          return {
            suspended: true,
            state: {
              batchId: "my-batch-id",
              submittedAt: now.toISOString(),
              pollInterval: 5000,
              maxWaitTime: 300000,
              metadata: { customField: "custom-value" },
            },
            pollConfig: {
              pollInterval: 5000,
              maxWaitTime: 300000,
              nextPollAt: new Date(now.getTime() + 5000),
            },
          } as SimpleSuspendedResult;
        },
        async checkCompletion(state) {
          return { ready: true, output: { data: "complete" } };
        },
      });

      const workflow = new WorkflowBuilder(
        "suspend-state",
        "Suspend State Workflow",
        "Test",
        z.object({}).passthrough(),
        z.object({ data: z.string() }),
      )
        .pipe(suspendingStage)
        .build();

      await persistence.createRun({
        id: "run-suspend-state",
        workflowId: "suspend-state",
        workflowName: "Suspend State Workflow",
        status: "PENDING",
        input: {},
      });

      const executor = new WorkflowExecutor(
        workflow,
        "run-suspend-state",
        "suspend-state",
        {
          persistence,
          aiLogger,
        },
      );

      // When: I execute
      await executor.execute({}, {});

      // Then: Stage record has suspended state
      const stages = await persistence.getStagesByRun("run-suspend-state", {});
      const uniqueStages = new Map(stages.map((s) => [s.stageId, s]));
      const stage = uniqueStages.get("state-stage");

      expect(stage?.status).toBe("SUSPENDED");
      expect(stage?.suspendedState).toBeDefined();

      const state = stage?.suspendedState as Record<string, unknown>;
      expect(state.batchId).toBe("my-batch-id");
      expect(state.metadata).toEqual({ customField: "custom-value" });
    });
  });

  describe("workflow resumption", () => {
    it("should resume suspended workflow with resume option", async () => {
      // Given: A previously suspended workflow that is now ready to complete
      let isComplete = false;

      const suspendingStage = defineAsyncBatchStage({
        id: "resume-stage",
        name: "Resume Stage",
        mode: "async-batch",
        schemas: {
          input: z.object({}).passthrough(),
          output: z.object({ result: z.string() }),
          config: z.object({}),
        },
        async execute(ctx) {
          if (ctx.resumeState) {
            // On resume, return the completed result
            return { output: { result: "workflow-completed" } };
          }

          // First execution - suspend
          const now = new Date();
          return {
            suspended: true,
            state: {
              batchId: "resume-batch",
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
          if (isComplete) {
            return { ready: true, output: { result: "from-check" } };
          }
          return { ready: false, nextCheckIn: 100 };
        },
      });

      const workflow = new WorkflowBuilder(
        "resume-workflow",
        "Resume Workflow",
        "Test",
        z.object({}).passthrough(),
        z.object({ result: z.string() }),
      )
        .pipe(suspendingStage)
        .build();

      // First: Create and suspend the workflow
      await persistence.createRun({
        id: "run-resume",
        workflowId: "resume-workflow",
        workflowName: "Resume Workflow",
        status: "PENDING",
        input: {},
      });

      const executor1 = new WorkflowExecutor(
        workflow,
        "run-resume",
        "resume-workflow",
        {
          persistence,
          aiLogger,
        },
      );

      const suspendResult = await executor1.execute({}, {});
      expect(suspendResult).toBe("suspended");

      // Now the batch is "complete"
      isComplete = true;

      // Update stage to be ready for resume (set nextPollAt to past)
      const stages = await persistence.getStagesByRun("run-resume", {});
      const uniqueStages = new Map(stages.map((s) => [s.stageId, s]));
      const stage = uniqueStages.get("resume-stage");
      if (stage) {
        await persistence.updateStage(stage.id, {
          nextPollAt: new Date(Date.now() - 1000), // Past time - ready to resume
        });
      }

      // When: I resume the workflow
      const executor2 = new WorkflowExecutor(
        workflow,
        "run-resume",
        "resume-workflow",
        {
          persistence,
          aiLogger,
        },
      );

      const result = await executor2.execute({}, {}, { resume: true });

      // Then: Workflow completes with output
      expect(result).toEqual({ result: "workflow-completed" });
    });

    it("should continue with stages after resumed stage completes", async () => {
      // Given: A workflow with suspend stage followed by normal stage
      let hasResumed = false;
      const executionOrder: string[] = [];

      const suspendStage = defineAsyncBatchStage({
        id: "first-suspend",
        name: "First Suspend",
        mode: "async-batch",
        schemas: {
          input: TestSchemas.string,
          output: TestSchemas.string,
          config: z.object({}),
        },
        async execute(ctx) {
          executionOrder.push("first-execute");

          if (ctx.resumeState) {
            executionOrder.push("first-resume");
            return { output: ctx.input };
          }

          const now = new Date();
          return {
            suspended: true,
            state: {
              batchId: "batch-first",
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
          return { ready: hasResumed };
        },
      });

      const secondStage = createPassthroughStage(
        "second-stage",
        TestSchemas.string,
      );

      // Wrap to track execution
      const originalExecute = secondStage.execute.bind(secondStage);
      secondStage.execute = async (ctx) => {
        executionOrder.push("second-execute");
        return originalExecute(ctx);
      };

      const workflow = new WorkflowBuilder(
        "multi-resume",
        "Multi Resume Workflow",
        "Test",
        TestSchemas.string,
        TestSchemas.string,
      )
        .pipe(suspendStage)
        .pipe(secondStage)
        .build();

      // First: Execute and suspend
      await persistence.createRun({
        id: "run-multi-resume",
        workflowId: "multi-resume",
        workflowName: "Multi Resume Workflow",
        status: "PENDING",
        input: { value: "test-data" },
      });

      const executor1 = new WorkflowExecutor(
        workflow,
        "run-multi-resume",
        "multi-resume",
        {
          persistence,
          aiLogger,
        },
      );

      const suspendResult = await executor1.execute({ value: "test-data" }, {});
      expect(suspendResult).toBe("suspended");
      expect(executionOrder).toEqual(["first-execute"]);

      // Mark as ready
      hasResumed = true;

      // Update stage to be ready for resume
      const stages = await persistence.getStagesByRun("run-multi-resume", {});
      const uniqueStages = new Map(stages.map((s) => [s.stageId, s]));
      const stage = uniqueStages.get("first-suspend");
      if (stage) {
        await persistence.updateStage(stage.id, {
          nextPollAt: new Date(Date.now() - 1000),
        });
      }

      // When: Resume
      const executor2 = new WorkflowExecutor(
        workflow,
        "run-multi-resume",
        "multi-resume",
        {
          persistence,
          aiLogger,
        },
      );

      const result = await executor2.execute(
        { value: "test-data" },
        {},
        { resume: true },
      );

      // Then: Both stages executed in order after resume
      expect(result).toEqual({ value: "test-data" });
      expect(executionOrder).toContain("first-resume");
      expect(executionOrder).toContain("second-execute");
    });
  });

  describe("suspension in multi-stage workflows", () => {
    it("should preserve completed stages when suspending", async () => {
      // Given: A workflow where second stage suspends
      const firstStage = createPassthroughStage(
        "first-done",
        TestSchemas.string,
      );

      const secondSuspend = createSuspendingStage(
        "second-suspend",
        TestSchemas.string,
        {
          getOutput: () => ({ value: "suspended-output" }),
        },
      );

      const workflow = new WorkflowBuilder(
        "partial-suspend",
        "Partial Suspend Workflow",
        "Test",
        TestSchemas.string,
        TestSchemas.string,
      )
        .pipe(firstStage)
        .pipe(secondSuspend)
        .build();

      await persistence.createRun({
        id: "run-partial-suspend",
        workflowId: "partial-suspend",
        workflowName: "Partial Suspend Workflow",
        status: "PENDING",
        input: { value: "input" },
      });

      const executor = new WorkflowExecutor(
        workflow,
        "run-partial-suspend",
        "partial-suspend",
        {
          persistence,
          aiLogger,
        },
      );

      // When: I execute
      const result = await executor.execute({ value: "input" }, {});

      // Then: Workflow is suspended
      expect(result).toBe("suspended");

      // And: First stage is completed, second is suspended
      const stages = await persistence.getStagesByRun(
        "run-partial-suspend",
        {},
      );
      const uniqueStages = new Map(stages.map((s) => [s.stageId, s]));

      expect(uniqueStages.get("first-done")?.status).toBe("COMPLETED");
      expect(uniqueStages.get("second-suspend")?.status).toBe("SUSPENDED");
    });
  });

  describe("parallel stage suspension", () => {
    it("should suspend workflow if any parallel stage suspends", async () => {
      // Given: Parallel stages where one suspends
      const normalStage = createPassthroughStage(
        "parallel-normal",
        TestSchemas.string,
      );

      const suspendStage = createSuspendingStage(
        "parallel-suspend",
        TestSchemas.string,
        {
          getOutput: () => ({ value: "suspended" }),
        },
      );

      const workflow = new WorkflowBuilder(
        "parallel-with-suspend",
        "Parallel With Suspend",
        "Test",
        TestSchemas.string,
        z.any(),
      )
        .parallel([normalStage, suspendStage])
        .build();

      await persistence.createRun({
        id: "run-parallel-suspend",
        workflowId: "parallel-with-suspend",
        workflowName: "Parallel With Suspend",
        status: "PENDING",
        input: { value: "test" },
      });

      const executor = new WorkflowExecutor(
        workflow,
        "run-parallel-suspend",
        "parallel-with-suspend",
        { persistence, aiLogger },
      );

      // When: I execute
      const result = await executor.execute({ value: "test" }, {});

      // Then: Workflow is suspended
      expect(result).toBe("suspended");
    });
  });
});
