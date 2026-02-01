/**
 * Adapter Conformance Tests
 *
 * These tests verify that any implementation of the persistence interfaces
 * follows the expected contract. They can be run against any adapter.
 *
 * Currently tests:
 * - WorkflowPersistence interface
 * - AICallLogger interface
 * - JobQueue interface
 */

import { describe, it, expect, beforeEach } from "vitest";
import { InMemoryWorkflowPersistence } from "../utils/in-memory-persistence.js";
import { InMemoryAICallLogger } from "../utils/in-memory-ai-logger.js";
import { InMemoryJobQueue } from "../utils/in-memory-job-queue.js";
import type {
  WorkflowPersistence,
  AICallLogger,
  JobQueue,
  CreateRunInput,
  CreateStageInput,
  CreateAICallInput,
  EnqueueJobInput,
} from "../../persistence/interface.js";

// ============================================================================
// Test Suite Factory Types
// ============================================================================

type PersistenceFactory = () => WorkflowPersistence & { clear?: () => void };
type AILoggerFactory = () => AICallLogger & { clear?: () => void };
type JobQueueFactory = () => JobQueue & { clear?: () => void };

// ============================================================================
// WorkflowPersistence Conformance Tests
// ============================================================================

function createPersistenceConformanceTests(
  name: string,
  factory: PersistenceFactory,
) {
  describe(`I want ${name} to conform to WorkflowPersistence interface`, () => {
    let persistence: ReturnType<PersistenceFactory>;

    beforeEach(() => {
      persistence = factory();
      persistence.clear?.();
    });

    // Helper functions
    function createRunData(
      overrides: Partial<CreateRunInput> = {},
    ): CreateRunInput {
      return {
        workflowId: `workflow-${Date.now()}`,
        workflowName: "Test Workflow",
        workflowType: "test-workflow",
        input: { value: "test" },
        ...overrides,
      };
    }

    function createStageData(
      overrides: Partial<CreateStageInput> = {},
    ): CreateStageInput {
      return {
        workflowRunId: "run-1",
        stageId: `stage-${Date.now()}`,
        stageName: "Test Stage",
        stageNumber: 1,
        executionGroup: 1,
        ...overrides,
      };
    }

    describe("workflow run CRUD operations", () => {
      it("should create a run and return it with all required fields", async () => {
        // Given: Valid run data
        const data = createRunData({ id: "conformance-run-1" });

        // When: Creating a run
        const run = await persistence.createRun(data);

        // Then: Run has all required fields from WorkflowRunRecord
        expect(run.id).toBe("conformance-run-1");
        expect(run.workflowId).toBe(data.workflowId);
        expect(run.workflowName).toBe(data.workflowName);
        expect(run.workflowType).toBe(data.workflowType);
        expect(run.input).toEqual(data.input);
        expect(run.status).toBeDefined();
        expect(run.createdAt).toBeInstanceOf(Date);
        expect(run.updatedAt).toBeInstanceOf(Date);
      });

      it("should generate an ID when not provided", async () => {
        // Given: Run data without ID
        const data = createRunData();

        // When: Creating a run
        const run = await persistence.createRun(data);

        // Then: ID is auto-generated
        expect(run.id).toBeDefined();
        expect(run.id.length).toBeGreaterThan(0);
      });

      it("should retrieve a run by ID", async () => {
        // Given: An existing run
        const created = await persistence.createRun(
          createRunData({ id: "get-run-test" }),
        );

        // When: Retrieving by ID
        const retrieved = await persistence.getRun(created.id);

        // Then: Returns the same run
        expect(retrieved).not.toBeNull();
        expect(retrieved?.id).toBe(created.id);
        expect(retrieved?.workflowName).toBe(created.workflowName);
      });

      it("should return null for non-existent run", async () => {
        // When: Getting a non-existent run
        const result = await persistence.getRun("non-existent-id-12345");

        // Then: Returns null
        expect(result).toBeNull();
      });

      it("should update a run", async () => {
        // Given: An existing run
        const run = await persistence.createRun(
          createRunData({ id: "update-run-test" }),
        );

        // When: Updating the run
        const startTime = new Date();
        await persistence.updateRun(run.id, {
          status: "RUNNING",
          startedAt: startTime,
        });

        // Then: Run reflects updates
        const updated = await persistence.getRun(run.id);
        expect(updated?.status).toBe("RUNNING");
        expect(updated?.startedAt).toEqual(startTime);
      });

      it("should throw when updating non-existent run", async () => {
        // When/Then: Updating non-existent run throws
        await expect(
          persistence.updateRun("non-existent-run", { status: "RUNNING" }),
        ).rejects.toThrow();
      });

      it("should get run status", async () => {
        // Given: A run with specific status
        const run = await persistence.createRun(
          createRunData({ id: "status-test-run" }),
        );
        await persistence.updateRun(run.id, { status: "COMPLETED" });

        // When: Getting status
        const status = await persistence.getRunStatus(run.id);

        // Then: Returns correct status
        expect(status).toBe("COMPLETED");
      });

      it("should return null status for non-existent run", async () => {
        // When: Getting status of non-existent run
        const status = await persistence.getRunStatus("non-existent");

        // Then: Returns null
        expect(status).toBeNull();
      });

      it("should get runs by status", async () => {
        // Given: Runs with different statuses
        const run1 = await persistence.createRun(
          createRunData({ id: "status-run-1" }),
        );
        const run2 = await persistence.createRun(
          createRunData({ id: "status-run-2" }),
        );
        const run3 = await persistence.createRun(
          createRunData({ id: "status-run-3" }),
        );

        await persistence.updateRun(run1.id, { status: "RUNNING" });
        await persistence.updateRun(run2.id, { status: "COMPLETED" });
        // run3 stays PENDING

        // When: Getting runs by status
        const running = await persistence.getRunsByStatus("RUNNING");
        const completed = await persistence.getRunsByStatus("COMPLETED");

        // Then: Returns correct runs
        expect(running.some((r) => r.id === run1.id)).toBe(true);
        expect(completed.some((r) => r.id === run2.id)).toBe(true);
      });
    });

    describe("workflow stage CRUD operations", () => {
      it("should create a stage with all required fields", async () => {
        // Given: Valid stage data
        const data = createStageData({ stageId: "create-stage-test" });

        // When: Creating a stage
        const stage = await persistence.createStage(data);

        // Then: Stage has all required fields
        expect(stage.id).toBeDefined();
        expect(stage.workflowRunId).toBe(data.workflowRunId);
        expect(stage.stageId).toBe(data.stageId);
        expect(stage.stageName).toBe(data.stageName);
        expect(stage.stageNumber).toBe(data.stageNumber);
        expect(stage.executionGroup).toBe(data.executionGroup);
        expect(stage.createdAt).toBeInstanceOf(Date);
      });

      it("should retrieve a stage by run ID and stage ID", async () => {
        // Given: An existing stage
        const data = createStageData({
          workflowRunId: "stage-get-run",
          stageId: "stage-get-test",
        });
        await persistence.createStage(data);

        // When: Getting the stage
        const stage = await persistence.getStage(
          "stage-get-run",
          "stage-get-test",
        );

        // Then: Returns the stage
        expect(stage).not.toBeNull();
        expect(stage?.stageId).toBe("stage-get-test");
      });

      it("should return null for non-existent stage", async () => {
        // When: Getting non-existent stage
        const stage = await persistence.getStage("no-run", "no-stage");

        // Then: Returns null
        expect(stage).toBeNull();
      });

      it("should retrieve a stage by its database ID", async () => {
        // Given: An existing stage
        const created = await persistence.createStage(
          createStageData({ stageId: "stage-by-id-test" }),
        );

        // When: Getting by database ID
        const stage = await persistence.getStageById(created.id);

        // Then: Returns the stage
        expect(stage).not.toBeNull();
        expect(stage?.id).toBe(created.id);
      });

      it("should update a stage by database ID", async () => {
        // Given: An existing stage
        const created = await persistence.createStage(
          createStageData({ stageId: "update-stage-test" }),
        );

        // When: Updating the stage
        await persistence.updateStage(created.id, {
          status: "RUNNING",
          startedAt: new Date(),
        });

        // Then: Stage reflects updates
        const updated = await persistence.getStageById(created.id);
        expect(updated?.status).toBe("RUNNING");
        expect(updated?.startedAt).toBeInstanceOf(Date);
      });

      it("should update a stage by run ID and stage ID", async () => {
        // Given: An existing stage
        await persistence.createStage(
          createStageData({
            workflowRunId: "update-by-ids-run",
            stageId: "update-by-ids-stage",
          }),
        );

        // When: Updating by run/stage IDs
        await persistence.updateStageByRunAndStageId(
          "update-by-ids-run",
          "update-by-ids-stage",
          { status: "COMPLETED" },
        );

        // Then: Stage is updated
        const stage = await persistence.getStage(
          "update-by-ids-run",
          "update-by-ids-stage",
        );
        expect(stage?.status).toBe("COMPLETED");
      });

      it("should upsert a stage - create when not exists", async () => {
        // Given: Upsert data for new stage
        const result = await persistence.upsertStage({
          workflowRunId: "upsert-run",
          stageId: "upsert-create-stage",
          create: {
            workflowRunId: "upsert-run",
            stageId: "upsert-create-stage",
            stageName: "Upsert Create",
            stageNumber: 1,
            executionGroup: 1,
            status: "PENDING",
          },
          update: {
            status: "RUNNING",
          },
        });

        // Then: Stage is created (uses create data)
        expect(result.stageId).toBe("upsert-create-stage");
        expect(result.status).toBe("PENDING");
      });

      it("should upsert a stage - update when exists", async () => {
        // Given: An existing stage
        await persistence.createStage(
          createStageData({
            workflowRunId: "upsert-update-run",
            stageId: "upsert-update-stage",
            status: "PENDING",
          }),
        );

        // When: Upserting
        const result = await persistence.upsertStage({
          workflowRunId: "upsert-update-run",
          stageId: "upsert-update-stage",
          create: {
            workflowRunId: "upsert-update-run",
            stageId: "upsert-update-stage",
            stageName: "Ignored",
            stageNumber: 1,
            executionGroup: 1,
            status: "PENDING",
          },
          update: {
            status: "RUNNING",
          },
        });

        // Then: Stage is updated (uses update data)
        expect(result.status).toBe("RUNNING");
      });

      it("should get stages by run ID", async () => {
        // Given: Multiple stages for a run
        const runId = "stages-by-run-test";
        await persistence.createStage(
          createStageData({
            workflowRunId: runId,
            stageId: "stage-a",
            stageNumber: 1,
          }),
        );
        await persistence.createStage(
          createStageData({
            workflowRunId: runId,
            stageId: "stage-b",
            stageNumber: 2,
          }),
        );
        await persistence.createStage(
          createStageData({
            workflowRunId: "other-run",
            stageId: "stage-c",
            stageNumber: 1,
          }),
        );

        // When: Getting stages for the run
        const stages = await persistence.getStagesByRun(runId, {});

        // Then: Returns only stages for that run
        expect(stages.length).toBeGreaterThanOrEqual(2);
        const stageIds = stages.map((s) => s.stageId);
        expect(stageIds).toContain("stage-a");
        expect(stageIds).toContain("stage-b");
        expect(stageIds).not.toContain("stage-c");
      });

      it("should filter stages by status", async () => {
        // Given: Stages with different statuses
        const runId = "filter-status-run";
        const stage1 = await persistence.createStage(
          createStageData({
            workflowRunId: runId,
            stageId: "completed-stage",
            stageNumber: 1,
            status: "COMPLETED",
          }),
        );
        await persistence.createStage(
          createStageData({
            workflowRunId: runId,
            stageId: "pending-stage",
            stageNumber: 2,
            status: "PENDING",
          }),
        );

        // Ensure the status is set correctly
        await persistence.updateStage(stage1.id, { status: "COMPLETED" });

        // When: Filtering by status
        const completed = await persistence.getStagesByRun(runId, {
          status: "COMPLETED",
        });

        // Then: Returns only matching stages
        expect(completed.some((s) => s.stageId === "completed-stage")).toBe(
          true,
        );
      });

      it("should order stages by stageNumber", async () => {
        // Given: Stages in random order
        const runId = `order-stages-run-${Date.now()}`;
        await persistence.createStage(
          createStageData({
            workflowRunId: runId,
            stageId: "third",
            stageName: "Third",
            stageNumber: 3,
            executionGroup: 3,
          }),
        );
        await persistence.createStage(
          createStageData({
            workflowRunId: runId,
            stageId: "first",
            stageName: "First",
            stageNumber: 1,
            executionGroup: 1,
          }),
        );
        await persistence.createStage(
          createStageData({
            workflowRunId: runId,
            stageId: "second",
            stageName: "Second",
            stageNumber: 2,
            executionGroup: 2,
          }),
        );

        // When: Getting stages with ordering
        const stagesAsc = await persistence.getStagesByRun(runId, {
          orderBy: "asc",
        });
        const stagesDesc = await persistence.getStagesByRun(runId, {
          orderBy: "desc",
        });

        // Get unique stage IDs in order (preserving order)
        const ascIds = [
          ...new Map(stagesAsc.map((s) => [s.stageId, s])).keys(),
        ];
        const descIds = [
          ...new Map(stagesDesc.map((s) => [s.stageId, s])).keys(),
        ];

        // Then: Stages are ordered correctly
        expect(ascIds).toEqual(["first", "second", "third"]);
        expect(descIds).toEqual(["third", "second", "first"]);
      });

      it("should delete a stage", async () => {
        // Given: An existing stage
        const stage = await persistence.createStage(
          createStageData({
            workflowRunId: "delete-stage-run",
            stageId: "delete-me",
          }),
        );

        // When: Deleting the stage
        await persistence.deleteStage(stage.id);

        // Then: Stage no longer exists
        const deleted = await persistence.getStage(
          "delete-stage-run",
          "delete-me",
        );
        expect(deleted).toBeNull();
      });

      it("should get first suspended stage ready to resume", async () => {
        // Given: Suspended stages with different poll times
        const runId = "suspended-ready-run";
        const past = new Date(Date.now() - 10000);
        const future = new Date(Date.now() + 10000);

        const readyStage = await persistence.createStage(
          createStageData({
            workflowRunId: runId,
            stageId: "ready-stage",
            stageNumber: 1,
            status: "SUSPENDED",
          }),
        );
        await persistence.updateStage(readyStage.id, {
          status: "SUSPENDED",
          nextPollAt: past,
          suspendedState: { batchId: "batch-1" },
        });

        const notReadyStage = await persistence.createStage(
          createStageData({
            workflowRunId: runId,
            stageId: "not-ready-stage",
            stageNumber: 2,
            status: "SUSPENDED",
          }),
        );
        await persistence.updateStage(notReadyStage.id, {
          status: "SUSPENDED",
          nextPollAt: future,
          suspendedState: { batchId: "batch-2" },
        });

        // When: Getting first suspended stage ready to resume
        const ready =
          await persistence.getFirstSuspendedStageReadyToResume(runId);

        // Then: Returns the ready stage
        expect(ready).not.toBeNull();
        expect(ready?.stageId).toBe("ready-stage");
      });

      it("should get first failed stage", async () => {
        // Given: A failed stage
        const runId = "failed-stage-run";
        const stage = await persistence.createStage(
          createStageData({
            workflowRunId: runId,
            stageId: "failed-stage",
            status: "FAILED",
          }),
        );
        await persistence.updateStage(stage.id, {
          status: "FAILED",
          errorMessage: "Something went wrong",
        });

        // When: Getting first failed stage
        const failed = await persistence.getFirstFailedStage(runId);

        // Then: Returns the failed stage
        expect(failed).not.toBeNull();
        expect(failed?.stageId).toBe("failed-stage");
      });

      it("should get last completed stage", async () => {
        // Given: Multiple completed stages
        const runId = "last-completed-run";
        const stage1 = await persistence.createStage(
          createStageData({
            workflowRunId: runId,
            stageId: "completed-1",
            stageNumber: 1,
            status: "COMPLETED",
          }),
        );
        const stage2 = await persistence.createStage(
          createStageData({
            workflowRunId: runId,
            stageId: "completed-2",
            stageNumber: 2,
            status: "COMPLETED",
          }),
        );

        await persistence.updateStage(stage1.id, { status: "COMPLETED" });
        await persistence.updateStage(stage2.id, { status: "COMPLETED" });

        // When: Getting last completed stage
        const last = await persistence.getLastCompletedStage(runId);

        // Then: Returns the highest stage number completed
        expect(last).not.toBeNull();
        expect(last?.stageId).toBe("completed-2");
      });

      it("should get last completed stage before execution group", async () => {
        // Given: Completed stages in different execution groups
        const runId = "completed-before-run";
        const stage1 = await persistence.createStage(
          createStageData({
            workflowRunId: runId,
            stageId: "group-1-stage",
            stageNumber: 1,
            executionGroup: 1,
            status: "COMPLETED",
          }),
        );
        const stage2 = await persistence.createStage(
          createStageData({
            workflowRunId: runId,
            stageId: "group-2-stage",
            stageNumber: 2,
            executionGroup: 2,
            status: "COMPLETED",
          }),
        );

        await persistence.updateStage(stage1.id, { status: "COMPLETED" });
        await persistence.updateStage(stage2.id, { status: "COMPLETED" });

        // When: Getting last completed before group 2
        const lastBefore = await persistence.getLastCompletedStageBefore(
          runId,
          2,
        );

        // Then: Returns group 1 stage
        expect(lastBefore).not.toBeNull();
        expect(lastBefore?.executionGroup).toBe(1);
      });
    });

    describe("artifact operations", () => {
      it("should save and load an artifact", async () => {
        // Given: Artifact data
        const runId = "artifact-run";
        const key = "test-artifact.json";
        const data = { result: "test data", count: 42 };

        // When: Saving and loading
        await persistence.saveArtifact({
          workflowRunId: runId,
          key,
          type: "ARTIFACT",
          data,
          size: JSON.stringify(data).length,
        });
        const loaded = await persistence.loadArtifact(runId, key);

        // Then: Data is preserved
        expect(loaded).toEqual(data);
      });

      it("should check if artifact exists", async () => {
        // Given: An artifact
        const runId = "exists-run";
        await persistence.saveArtifact({
          workflowRunId: runId,
          key: "exists.json",
          type: "ARTIFACT",
          data: {},
          size: 2,
        });

        // When: Checking existence
        const exists = await persistence.hasArtifact(runId, "exists.json");
        const notExists = await persistence.hasArtifact(
          runId,
          "not-exists.json",
        );

        // Then: Returns correct result
        expect(exists).toBe(true);
        expect(notExists).toBe(false);
      });

      it("should delete an artifact", async () => {
        // Given: An artifact
        const runId = "delete-artifact-run";
        await persistence.saveArtifact({
          workflowRunId: runId,
          key: "delete-me.json",
          type: "ARTIFACT",
          data: { delete: true },
          size: 15,
        });

        // When: Deleting
        await persistence.deleteArtifact(runId, "delete-me.json");

        // Then: Artifact no longer exists
        const exists = await persistence.hasArtifact(runId, "delete-me.json");
        expect(exists).toBe(false);
      });

      it("should list artifacts for a run", async () => {
        // Given: Multiple artifacts
        const runId = "list-artifacts-run";
        await persistence.saveArtifact({
          workflowRunId: runId,
          key: "artifact-1.json",
          type: "ARTIFACT",
          data: {},
          size: 2,
        });
        await persistence.saveArtifact({
          workflowRunId: runId,
          key: "artifact-2.json",
          type: "ARTIFACT",
          data: {},
          size: 2,
        });
        await persistence.saveArtifact({
          workflowRunId: "other-run",
          key: "other.json",
          type: "ARTIFACT",
          data: {},
          size: 2,
        });

        // When: Listing artifacts
        const artifacts = await persistence.listArtifacts(runId);

        // Then: Returns only artifacts for that run
        expect(artifacts.length).toBe(2);
        const keys = artifacts.map((a) => a.key);
        expect(keys).toContain("artifact-1.json");
        expect(keys).toContain("artifact-2.json");
        expect(keys).not.toContain("other.json");
      });

      it("should save stage output with generated key", async () => {
        // Given: A stage exists
        const runId = "stage-output-run";
        const stageId = "output-stage";
        await persistence.createStage(
          createStageData({
            workflowRunId: runId,
            stageId,
          }),
        );

        // When: Saving stage output
        const key = await persistence.saveStageOutput(
          runId,
          "test-workflow",
          stageId,
          { processed: true },
        );

        // Then: Key is generated and data is stored
        expect(key).toContain(stageId);
        expect(key).toContain("output.json");

        const loaded = await persistence.loadArtifact(runId, key);
        expect(loaded).toEqual({ processed: true });
      });
    });

    describe("log operations", () => {
      it("should create a log without throwing", async () => {
        // Given: Log data
        // When: Creating a log
        // Then: No error is thrown
        await expect(
          persistence.createLog({
            workflowRunId: "log-run",
            level: "INFO",
            message: "Test log message",
            metadata: { key: "value" },
          }),
        ).resolves.not.toThrow();
      });

      it("should support all log levels", async () => {
        // Given/When: Creating logs with different levels
        // Then: No errors are thrown
        const levels = ["DEBUG", "INFO", "WARN", "ERROR"] as const;
        for (const level of levels) {
          await expect(
            persistence.createLog({
              workflowRunId: "log-levels-run",
              level,
              message: `${level} message`,
            }),
          ).resolves.not.toThrow();
        }
      });
    });
  });
}

// ============================================================================
// AICallLogger Conformance Tests
// ============================================================================

function createAILoggerConformanceTests(
  name: string,
  factory: AILoggerFactory,
) {
  describe(`I want ${name} to conform to AICallLogger interface`, () => {
    let logger: ReturnType<AILoggerFactory>;

    beforeEach(() => {
      logger = factory();
      logger.clear?.();
    });

    function createCallInput(
      overrides: Partial<CreateAICallInput> = {},
    ): CreateAICallInput {
      return {
        topic: "workflow.test",
        callType: "text",
        modelKey: "test-model",
        modelId: "test-model-v1",
        prompt: "Test prompt",
        response: "Test response",
        inputTokens: 100,
        outputTokens: 50,
        cost: 0.001,
        ...overrides,
      };
    }

    describe("logCall operation", () => {
      it("should log a call without throwing", () => {
        // Given: Call data
        // When: Logging
        // Then: No error is thrown
        expect(() => logger.logCall(createCallInput())).not.toThrow();
      });

      it("should accept all required call properties", () => {
        // Given: Complete call data
        const input = createCallInput({
          topic: "workflow.complete.test",
          callType: "object",
          modelKey: "gemini-2.5-pro",
          modelId: "gemini-2.5-pro-latest",
          prompt: "Generate JSON",
          response: '{"key": "value"}',
          inputTokens: 200,
          outputTokens: 100,
          cost: 0.005,
          metadata: { schemaName: "TestSchema" },
        });

        // When/Then: Logging completes without error
        expect(() => logger.logCall(input)).not.toThrow();
      });
    });

    describe("logBatchResults operation", () => {
      it("should log batch results", async () => {
        // Given: Batch results
        const results = [
          createCallInput({ prompt: "Batch 1" }),
          createCallInput({ prompt: "Batch 2" }),
        ];

        // When/Then: Logging completes without error
        await expect(
          logger.logBatchResults("batch-123", results),
        ).resolves.not.toThrow();
      });

      it("should mark batch as recorded", async () => {
        // Given: A batch
        await logger.logBatchResults("recorded-batch", [createCallInput()]);

        // When: Checking if recorded
        const isRecorded = await logger.isRecorded("recorded-batch");

        // Then: Returns true
        expect(isRecorded).toBe(true);
      });
    });

    describe("isRecorded operation", () => {
      it("should return false for unrecorded batch", async () => {
        // When: Checking unrecorded batch
        const isRecorded = await logger.isRecorded("unknown-batch");

        // Then: Returns false
        expect(isRecorded).toBe(false);
      });

      it("should return true after batch is logged", async () => {
        // Given: A logged batch
        await logger.logBatchResults("my-batch", [createCallInput()]);

        // When: Checking
        const isRecorded = await logger.isRecorded("my-batch");

        // Then: Returns true
        expect(isRecorded).toBe(true);
      });
    });

    describe("getStats operation", () => {
      it("should aggregate stats for matching topic prefix", async () => {
        // Given: Calls with specific topic
        logger.logCall(
          createCallInput({
            topic: "workflow.stats.test",
            inputTokens: 100,
            outputTokens: 50,
            cost: 0.01,
          }),
        );
        logger.logCall(
          createCallInput({
            topic: "workflow.stats.test2",
            inputTokens: 200,
            outputTokens: 100,
            cost: 0.02,
          }),
        );

        // When: Getting stats
        const stats = await logger.getStats("workflow.stats");

        // Then: Stats are aggregated
        expect(stats.totalCalls).toBe(2);
        expect(stats.totalInputTokens).toBe(300);
        expect(stats.totalOutputTokens).toBe(150);
        expect(stats.totalCost).toBe(0.03);
      });

      it("should return empty stats for non-matching prefix", async () => {
        // Given: Calls with different topics
        logger.logCall(createCallInput({ topic: "workflow.abc" }));

        // When: Getting stats for non-matching prefix
        const stats = await logger.getStats("workflow.xyz");

        // Then: Stats are empty
        expect(stats.totalCalls).toBe(0);
        expect(stats.totalInputTokens).toBe(0);
        expect(stats.totalOutputTokens).toBe(0);
        expect(stats.totalCost).toBe(0);
      });

      it("should aggregate per-model stats", async () => {
        // Given: Calls with different models
        logger.logCall(
          createCallInput({
            topic: "workflow.model",
            modelKey: "model-a",
            inputTokens: 100,
            outputTokens: 50,
            cost: 0.01,
          }),
        );
        logger.logCall(
          createCallInput({
            topic: "workflow.model",
            modelKey: "model-a",
            inputTokens: 100,
            outputTokens: 50,
            cost: 0.01,
          }),
        );
        logger.logCall(
          createCallInput({
            topic: "workflow.model",
            modelKey: "model-b",
            inputTokens: 200,
            outputTokens: 100,
            cost: 0.05,
          }),
        );

        // When: Getting stats
        const stats = await logger.getStats("workflow.model");

        // Then: Per-model stats are correct
        expect(stats.perModel["model-a"]).toEqual({
          calls: 2,
          inputTokens: 200,
          outputTokens: 100,
          cost: 0.02,
        });
        expect(stats.perModel["model-b"]).toEqual({
          calls: 1,
          inputTokens: 200,
          outputTokens: 100,
          cost: 0.05,
        });
      });
    });
  });
}

// ============================================================================
// JobQueue Conformance Tests
// ============================================================================

function createJobQueueConformanceTests(
  name: string,
  factory: JobQueueFactory,
) {
  describe(`I want ${name} to conform to JobQueue interface`, () => {
    let queue: ReturnType<JobQueueFactory>;

    beforeEach(() => {
      queue = factory();
      queue.clear?.();
    });

    function createJobInput(
      overrides: Partial<EnqueueJobInput> = {},
    ): EnqueueJobInput {
      return {
        workflowRunId: "run-1",
        stageId: `stage-${Date.now()}`,
        priority: 5,
        ...overrides,
      };
    }

    describe("enqueue operation", () => {
      it("should enqueue a job and return an ID", async () => {
        // Given: Job input
        const input = createJobInput({ stageId: "enqueue-test" });

        // When: Enqueueing
        const jobId = await queue.enqueue(input);

        // Then: Returns a valid ID
        expect(jobId).toBeDefined();
        expect(jobId.length).toBeGreaterThan(0);
      });

      it("should enqueue multiple jobs in parallel", async () => {
        // Given: Multiple job inputs
        const inputs = [
          createJobInput({ stageId: "parallel-1" }),
          createJobInput({ stageId: "parallel-2" }),
          createJobInput({ stageId: "parallel-3" }),
        ];

        // When: Enqueueing in parallel
        const ids = await queue.enqueueParallel(inputs);

        // Then: Returns IDs for all jobs
        expect(ids).toHaveLength(3);
        expect(new Set(ids).size).toBe(3); // All unique
      });
    });

    describe("dequeue operation", () => {
      it("should dequeue the highest priority job", async () => {
        // Given: Jobs with different priorities
        await queue.enqueue(
          createJobInput({ stageId: "low-priority", priority: 1 }),
        );
        await queue.enqueue(
          createJobInput({ stageId: "high-priority", priority: 10 }),
        );
        await queue.enqueue(
          createJobInput({ stageId: "medium-priority", priority: 5 }),
        );

        // When: Dequeueing
        const result = await queue.dequeue();

        // Then: Returns highest priority job
        expect(result).not.toBeNull();
        expect(result?.stageId).toBe("high-priority");
        expect(result?.priority).toBe(10);
      });

      it("should return null when queue is empty", async () => {
        // Given: Empty queue
        // When: Dequeueing
        const result = await queue.dequeue();

        // Then: Returns null
        expect(result).toBeNull();
      });

      it("should return job details in dequeue result", async () => {
        // Given: A job
        await queue.enqueue(
          createJobInput({
            workflowRunId: "dequeue-run",
            stageId: "dequeue-stage",
            priority: 7,
            payload: { custom: "data" },
          }),
        );

        // When: Dequeueing
        const result = await queue.dequeue();

        // Then: Result has all expected fields
        expect(result).not.toBeNull();
        expect(result?.jobId).toBeDefined();
        expect(result?.workflowRunId).toBe("dequeue-run");
        expect(result?.stageId).toBe("dequeue-stage");
        expect(result?.priority).toBe(7);
        expect(result?.payload).toEqual({ custom: "data" });
        expect(result?.attempt).toBeDefined();
      });
    });

    describe("complete operation", () => {
      it("should mark a job as completed", async () => {
        // Given: A dequeued job
        const jobId = await queue.enqueue(
          createJobInput({ stageId: "complete-test" }),
        );
        await queue.dequeue();

        // When: Completing
        // Then: No error is thrown
        await expect(queue.complete(jobId)).resolves.not.toThrow();
      });

      it("should throw for non-existent job", async () => {
        // When/Then: Completing non-existent job throws
        await expect(queue.complete("non-existent-job")).rejects.toThrow();
      });
    });

    describe("suspend operation", () => {
      it("should suspend a job with next poll time", async () => {
        // Given: A dequeued job
        const jobId = await queue.enqueue(
          createJobInput({ stageId: "suspend-test" }),
        );
        await queue.dequeue();

        // When: Suspending
        const nextPoll = new Date(Date.now() + 60000);

        // Then: No error is thrown
        await expect(queue.suspend(jobId, nextPoll)).resolves.not.toThrow();
      });
    });

    describe("fail operation", () => {
      it("should mark a job as failed", async () => {
        // Given: A dequeued job
        const jobId = await queue.enqueue(
          createJobInput({ stageId: "fail-test" }),
        );
        await queue.dequeue();

        // When: Failing
        // Then: No error is thrown
        await expect(
          queue.fail(jobId, "Test error", false),
        ).resolves.not.toThrow();
      });

      it("should retry a job when shouldRetry is true", async () => {
        // Given: A dequeued job
        const jobId = await queue.enqueue(
          createJobInput({ stageId: "retry-test" }),
        );
        await queue.dequeue();

        // When: Failing with retry
        await queue.fail(jobId, "Recoverable error", true);

        // Then: Job can be dequeued again
        const retried = await queue.dequeue();
        expect(retried).not.toBeNull();
        expect(retried?.stageId).toBe("retry-test");
        expect(retried?.attempt).toBeGreaterThan(1);
      });
    });

    describe("getSuspendedJobsReadyToPoll operation", () => {
      it("should return suspended jobs ready to poll", async () => {
        // Given: A suspended job with past poll time
        const jobId = await queue.enqueue(
          createJobInput({ stageId: "poll-ready" }),
        );
        await queue.dequeue();
        const pastTime = new Date(Date.now() - 10000);
        await queue.suspend(jobId, pastTime);

        // When: Getting suspended jobs
        const ready = await queue.getSuspendedJobsReadyToPoll();

        // Then: Returns the ready job
        expect(ready.some((j) => j.stageId === "poll-ready")).toBe(true);
      });

      it("should not return suspended jobs not yet ready", async () => {
        // Given: A suspended job with future poll time
        const jobId = await queue.enqueue(
          createJobInput({ stageId: "poll-not-ready" }),
        );
        await queue.dequeue();
        const futureTime = new Date(Date.now() + 60000);
        await queue.suspend(jobId, futureTime);

        // When: Getting suspended jobs
        const ready = await queue.getSuspendedJobsReadyToPoll();

        // Then: Does not return the job
        expect(ready.some((j) => j.stageId === "poll-not-ready")).toBe(false);
      });
    });

    describe("releaseStaleJobs operation", () => {
      it("should return number of released jobs", async () => {
        // Given: No stale jobs
        // When: Releasing stale jobs
        const released = await queue.releaseStaleJobs(60000);

        // Then: Returns a number
        expect(typeof released).toBe("number");
        expect(released).toBeGreaterThanOrEqual(0);
      });
    });
  });
}

// ============================================================================
// Run Conformance Tests Against In-Memory Implementations
// ============================================================================

createPersistenceConformanceTests(
  "InMemoryWorkflowPersistence",
  () => new InMemoryWorkflowPersistence(),
);

createAILoggerConformanceTests(
  "InMemoryAICallLogger",
  () => new InMemoryAICallLogger(),
);

createJobQueueConformanceTests(
  "InMemoryJobQueue",
  () => new InMemoryJobQueue(),
);
