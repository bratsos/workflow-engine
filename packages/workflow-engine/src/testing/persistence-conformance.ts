/**
 * Persistence Conformance Suite
 *
 * Shared vitest suites that verify any implementation of
 * `WorkflowPersistence`, `AICallLogger`, or `JobQueue` follows the
 * contract documented on those interfaces. Used internally to pin the
 * in-memory implementations (see
 * `src/__tests__/12-persistence-adapters/adapter-conformance.test.ts`),
 * and exported here so third-party adapters (custom `WorkflowPersistence`
 * / `JobQueue` implementations) can run the exact same spec against their
 * own implementation:
 *
 * @example
 * ```typescript
 * import { persistenceConformanceSuite } from '@bratsos/workflow-engine/testing';
 *
 * persistenceConformanceSuite('MyCustomPersistence', () => new MyCustomPersistence());
 * ```
 *
 * Each suite factory registers vitest `describe`/`it` blocks as a side
 * effect when called, so it must be invoked from within a vitest test
 * file (directly, or transitively via an import at module scope).
 */

import { beforeEach, describe, expect, it } from "vitest";
import type {
  AICallLogger,
  CreateAICallInput,
  CreateRunInput,
  CreateStageInput,
  EnqueueJobInput,
  JobQueue,
  WorkflowPersistence,
} from "../persistence/interface.js";

// ============================================================================
// Test Suite Factory Types
// ============================================================================

/**
 * Reset/clear seam shared by all three factory contracts: implementations
 * that can reset synchronously (the in-memory fakes) provide `clear`;
 * implementations that must do async I/O to reset (e.g. a Postgres
 * adapter issuing a `TRUNCATE`) provide `reset` instead. Each suite's
 * `beforeEach` prefers `reset` when present, falling back to `clear`.
 */
export interface ResettableFixture {
  clear?: () => void;
  reset?: () => Promise<void>;
}

export type PersistenceFactory = () => WorkflowPersistence & ResettableFixture;
export type AILoggerFactory = () => AICallLogger & ResettableFixture;
export type JobQueueFactory = () => JobQueue & ResettableFixture;

/**
 * Resets a fixture between tests: prefers the async `reset` seam (e.g.
 * TRUNCATE against a real database) when the fixture provides one,
 * otherwise falls back to the synchronous `clear`.
 */
async function resetFixture(fixture: ResettableFixture): Promise<void> {
  if (fixture.reset) {
    await fixture.reset();
  } else {
    fixture.clear?.();
  }
}

/**
 * Real-time delay, used sparingly where a suite has no other way to wait
 * for adapter-async behavior to settle (neither `JobQueue` nor
 * `AICallLogger` expose an injectable clock or a "flush pending writes"
 * primitive) -- e.g. `AICallLogger.logCall` is documented fire-and-forget,
 * so a real (non-fake) implementation logging to a database may not have
 * committed the write by the time a `logCall` call returns.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ============================================================================
// WorkflowPersistence Conformance Tests
// ============================================================================

export function persistenceConformanceSuite(
  name: string,
  factory: PersistenceFactory,
) {
  describe(`I want ${name} to conform to WorkflowPersistence interface`, () => {
    let persistence: ReturnType<PersistenceFactory>;

    beforeEach(async () => {
      persistence = factory();
      await resetFixture(persistence);
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

    /**
     * Seeds `id` (default: "run-1") as a real `WorkflowRun` row if one
     * doesn't already exist. Real schemas (Postgres) enforce a mandatory
     * FK from `WorkflowStage`/`WorkflowLog`/`WorkflowArtifact`/
     * `WorkflowAnnotation` to their parent run, so any conformance test
     * that creates a child row against a bare string id needs its parent
     * seeded first -- `createStageData` does this automatically; tests
     * that build stage/artifact/log/annotation input inline (not via
     * `createStageData`) call this directly.
     */
    async function ensureRun(id: string): Promise<void> {
      const existing = await persistence.getRun(id);
      if (!existing) {
        await persistence.createRun(createRunData({ id }));
      }
    }

    async function createStageData(
      overrides: Partial<CreateStageInput> = {},
    ): Promise<CreateStageInput> {
      const workflowRunId = overrides.workflowRunId ?? "run-1";
      await ensureRun(workflowRunId);
      return {
        workflowRunId,
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

      it("should bump version on every update, even without expectedVersion", async () => {
        // Given: An existing run
        const run = await persistence.createRun(
          createRunData({ id: "version-bump-run-test" }),
        );
        const initialVersion = run.version;

        // When: Updating without expectedVersion (e.g. run.cancel's path)
        await persistence.updateRun(run.id, { status: "CANCELLED" });

        // Then: version is incremented so concurrent optimistic claims can
        // detect the change
        const updated = await persistence.getRun(run.id);
        expect(updated?.version).toBe(initialVersion + 1);
      });

      it("should ignore explicit undefined fields on update (not clobber stored value)", async () => {
        // Given: A run with a non-null completedAt
        const run = await persistence.createRun(
          createRunData({ id: "undefined-clobber-run-test" }),
        );
        await persistence.updateRun(run.id, {
          status: "COMPLETED",
          completedAt: new Date("2024-01-01T00:00:00Z"),
        });

        // When: Updating a different field, leaving completedAt undefined
        await persistence.updateRun(run.id, { totalCost: 1.5 });

        // Then: completedAt is untouched (undefined must not overwrite it)
        const updated = await persistence.getRun(run.id);
        expect(updated?.completedAt).toEqual(new Date("2024-01-01T00:00:00Z"));
        expect(updated?.totalCost).toBe(1.5);
      });

      it("should throw when updating non-existent run", async () => {
        // When/Then: Updating non-existent run throws
        await expect(
          persistence.updateRun("non-existent-run", { status: "RUNNING" }),
        ).rejects.toThrow();
      });

      it("should throw on stale run expectedVersion", async () => {
        const run = await persistence.createRun(
          createRunData({ id: "stale-run-test" }),
        );

        await expect(
          persistence.updateRun(run.id, {
            status: "RUNNING",
            expectedVersion: run.version + 1,
          }),
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

    describe("claim operations", () => {
      it("should bump version when claiming a pending run", async () => {
        // Given: A pending run
        const run = await persistence.createRun(
          createRunData({ id: "claim-version-run-test" }),
        );

        // When: Claiming it
        const claimed = await persistence.claimPendingRun(run.id);

        // Then: version is incremented (so a concurrent optimistic write
        // against the pre-claim version is rejected)
        expect(claimed).toBe(true);
        const updated = await persistence.getRun(run.id);
        expect(updated?.version).toBe(run.version + 1);
      });

      it("should bump version when claiming the next pending run", async () => {
        // Given: A pending run
        const run = await persistence.createRun(
          createRunData({ id: "claim-next-version-run-test" }),
        );

        // When: Claiming the next pending run
        const claimed = await persistence.claimNextPendingRun();

        // Then: version is incremented
        expect(claimed?.id).toBe(run.id);
        expect(claimed?.version).toBe(run.version + 1);
      });
    });

    describe("workflow stage CRUD operations", () => {
      it("should create a stage with all required fields", async () => {
        // Given: Valid stage data
        const data = await createStageData({ stageId: "create-stage-test" });

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
        const data = await createStageData({
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
          await createStageData({ stageId: "stage-by-id-test" }),
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
          await createStageData({ stageId: "update-stage-test" }),
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
          await createStageData({
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

      it("should throw on stale stage expectedVersion", async () => {
        const created = await persistence.createStage(
          await createStageData({
            workflowRunId: "stale-stage-run",
            stageId: "stale-stage",
          }),
        );

        await expect(
          persistence.updateStage(created.id, {
            status: "RUNNING",
            expectedVersion: created.version + 1,
          }),
        ).rejects.toThrow();
      });

      it("should upsert a stage - create when not exists", async () => {
        // Given: Upsert data for new stage
        await ensureRun("upsert-run");
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

      it("should upsert a stage - update when exists, applying all update fields", async () => {
        // Given: An existing stage
        await persistence.createStage(
          await createStageData({
            workflowRunId: "upsert-update-run",
            stageId: "upsert-update-stage",
            status: "PENDING",
          }),
        );

        // When: Upserting with multiple update fields (not just status/startedAt)
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
            outputData: { partial: true },
            errorMessage: "transient",
          },
        });

        // Then: Stage is updated with ALL provided fields, not just
        // status/startedAt
        expect(result.status).toBe("RUNNING");
        expect(result.outputData).toEqual({ partial: true });
        expect(result.errorMessage).toBe("transient");
      });

      it("should get stages by run ID", async () => {
        // Given: Multiple stages for a run
        const runId = "stages-by-run-test";
        await persistence.createStage(
          await createStageData({
            workflowRunId: runId,
            stageId: "stage-a",
            stageNumber: 1,
          }),
        );
        await persistence.createStage(
          await createStageData({
            workflowRunId: runId,
            stageId: "stage-b",
            stageNumber: 2,
          }),
        );
        await persistence.createStage(
          await createStageData({
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
          await createStageData({
            workflowRunId: runId,
            stageId: "completed-stage",
            stageNumber: 1,
            status: "COMPLETED",
          }),
        );
        await persistence.createStage(
          await createStageData({
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

      it("should order stages by executionGroup, with stageNumber as tiebreaker", async () => {
        // Given: Stages in random order
        const runId = `order-stages-run-${Date.now()}`;
        await persistence.createStage(
          await createStageData({
            workflowRunId: runId,
            stageId: "third",
            stageName: "Third",
            stageNumber: 3,
            executionGroup: 3,
          }),
        );
        await persistence.createStage(
          await createStageData({
            workflowRunId: runId,
            stageId: "first",
            stageName: "First",
            stageNumber: 1,
            executionGroup: 1,
          }),
        );
        await persistence.createStage(
          await createStageData({
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
          await createStageData({
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

      it("should get first suspended stage ready to resume (nextPollAt cleared to null)", async () => {
        // Given: Suspended stages -- one with nextPollAt explicitly
        // cleared (ready), one still holding a poll deadline (not ready,
        // regardless of whether that deadline has passed)
        const runId = "suspended-ready-run";
        const past = new Date(Date.now() - 10000);

        const readyStage = await persistence.createStage(
          await createStageData({
            workflowRunId: runId,
            stageId: "ready-stage",
            stageNumber: 1,
            status: "SUSPENDED",
          }),
        );
        await persistence.updateStage(readyStage.id, {
          status: "SUSPENDED",
          nextPollAt: null,
          suspendedState: { batchId: "batch-1" },
        });

        const notReadyStage = await persistence.createStage(
          await createStageData({
            workflowRunId: runId,
            stageId: "not-ready-stage",
            stageNumber: 2,
            status: "SUSPENDED",
          }),
        );
        await persistence.updateStage(notReadyStage.id, {
          status: "SUSPENDED",
          nextPollAt: past,
          suspendedState: { batchId: "batch-2" },
        });

        // When: Getting first suspended stage ready to resume
        const ready =
          await persistence.getFirstSuspendedStageReadyToResume(runId);

        // Then: Returns only the stage with nextPollAt cleared
        expect(ready).not.toBeNull();
        expect(ready?.stageId).toBe("ready-stage");
      });

      it("should get first failed stage", async () => {
        // Given: A failed stage
        const runId = "failed-stage-run";
        const stage = await persistence.createStage(
          await createStageData({
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
          await createStageData({
            workflowRunId: runId,
            stageId: "completed-1",
            stageNumber: 1,
            status: "COMPLETED",
          }),
        );
        const stage2 = await persistence.createStage(
          await createStageData({
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
          await createStageData({
            workflowRunId: runId,
            stageId: "group-1-stage",
            stageNumber: 1,
            executionGroup: 1,
            status: "COMPLETED",
          }),
        );
        const stage2 = await persistence.createStage(
          await createStageData({
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
        await ensureRun(runId);

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

      it("should return undefined (not throw) for a missing artifact", async () => {
        // When: Loading an artifact that was never saved
        const loaded = await persistence.loadArtifact(
          "missing-artifact-run",
          "missing.json",
        );

        // Then: Returns undefined rather than throwing
        expect(loaded).toBeUndefined();
      });

      it("should check if artifact exists", async () => {
        // Given: An artifact
        const runId = "exists-run";
        await ensureRun(runId);
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
        await ensureRun(runId);
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
        await ensureRun(runId);
        await ensureRun("other-run");
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
          await createStageData({
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
        await ensureRun("log-run");
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
        await ensureRun("log-levels-run");
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

    describe("annotation operations", () => {
      it("should append and list an annotation", async () => {
        // Given: A run to attach the annotation to
        const runId = "annotation-run";
        await ensureRun(runId);

        // When: Appending an annotation
        await persistence.appendAnnotations([
          {
            workflowRunId: runId,
            scope: "run",
            key: "trigger.source",
            value: "webhook:test",
            payload: { requestId: "req-1" },
          },
        ]);

        // Then: It comes back from listAnnotations with all fields set
        const annotations = await persistence.listAnnotations(runId);
        expect(annotations).toHaveLength(1);
        expect(annotations[0]?.key).toBe("trigger.source");
        expect(annotations[0]?.value).toBe("webhook:test");
        expect(annotations[0]?.payload).toEqual({ requestId: "req-1" });
        expect(annotations[0]?.scope).toBe("run");
        expect(annotations[0]?.attempt).toBe(0);
        expect(annotations[0]?.createdAt).toBeInstanceOf(Date);
      });

      it("should default actor and scopeId fields to null when omitted", async () => {
        const runId = "annotation-actor-default-run";
        await ensureRun(runId);

        await persistence.appendAnnotations([
          { workflowRunId: runId, scope: "run", key: "k", value: "v" },
        ]);

        const [annotation] = await persistence.listAnnotations(runId);
        expect(annotation?.actorKind).toBeNull();
        expect(annotation?.actorId).toBeNull();
        expect(annotation?.actorVersion).toBeNull();
        expect(annotation?.scopeId).toBeNull();
      });

      it("should record actor and scopeId fields when supplied", async () => {
        const runId = "annotation-actor-run";
        await ensureRun(runId);

        await persistence.appendAnnotations([
          {
            workflowRunId: runId,
            scope: "stage",
            scopeId: "stage-1",
            key: "decision",
            value: "approved",
            actor: { kind: "agent", id: "agent-42", version: "v3" },
          },
        ]);

        const [annotation] = await persistence.listAnnotations(runId);
        expect(annotation?.actorKind).toBe("agent");
        expect(annotation?.actorId).toBe("agent-42");
        expect(annotation?.actorVersion).toBe("v3");
        expect(annotation?.scopeId).toBe("stage-1");
      });

      it("should list annotations ordered by createdAt ascending", async () => {
        const runId = "annotation-order-run";
        await ensureRun(runId);

        // Given: Three annotations appended in one batch (same createdAt
        // tick on some adapters) -- insertion order is the tiebreak,
        // matching the id-ordering documented on listAnnotations.
        await persistence.appendAnnotations([
          { workflowRunId: runId, scope: "run", key: "first", value: 1 },
          { workflowRunId: runId, scope: "run", key: "second", value: 2 },
          { workflowRunId: runId, scope: "run", key: "third", value: 3 },
        ]);

        const annotations = await persistence.listAnnotations(runId);
        expect(annotations.map((a) => a.key)).toEqual([
          "first",
          "second",
          "third",
        ]);
      });

      it("should dedupe rows with the same (workflowRunId, key, idempotencyKey)", async () => {
        const runId = "annotation-idempotency-run";
        await ensureRun(runId);

        const input = {
          workflowRunId: runId,
          scope: "run",
          key: "dedup-key",
          value: "first-write",
          idempotencyKey: "idem-1",
        };

        // When: Appending the same idempotency key twice (e.g. a retried
        // stage-completion transaction)
        await persistence.appendAnnotations([input]);
        await persistence.appendAnnotations([
          { ...input, value: "second-write-should-be-skipped" },
        ]);

        // Then: Only the first write is kept
        const annotations = await persistence.listAnnotations(runId, {
          key: "dedup-key",
        });
        expect(annotations).toHaveLength(1);
        expect(annotations[0]?.value).toBe("first-write");
      });

      it("should NOT dedupe rows with a null idempotencyKey", async () => {
        const runId = "annotation-null-idempotency-run";
        await ensureRun(runId);

        // Given/When: Two annotations with the same key but no
        // idempotencyKey (the unique constraint does not apply to NULLs)
        await persistence.appendAnnotations([
          { workflowRunId: runId, scope: "run", key: "repeatable", value: 1 },
          { workflowRunId: runId, scope: "run", key: "repeatable", value: 2 },
        ]);

        // Then: Both rows are kept
        const annotations = await persistence.listAnnotations(runId, {
          key: "repeatable",
        });
        expect(annotations).toHaveLength(2);
      });

      it("should filter by exact key", async () => {
        const runId = "annotation-filter-key-run";
        await ensureRun(runId);
        await persistence.appendAnnotations([
          { workflowRunId: runId, scope: "run", key: "a.b", value: 1 },
          { workflowRunId: runId, scope: "run", key: "a.c", value: 2 },
        ]);

        const annotations = await persistence.listAnnotations(runId, {
          key: "a.b",
        });
        expect(annotations).toHaveLength(1);
        expect(annotations[0]?.key).toBe("a.b");
      });

      it("should filter by keyPrefix", async () => {
        const runId = "annotation-filter-prefix-run";
        await ensureRun(runId);
        await persistence.appendAnnotations([
          { workflowRunId: runId, scope: "run", key: "cost.input", value: 1 },
          { workflowRunId: runId, scope: "run", key: "cost.output", value: 2 },
          { workflowRunId: runId, scope: "run", key: "other", value: 3 },
        ]);

        const annotations = await persistence.listAnnotations(runId, {
          keyPrefix: "cost.",
        });
        expect(annotations).toHaveLength(2);
        expect(annotations.map((a) => a.key).sort()).toEqual([
          "cost.input",
          "cost.output",
        ]);
      });

      it("should filter by scope and scopeId", async () => {
        const runId = "annotation-filter-scope-run";
        await ensureRun(runId);
        await persistence.appendAnnotations([
          { workflowRunId: runId, scope: "run", key: "k", value: 1 },
          {
            workflowRunId: runId,
            scope: "stage",
            scopeId: "stage-a",
            key: "k",
            value: 2,
          },
          {
            workflowRunId: runId,
            scope: "stage",
            scopeId: "stage-b",
            key: "k",
            value: 3,
          },
        ]);

        const stageAnnotations = await persistence.listAnnotations(runId, {
          scope: "stage",
        });
        expect(stageAnnotations).toHaveLength(2);

        const stageAOnly = await persistence.listAnnotations(runId, {
          scope: "stage",
          scopeId: "stage-a",
        });
        expect(stageAOnly).toHaveLength(1);
        expect(stageAOnly[0]?.value).toBe(2);
      });

      it("should filter by actorId and actorKind", async () => {
        const runId = "annotation-filter-actor-run";
        await ensureRun(runId);
        await persistence.appendAnnotations([
          {
            workflowRunId: runId,
            scope: "run",
            key: "k",
            value: 1,
            actor: { kind: "agent", id: "agent-1" },
          },
          {
            workflowRunId: runId,
            scope: "run",
            key: "k",
            value: 2,
            actor: { kind: "user", id: "user-1" },
          },
        ]);

        const byActorId = await persistence.listAnnotations(runId, {
          actorId: "agent-1",
        });
        expect(byActorId).toHaveLength(1);
        expect(byActorId[0]?.value).toBe(1);

        const byActorKind = await persistence.listAnnotations(runId, {
          actorKind: "user",
        });
        expect(byActorKind).toHaveLength(1);
        expect(byActorKind[0]?.value).toBe(2);
      });

      it("should filter by attempt", async () => {
        const runId = "annotation-filter-attempt-run";
        await ensureRun(runId);
        await persistence.appendAnnotations([
          {
            workflowRunId: runId,
            scope: "run",
            key: "k",
            value: 1,
            attempt: 0,
          },
          {
            workflowRunId: runId,
            scope: "run",
            key: "k",
            value: 2,
            attempt: 1,
          },
        ]);

        const attempt1 = await persistence.listAnnotations(runId, {
          attempt: 1,
        });
        expect(attempt1).toHaveLength(1);
        expect(attempt1[0]?.value).toBe(2);
      });

      it("should filter by since/until", async () => {
        const runId = "annotation-filter-time-run";
        await ensureRun(runId);
        await persistence.appendAnnotations([
          { workflowRunId: runId, scope: "run", key: "k", value: 1 },
        ]);

        const before = new Date(Date.now() - 60_000);
        const after = new Date(Date.now() + 60_000);

        const withinRange = await persistence.listAnnotations(runId, {
          since: before,
          until: after,
        });
        expect(withinRange).toHaveLength(1);

        const outsideRange = await persistence.listAnnotations(runId, {
          since: after,
        });
        expect(outsideRange).toHaveLength(0);
      });

      it("should respect the limit parameter", async () => {
        const runId = "annotation-limit-run";
        await ensureRun(runId);
        await persistence.appendAnnotations(
          Array.from({ length: 5 }, (_, i) => ({
            workflowRunId: runId,
            scope: "run",
            key: `k${i}`,
            value: i,
          })),
        );

        const limited = await persistence.listAnnotations(runId, { limit: 2 });
        expect(limited).toHaveLength(2);
      });

      it("should handle an empty array gracefully", async () => {
        await expect(persistence.appendAnnotations([])).resolves.not.toThrow();
      });

      it("should clear workflowStageRecordId on the surviving annotation when its stage is deleted", async () => {
        // Given: A stage and an annotation scoped to it. `deleteStage` is
        // called by the kernel's run.rerunFrom handler, so this mirrors a
        // rerun: prior annotations must survive with the FK cleared, not
        // be deleted or orphaned with a dangling reference.
        const runId = "annotation-stage-delete-run";
        const stage = await persistence.createStage(
          await createStageData({ workflowRunId: runId, stageId: "s1" }),
        );
        await persistence.appendAnnotations([
          {
            workflowRunId: runId,
            workflowStageRecordId: stage.id,
            scope: "stage",
            scopeId: "s1",
            key: "k",
            value: 1,
          },
        ]);

        // When: The stage is deleted
        await persistence.deleteStage(stage.id);

        // Then: The annotation survives with workflowStageRecordId cleared
        // (mirrors the schema's onDelete: SetNull)
        const annotations = await persistence.listAnnotations(runId);
        expect(annotations).toHaveLength(1);
        expect(annotations[0]?.workflowStageRecordId).toBeNull();
      });
    });

    describe("outbox operations", () => {
      it("should append outbox events with auto-assigned sequences", async () => {
        // Given: Two events for the same run
        const events = [
          {
            workflowRunId: "outbox-run-1",
            eventType: "run.started",
            payload: { runId: "outbox-run-1" },
            causationId: "cmd-1",
            occurredAt: new Date(),
          },
          {
            workflowRunId: "outbox-run-1",
            eventType: "stage.completed",
            payload: { stageId: "s1" },
            causationId: "cmd-1",
            occurredAt: new Date(),
          },
        ];

        // When: Appending events
        await persistence.appendOutboxEvents(events);

        // Then: Events are stored with incrementing sequences
        const unpublished = await persistence.getUnpublishedOutboxEvents();
        const runEvents = unpublished.filter(
          (e) => e.workflowRunId === "outbox-run-1",
        );
        expect(runEvents).toHaveLength(2);
        expect(runEvents[0].sequence).toBe(1);
        expect(runEvents[1].sequence).toBe(2);
      });

      it("should return unpublished events ordered by run and sequence", async () => {
        // Given: Events for two different runs
        await persistence.appendOutboxEvents([
          {
            workflowRunId: "outbox-run-b",
            eventType: "run.started",
            payload: {},
            causationId: "cmd-b",
            occurredAt: new Date(),
          },
          {
            workflowRunId: "outbox-run-a",
            eventType: "run.started",
            payload: {},
            causationId: "cmd-a",
            occurredAt: new Date(),
          },
        ]);

        // When: Getting unpublished events
        const events = await persistence.getUnpublishedOutboxEvents();

        // Then: Ordered by workflowRunId, then sequence
        const runIds = events.map((e) => e.workflowRunId);
        const aIdx = runIds.indexOf("outbox-run-a");
        const bIdx = runIds.indexOf("outbox-run-b");
        expect(aIdx).toBeLessThan(bIdx);
      });

      it("should respect the limit parameter", async () => {
        // Given: 5 events
        const events = Array.from({ length: 5 }, (_, i) => ({
          workflowRunId: "outbox-limit-run",
          eventType: `event-${i}`,
          payload: {},
          causationId: `cmd-${i}`,
          occurredAt: new Date(),
        }));
        await persistence.appendOutboxEvents(events);

        // When: Getting with limit of 2
        const result = await persistence.getUnpublishedOutboxEvents(2);

        // Then: Returns only 2
        expect(result).toHaveLength(2);
      });

      it("should mark events as published", async () => {
        // Given: Two unpublished events
        await persistence.appendOutboxEvents([
          {
            workflowRunId: "outbox-publish-run",
            eventType: "run.started",
            payload: {},
            causationId: "cmd-1",
            occurredAt: new Date(),
          },
          {
            workflowRunId: "outbox-publish-run",
            eventType: "stage.completed",
            payload: {},
            causationId: "cmd-2",
            occurredAt: new Date(),
          },
        ]);

        const events = await persistence.getUnpublishedOutboxEvents();
        const targetEvents = events.filter(
          (e) => e.workflowRunId === "outbox-publish-run",
        );
        expect(targetEvents.length).toBeGreaterThanOrEqual(1);

        // When: Marking the first event as published
        await persistence.markOutboxEventsPublished([targetEvents[0].id]);

        // Then: Published event no longer appears in unpublished
        const remaining = await persistence.getUnpublishedOutboxEvents();
        const remainingForRun = remaining.filter(
          (e) => e.workflowRunId === "outbox-publish-run",
        );
        expect(remainingForRun.some((e) => e.id === targetEvents[0].id)).toBe(
          false,
        );
      });

      it("should handle empty arrays gracefully", async () => {
        // When: Appending empty array and marking empty array
        // Then: No errors thrown
        await expect(persistence.appendOutboxEvents([])).resolves.not.toThrow();
        await expect(
          persistence.markOutboxEventsPublished([]),
        ).resolves.not.toThrow();
      });
    });

    describe("outbox DLQ operations", () => {
      it("should increment retry count and return new count", async () => {
        // Given: An outbox event
        await persistence.appendOutboxEvents([
          {
            workflowRunId: "dlq-retry-run",
            eventType: "run.started",
            payload: {},
            causationId: "cmd-1",
            occurredAt: new Date(),
          },
        ]);
        const events = await persistence.getUnpublishedOutboxEvents();
        const event = events.find((e) => e.workflowRunId === "dlq-retry-run")!;
        expect(event.retryCount).toBe(0);

        // When: Incrementing retry count twice
        const count1 = await persistence.incrementOutboxRetryCount(event.id);
        const count2 = await persistence.incrementOutboxRetryCount(event.id);

        // Then: Returns incrementing counts
        expect(count1).toBe(1);
        expect(count2).toBe(2);
      });

      it("should move event to DLQ and exclude from unpublished", async () => {
        // Given: An outbox event
        await persistence.appendOutboxEvents([
          {
            workflowRunId: "dlq-move-run",
            eventType: "run.started",
            payload: {},
            causationId: "cmd-1",
            occurredAt: new Date(),
          },
        ]);
        const events = await persistence.getUnpublishedOutboxEvents();
        const event = events.find((e) => e.workflowRunId === "dlq-move-run")!;

        // When: Moving to DLQ
        await persistence.moveOutboxEventToDLQ(event.id);

        // Then: Event is no longer in unpublished results
        const remaining = await persistence.getUnpublishedOutboxEvents();
        expect(remaining.some((e) => e.id === event.id)).toBe(false);
      });

      it("should replay DLQ events back to unpublished", async () => {
        // Given: An event in DLQ
        await persistence.appendOutboxEvents([
          {
            workflowRunId: "dlq-replay-run",
            eventType: "run.started",
            payload: {},
            causationId: "cmd-1",
            occurredAt: new Date(),
          },
        ]);
        const events = await persistence.getUnpublishedOutboxEvents();
        const event = events.find((e) => e.workflowRunId === "dlq-replay-run")!;
        await persistence.moveOutboxEventToDLQ(event.id);

        // Verify it's gone from unpublished
        const beforeReplay = await persistence.getUnpublishedOutboxEvents();
        expect(beforeReplay.some((e) => e.id === event.id)).toBe(false);

        // When: Replaying DLQ
        const replayedCount = await persistence.replayDLQEvents(10);

        // Then: Event is back in unpublished
        expect(replayedCount).toBeGreaterThanOrEqual(1);
        const afterReplay = await persistence.getUnpublishedOutboxEvents();
        expect(afterReplay.some((e) => e.id === event.id)).toBe(true);
      });

      it("should return 0 when no DLQ events to replay", async () => {
        // When: Replaying with no DLQ events
        const count = await persistence.replayDLQEvents(10);

        // Then: Returns 0
        expect(count).toBe(0);
      });
    });

    describe("idempotency operations", () => {
      it("should acquire a new idempotency key", async () => {
        const result = await persistence.acquireIdempotencyKey(
          "idem-key-1",
          "run.create",
        );
        expect(result.status).toBe("acquired");
      });

      it("should return in_progress when key is already acquired", async () => {
        await persistence.acquireIdempotencyKey("idem-key-1", "run.create");

        const second = await persistence.acquireIdempotencyKey(
          "idem-key-1",
          "run.create",
        );
        expect(second.status).toBe("in_progress");
      });

      it("should return replay after completion", async () => {
        await persistence.acquireIdempotencyKey("idem-key-1", "run.create");
        await persistence.completeIdempotencyKey("idem-key-1", "run.create", {
          workflowRunId: "run-123",
          status: "PENDING",
        });

        const replay = await persistence.acquireIdempotencyKey(
          "idem-key-1",
          "run.create",
        );
        expect(replay.status).toBe("replay");
        if (replay.status === "replay") {
          expect(replay.result).toEqual({
            workflowRunId: "run-123",
            status: "PENDING",
          });
        }
      });

      it("should release key back to available after failure", async () => {
        await persistence.acquireIdempotencyKey("idem-key-1", "run.create");
        await persistence.releaseIdempotencyKey("idem-key-1", "run.create");

        const reacquire = await persistence.acquireIdempotencyKey(
          "idem-key-1",
          "run.create",
        );
        expect(reacquire.status).toBe("acquired");
      });

      it("should scope idempotency keys by command type", async () => {
        await persistence.acquireIdempotencyKey("shared", "run.create");
        await persistence.completeIdempotencyKey("shared", "run.create", {
          type: "create",
        });

        const execute = await persistence.acquireIdempotencyKey(
          "shared",
          "job.execute",
        );
        expect(execute.status).toBe("acquired");
      });

      describe("stale in_progress reclaim", () => {
        it("does not reclaim an in_progress key when staleInProgressAfterMs is omitted", async () => {
          const start = new Date("2024-01-01T00:00:00.000Z");
          await persistence.acquireIdempotencyKey("stale-key", "run.create", {
            now: start,
          });

          const later = new Date(start.getTime() + 60 * 60 * 1000);
          const result = await persistence.acquireIdempotencyKey(
            "stale-key",
            "run.create",
            { now: later },
          );
          expect(result.status).toBe("in_progress");
        });

        it("does not reclaim an in_progress key before the threshold elapses", async () => {
          const start = new Date("2024-01-01T00:00:00.000Z");
          await persistence.acquireIdempotencyKey("stale-key-2", "run.create", {
            now: start,
          });

          const almostStale = new Date(start.getTime() + 9 * 60 * 1000);
          const result = await persistence.acquireIdempotencyKey(
            "stale-key-2",
            "run.create",
            { now: almostStale, staleInProgressAfterMs: 10 * 60 * 1000 },
          );
          expect(result.status).toBe("in_progress");
        });

        it("reclaims an in_progress key once it is older than the threshold", async () => {
          const start = new Date("2024-01-01T00:00:00.000Z");
          const first = await persistence.acquireIdempotencyKey(
            "stale-key-3",
            "run.create",
            { now: start, staleInProgressAfterMs: 10 * 60 * 1000 },
          );
          expect(first.status).toBe("acquired");

          const stale = new Date(start.getTime() + 10 * 60 * 1000);
          const reclaimed = await persistence.acquireIdempotencyKey(
            "stale-key-3",
            "run.create",
            { now: stale, staleInProgressAfterMs: 10 * 60 * 1000 },
          );
          expect(reclaimed.status).toBe("acquired");

          // The reclaim resets the clock -- an immediate subsequent
          // dispatch sees it as freshly in_progress, not stale again.
          const immediatelyAfter = await persistence.acquireIdempotencyKey(
            "stale-key-3",
            "run.create",
            { now: stale, staleInProgressAfterMs: 10 * 60 * 1000 },
          );
          expect(immediatelyAfter.status).toBe("in_progress");
        });

        it("does not reclaim a key that already completed, even if old", async () => {
          const start = new Date("2024-01-01T00:00:00.000Z");
          await persistence.acquireIdempotencyKey("stale-key-4", "run.create", {
            now: start,
          });
          await persistence.completeIdempotencyKey(
            "stale-key-4",
            "run.create",
            {
              workflowRunId: "run-456",
            },
          );

          const muchLater = new Date(start.getTime() + 24 * 60 * 60 * 1000);
          const result = await persistence.acquireIdempotencyKey(
            "stale-key-4",
            "run.create",
            { now: muchLater, staleInProgressAfterMs: 10 * 60 * 1000 },
          );
          expect(result.status).toBe("replay");
          if (result.status === "replay") {
            expect(result.result).toEqual({ workflowRunId: "run-456" });
          }
        });
      });
    });
  });
}

// ============================================================================
// AICallLogger Conformance Tests
// ============================================================================

export function aiCallLoggerConformanceSuite(
  name: string,
  factory: AILoggerFactory,
) {
  describe(`I want ${name} to conform to AICallLogger interface`, () => {
    let logger: ReturnType<AILoggerFactory>;

    beforeEach(async () => {
      logger = factory();
      await resetFixture(logger);
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
        // logCall is documented fire-and-forget (see AICallLogger.logCall)
        // -- a real adapter logging to a database may not have committed
        // the write yet when logCall() returns, so give it a moment
        // before reading it back via getStats.
        await sleep(100);

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
        // logCall is fire-and-forget -- see the equivalent wait in
        // "should aggregate stats for matching topic prefix" above.
        await sleep(100);

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

export function jobQueueConformanceSuite(
  name: string,
  factory: JobQueueFactory,
) {
  describe(`I want ${name} to conform to JobQueue interface`, () => {
    let queue: ReturnType<JobQueueFactory>;

    beforeEach(async () => {
      queue = factory();
      await resetFixture(queue);
    });

    function createJobInput(
      overrides: Partial<EnqueueJobInput> = {},
    ): EnqueueJobInput {
      return {
        workflowRunId: "run-1",
        workflowId: "workflow-1",
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
        expect(result?.maxAttempts).toBeDefined();
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

      it("should default shouldRetry to false when omitted", async () => {
        // Given: A dequeued job
        const jobId = await queue.enqueue(
          createJobInput({ stageId: "fail-default-test" }),
        );
        await queue.dequeue();

        // When: Failing without specifying shouldRetry
        await queue.fail(jobId, "Unrecoverable by default");

        // Then: The job is NOT retried -- dequeue returns null
        const retried = await queue.dequeue();
        expect(retried).toBeNull();
      });

      it("should retry a job when shouldRetry is true", async () => {
        // Given: A dequeued job
        const runId = "retry-run";
        const jobId = await queue.enqueue(
          createJobInput({ workflowRunId: runId, stageId: "retry-test" }),
        );
        const dequeued = await queue.dequeue();
        expect(dequeued?.attempt).toBe(1);

        // When: Failing with retry
        await queue.fail(jobId, "Recoverable error", true);

        // Then: The job is back in a retryable (PENDING, not permanently
        // FAILED) state with its error recorded. Checked via
        // getJobsByWorkflowRun rather than an immediate re-dequeue --
        // adapters may apply a backoff delay before a retried job becomes
        // dequeueable again (PrismaJobQueue does: 2^attempt seconds;
        // InMemoryJobQueue doesn't), so "immediately re-dequeueable" isn't
        // a portable assertion across adapters.
        const [job] = await queue.getJobsByWorkflowRun(runId);
        expect(job?.status).toBe("PENDING");
        expect(job?.attempt).toBe(1);
        expect(job?.lastError).toBe("Recoverable error");
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

    describe("touchJob operation", () => {
      it("should advance lockedAt without changing status", async () => {
        // Given: A dequeued (RUNNING/locked) job
        const runId = "touch-advances-run";
        const jobId = await queue.enqueue(
          createJobInput({ workflowRunId: runId, stageId: "touch-advances" }),
        );
        await queue.dequeue();
        const [before] = await queue.getJobsByWorkflowRun(runId);
        expect(before?.status).toBe("RUNNING");
        expect(before?.lockedAt).not.toBeNull();

        // When: Touching the job after some real time has passed
        await sleep(30);
        await queue.touchJob(jobId);

        // Then: lockedAt moved forward and status is unchanged
        const [after] = await queue.getJobsByWorkflowRun(runId);
        expect(after?.status).toBe("RUNNING");
        expect(after?.lockedAt).not.toBeNull();
        expect(after?.lockedAt?.getTime() ?? 0).toBeGreaterThan(
          before?.lockedAt?.getTime() ?? 0,
        );
      });

      it("should not touch a job that isn't RUNNING", async () => {
        // Given: A job that was never dequeued (still PENDING)
        const runId = "touch-noop-run";
        const jobId = await queue.enqueue(
          createJobInput({ workflowRunId: runId, stageId: "touch-noop" }),
        );

        // When/Then: Touching it does not throw and leaves it PENDING
        await expect(queue.touchJob(jobId)).resolves.not.toThrow();
        const [job] = await queue.getJobsByWorkflowRun(runId);
        expect(job?.status).toBe("PENDING");
      });

      it("a touched (heartbeating) job survives releaseStaleJobs while an untouched stale job is reclaimed", async () => {
        // Given: Two jobs locked at roughly the same time (the
        // heartbeat-vs-reaper race, at the queue level -- mirrors
        // NodeHost's periodic touchJob heartbeat racing lease.reapStale)
        const survivorRunId = "touch-survivor-run";
        const victimRunId = "touch-victim-run";
        const survivorId = await queue.enqueue(
          createJobInput({
            workflowRunId: survivorRunId,
            stageId: "heartbeat-survivor",
          }),
        );
        await queue.dequeue();
        const victimId = await queue.enqueue(
          createJobInput({
            workflowRunId: victimRunId,
            stageId: "heartbeat-victim",
          }),
        );
        await queue.dequeue();

        // When: Real time passes, then only the survivor is heartbeated
        // (touched) right before the stale-lease reap runs. Margins are
        // generous (well beyond typical DB round-trip / CI scheduling
        // jitter) since this assertion depends on real elapsed time --
        // neither JobQueue nor its factory expose an injectable clock.
        await sleep(200);
        await queue.touchJob(survivorId);
        const released = await queue.releaseStaleJobs(100);

        // Then: The untouched job was reclaimed (back to PENDING, lock
        // cleared); the freshly-touched job is untouched by the reap and
        // stays RUNNING with its worker lock intact
        expect(released).toBeGreaterThanOrEqual(1);

        const [victim] = await queue.getJobsByWorkflowRun(victimRunId);
        expect(victim?.status).toBe("PENDING");
        expect(victim?.lockedAt).toBeNull();
        expect(victim?.workerId).toBeNull();

        const [survivor] = await queue.getJobsByWorkflowRun(survivorRunId);
        expect(survivor?.status).toBe("RUNNING");
        expect(survivor?.lockedAt).not.toBeNull();
        expect(survivor?.id).toBe(survivorId);
        expect(victim?.id).toBe(victimId);
      });
    });
  });
}
