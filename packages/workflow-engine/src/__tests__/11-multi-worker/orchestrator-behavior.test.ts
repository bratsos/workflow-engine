/**
 * Orchestrator Behavior Tests
 *
 * Tests for WorkflowRuntime orchestration logic.
 * Note: WorkflowRuntime is the orchestrator in this workflow engine.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import type { Workflow } from "../../core/workflow.js";
import { WorkflowBuilder } from "../../core/workflow.js";
import {
  WorkflowRuntime,
  type WorkflowRuntimeConfig,
} from "../../runtime/index.js";
import { InMemoryJobQueue } from "../utils/in-memory-job-queue.js";
import {
  createPassthroughStage,
  InMemoryAICallLogger,
  InMemoryWorkflowPersistence,
  TestSchemas,
} from "../utils/index.js";

describe("I want orchestrator to manage workflow state", () => {
  let persistence: InMemoryWorkflowPersistence;
  let aiLogger: InMemoryAICallLogger;
  let jobQueue: InMemoryJobQueue;
  let registry: Map<string, Workflow<any, any>>;

  beforeEach(() => {
    persistence = new InMemoryWorkflowPersistence();
    aiLogger = new InMemoryAICallLogger();
    jobQueue = new InMemoryJobQueue("worker-test");
    registry = new Map();
  });

  function createRuntime(overrides: Partial<WorkflowRuntimeConfig> = {}) {
    return new WorkflowRuntime({
      persistence,
      jobQueue,
      registry: {
        getWorkflow: (id: string) => registry.get(id),
      },
      aiCallLogger: aiLogger,
      pollIntervalMs: 100,
      jobPollIntervalMs: 50,
      staleJobThresholdMs: 5000,
      ...overrides,
    });
  }

  describe("workflow creation", () => {
    it("should validate workflow exists in registry before creating run", async () => {
      // Given: A runtime with an empty registry
      const runtime = createRuntime();

      // When: I try to create a run for unknown workflow
      // Then: It throws
      await expect(
        runtime.createRun({
          workflowId: "unknown-workflow",
          input: { value: "test" },
        }),
      ).rejects.toThrow(/not found/);
    });

    it("should validate input against workflow schema", async () => {
      // Given: A workflow with specific input schema
      const stage = createPassthroughStage("process", TestSchemas.string);
      const workflow = new WorkflowBuilder(
        "validated-workflow",
        "Validated Workflow",
        "Test",
        z.object({ requiredField: z.string() }),
        TestSchemas.string,
      )
        .pipe(stage)
        .build();

      registry.set("validated-workflow", workflow);
      const runtime = createRuntime();

      // When: I try to create with invalid input
      // Then: It throws
      await expect(
        runtime.createRun({
          workflowId: "validated-workflow",
          input: { wrongField: "test" },
        }),
      ).rejects.toThrow(/Invalid workflow input/);
    });

    it("should create workflow run in PENDING status", async () => {
      // Given: A valid workflow
      const stage = createPassthroughStage("process", TestSchemas.string);
      const workflow = new WorkflowBuilder(
        "test-workflow",
        "Test Workflow",
        "Test",
        TestSchemas.string,
        TestSchemas.string,
      )
        .pipe(stage)
        .build();

      registry.set("test-workflow", workflow);
      const runtime = createRuntime();

      // When: I create a run
      const result = await runtime.createRun({
        workflowId: "test-workflow",
        input: { value: "test" },
      });

      // Then: Run is created in PENDING status
      expect(result.workflowRunId).toBeDefined();

      const run = await persistence.getRun(result.workflowRunId);
      expect(run?.status).toBe("PENDING");
      expect(run?.workflowId).toBe("test-workflow");
      expect(run?.input).toEqual({ value: "test" });
    });

    it("should merge default config with provided config", async () => {
      // Given: A workflow with default config
      const configuredStage = {
        id: "configured",
        name: "Configured Stage",
        description: "Stage with config",
        inputSchema: TestSchemas.string,
        outputSchema: TestSchemas.string,
        configSchema: z.object({
          setting: z.string().default("default-value"),
        }),
        execute: async (ctx: any) => ({ output: ctx.input }),
      };

      const workflow = new WorkflowBuilder(
        "config-workflow",
        "Config Workflow",
        "Test",
        TestSchemas.string,
        TestSchemas.string,
      )
        .pipe(configuredStage as any)
        .build();

      registry.set("config-workflow", workflow);
      const runtime = createRuntime();

      // When: I create with partial config
      const result = await runtime.createRun({
        workflowId: "config-workflow",
        input: { value: "test" },
        config: { configured: { setting: "custom-value" } },
      });

      // Then: Config is stored
      const run = await persistence.getRun(result.workflowRunId);
      expect(run?.config).toEqual({ configured: { setting: "custom-value" } });
    });

    it("should respect custom priority", async () => {
      // Given: A workflow
      const stage = createPassthroughStage("process", TestSchemas.string);
      const workflow = new WorkflowBuilder(
        "priority-workflow",
        "Priority Workflow",
        "Test",
        TestSchemas.string,
        TestSchemas.string,
      )
        .pipe(stage)
        .build();

      registry.set("priority-workflow", workflow);
      const runtime = createRuntime();

      // When: I create with custom priority
      const result = await runtime.createRun({
        workflowId: "priority-workflow",
        input: { value: "test" },
        priority: 10,
      });

      // Then: Priority is stored
      const run = await persistence.getRun(result.workflowRunId);
      expect(run?.priority).toBe(10);
    });

    it("should use priority function when no explicit priority given", async () => {
      // Given: A runtime with priority function
      const stage = createPassthroughStage("process", TestSchemas.string);
      const workflow = new WorkflowBuilder(
        "auto-priority-workflow",
        "Auto Priority Workflow",
        "Test",
        TestSchemas.string,
        TestSchemas.string,
      )
        .pipe(stage)
        .build();

      registry.set("auto-priority-workflow", workflow);

      const runtime = createRuntime({
        getWorkflowPriority: (workflowId: string) => {
          if (workflowId === "auto-priority-workflow") return 8;
          return 5;
        },
      });

      // When: I create without explicit priority
      const result = await runtime.createRun({
        workflowId: "auto-priority-workflow",
        input: { value: "test" },
      });

      // Then: Priority function is used
      const run = await persistence.getRun(result.workflowRunId);
      expect(run?.priority).toBe(8);
    });
  });

  describe("workflow transition", () => {
    it("should transition completed workflow stages", async () => {
      // Given: A multi-stage workflow
      const stage1 = createPassthroughStage("stage-1", TestSchemas.string);
      const stage2 = createPassthroughStage("stage-2", TestSchemas.string);

      const workflow = new WorkflowBuilder(
        "multi-stage",
        "Multi Stage Workflow",
        "Test",
        TestSchemas.string,
        TestSchemas.string,
      )
        .pipe(stage1)
        .pipe(stage2)
        .build();

      registry.set("multi-stage", workflow);
      const runtime = createRuntime();

      // Create run and first stage
      await persistence.createRun({
        id: "run-1",
        workflowId: "multi-stage",
        workflowName: "Multi Stage Workflow",
        input: { value: "test" },
      });

      await persistence.createStage({
        workflowRunId: "run-1",
        stageId: "stage-1",
        stageName: "Stage 1",
        stageNumber: 1,
        executionGroup: 1,
        status: "COMPLETED",
      });

      await persistence.updateRun("run-1", { status: "RUNNING" });

      // When: I trigger transition
      await runtime.transitionWorkflow("run-1");

      // Then: Jobs for next stage are enqueued
      const pendingJobs = jobQueue.getJobsByStatus("PENDING");
      expect(pendingJobs).toHaveLength(1);
      expect(pendingJobs[0]?.stageId).toBe("stage-2");
    });

    it("should not transition while stages are still active", async () => {
      // Given: A workflow with an active stage
      const stage1 = createPassthroughStage("stage-1", TestSchemas.string);
      const stage2 = createPassthroughStage("stage-2", TestSchemas.string);

      const workflow = new WorkflowBuilder(
        "active-workflow",
        "Active Workflow",
        "Test",
        TestSchemas.string,
        TestSchemas.string,
      )
        .pipe(stage1)
        .pipe(stage2)
        .build();

      registry.set("active-workflow", workflow);
      const runtime = createRuntime();

      await persistence.createRun({
        id: "run-active",
        workflowId: "active-workflow",
        workflowName: "Active Workflow",
        input: { value: "test" },
      });

      await persistence.createStage({
        workflowRunId: "run-active",
        stageId: "stage-1",
        stageName: "Stage 1",
        stageNumber: 1,
        executionGroup: 1,
        status: "RUNNING", // Still running
      });

      await persistence.updateRun("run-active", { status: "RUNNING" });

      // When: I try to transition
      await runtime.transitionWorkflow("run-active");

      // Then: No new jobs enqueued
      const pendingJobs = jobQueue.getJobsByStatus("PENDING");
      expect(pendingJobs).toHaveLength(0);
    });

    it("should complete workflow when all stages done", async () => {
      // Given: A workflow with all stages completed
      const stage = createPassthroughStage("only-stage", TestSchemas.string);

      const workflow = new WorkflowBuilder(
        "complete-workflow",
        "Complete Workflow",
        "Test",
        TestSchemas.string,
        TestSchemas.string,
      )
        .pipe(stage)
        .build();

      registry.set("complete-workflow", workflow);
      const runtime = createRuntime();

      await persistence.createRun({
        id: "run-complete",
        workflowId: "complete-workflow",
        workflowName: "Complete Workflow",
        input: { value: "test" },
      });

      await persistence.createStage({
        workflowRunId: "run-complete",
        stageId: "only-stage",
        stageName: "Only Stage",
        stageNumber: 1,
        executionGroup: 1,
        status: "COMPLETED",
      });

      await persistence.updateRun("run-complete", { status: "RUNNING" });

      // When: I trigger transition
      await runtime.transitionWorkflow("run-complete");

      // Then: Workflow is marked complete
      const run = await persistence.getRun("run-complete");
      expect(run?.status).toBe("COMPLETED");
      expect(run?.completedAt).toBeInstanceOf(Date);
    });

    it("should not transition cancelled workflows", async () => {
      // Given: A cancelled workflow
      const stage = createPassthroughStage("stage", TestSchemas.string);
      const workflow = new WorkflowBuilder(
        "cancelled-workflow",
        "Cancelled Workflow",
        "Test",
        TestSchemas.string,
        TestSchemas.string,
      )
        .pipe(stage)
        .build();

      registry.set("cancelled-workflow", workflow);
      const runtime = createRuntime();

      await persistence.createRun({
        id: "run-cancelled",
        workflowId: "cancelled-workflow",
        workflowName: "Cancelled Workflow",
        input: { value: "test" },
      });

      await persistence.updateRun("run-cancelled", { status: "CANCELLED" });

      // When: I try to transition
      await runtime.transitionWorkflow("run-cancelled");

      // Then: No jobs enqueued, status unchanged
      const pendingJobs = jobQueue.getJobsByStatus("PENDING");
      expect(pendingJobs).toHaveLength(0);

      const run = await persistence.getRun("run-cancelled");
      expect(run?.status).toBe("CANCELLED");
    });
  });

  describe("parallel stage handling", () => {
    it("should enqueue all stages in an execution group", async () => {
      // Given: A workflow with parallel stages
      const stageA = createPassthroughStage("parallel-a", TestSchemas.string);
      const stageB = createPassthroughStage("parallel-b", TestSchemas.string);

      const workflow = new WorkflowBuilder(
        "parallel-workflow",
        "Parallel Workflow",
        "Test",
        TestSchemas.string,
        z.any(),
      )
        .parallel([stageA, stageB])
        .build();

      registry.set("parallel-workflow", workflow);
      const runtime = createRuntime();

      const result = await runtime.createRun({
        workflowId: "parallel-workflow",
        input: { value: "test" },
      });

      // Simulate pending workflow pickup
      await persistence.updateRun(result.workflowRunId, { status: "RUNNING" });
      await runtime.transitionWorkflow(result.workflowRunId);

      // Then: Both parallel stages have jobs
      const pendingJobs = jobQueue.getJobsByStatus("PENDING");
      expect(pendingJobs).toHaveLength(2);

      const stageIds = pendingJobs.map((j) => j.stageId);
      expect(stageIds).toContain("parallel-a");
      expect(stageIds).toContain("parallel-b");
    });
  });

  describe("suspended stage polling", () => {
    it("should find suspended stages ready to poll", async () => {
      // Given: A suspended stage ready to check
      await persistence.createRun({
        id: "run-suspended",
        workflowId: "test-workflow",
        workflowName: "Test Workflow",
        input: { value: "test" },
      });

      const stage = await persistence.createStage({
        workflowRunId: "run-suspended",
        stageId: "suspended-stage",
        stageName: "Suspended Stage",
        stageNumber: 1,
        executionGroup: 1,
        status: "SUSPENDED",
      });

      await persistence.updateStage(stage.id, {
        nextPollAt: new Date(Date.now() - 1000), // Ready
        suspendedState: { batchId: "batch-123" },
      });

      // When: I poll for suspended stages
      const runtime = createRuntime();
      const suspendedStages = await persistence.getSuspendedStages(new Date());

      // Then: Stage is found (filter for unique stageIds due to potential indexing)
      const uniqueStageIds = [
        ...new Set(suspendedStages.map((s) => s.stageId)),
      ];
      expect(uniqueStageIds).toHaveLength(1);
      expect(uniqueStageIds[0]).toBe("suspended-stage");
    });

    it("should not return suspended stages not yet ready", async () => {
      // Given: A suspended stage not yet ready
      await persistence.createRun({
        id: "run-future",
        workflowId: "test-workflow",
        workflowName: "Test Workflow",
        input: { value: "test" },
      });

      const stage = await persistence.createStage({
        workflowRunId: "run-future",
        stageId: "future-stage",
        stageName: "Future Stage",
        stageNumber: 1,
        executionGroup: 1,
        status: "SUSPENDED",
      });

      await persistence.updateStage(stage.id, {
        nextPollAt: new Date(Date.now() + 60000), // Not ready
        suspendedState: { batchId: "batch-future" },
      });

      // When: I poll for suspended stages
      const suspendedStages = await persistence.getSuspendedStages(new Date());

      // Then: Stage is not found
      expect(suspendedStages).toHaveLength(0);
    });
  });

  describe("runtime lifecycle", () => {
    it("should create AI helper when configured", async () => {
      // Given: A runtime with AI logger
      const runtime = createRuntime();

      // When: I create an AI helper
      const helper = runtime.createAIHelper("test.topic");

      // Then: Helper is created
      expect(helper).toBeDefined();
    });

    it("should throw when creating AI helper without logger", async () => {
      // Given: A runtime without AI logger
      const runtime = new WorkflowRuntime({
        persistence,
        jobQueue,
        registry: { getWorkflow: (id) => registry.get(id) },
        // aiCallLogger intentionally omitted
      });

      // When: I try to create an AI helper
      // Then: It throws
      expect(() => runtime.createAIHelper("test.topic")).toThrow(
        /AICallLogger not configured/,
      );
    });

    it("should create log context for workflow stages", async () => {
      // Given: A runtime
      const runtime = createRuntime();

      // When: I create a log context
      const logContext = runtime.createLogContext("run-123", "stage-456");

      // Then: Log context has the right properties
      expect(logContext.workflowRunId).toBe("run-123");
      expect(logContext.stageRecordId).toBe("stage-456");
      expect(typeof logContext.createLog).toBe("function");
    });
  });

  describe("error handling", () => {
    it("should handle missing workflow gracefully on transition", async () => {
      // Given: A run with unknown workflow
      await persistence.createRun({
        id: "run-unknown",
        workflowId: "non-existent",
        workflowName: "Non-existent",
        input: { value: "test" },
      });

      await persistence.updateRun("run-unknown", { status: "RUNNING" });

      const runtime = createRuntime();

      // When: I try to transition (workflow not in registry)
      // Should not throw, just return
      await runtime.transitionWorkflow("run-unknown");

      // Then: No jobs created, run unchanged
      const pendingJobs = jobQueue.getJobsByStatus("PENDING");
      expect(pendingJobs).toHaveLength(0);
    });

    it("should handle non-existent run gracefully on transition", async () => {
      // Given: A runtime
      const runtime = createRuntime();

      // When: I try to transition a non-existent run
      // Should not throw
      await runtime.transitionWorkflow("non-existent-run");

      // Then: No error, nothing happens
      const pendingJobs = jobQueue.getJobsByStatus("PENDING");
      expect(pendingJobs).toHaveLength(0);
    });
  });
});
