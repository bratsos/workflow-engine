/**
 * In-Memory Persistence Tests
 *
 * Tests for the InMemoryWorkflowPersistence utility.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { InMemoryWorkflowPersistence } from "../utils/in-memory-persistence.js";

describe("I want to use InMemoryWorkflowPersistence in tests", () => {
  let persistence: InMemoryWorkflowPersistence;

  beforeEach(() => {
    persistence = new InMemoryWorkflowPersistence();
  });

  describe("workflow run operations", () => {
    it("should create a workflow run", async () => {
      // Given: Run data
      const runData = {
        id: "run-1",
        workflowId: "workflow-1",
        workflowName: "Test Workflow",
        status: "PENDING" as const,
        input: { value: "test" },
      };

      // When: I create a run
      const run = await persistence.createRun(runData);

      // Then: Run is created with correct data
      expect(run.id).toBe("run-1");
      expect(run.workflowId).toBe("workflow-1");
      expect(run.workflowName).toBe("Test Workflow");
      expect(run.status).toBe("PENDING");
      expect(run.input).toEqual({ value: "test" });
      expect(run.createdAt).toBeInstanceOf(Date);
    });

    it("should generate ID if not provided", async () => {
      // Given: Run data without ID
      const runData = {
        workflowId: "workflow-1",
        workflowName: "Test Workflow",
        status: "PENDING" as const,
        input: {},
      };

      // When: I create a run
      const run = await persistence.createRun(runData);

      // Then: ID is generated
      expect(run.id).toBeDefined();
      expect(run.id.length).toBeGreaterThan(0);
    });

    it("should get a run by ID", async () => {
      // Given: An existing run
      await persistence.createRun({
        id: "run-get",
        workflowId: "workflow-1",
        workflowName: "Test",
        status: "PENDING" as const,
        input: { data: "test" },
      });

      // When: I get the run
      const run = await persistence.getRun("run-get");

      // Then: Returns the run
      expect(run).not.toBeNull();
      expect(run?.id).toBe("run-get");
      expect(run?.input).toEqual({ data: "test" });
    });

    it("should return null for non-existent run", async () => {
      // When: I get a non-existent run
      const run = await persistence.getRun("non-existent");

      // Then: Returns null
      expect(run).toBeNull();
    });

    it("should update a run", async () => {
      // Given: An existing run
      await persistence.createRun({
        id: "run-update",
        workflowId: "workflow-1",
        workflowName: "Test",
        status: "PENDING" as const,
        input: {},
      });

      // When: I update the run
      await persistence.updateRun("run-update", {
        status: "RUNNING",
        startedAt: new Date(),
      });

      // Then: Run is updated
      const run = await persistence.getRun("run-update");
      expect(run?.status).toBe("RUNNING");
      expect(run?.startedAt).toBeInstanceOf(Date);
    });

    it("should throw when updating non-existent run", async () => {
      // When/Then: Updating non-existent run throws
      await expect(
        persistence.updateRun("non-existent", { status: "RUNNING" }),
      ).rejects.toThrow(/not found/i);
    });

    it("should get run status", async () => {
      // Given: A run with specific status
      await persistence.createRun({
        id: "run-status",
        workflowId: "workflow-1",
        workflowName: "Test",
        status: "PENDING" as const,
        input: {},
      });

      await persistence.updateRun("run-status", { status: "COMPLETED" });

      // When: I get the status
      const status = await persistence.getRunStatus("run-status");

      // Then: Returns correct status
      expect(status).toBe("COMPLETED");
    });

    it("should get runs by status", async () => {
      // Given: Multiple runs with different statuses
      await persistence.createRun({
        id: "run-1",
        workflowId: "w1",
        workflowName: "Test",
        status: "PENDING" as const,
        input: {},
      });
      await persistence.createRun({
        id: "run-2",
        workflowId: "w2",
        workflowName: "Test",
        status: "PENDING" as const,
        input: {},
      });
      await persistence.createRun({
        id: "run-3",
        workflowId: "w3",
        workflowName: "Test",
        status: "PENDING" as const,
        input: {},
      });

      await persistence.updateRun("run-1", { status: "RUNNING" });
      await persistence.updateRun("run-2", { status: "COMPLETED" });

      // When: I get runs by status
      const pendingRuns = await persistence.getRunsByStatus("PENDING");
      const runningRuns = await persistence.getRunsByStatus("RUNNING");
      const completedRuns = await persistence.getRunsByStatus("COMPLETED");

      // Then: Returns correct runs
      expect(pendingRuns).toHaveLength(1);
      expect(runningRuns).toHaveLength(1);
      expect(completedRuns).toHaveLength(1);
      expect(runningRuns[0]?.id).toBe("run-1");
    });
  });

  describe("workflow stage operations", () => {
    it("should create a stage", async () => {
      // Given: Stage data
      const stageData = {
        workflowRunId: "run-1",
        stageId: "stage-1",
        stageName: "Stage One",
        stageNumber: 1,
        executionGroup: 1,
        status: "PENDING" as const,
      };

      // When: I create a stage
      const stage = await persistence.createStage(stageData);

      // Then: Stage is created
      expect(stage.stageId).toBe("stage-1");
      expect(stage.stageName).toBe("Stage One");
      expect(stage.status).toBe("PENDING");
      expect(stage.id).toBeDefined(); // UUID is generated
    });

    it("should upsert a stage (create)", async () => {
      // Given: Upsert data for new stage
      const upsertData = {
        workflowRunId: "run-1",
        stageId: "new-stage",
        create: {
          workflowRunId: "run-1",
          stageId: "new-stage",
          stageName: "New Stage",
          stageNumber: 1,
          executionGroup: 1,
          status: "RUNNING" as const,
        },
        update: {
          status: "COMPLETED" as const,
        },
      };

      // When: I upsert (creates because it doesn't exist)
      const stage = await persistence.upsertStage(upsertData);

      // Then: Stage is created with create data
      expect(stage.stageId).toBe("new-stage");
      expect(stage.status).toBe("RUNNING"); // Uses create data, not update
    });

    it("should upsert a stage (update)", async () => {
      // Given: An existing stage
      await persistence.createStage({
        workflowRunId: "run-1",
        stageId: "existing-stage",
        stageName: "Existing Stage",
        stageNumber: 1,
        executionGroup: 1,
        status: "PENDING" as const,
      });

      // When: I upsert (updates because it exists)
      const stage = await persistence.upsertStage({
        workflowRunId: "run-1",
        stageId: "existing-stage",
        create: {
          workflowRunId: "run-1",
          stageId: "existing-stage",
          stageName: "Existing Stage",
          stageNumber: 1,
          executionGroup: 1,
          status: "PENDING" as const,
        },
        update: {
          status: "RUNNING" as const,
        },
      });

      // Then: Stage is updated
      expect(stage.status).toBe("RUNNING");
    });

    it("should get stage by run and stage ID", async () => {
      // Given: A stage
      await persistence.createStage({
        workflowRunId: "run-1",
        stageId: "my-stage",
        stageName: "My Stage",
        stageNumber: 1,
        executionGroup: 1,
      });

      // When: I get the stage
      const stage = await persistence.getStage("run-1", "my-stage");

      // Then: Returns the stage
      expect(stage).not.toBeNull();
      expect(stage?.stageId).toBe("my-stage");
    });

    it("should get stages by run ID", async () => {
      // Given: Multiple stages for a run
      await persistence.createStage({
        workflowRunId: "run-1",
        stageId: "stage-a",
        stageName: "Stage A",
        stageNumber: 1,
        executionGroup: 1,
      });
      await persistence.createStage({
        workflowRunId: "run-1",
        stageId: "stage-b",
        stageName: "Stage B",
        stageNumber: 2,
        executionGroup: 2,
      });
      await persistence.createStage({
        workflowRunId: "run-2",
        stageId: "other-stage",
        stageName: "Other",
        stageNumber: 1,
        executionGroup: 1,
      });

      // When: I get stages by run
      const stages = await persistence.getStagesByRun("run-1", {});

      // Then: Returns only stages for that run
      const stageIds = [...new Set(stages.map((s) => s.stageId))];
      expect(stageIds).toHaveLength(2);
      expect(stageIds).toContain("stage-a");
      expect(stageIds).toContain("stage-b");
      expect(stageIds).not.toContain("other-stage");
    });

    it("should filter stages by status", async () => {
      // Given: Stages with different statuses
      const stage1 = await persistence.createStage({
        workflowRunId: "run-1",
        stageId: "stage-1",
        stageName: "Stage 1",
        stageNumber: 1,
        executionGroup: 1,
        status: "COMPLETED" as const,
      });
      await persistence.createStage({
        workflowRunId: "run-1",
        stageId: "stage-2",
        stageName: "Stage 2",
        stageNumber: 2,
        executionGroup: 2,
        status: "PENDING" as const,
      });

      await persistence.updateStage(stage1.id, { status: "COMPLETED" });

      // When: I get completed stages
      const completed = await persistence.getStagesByRun("run-1", {
        status: "COMPLETED",
      });

      // Then: Returns only completed stages
      const stageIds = [...new Set(completed.map((s) => s.stageId))];
      expect(stageIds).toContain("stage-1");
    });

    it("should order stages by stageNumber", async () => {
      // Given: Stages in random order
      await persistence.createStage({
        workflowRunId: "run-1",
        stageId: "stage-3",
        stageName: "Stage 3",
        stageNumber: 3,
        executionGroup: 3,
      });
      await persistence.createStage({
        workflowRunId: "run-1",
        stageId: "stage-1",
        stageName: "Stage 1",
        stageNumber: 1,
        executionGroup: 1,
      });
      await persistence.createStage({
        workflowRunId: "run-1",
        stageId: "stage-2",
        stageName: "Stage 2",
        stageNumber: 2,
        executionGroup: 2,
      });

      // When: I get stages (default ascending)
      const stagesAsc = await persistence.getStagesByRun("run-1", {
        orderBy: "asc",
      });
      const stagesDesc = await persistence.getStagesByRun("run-1", {
        orderBy: "desc",
      });

      // Get unique stage IDs in order
      const ascIds = [...new Map(stagesAsc.map((s) => [s.stageId, s])).keys()];
      const descIds = [
        ...new Map(stagesDesc.map((s) => [s.stageId, s])).keys(),
      ];

      // Then: Stages are ordered correctly
      expect(ascIds).toEqual(["stage-1", "stage-2", "stage-3"]);
      expect(descIds).toEqual(["stage-3", "stage-2", "stage-1"]);
    });

    it("should update stage by run and stage ID", async () => {
      // Given: A stage
      await persistence.createStage({
        workflowRunId: "run-1",
        stageId: "update-me",
        stageName: "Update Me",
        stageNumber: 1,
        executionGroup: 1,
        status: "PENDING" as const,
      });

      // When: I update by run/stage ID
      await persistence.updateStageByRunAndStageId("run-1", "update-me", {
        status: "COMPLETED",
        completedAt: new Date(),
      });

      // Then: Stage is updated
      const stage = await persistence.getStage("run-1", "update-me");
      expect(stage?.status).toBe("COMPLETED");
      expect(stage?.completedAt).toBeInstanceOf(Date);
    });

    it("should delete a stage", async () => {
      // Given: A stage
      const stage = await persistence.createStage({
        workflowRunId: "run-1",
        stageId: "delete-me",
        stageName: "Delete Me",
        stageNumber: 1,
        executionGroup: 1,
      });

      // When: I delete the stage
      await persistence.deleteStage(stage.id);

      // Then: Stage no longer exists
      const deleted = await persistence.getStage("run-1", "delete-me");
      expect(deleted).toBeNull();
    });

    it("should get suspended stages ready to resume", async () => {
      // Given: Suspended stages with different poll times
      const now = new Date();
      const past = new Date(now.getTime() - 10000);
      const future = new Date(now.getTime() + 10000);

      const stage1 = await persistence.createStage({
        workflowRunId: "run-1",
        stageId: "ready",
        stageName: "Ready",
        stageNumber: 1,
        executionGroup: 1,
        status: "SUSPENDED" as const,
      });
      await persistence.updateStage(stage1.id, {
        status: "SUSPENDED",
        nextPollAt: past,
        suspendedState: { batchId: "batch-1" },
      });

      const stage2 = await persistence.createStage({
        workflowRunId: "run-1",
        stageId: "not-ready",
        stageName: "Not Ready",
        stageNumber: 2,
        executionGroup: 2,
        status: "SUSPENDED" as const,
      });
      await persistence.updateStage(stage2.id, {
        status: "SUSPENDED",
        nextPollAt: future,
        suspendedState: { batchId: "batch-2" },
      });

      // When: I get first suspended stage ready to resume
      const ready =
        await persistence.getFirstSuspendedStageReadyToResume("run-1");

      // Then: Returns only the ready stage
      expect(ready).not.toBeNull();
      expect(ready?.stageId).toBe("ready");
    });

    it("should get last completed stage before execution group", async () => {
      // Given: Multiple completed stages
      const stage1 = await persistence.createStage({
        workflowRunId: "run-1",
        stageId: "stage-1",
        stageName: "Stage 1",
        stageNumber: 1,
        executionGroup: 1,
        status: "COMPLETED" as const,
      });
      await persistence.updateStage(stage1.id, { status: "COMPLETED" });

      const stage2 = await persistence.createStage({
        workflowRunId: "run-1",
        stageId: "stage-2",
        stageName: "Stage 2",
        stageNumber: 2,
        executionGroup: 2,
        status: "COMPLETED" as const,
      });
      await persistence.updateStage(stage2.id, { status: "COMPLETED" });

      const stage3 = await persistence.createStage({
        workflowRunId: "run-1",
        stageId: "stage-3",
        stageName: "Stage 3",
        stageNumber: 3,
        executionGroup: 3,
        status: "FAILED" as const,
      });
      await persistence.updateStage(stage3.id, { status: "FAILED" });

      // When: I get last completed before group 3
      const lastCompleted = await persistence.getLastCompletedStageBefore(
        "run-1",
        3,
      );

      // Then: Returns stage-2
      expect(lastCompleted).not.toBeNull();
      expect(lastCompleted?.stageId).toBe("stage-2");
    });
  });

  describe("artifact operations", () => {
    it("should save and load an artifact", async () => {
      // Given: Artifact data
      const artifactData = {
        workflowRunId: "run-1",
        key: "output.json",
        type: "STAGE_OUTPUT" as const,
        data: { result: "test data" },
        size: 100,
      };

      // When: I save and load the artifact
      await persistence.saveArtifact(artifactData);
      const loaded = await persistence.loadArtifact("run-1", "output.json");

      // Then: Returns the artifact data
      expect(loaded).toEqual({ result: "test data" });
    });

    it("should check if artifact exists", async () => {
      // Given: An artifact
      await persistence.saveArtifact({
        workflowRunId: "run-1",
        key: "exists.json",
        type: "ARTIFACT" as const,
        data: {},
        size: 10,
      });

      // When: I check existence
      const exists = await persistence.hasArtifact("run-1", "exists.json");
      const notExists = await persistence.hasArtifact(
        "run-1",
        "not-exists.json",
      );

      // Then: Returns correct result
      expect(exists).toBe(true);
      expect(notExists).toBe(false);
    });

    it("should delete an artifact", async () => {
      // Given: An artifact
      await persistence.saveArtifact({
        workflowRunId: "run-1",
        key: "delete-me.json",
        type: "ARTIFACT" as const,
        data: { delete: true },
        size: 20,
      });

      // When: I delete and check
      await persistence.deleteArtifact("run-1", "delete-me.json");
      const exists = await persistence.hasArtifact("run-1", "delete-me.json");

      // Then: Artifact no longer exists
      expect(exists).toBe(false);
    });

    it("should list artifacts for a run", async () => {
      // Given: Multiple artifacts
      await persistence.saveArtifact({
        workflowRunId: "run-1",
        key: "artifact-1.json",
        type: "ARTIFACT" as const,
        data: {},
        size: 10,
      });
      await persistence.saveArtifact({
        workflowRunId: "run-1",
        key: "artifact-2.json",
        type: "ARTIFACT" as const,
        data: {},
        size: 20,
      });
      await persistence.saveArtifact({
        workflowRunId: "run-2",
        key: "other.json",
        type: "ARTIFACT" as const,
        data: {},
        size: 30,
      });

      // When: I list artifacts
      const artifacts = await persistence.listArtifacts("run-1");

      // Then: Returns only artifacts for that run
      expect(artifacts).toHaveLength(2);
      const keys = artifacts.map((a) => a.key);
      expect(keys).toContain("artifact-1.json");
      expect(keys).toContain("artifact-2.json");
    });

    it("should save stage output with key generation", async () => {
      // Given: A stage exists
      await persistence.createStage({
        workflowRunId: "run-1",
        stageId: "output-stage",
        stageName: "Output Stage",
        stageNumber: 1,
        executionGroup: 1,
      });

      // When: I save stage output
      const key = await persistence.saveStageOutput(
        "run-1",
        "my-workflow",
        "output-stage",
        { processed: true },
      );

      // Then: Key is generated and artifact is stored
      expect(key).toContain("output-stage");
      expect(key).toContain("output.json");

      const loaded = await persistence.loadArtifact("run-1", key);
      expect(loaded).toEqual({ processed: true });
    });
  });

  describe("log operations", () => {
    it("should create a log", async () => {
      // Given: Log data
      const logData = {
        workflowRunId: "run-1",
        level: "INFO" as const,
        message: "Test log message",
        metadata: { key: "value" },
      };

      // When: I create a log (fire and forget)
      await persistence.createLog(logData);

      // Then: Log is stored
      const logs = persistence.getAllLogs();
      expect(logs.length).toBeGreaterThan(0);

      const testLog = logs.find((l) => l.message === "Test log message");
      expect(testLog).toBeDefined();
      expect(testLog?.level).toBe("INFO");
      expect(testLog?.metadata).toEqual({ key: "value" });
    });

    it("should create log with stage ID", async () => {
      // Given: A stage
      const stage = await persistence.createStage({
        workflowRunId: "run-1",
        stageId: "log-stage",
        stageName: "Log Stage",
        stageNumber: 1,
        executionGroup: 1,
      });

      // When: I create a log with stage ID
      await persistence.createLog({
        workflowRunId: "run-1",
        workflowStageId: stage.id,
        level: "DEBUG" as const,
        message: "Stage debug message",
      });

      // Then: Log has stage ID
      const logs = persistence.getAllLogs();
      const stageLog = logs.find((l) => l.message === "Stage debug message");
      expect(stageLog?.workflowStageId).toBe(stage.id);
    });
  });

  describe("test helpers", () => {
    it("should clear all data", async () => {
      // Given: Some data exists
      await persistence.createRun({
        id: "run-1",
        workflowId: "w1",
        workflowName: "Test",
        status: "PENDING" as const,
        input: {},
      });
      await persistence.createStage({
        workflowRunId: "run-1",
        stageId: "stage-1",
        stageName: "Stage",
        stageNumber: 1,
        executionGroup: 1,
      });
      await persistence.saveArtifact({
        workflowRunId: "run-1",
        key: "test.json",
        type: "ARTIFACT" as const,
        data: {},
        size: 10,
      });
      await persistence.createLog({
        workflowRunId: "run-1",
        level: "INFO" as const,
        message: "test",
      });

      // When: I clear all data
      persistence.clear();

      // Then: All data is gone
      expect(persistence.getAllRuns()).toHaveLength(0);
      expect(persistence.getAllStages()).toHaveLength(0);
      expect(persistence.getAllArtifacts()).toHaveLength(0);
      expect(persistence.getAllLogs()).toHaveLength(0);
    });

    it("should get all runs for inspection", async () => {
      // Given: Multiple runs
      await persistence.createRun({
        id: "run-a",
        workflowId: "w1",
        workflowName: "A",
        status: "PENDING" as const,
        input: {},
      });
      await persistence.createRun({
        id: "run-b",
        workflowId: "w2",
        workflowName: "B",
        status: "PENDING" as const,
        input: {},
      });

      // When: I get all runs
      const runs = persistence.getAllRuns();

      // Then: Returns all runs
      expect(runs).toHaveLength(2);
    });

    it("should get all stages for inspection", async () => {
      // Given: Stages
      await persistence.createStage({
        workflowRunId: "run-1",
        stageId: "stage-1",
        stageName: "Stage 1",
        stageNumber: 1,
        executionGroup: 1,
      });
      await persistence.createStage({
        workflowRunId: "run-1",
        stageId: "stage-2",
        stageName: "Stage 2",
        stageNumber: 2,
        executionGroup: 2,
      });

      // When: I get all stages
      const stages = persistence.getAllStages();

      // Then: Returns stages (may include duplicates due to indexing)
      // Use unique stageIds to verify both stages exist
      const uniqueStageIds = new Set(stages.map((s) => s.stageId));
      expect(uniqueStageIds.size).toBe(2);
      expect(uniqueStageIds.has("stage-1")).toBe(true);
      expect(uniqueStageIds.has("stage-2")).toBe(true);
    });
  });
});
