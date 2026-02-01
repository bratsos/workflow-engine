/**
 * Concurrent Workflows Tests
 *
 * Tests for running multiple workflows simultaneously.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { z } from "zod";
import { InMemoryJobQueue } from "../utils/in-memory-job-queue.js";
import {
  InMemoryWorkflowPersistence,
  InMemoryAICallLogger,
  createPassthroughStage,
  createTrackingStage,
  TestSchemas,
} from "../utils/index.js";
import { WorkflowBuilder } from "../../core/workflow.js";
import { WorkflowExecutor } from "../../core/executor.js";

describe("I want to run multiple workflows concurrently", () => {
  let persistence: InMemoryWorkflowPersistence;
  let aiLogger: InMemoryAICallLogger;
  let jobQueue: InMemoryJobQueue;

  beforeEach(() => {
    persistence = new InMemoryWorkflowPersistence();
    aiLogger = new InMemoryAICallLogger();
    jobQueue = new InMemoryJobQueue("worker-1");
  });

  describe("job queue with multiple workflows", () => {
    it("should queue jobs from different workflows", async () => {
      // Given: Jobs from different workflows
      await jobQueue.enqueue({
        workflowRunId: "workflow-a-run-1",
        stageId: "stage-1",
      });
      await jobQueue.enqueue({
        workflowRunId: "workflow-b-run-1",
        stageId: "stage-1",
      });
      await jobQueue.enqueue({
        workflowRunId: "workflow-a-run-2",
        stageId: "stage-1",
      });

      // When: I get all jobs
      const allJobs = jobQueue.getAllJobs();

      // Then: All workflows' jobs are in the queue
      expect(allJobs).toHaveLength(3);

      const runIds = allJobs.map((j) => j.workflowRunId);
      expect(runIds).toContain("workflow-a-run-1");
      expect(runIds).toContain("workflow-b-run-1");
      expect(runIds).toContain("workflow-a-run-2");
    });

    it("should process jobs in priority order across workflows", async () => {
      // Given: Jobs from different workflows with different priorities
      await jobQueue.enqueue({
        workflowRunId: "low-priority-workflow",
        stageId: "stage-1",
        priority: 1,
      });
      await jobQueue.enqueue({
        workflowRunId: "high-priority-workflow",
        stageId: "stage-1",
        priority: 10,
      });
      await jobQueue.enqueue({
        workflowRunId: "medium-priority-workflow",
        stageId: "stage-1",
        priority: 5,
      });

      // When: I dequeue all jobs
      const first = await jobQueue.dequeue();
      const second = await jobQueue.dequeue();
      const third = await jobQueue.dequeue();

      // Then: Jobs come out in priority order
      expect(first?.workflowRunId).toBe("high-priority-workflow");
      expect(second?.workflowRunId).toBe("medium-priority-workflow");
      expect(third?.workflowRunId).toBe("low-priority-workflow");
    });

    it("should handle interleaved job completion", async () => {
      // Given: Jobs from two workflows
      const job1 = await jobQueue.enqueue({
        workflowRunId: "workflow-a",
        stageId: "stage-1",
      });
      const job2 = await jobQueue.enqueue({
        workflowRunId: "workflow-b",
        stageId: "stage-1",
      });

      // When: Both are being processed
      await jobQueue.dequeue(); // Gets job1
      await jobQueue.dequeue(); // Gets job2

      // And: Job2 completes first
      await jobQueue.complete(job2);

      // Then: Job statuses are independent
      expect(jobQueue.getJob(job1)?.status).toBe("RUNNING");
      expect(jobQueue.getJob(job2)?.status).toBe("COMPLETED");
    });
  });

  describe("persistence isolation", () => {
    it("should store workflow runs independently", async () => {
      // Given: Two concurrent workflow runs
      await persistence.createRun({
        id: "run-a",
        workflowId: "workflow-a",
        workflowName: "Workflow A",
        input: { data: "a" },
      });
      await persistence.createRun({
        id: "run-b",
        workflowId: "workflow-b",
        workflowName: "Workflow B",
        input: { data: "b" },
      });

      // When: I update one
      await persistence.updateRun("run-a", { status: "COMPLETED" });

      // Then: The other is unaffected
      const runA = await persistence.getRun("run-a");
      const runB = await persistence.getRun("run-b");

      expect(runA?.status).toBe("COMPLETED");
      expect(runB?.status).toBe("PENDING");
    });

    it("should store stages for different workflows separately", async () => {
      // Given: Stages from different workflows
      await persistence.createStage({
        workflowRunId: "run-a",
        stageId: "shared-name",
        stageName: "Stage from A",
        stageNumber: 1,
        executionGroup: 1,
      });
      await persistence.createStage({
        workflowRunId: "run-b",
        stageId: "shared-name",
        stageName: "Stage from B",
        stageNumber: 1,
        executionGroup: 1,
      });

      // When: I get stages for each run
      const stagesA = await persistence.getStagesByRun("run-a", {});
      const stagesB = await persistence.getStagesByRun("run-b", {});

      // Then: Each run has its own stage
      const uniqueStagesA = new Map(stagesA.map((s) => [s.stageId, s]));
      const uniqueStagesB = new Map(stagesB.map((s) => [s.stageId, s]));

      expect(uniqueStagesA.size).toBe(1);
      expect(uniqueStagesB.size).toBe(1);
      expect(uniqueStagesA.get("shared-name")?.stageName).toBe("Stage from A");
      expect(uniqueStagesB.get("shared-name")?.stageName).toBe("Stage from B");
    });

    it("should store artifacts for different workflows separately", async () => {
      // Given: Artifacts with same key from different workflows
      await persistence.saveArtifact({
        workflowRunId: "run-a",
        key: "output.json",
        type: "STAGE_OUTPUT",
        data: { source: "workflow-a" },
        size: 100,
      });
      await persistence.saveArtifact({
        workflowRunId: "run-b",
        key: "output.json",
        type: "STAGE_OUTPUT",
        data: { source: "workflow-b" },
        size: 100,
      });

      // When: I load artifacts
      const artifactA = await persistence.loadArtifact("run-a", "output.json");
      const artifactB = await persistence.loadArtifact("run-b", "output.json");

      // Then: Each workflow has its own artifact
      expect(artifactA).toEqual({ source: "workflow-a" });
      expect(artifactB).toEqual({ source: "workflow-b" });
    });
  });

  describe("concurrent workflow execution", () => {
    it("should execute multiple workflows in parallel", async () => {
      // Given: Two simple workflows
      const stage = createPassthroughStage("process", TestSchemas.string);

      const workflow = new WorkflowBuilder(
        "concurrent-test",
        "Concurrent Test",
        "Test",
        TestSchemas.string,
        TestSchemas.string,
      )
        .pipe(stage)
        .build();

      // Create runs
      await persistence.createRun({
        id: "run-1",
        workflowId: "concurrent-test",
        workflowName: "Concurrent Test",
        input: { value: "first" },
      });
      await persistence.createRun({
        id: "run-2",
        workflowId: "concurrent-test",
        workflowName: "Concurrent Test",
        input: { value: "second" },
      });

      // When: Execute both in parallel
      const executor1 = new WorkflowExecutor(
        workflow,
        "run-1",
        "concurrent-test",
        {
          persistence,
          aiLogger,
        },
      );
      const executor2 = new WorkflowExecutor(
        workflow,
        "run-2",
        "concurrent-test",
        {
          persistence,
          aiLogger,
        },
      );

      const [result1, result2] = await Promise.all([
        executor1.execute({ value: "first" }, {}),
        executor2.execute({ value: "second" }, {}),
      ]);

      // Then: Both complete successfully
      expect(result1).toEqual({ value: "first" });
      expect(result2).toEqual({ value: "second" });

      // And: Both runs are marked completed
      const run1 = await persistence.getRun("run-1");
      const run2 = await persistence.getRun("run-2");
      expect(run1?.status).toBe("COMPLETED");
      expect(run2?.status).toBe("COMPLETED");
    });

    it("should track execution order across concurrent workflows", async () => {
      // Given: A tracker for execution order
      const tracker = {
        executions: [] as Array<{
          stageId: string;
          input: unknown;
          timestamp: number;
        }>,
      };

      // Create workflows with tracking stages
      const stageA = createTrackingStage(
        "stage-a",
        TestSchemas.string,
        tracker,
        {
          delayMs: 50,
        },
      );
      const stageB = createTrackingStage(
        "stage-b",
        TestSchemas.string,
        tracker,
        {
          delayMs: 50,
        },
      );

      const workflowA = new WorkflowBuilder(
        "workflow-a",
        "Workflow A",
        "Test",
        TestSchemas.string,
        TestSchemas.string,
      )
        .pipe(stageA)
        .build();

      const workflowB = new WorkflowBuilder(
        "workflow-b",
        "Workflow B",
        "Test",
        TestSchemas.string,
        TestSchemas.string,
      )
        .pipe(stageB)
        .build();

      // Create runs
      await persistence.createRun({
        id: "run-a",
        workflowId: "workflow-a",
        workflowName: "Workflow A",
        input: { value: "a" },
      });
      await persistence.createRun({
        id: "run-b",
        workflowId: "workflow-b",
        workflowName: "Workflow B",
        input: { value: "b" },
      });

      // When: Execute both concurrently
      const executorA = new WorkflowExecutor(workflowA, "run-a", "workflow-a", {
        persistence,
        aiLogger,
      });
      const executorB = new WorkflowExecutor(workflowB, "run-b", "workflow-b", {
        persistence,
        aiLogger,
      });

      await Promise.all([
        executorA.execute({ value: "a" }, {}),
        executorB.execute({ value: "b" }, {}),
      ]);

      // Then: Both stages executed
      expect(tracker.executions).toHaveLength(2);

      const stageIds = tracker.executions.map((e) => e.stageId);
      expect(stageIds).toContain("stage-a");
      expect(stageIds).toContain("stage-b");
    });
  });

  describe("status filtering across workflows", () => {
    it("should filter runs by status across all workflows", async () => {
      // Given: Runs from different workflows in different states
      await persistence.createRun({
        id: "run-a-1",
        workflowId: "workflow-a",
        workflowName: "Workflow A",
        input: {},
      });
      await persistence.createRun({
        id: "run-a-2",
        workflowId: "workflow-a",
        workflowName: "Workflow A",
        input: {},
      });
      await persistence.createRun({
        id: "run-b-1",
        workflowId: "workflow-b",
        workflowName: "Workflow B",
        input: {},
      });

      await persistence.updateRun("run-a-1", { status: "RUNNING" });
      await persistence.updateRun("run-a-2", { status: "COMPLETED" });

      // When: I get runs by status
      const pendingRuns = await persistence.getRunsByStatus("PENDING");
      const runningRuns = await persistence.getRunsByStatus("RUNNING");
      const completedRuns = await persistence.getRunsByStatus("COMPLETED");

      // Then: Returns runs from all workflows matching the status
      expect(pendingRuns).toHaveLength(1);
      expect(pendingRuns[0]?.id).toBe("run-b-1");

      expect(runningRuns).toHaveLength(1);
      expect(runningRuns[0]?.id).toBe("run-a-1");

      expect(completedRuns).toHaveLength(1);
      expect(completedRuns[0]?.id).toBe("run-a-2");
    });
  });

  describe("error isolation", () => {
    it("should isolate failures between concurrent workflows", async () => {
      // Given: Two workflows - one will fail
      const successStage = createPassthroughStage(
        "success",
        TestSchemas.string,
      );

      const failStage = createPassthroughStage("fail", TestSchemas.string);
      // Override the execute to throw
      const originalExecute = failStage.execute;
      failStage.execute = async () => {
        throw new Error("Intentional failure");
      };

      const successWorkflow = new WorkflowBuilder(
        "success-workflow",
        "Success Workflow",
        "Test",
        TestSchemas.string,
        TestSchemas.string,
      )
        .pipe(successStage)
        .build();

      const failWorkflow = new WorkflowBuilder(
        "fail-workflow",
        "Fail Workflow",
        "Test",
        TestSchemas.string,
        TestSchemas.string,
      )
        .pipe(failStage)
        .build();

      // Create runs
      await persistence.createRun({
        id: "run-success",
        workflowId: "success-workflow",
        workflowName: "Success Workflow",
        input: { value: "success" },
      });
      await persistence.createRun({
        id: "run-fail",
        workflowId: "fail-workflow",
        workflowName: "Fail Workflow",
        input: { value: "fail" },
      });

      // When: Execute both
      const successExecutor = new WorkflowExecutor(
        successWorkflow,
        "run-success",
        "success-workflow",
        { persistence, aiLogger },
      );
      const failExecutor = new WorkflowExecutor(
        failWorkflow,
        "run-fail",
        "fail-workflow",
        { persistence, aiLogger },
      );

      // Execute and handle expected failure
      const results = await Promise.allSettled([
        successExecutor.execute({ value: "success" }, {}),
        failExecutor.execute({ value: "fail" }, {}),
      ]);

      // Then: Success workflow completed
      expect(results[0].status).toBe("fulfilled");
      if (results[0].status === "fulfilled") {
        expect(results[0].value).toEqual({ value: "success" });
      }

      // And: Fail workflow failed
      expect(results[1].status).toBe("rejected");

      // And: Persistence reflects the correct states
      const successRun = await persistence.getRun("run-success");
      const failRun = await persistence.getRun("run-fail");

      expect(successRun?.status).toBe("COMPLETED");
      expect(failRun?.status).toBe("FAILED");
    });
  });

  describe("job queue fairness", () => {
    it("should interleave jobs from multiple workflows fairly", async () => {
      // Given: Jobs from different workflows at same priority
      for (let i = 0; i < 3; i++) {
        await jobQueue.enqueue({
          workflowRunId: `workflow-a-run-${i}`,
          stageId: "stage-1",
          priority: 5,
        });
        await jobQueue.enqueue({
          workflowRunId: `workflow-b-run-${i}`,
          stageId: "stage-1",
          priority: 5,
        });
      }

      // When: I dequeue all
      const results: string[] = [];
      for (let i = 0; i < 6; i++) {
        const result = await jobQueue.dequeue();
        if (result) {
          results.push(result.workflowRunId);
          await jobQueue.complete(result.jobId);
        }
      }

      // Then: Jobs are interleaved in FIFO order (a,b,a,b,a,b)
      expect(results[0]).toBe("workflow-a-run-0");
      expect(results[1]).toBe("workflow-b-run-0");
      expect(results[2]).toBe("workflow-a-run-1");
      expect(results[3]).toBe("workflow-b-run-1");
      expect(results[4]).toBe("workflow-a-run-2");
      expect(results[5]).toBe("workflow-b-run-2");
    });
  });
});
