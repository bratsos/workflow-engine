/**
 * API Workflow Lifecycle Tests
 *
 * Tests for how an API server would interact with the workflow engine:
 * - Starting workflows from API endpoints
 * - Checking workflow status
 * - Waiting for workflow completion
 * - Canceling workflows
 */

import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { defineStage } from "../../core/stage-factory.js";
import type { Workflow } from "../../core/workflow.js";
import { WorkflowBuilder } from "../../core/workflow.js";
import type { WorkflowRegistry } from "../../kernel/kernel.js";
import {
  InMemoryAICallLogger,
  InMemoryJobQueue,
  InMemoryWorkflowPersistence,
  TestSchemas,
} from "../utils/index.js";

describe("I want to manage workflow lifecycle from an API", () => {
  let persistence: InMemoryWorkflowPersistence;
  let jobQueue: InMemoryJobQueue;
  let aiLogger: InMemoryAICallLogger;
  let registry: WorkflowRegistry;

  // Simple workflow for testing
  const createTestWorkflow = () => {
    const processStage = defineStage({
      id: "process",
      name: "Process Data",
      schemas: {
        input: z.object({ data: z.string() }),
        output: z.object({ result: z.string() }),
        config: z.object({}),
      },
      async execute(ctx) {
        return { output: { result: `Processed: ${ctx.input.data}` } };
      },
    });

    return new WorkflowBuilder(
      "test-workflow",
      "Test Workflow",
      "A simple test workflow",
      z.object({ data: z.string() }),
      z.object({ result: z.string() }),
    )
      .pipe(processStage)
      .build();
  };

  beforeEach(() => {
    persistence = new InMemoryWorkflowPersistence();
    jobQueue = new InMemoryJobQueue("api-worker");
    aiLogger = new InMemoryAICallLogger();

    const workflow = createTestWorkflow();
    registry = {
      getWorkflow: (id: string) => (id === "test-workflow" ? workflow : null),
    } as WorkflowRegistry;
  });

  describe("starting a workflow from API", () => {
    it("should create a workflow run with PENDING status", async () => {
      // Given: An API request to start a workflow
      const workflowId = "test-workflow";
      const input = { data: "hello world" };

      // When: I create a workflow run (simulating API call)
      const run = await persistence.createRun({
        workflowId,
        workflowName: "Test Workflow",
        workflowType: workflowId,
        input,
        priority: 5,
      });

      // Then: Run is created with PENDING status
      expect(run.id).toBeDefined();
      expect(run.status).toBe("PENDING");
      expect(run.workflowId).toBe(workflowId);
      expect(run.input).toEqual(input);
    });

    it("should support custom priority for workflow runs", async () => {
      // Given: A high-priority API request
      const highPriority = 10;

      // When: I create a workflow run with priority
      const run = await persistence.createRun({
        workflowId: "test-workflow",
        workflowName: "Test Workflow",
        workflowType: "test-workflow",
        input: { data: "urgent" },
        priority: highPriority,
      });

      // Then: Priority is set
      expect(run.priority).toBe(highPriority);
    });

    it("should support custom run ID for idempotency", async () => {
      // Given: An API request with a specific run ID (for idempotency)
      const customId = "api-request-12345";

      // When: I create a workflow run with custom ID
      const run = await persistence.createRun({
        id: customId,
        workflowId: "test-workflow",
        workflowName: "Test Workflow",
        workflowType: "test-workflow",
        input: { data: "test" },
      });

      // Then: Custom ID is used
      expect(run.id).toBe(customId);
    });

    it("should store workflow configuration with the run", async () => {
      // Given: An API request with stage configuration
      const config = {
        process: { maxRetries: 3, timeout: 30000 },
      };

      // When: I create a workflow run with config
      const run = await persistence.createRun({
        workflowId: "test-workflow",
        workflowName: "Test Workflow",
        workflowType: "test-workflow",
        input: { data: "test" },
        config,
      });

      // Then: Config is stored
      expect(run.config).toEqual(config);
    });
  });

  describe("checking workflow status", () => {
    it("should return PENDING for newly created workflow", async () => {
      // Given: A newly created workflow run
      const run = await persistence.createRun({
        workflowId: "test-workflow",
        workflowName: "Test Workflow",
        workflowType: "test-workflow",
        input: { data: "test" },
      });

      // When: I check the status
      const status = await persistence.getRunStatus(run.id);

      // Then: Status is PENDING
      expect(status).toBe("PENDING");
    });

    it("should return RUNNING after workflow starts", async () => {
      // Given: A workflow run that has started
      const run = await persistence.createRun({
        workflowId: "test-workflow",
        workflowName: "Test Workflow",
        workflowType: "test-workflow",
        input: { data: "test" },
      });

      await persistence.updateRun(run.id, {
        status: "RUNNING",
        startedAt: new Date(),
      });

      // When: I check the status
      const status = await persistence.getRunStatus(run.id);

      // Then: Status is RUNNING
      expect(status).toBe("RUNNING");
    });

    it("should return full run details when needed", async () => {
      // Given: A workflow run with some progress
      const run = await persistence.createRun({
        workflowId: "test-workflow",
        workflowName: "Test Workflow",
        workflowType: "test-workflow",
        input: { data: "test" },
        priority: 8,
      });

      const startedAt = new Date();
      await persistence.updateRun(run.id, {
        status: "RUNNING",
        startedAt,
      });

      // When: I get full run details
      const details = await persistence.getRun(run.id);

      // Then: All details are available
      expect(details).not.toBeNull();
      expect(details?.status).toBe("RUNNING");
      expect(details?.startedAt).toEqual(startedAt);
      expect(details?.priority).toBe(8);
      expect(details?.input).toEqual({ data: "test" });
    });

    it("should return null for non-existent workflow", async () => {
      // When: I check status of non-existent workflow
      const status = await persistence.getRunStatus("non-existent-id");

      // Then: Returns null
      expect(status).toBeNull();
    });

    it("should list workflows by status for dashboard", async () => {
      // Given: Multiple workflows in different states
      const run1 = await persistence.createRun({
        workflowId: "test-workflow",
        workflowName: "Test Workflow",
        workflowType: "test-workflow",
        input: { data: "test1" },
      });

      const run2 = await persistence.createRun({
        workflowId: "test-workflow",
        workflowName: "Test Workflow",
        workflowType: "test-workflow",
        input: { data: "test2" },
      });

      const run3 = await persistence.createRun({
        workflowId: "test-workflow",
        workflowName: "Test Workflow",
        workflowType: "test-workflow",
        input: { data: "test3" },
      });

      await persistence.updateRun(run1.id, { status: "RUNNING" });
      await persistence.updateRun(run2.id, { status: "COMPLETED" });
      // run3 stays PENDING

      // When: I list workflows by status
      const pending = await persistence.getRunsByStatus("PENDING");
      const running = await persistence.getRunsByStatus("RUNNING");
      const completed = await persistence.getRunsByStatus("COMPLETED");

      // Then: Correct workflows are returned
      expect(pending).toHaveLength(1);
      expect(pending[0]?.id).toBe(run3.id);

      expect(running).toHaveLength(1);
      expect(running[0]?.id).toBe(run1.id);

      expect(completed).toHaveLength(1);
      expect(completed[0]?.id).toBe(run2.id);
    });
  });

  describe("waiting for workflow completion", () => {
    it("should detect when workflow completes", async () => {
      // Given: A running workflow
      const run = await persistence.createRun({
        workflowId: "test-workflow",
        workflowName: "Test Workflow",
        workflowType: "test-workflow",
        input: { data: "test" },
      });

      await persistence.updateRun(run.id, {
        status: "RUNNING",
        startedAt: new Date(),
      });

      // When: Workflow completes
      await persistence.updateRun(run.id, {
        status: "COMPLETED",
        completedAt: new Date(),
        output: { result: "Processed: test" },
        duration: 1500,
      });

      // Then: Status reflects completion
      const status = await persistence.getRunStatus(run.id);
      expect(status).toBe("COMPLETED");

      const details = await persistence.getRun(run.id);
      expect(details?.output).toEqual({ result: "Processed: test" });
      expect(details?.duration).toBe(1500);
    });

    it("should support polling for completion", async () => {
      // Given: A running workflow
      const run = await persistence.createRun({
        workflowId: "test-workflow",
        workflowName: "Test Workflow",
        workflowType: "test-workflow",
        input: { data: "test" },
      });

      await persistence.updateRun(run.id, { status: "RUNNING" });

      // Simulate polling function
      const pollUntilComplete = async (
        runId: string,
        maxAttempts: number,
        intervalMs: number,
      ): Promise<string | null> => {
        for (let i = 0; i < maxAttempts; i++) {
          const status = await persistence.getRunStatus(runId);
          if (
            status === "COMPLETED" ||
            status === "FAILED" ||
            status === "CANCELLED"
          ) {
            return status;
          }
          await new Promise((r) => setTimeout(r, intervalMs));
        }
        return null; // Timeout
      };

      // Simulate workflow completing after a short delay
      setTimeout(async () => {
        await persistence.updateRun(run.id, {
          status: "COMPLETED",
          completedAt: new Date(),
        });
      }, 50);

      // When: I poll for completion
      const finalStatus = await pollUntilComplete(run.id, 10, 20);

      // Then: Completion is detected
      expect(finalStatus).toBe("COMPLETED");
    });

    it("should detect workflow failure", async () => {
      // Given: A running workflow
      const run = await persistence.createRun({
        workflowId: "test-workflow",
        workflowName: "Test Workflow",
        workflowType: "test-workflow",
        input: { data: "test" },
      });

      await persistence.updateRun(run.id, { status: "RUNNING" });

      // When: Workflow fails
      await persistence.updateRun(run.id, {
        status: "FAILED",
        completedAt: new Date(),
      });

      // Then: Failure is reflected
      const status = await persistence.getRunStatus(run.id);
      expect(status).toBe("FAILED");
    });

    it("should track workflow duration", async () => {
      // Given: A workflow that runs for some time
      const startTime = new Date();
      const run = await persistence.createRun({
        workflowId: "test-workflow",
        workflowName: "Test Workflow",
        workflowType: "test-workflow",
        input: { data: "test" },
      });

      await persistence.updateRun(run.id, {
        status: "RUNNING",
        startedAt: startTime,
      });

      // Simulate some work
      await new Promise((r) => setTimeout(r, 100));

      // When: Workflow completes
      const endTime = new Date();
      const duration = endTime.getTime() - startTime.getTime();

      await persistence.updateRun(run.id, {
        status: "COMPLETED",
        completedAt: endTime,
        duration,
      });

      // Then: Duration is tracked
      const details = await persistence.getRun(run.id);
      expect(details?.duration).toBeGreaterThanOrEqual(100);
    });
  });

  describe("canceling a workflow", () => {
    it("should allow canceling a pending workflow", async () => {
      // Given: A pending workflow
      const run = await persistence.createRun({
        workflowId: "test-workflow",
        workflowName: "Test Workflow",
        workflowType: "test-workflow",
        input: { data: "test" },
      });

      // When: I cancel it
      await persistence.updateRun(run.id, {
        status: "CANCELLED",
        completedAt: new Date(),
      });

      // Then: Status is CANCELLED
      const status = await persistence.getRunStatus(run.id);
      expect(status).toBe("CANCELLED");
    });

    it("should allow canceling a running workflow", async () => {
      // Given: A running workflow
      const run = await persistence.createRun({
        workflowId: "test-workflow",
        workflowName: "Test Workflow",
        workflowType: "test-workflow",
        input: { data: "test" },
      });

      await persistence.updateRun(run.id, {
        status: "RUNNING",
        startedAt: new Date(),
      });

      // When: I cancel it
      await persistence.updateRun(run.id, {
        status: "CANCELLED",
        completedAt: new Date(),
      });

      // Then: Status is CANCELLED
      const status = await persistence.getRunStatus(run.id);
      expect(status).toBe("CANCELLED");
    });

    it("should not affect already completed workflows", async () => {
      // Given: A completed workflow
      const run = await persistence.createRun({
        workflowId: "test-workflow",
        workflowName: "Test Workflow",
        workflowType: "test-workflow",
        input: { data: "test" },
      });

      await persistence.updateRun(run.id, {
        status: "COMPLETED",
        completedAt: new Date(),
        output: { result: "done" },
      });

      // When: I try to "cancel" it (in practice, API should prevent this)
      // The persistence layer will allow the update, but the output remains
      await persistence.updateRun(run.id, {
        status: "CANCELLED",
      });

      // Then: Status changes but output is preserved
      const details = await persistence.getRun(run.id);
      expect(details?.status).toBe("CANCELLED");
      expect(details?.output).toEqual({ result: "done" });
    });
  });

  describe("workflow stage progress tracking", () => {
    it("should track individual stage status", async () => {
      // Given: A workflow run
      const run = await persistence.createRun({
        workflowId: "test-workflow",
        workflowName: "Test Workflow",
        workflowType: "test-workflow",
        input: { data: "test" },
      });

      // When: Stages are created and progress
      await persistence.createStage({
        workflowRunId: run.id,
        stageId: "process",
        stageName: "Process Data",
        stageNumber: 1,
        executionGroup: 1,
        status: "PENDING",
      });

      // Then: Stage can be queried
      const stages = await persistence.getStagesByRun(run.id);
      expect(stages).toHaveLength(1);
      expect(stages[0]?.stageId).toBe("process");
      expect(stages[0]?.status).toBe("PENDING");
    });

    it("should update stage status as workflow progresses", async () => {
      // Given: A workflow with a stage
      const run = await persistence.createRun({
        workflowId: "test-workflow",
        workflowName: "Test Workflow",
        workflowType: "test-workflow",
        input: { data: "test" },
      });

      const stage = await persistence.createStage({
        workflowRunId: run.id,
        stageId: "process",
        stageName: "Process Data",
        stageNumber: 1,
        executionGroup: 1,
        status: "PENDING",
      });

      // When: Stage starts and completes
      await persistence.updateStage(stage.id, {
        status: "RUNNING",
        startedAt: new Date(),
      });

      let currentStage = await persistence.getStage(run.id, "process");
      expect(currentStage?.status).toBe("RUNNING");

      await persistence.updateStage(stage.id, {
        status: "COMPLETED",
        completedAt: new Date(),
        duration: 500,
      });

      currentStage = await persistence.getStage(run.id, "process");
      expect(currentStage?.status).toBe("COMPLETED");
      expect(currentStage?.duration).toBe(500);
    });

    it("should provide stage progress for API responses", async () => {
      // Given: A workflow with multiple stages at different states
      const run = await persistence.createRun({
        workflowId: "test-workflow",
        workflowName: "Test Workflow",
        workflowType: "test-workflow",
        input: { data: "test" },
      });

      await persistence.createStage({
        workflowRunId: run.id,
        stageId: "stage-1",
        stageName: "Stage 1",
        stageNumber: 1,
        executionGroup: 1,
        status: "COMPLETED",
      });

      await persistence.createStage({
        workflowRunId: run.id,
        stageId: "stage-2",
        stageName: "Stage 2",
        stageNumber: 2,
        executionGroup: 2,
        status: "RUNNING",
      });

      await persistence.createStage({
        workflowRunId: run.id,
        stageId: "stage-3",
        stageName: "Stage 3",
        stageNumber: 3,
        executionGroup: 3,
        status: "PENDING",
      });

      // When: I query for stage progress
      const allStages = await persistence.getStagesByRun(run.id);
      const completed = allStages.filter((s) => s.status === "COMPLETED");
      const running = allStages.filter((s) => s.status === "RUNNING");
      const pending = allStages.filter((s) => s.status === "PENDING");

      // Then: Progress can be computed for API response
      expect(allStages).toHaveLength(3);
      expect(completed).toHaveLength(1);
      expect(running).toHaveLength(1);
      expect(pending).toHaveLength(1);

      // API could return: { total: 3, completed: 1, running: 1, pending: 1 }
    });
  });

  describe("workflow cost and token tracking", () => {
    it("should track total cost after workflow completion", async () => {
      // Given: A completed workflow with cost tracking
      const run = await persistence.createRun({
        workflowId: "test-workflow",
        workflowName: "Test Workflow",
        workflowType: "test-workflow",
        input: { data: "test" },
      });

      // When: Workflow completes with aggregated costs
      await persistence.updateRun(run.id, {
        status: "COMPLETED",
        completedAt: new Date(),
        totalCost: 0.0125,
        totalTokens: 1500,
      });

      // Then: Costs are available for billing/monitoring
      const details = await persistence.getRun(run.id);
      expect(details?.totalCost).toBe(0.0125);
      expect(details?.totalTokens).toBe(1500);
    });
  });
});
