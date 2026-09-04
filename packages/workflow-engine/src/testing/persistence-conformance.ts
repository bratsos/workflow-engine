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

import type { StepLedger, StepRecord } from "../kernel/ports.js";
import type {
  AICallLogger,
  CreateAICallInput,
  CreateRunInput,
  CreateStageInput,
  EnqueueJobInput,
  JobQueue,
  OutboxRecord,
  SaveArtifactInput,
  UpdateStageInput,
  WorkflowArtifactRecord,
  WorkflowPersistence,
  WorkflowRunRecord,
  WorkflowStageRecord,
} from "../persistence/interface.js";
import {
  LEASE_ABSOLUTE_CAP,
  LEASE_HEARTBEAT_LOST,
} from "../persistence/interface.js";

// ============================================================================
// Test API injection
// ============================================================================

/**
 * The four test primitives a suite needs, supplied by the caller (pass
 * vitest's `{ describe, it, expect, beforeEach }`). The `testing` entry
 * therefore imports nothing from vitest, so it loads from any script.
 */
export interface ConformanceTestApi {
  describe: (name: string, fn: () => void) => void;
  it: (name: string, fn: () => void | Promise<void>) => void;
  expect: (value: unknown) => any;
  beforeEach: (fn: () => void | Promise<void>) => void;
}

/** Pre-1.0 query/artifact methods the built-in adapters still ship. */
type LegacyPersistence = WorkflowPersistence & {
  getRunsByStatus(status: string): Promise<WorkflowRunRecord[]>;
  claimPendingRun(id: string): Promise<boolean>;
  updateStageByRunAndStageId(
    workflowRunId: string,
    stageId: string,
    data: UpdateStageInput,
  ): Promise<void>;
  getStageById(id: string): Promise<WorkflowStageRecord | null>;
  getFirstSuspendedStageReadyToResume(
    runId: string,
  ): Promise<WorkflowStageRecord | null>;
  getFirstFailedStage(runId: string): Promise<WorkflowStageRecord | null>;
  getLastCompletedStage(runId: string): Promise<WorkflowStageRecord | null>;
  getLastCompletedStageBefore(
    runId: string,
    executionGroup: number,
  ): Promise<WorkflowStageRecord | null>;
  saveArtifact(data: SaveArtifactInput): Promise<void>;
  loadArtifact(runId: string, key: string): Promise<unknown>;
  hasArtifact(runId: string, key: string): Promise<boolean>;
  deleteArtifact(runId: string, key: string): Promise<void>;
  listArtifacts(runId: string): Promise<WorkflowArtifactRecord[]>;
  getStageIdForArtifact(runId: string, stageId: string): Promise<string | null>;
  saveStageOutput(...args: any[]): Promise<any>;
  loadStageOutput(...args: any[]): Promise<any>;
};
type LegacyQueue = JobQueue & {
  enqueue(options: EnqueueJobInput): Promise<string>;
};

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
  api: ConformanceTestApi,
) {
  const { describe, it, expect, beforeEach } = api;
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
        const running = await (
          persistence as LegacyPersistence
        ).getRunsByStatus("RUNNING");
        const completed = await (
          persistence as LegacyPersistence
        ).getRunsByStatus("COMPLETED");

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
        const claimed = await (
          persistence as LegacyPersistence
        ).claimPendingRun(run.id);

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

    describe("definition versioning", () => {
      it("reports whether the schema behind the adapter carries it", () => {
        // A database that has not been migrated answers false and the
        // engine falls back to unpinned runs rather than failing to start.
        expect(typeof persistence.supportsDefinitionVersioning()).toBe(
          "boolean",
        );
      });

      it("stores a definition snapshot once and returns the stored row on re-registration", async () => {
        if (!persistence.supportsDefinitionVersioning()) return;
        const input = {
          workflowId: "defver-wf",
          version: "sha256-defver0000000000000000000000000",
          snapshot: { format: 1, workflowId: "defver-wf", stages: [] },
          structureHash: "sha256-defver0000000000000000000000000",
        };

        const first = await persistence.insertDefinitionIfAbsent(input);
        expect(first?.version).toBe(input.version);
        expect(first?.structureHash).toBe(input.structureHash);

        // Content-addressed: a second registration of the same version
        // returns what is stored rather than overwriting it, so a caller
        // can detect an explicit version reused for a different structure.
        const second = await persistence.insertDefinitionIfAbsent({
          ...input,
          snapshot: { format: 1, workflowId: "defver-wf", stages: ["drift"] },
          structureHash: "sha256-different000000000000000000000",
        });
        expect(second?.structureHash).toBe(input.structureHash);

        const loaded = await persistence.getDefinition(
          input.workflowId,
          input.version,
        );
        expect(loaded?.structureHash).toBe(input.structureHash);
      });

      it("returns null for a definition that was never registered", async () => {
        if (!persistence.supportsDefinitionVersioning()) return;
        expect(await persistence.getDefinition("defver-wf", "nope")).toBeNull();
      });

      it("counts runs grouped by workflow, version and status", async () => {
        if (!persistence.supportsDefinitionVersioning()) return;
        const workflowId = `defver-count-${Date.now()}`;
        await persistence.createRun(
          createRunData({
            id: `${workflowId}-a`,
            workflowId,
            definitionVersion: "v-count-1",
          }),
        );
        await persistence.createRun(
          createRunData({
            id: `${workflowId}-b`,
            workflowId,
            definitionVersion: "v-count-1",
          }),
        );

        const counts = await persistence.countRunsByDefinitionVersion({
          workflowId,
        });
        const pending = counts.find(
          (row) =>
            row.definitionVersion === "v-count-1" && row.status === "PENDING",
        );
        expect(pending?.count).toBe(2);
        expect(pending?.oldestCreatedAt).toBeInstanceOf(Date);
      });

      it("claims only runs pinned to a version the caller serves", async () => {
        if (!persistence.supportsDefinitionVersioning()) return;
        const workflowId = `defver-claim-${Date.now()}`;
        const pinned = await persistence.createRun(
          createRunData({
            id: `${workflowId}-pinned`,
            workflowId,
            definitionVersion: "v-served",
          }),
        );

        // A host that does not serve this version leaves it alone.
        const missed = await persistence.claimNextPendingRun({
          serves: [{ workflowId, version: "v-other" }],
        });
        expect(missed?.id).not.toBe(pinned.id);
        if (missed) {
          await persistence.updateRun(missed.id, { status: "COMPLETED" });
        }

        const claimed = await persistence.claimNextPendingRun({
          serves: [{ workflowId, version: "v-served" }],
        });
        expect(claimed?.id).toBe(pinned.id);
        expect(claimed?.definitionVersion).toBe("v-served");
      });

      it("claims a run created before versioning regardless of what the caller serves", async () => {
        if (!persistence.supportsDefinitionVersioning()) return;
        const workflowId = `defver-legacy-${Date.now()}`;
        const legacy = await persistence.createRun(
          createRunData({ id: `${workflowId}-legacy`, workflowId }),
        );
        expect(legacy.definitionVersion).toBeNull();

        let claimed = await persistence.claimNextPendingRun({
          serves: [{ workflowId, version: "irrelevant" }],
        });
        while (claimed && claimed.id !== legacy.id) {
          await persistence.updateRun(claimed.id, { status: "COMPLETED" });
          claimed = await persistence.claimNextPendingRun({
            serves: [{ workflowId, version: "irrelevant" }],
          });
        }
        expect(claimed?.id).toBe(legacy.id);
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
        const stage = await (persistence as LegacyPersistence).getStageById(
          created.id,
        );

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
        const updated = await (persistence as LegacyPersistence).getStageById(
          created.id,
        );
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
        await (persistence as LegacyPersistence).updateStageByRunAndStageId(
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
        const ready = await (
          persistence as LegacyPersistence
        ).getFirstSuspendedStageReadyToResume(runId);

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
        const failed = await (
          persistence as LegacyPersistence
        ).getFirstFailedStage(runId);

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
        const last = await (
          persistence as LegacyPersistence
        ).getLastCompletedStage(runId);

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
        const lastBefore = await (
          persistence as LegacyPersistence
        ).getLastCompletedStageBefore(runId, 2);

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
        await (persistence as LegacyPersistence).saveArtifact({
          workflowRunId: runId,
          key,
          type: "ARTIFACT",
          data,
          size: JSON.stringify(data).length,
        });
        const loaded = await (persistence as LegacyPersistence).loadArtifact(
          runId,
          key,
        );

        // Then: Data is preserved
        expect(loaded).toEqual(data);
      });

      it("should return undefined (not throw) for a missing artifact", async () => {
        // When: Loading an artifact that was never saved
        const loaded = await (persistence as LegacyPersistence).loadArtifact(
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
        await (persistence as LegacyPersistence).saveArtifact({
          workflowRunId: runId,
          key: "exists.json",
          type: "ARTIFACT",
          data: {},
          size: 2,
        });

        // When: Checking existence
        const exists = await (persistence as LegacyPersistence).hasArtifact(
          runId,
          "exists.json",
        );
        const notExists = await (persistence as LegacyPersistence).hasArtifact(
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
        await (persistence as LegacyPersistence).saveArtifact({
          workflowRunId: runId,
          key: "delete-me.json",
          type: "ARTIFACT",
          data: { delete: true },
          size: 15,
        });

        // When: Deleting
        await (persistence as LegacyPersistence).deleteArtifact(
          runId,
          "delete-me.json",
        );

        // Then: Artifact no longer exists
        const exists = await (persistence as LegacyPersistence).hasArtifact(
          runId,
          "delete-me.json",
        );
        expect(exists).toBe(false);
      });

      it("should list artifacts for a run", async () => {
        // Given: Multiple artifacts
        const runId = "list-artifacts-run";
        await ensureRun(runId);
        await ensureRun("other-run");
        await (persistence as LegacyPersistence).saveArtifact({
          workflowRunId: runId,
          key: "artifact-1.json",
          type: "ARTIFACT",
          data: {},
          size: 2,
        });
        await (persistence as LegacyPersistence).saveArtifact({
          workflowRunId: runId,
          key: "artifact-2.json",
          type: "ARTIFACT",
          data: {},
          size: 2,
        });
        await (persistence as LegacyPersistence).saveArtifact({
          workflowRunId: "other-run",
          key: "other.json",
          type: "ARTIFACT",
          data: {},
          size: 2,
        });

        // When: Listing artifacts
        const artifacts = await (
          persistence as LegacyPersistence
        ).listArtifacts(runId);

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
        const key = await (persistence as LegacyPersistence).saveStageOutput(
          runId,
          "test-workflow",
          stageId,
          { processed: true },
        );

        // Then: Key is generated and data is stored
        expect(key).toContain(stageId);
        expect(key).toContain("output.json");

        const loaded = await (persistence as LegacyPersistence).loadArtifact(
          runId,
          key,
        );
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
        await expect(
          persistence.releaseOutboxEvents([]),
        ).resolves.not.toThrow();
      });

      it("should hand each unpublished event to exactly one claimant, in order", async () => {
        // Given: Two events for one run
        await persistence.appendOutboxEvents([
          {
            workflowRunId: "outbox-claim-run",
            eventType: "run.created",
            payload: { n: 1 },
            causationId: "cmd-1",
            occurredAt: new Date(),
          },
          {
            workflowRunId: "outbox-claim-run",
            eventType: "run.started",
            payload: { n: 2 },
            causationId: "cmd-1",
            occurredAt: new Date(),
          },
        ]);

        // When: Two flushes claim concurrently
        const [first, second] = await Promise.all([
          persistence.claimUnpublishedOutboxEvents(),
          persistence.claimUnpublishedOutboxEvents(),
        ]);
        const forRun = (events: OutboxRecord[]) =>
          events.filter((e) => e.workflowRunId === "outbox-claim-run");

        // Then: Every event is claimed by exactly one of them, in
        // sequence order, and is stamped as published
        const claimed = [...forRun(first), ...forRun(second)];
        expect(claimed).toHaveLength(2);
        expect(new Set(claimed.map((e) => e.id)).size).toBe(2);
        expect(claimed.every((e) => e.publishedAt !== null)).toBe(true);
        const winner =
          forRun(first).length > 0 ? forRun(first) : forRun(second);
        expect(winner.map((e) => e.sequence)).toEqual([1, 2]);
        const unpublished = await persistence.getUnpublishedOutboxEvents();
        expect(forRun(unpublished)).toHaveLength(0);
      });

      it("should make released events claimable again", async () => {
        // Given: A claimed event
        await persistence.appendOutboxEvents([
          {
            workflowRunId: "outbox-release-run",
            eventType: "run.created",
            payload: {},
            causationId: "cmd-1",
            occurredAt: new Date(),
          },
        ]);
        const claimed = (
          await persistence.claimUnpublishedOutboxEvents()
        ).filter((e) => e.workflowRunId === "outbox-release-run");
        expect(claimed).toHaveLength(1);

        // When: Releasing it
        await persistence.releaseOutboxEvents([claimed[0]!.id]);

        // Then: It is unpublished again and the next claim gets it
        const unpublished = await persistence.getUnpublishedOutboxEvents();
        expect(
          unpublished.some(
            (e) => e.id === claimed[0]!.id && e.publishedAt === null,
          ),
        ).toBe(true);
        const again = (await persistence.claimUnpublishedOutboxEvents()).filter(
          (e) => e.workflowRunId === "outbox-release-run",
        );
        expect(again.map((e) => e.id)).toEqual([claimed[0]!.id]);
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
  api: ConformanceTestApi,
) {
  const { describe, it, expect, beforeEach } = api;
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
        // Given: An unrecorded batch
        expect(await logger.isRecorded("recorded-batch")).toBe(false);

        // When: Logging the batch
        await logger.logBatchResults("recorded-batch", [
          createCallInput({ requestId: "recorded-request" }),
        ]);

        // When: Checking if recorded
        const isRecorded = await logger.isRecorded("recorded-batch");

        // Then: Returns true
        expect(isRecorded).toBe(true);
      });

      it("should write each repeated batch request only once", async () => {
        const results = [
          createCallInput({
            topic: "workflow.batch.dedupe",
            requestId: "request-1",
          }),
          createCallInput({
            topic: "workflow.batch.dedupe",
            requestId: "request-2",
          }),
        ];

        await logger.logBatchResults("dedupe-batch", results);
        await logger.logBatchResults("dedupe-batch", results);

        const stats = await logger.getStats("workflow.batch.dedupe");
        expect(stats.totalCalls).toBe(2);
      });

      it("should deduplicate concurrent writes for the same batch requests", async () => {
        const results = [
          createCallInput({
            topic: "workflow.batch.concurrent",
            requestId: "request-1",
          }),
          createCallInput({
            topic: "workflow.batch.concurrent",
            requestId: "request-2",
          }),
        ];

        await Promise.all([
          logger.logBatchResults("concurrent-batch", results),
          logger.logBatchResults("concurrent-batch", results),
        ]);

        const stats = await logger.getStats("workflow.batch.concurrent");
        expect(stats.totalCalls).toBe(2);
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

      it("should recognize a batch ID stored only in legacy metadata", async () => {
        logger.logCall(
          createCallInput({
            metadata: { batchId: "legacy-metadata-batch" },
          }),
        );
        await sleep(100);

        expect(await logger.isRecorded("legacy-metadata-batch")).toBe(true);
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
  api: ConformanceTestApi,
) {
  const { describe, it, expect, beforeEach } = api;
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
        const jobId = await (queue as LegacyQueue).enqueue(input);

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

      it("keeps one job row per (workflowRunId, stageId), replacing the row already queued", async () => {
        // Given: A stage whose job row already ran and failed (what
        // `run.rerunFrom` and `run.reapStuck`'s PENDING-without-job sweep
        // both find when they re-enqueue a stage that has executed)
        const runId = "reenqueue-run";
        await queue.enqueueParallel([
          createJobInput({ workflowRunId: runId, stageId: "reenqueue-stage" }),
        ]);
        const first = await queue.dequeue();
        expect(first).not.toBeNull();
        await queue.fail(first!.jobId, "boom", false);
        const [failed] = await queue.getJobsByWorkflowRun(runId);
        expect(failed?.status).toBe("FAILED");
        expect(failed?.attempt).toBe(1);

        // When: The same (run, stage) is enqueued again
        const ids = await queue.enqueueParallel([
          createJobInput({
            workflowRunId: runId,
            stageId: "reenqueue-stage",
            priority: 7,
          }),
        ]);

        // Then: Exactly one row remains, PENDING and reset — not a second
        // row, and not a unique-constraint violation
        expect(ids).toHaveLength(1);
        const rows = await queue.getJobsByWorkflowRun(runId);
        expect(rows).toHaveLength(1);
        expect(rows[0]?.status).toBe("PENDING");
        expect(rows[0]?.attempt).toBe(0);
        expect(rows[0]?.priority).toBe(7);
        expect(rows[0]?.workerId).toBeNull();
        expect(rows[0]?.lockedAt).toBeNull();
        expect(rows[0]?.nextPollAt).toBeNull();
      });

      it("re-enqueueing twice in a row still leaves one row per stage", async () => {
        // Given/When: Two consecutive reruns of the same two stages
        const runId = "double-rerun-run";
        const stages = ["double-a", "double-b"];
        for (let round = 0; round < 3; round++) {
          await queue.enqueueParallel(
            stages.map((stageId) =>
              createJobInput({ workflowRunId: runId, stageId }),
            ),
          );
        }

        // Then: One row per stage, all PENDING at attempt 0
        const rows = await queue.getJobsByWorkflowRun(runId);
        expect(rows).toHaveLength(2);
        expect(new Set(rows.map((r) => r.stageId))).toEqual(new Set(stages));
        for (const row of rows) {
          expect(row.status).toBe("PENDING");
          expect(row.attempt).toBe(0);
        }
      });
    });

    describe("deleteByRunAndStages operation", () => {
      it("removes the named stages' rows whatever their status and leaves the rest", async () => {
        // Given: Three stages of one run, one of them already RUNNING,
        // plus a stage of an unrelated run
        const runId = "delete-run";
        await queue.enqueueParallel([
          createJobInput({ workflowRunId: runId, stageId: "delete-keep" }),
          createJobInput({
            workflowRunId: runId,
            stageId: "delete-a",
            priority: 9,
          }),
          createJobInput({ workflowRunId: runId, stageId: "delete-b" }),
        ]);
        await queue.enqueueParallel([
          createJobInput({
            workflowRunId: "delete-other-run",
            stageId: "delete-a",
          }),
        ]);
        // Highest priority wins the dequeue, so `delete-a` is the RUNNING one.
        const locked = await queue.dequeue();
        expect(locked?.stageId).toBe("delete-a");

        // When: Deleting two of the stages
        const deleted = await queue.deleteByRunAndStages(runId, [
          "delete-a",
          "delete-b",
        ]);

        // Then: Both rows are gone regardless of status; the run's other
        // stage and the other run's same-named stage are untouched
        expect(deleted).toBe(2);
        const rows = await queue.getJobsByWorkflowRun(runId);
        expect(rows.map((r) => r.stageId)).toEqual(["delete-keep"]);
        const other = await queue.getJobsByWorkflowRun("delete-other-run");
        expect(other).toHaveLength(1);
      });

      it("is a no-op for an empty stage list or unknown stages", async () => {
        // Given: A run with one queued job
        const runId = "delete-noop-run";
        await queue.enqueueParallel([
          createJobInput({ workflowRunId: runId, stageId: "delete-noop" }),
        ]);

        // When/Then: Neither call removes anything
        expect(await queue.deleteByRunAndStages(runId, [])).toBe(0);
        expect(await queue.deleteByRunAndStages(runId, ["not-a-stage"])).toBe(
          0,
        );
        expect(await queue.getJobsByWorkflowRun(runId)).toHaveLength(1);
      });
    });

    describe("dequeue operation", () => {
      it("should dequeue the highest priority job", async () => {
        // Given: Jobs with different priorities
        await (queue as LegacyQueue).enqueue(
          createJobInput({ stageId: "low-priority", priority: 1 }),
        );
        await (queue as LegacyQueue).enqueue(
          createJobInput({ stageId: "high-priority", priority: 10 }),
        );
        await (queue as LegacyQueue).enqueue(
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
        await (queue as LegacyQueue).enqueue(
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
        const jobId = await (queue as LegacyQueue).enqueue(
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
        const jobId = await (queue as LegacyQueue).enqueue(
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
        const jobId = await (queue as LegacyQueue).enqueue(
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
        const jobId = await (queue as LegacyQueue).enqueue(
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
        const jobId = await (queue as LegacyQueue).enqueue(
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

    describe("fenced acknowledgement", () => {
      // A negative threshold makes every held lease look stale straight
      // away, which is how these tests force the rescue deterministically
      // instead of sleeping past a real threshold.
      const RESCUE_EVERYTHING_MS = -1000;

      /**
       * Claim a job, have it rescued by the sweeper, and let a second
       * worker claim it — the exact sequence a stalled worker's
       * acknowledgement has to survive. Returns both fences.
       */
      async function rescueAndReclaim(stageId: string) {
        const jobId = await (queue as LegacyQueue).enqueue(
          createJobInput({ workflowRunId: `fence-${stageId}`, stageId }),
        );
        const first = await queue.dequeue();
        expect(first?.jobId).toBe(jobId);
        expect(await queue.releaseStaleJobs(RESCUE_EVERYTHING_MS)).toBe(1);
        const second = await queue.dequeue();
        expect(second?.jobId).toBe(jobId);
        return { jobId, first: first!, second: second! };
      }

      it("should acknowledge a completion carrying the fence from its own claim", async () => {
        await (queue as LegacyQueue).enqueue(
          createJobInput({ stageId: "fence-happy" }),
        );
        const job = await queue.dequeue();
        expect(job?.startedAt).toBeInstanceOf(Date);

        const outcome = await queue.complete(job!.jobId, {
          startedAt: job!.startedAt,
          attempt: job!.attempt,
        });
        expect(outcome).toBe("acknowledged");
      });

      it("should report a completion from a superseded attempt instead of clobbering the newer one", async () => {
        const { jobId, first, second } =
          await rescueAndReclaim("fence-complete");

        // The stalled worker finally finishes and acknowledges.
        const stale = await queue.complete(jobId, {
          startedAt: first.startedAt,
          attempt: first.attempt,
        });
        expect(stale).toBe("superseded");

        // Nothing was written: the newer attempt is still RUNNING.
        const [afterStale] = await queue.getJobsByWorkflowRun(
          "fence-fence-complete",
        );
        expect(afterStale?.status).toBe("RUNNING");

        // The current owner's acknowledgement still lands.
        const live = await queue.complete(jobId, {
          startedAt: second.startedAt,
          attempt: second.attempt,
        });
        expect(live).toBe("acknowledged");
        const [afterLive] = await queue.getJobsByWorkflowRun(
          "fence-fence-complete",
        );
        expect(afterLive?.status).toBe("COMPLETED");
      });

      it("should report a failure from a superseded attempt instead of clobbering the newer one", async () => {
        const { jobId, first } = await rescueAndReclaim("fence-fail");

        const stale = await queue.fail(jobId, "stalled worker error", false, {
          startedAt: first.startedAt,
          attempt: first.attempt,
        });
        expect(stale).toBe("superseded");

        const [job] = await queue.getJobsByWorkflowRun("fence-fence-fail");
        expect(job?.status).toBe("RUNNING");
        // The stalled worker's error was not recorded; the only error on the
        // row is the sweeper's note that it reclaimed the lease.
        expect(job?.lastError).not.toContain("stalled worker error");
      });

      it("should report a suspend from a superseded attempt instead of releasing the newer one's lease", async () => {
        const { jobId, first } = await rescueAndReclaim("fence-suspend");

        const stale = await queue.suspend(
          jobId,
          new Date(Date.now() + 60_000),
          { startedAt: first.startedAt, attempt: first.attempt },
        );
        expect(stale).toBe("superseded");

        const [job] = await queue.getJobsByWorkflowRun("fence-fence-suspend");
        expect(job?.status).toBe("RUNNING");
        expect(job?.workerId).not.toBeNull();
      });

      it("should keep acknowledging unconditionally when no fence is passed", async () => {
        const { jobId } = await rescueAndReclaim("fence-optional");

        // No fence: the previous, unconditional contract — the write lands
        // whichever attempt the caller is on.
        expect(await queue.complete(jobId)).toBe("acknowledged");
        const [job] = await queue.getJobsByWorkflowRun("fence-fence-optional");
        expect(job?.status).toBe("COMPLETED");
      });

      it("should report a fenced acknowledgement of a deleted job as superseded", async () => {
        // A rerun deletes the retired stages' job rows underneath whatever
        // worker still holds them (`deleteByRunAndStages`). `JobAckOutcome`
        // names deletion as one of the things "superseded" covers, so the
        // fenced write must report it, not throw: the worker's job is to
        // surface a superseded ack, and an implementation that throws turns
        // a benign no-op into a host-level error.
        const jobId = await (queue as LegacyQueue).enqueue(
          createJobInput({
            workflowRunId: "fence-deleted",
            stageId: "fence-deleted-stage",
          }),
        );
        const claim = await queue.dequeue();
        expect(claim?.jobId).toBe(jobId);

        expect(
          await queue.deleteByRunAndStages("fence-deleted", [
            "fence-deleted-stage",
          ]),
        ).toBe(1);

        const outcome = await queue.complete(jobId, {
          startedAt: claim!.startedAt,
          attempt: claim!.attempt,
        });
        expect(outcome).toBe("superseded");
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

      it("should name the heartbeat tier in lastError when it reclaims a lease", async () => {
        await (queue as LegacyQueue).enqueue(
          createJobInput({
            workflowRunId: "tier-heartbeat",
            stageId: "tier-stage",
          }),
        );
        await queue.dequeue();

        // A negative threshold makes the held lease look stale straight away.
        expect(await queue.releaseStaleJobs(-1000)).toBe(1);

        const [job] = await queue.getJobsByWorkflowRun("tier-heartbeat");
        expect(job?.status).toBe("PENDING");
        // Distinguishable from the absolute tier, and from a stage error.
        expect(job?.lastError).toContain(LEASE_HEARTBEAT_LOST);
        expect(job?.lastError).not.toContain(LEASE_ABSOLUTE_CAP);
      });
    });

    describe("expireRunawayJobs operation (absolute lease tier)", () => {
      it("should fail a job that held its lease past the absolute cap, even while heartbeating", async () => {
        const expire = queue.expireRunawayJobs?.bind(queue);
        if (!expire) return; // optional port method

        await (queue as LegacyQueue).enqueue(
          createJobInput({
            workflowRunId: "tier-absolute",
            stageId: "tier-stage",
          }),
        );
        const claimed = await queue.dequeue();
        expect(claimed).not.toBeNull();

        // The wedged-but-alive worker the heartbeat tier cannot catch: its
        // lease is fresh, so the heartbeat sweep skips it...
        await queue.touchJob(claimed!.jobId);
        expect(await queue.releaseStaleJobs(60_000)).toBe(0);

        // ...but the absolute cap is measured from the claim, which no
        // heartbeat refreshes, so it fires anyway.
        expect(await expire(-1000)).toBe(1);

        const [job] = await queue.getJobsByWorkflowRun("tier-absolute");
        expect(job?.status).toBe("FAILED");
        expect(job?.lastError).toContain(LEASE_ABSOLUTE_CAP);
        expect(job?.lastError).not.toContain(LEASE_HEARTBEAT_LOST);
      });

      it("should leave a job inside the cap alone", async () => {
        const expire = queue.expireRunawayJobs?.bind(queue);
        if (!expire) return;

        await (queue as LegacyQueue).enqueue(
          createJobInput({
            workflowRunId: "tier-within",
            stageId: "tier-stage",
          }),
        );
        await queue.dequeue();

        expect(await expire(60 * 60_000)).toBe(0);
        const [job] = await queue.getJobsByWorkflowRun("tier-within");
        expect(job?.status).toBe("RUNNING");
      });
    });

    describe("touchJob operation", () => {
      it("should advance lockedAt without changing status", async () => {
        // Given: A dequeued (RUNNING/locked) job
        const runId = "touch-advances-run";
        const jobId = await (queue as LegacyQueue).enqueue(
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
        const jobId = await (queue as LegacyQueue).enqueue(
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
        const survivorId = await (queue as LegacyQueue).enqueue(
          createJobInput({
            workflowRunId: survivorRunId,
            stageId: "heartbeat-survivor",
          }),
        );
        await queue.dequeue();
        const victimId = await (queue as LegacyQueue).enqueue(
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

// ============================================================================
// StepLedger Conformance Tests
// ============================================================================

/**
 * A `StepLedger` under test, plus an optional async teardown seam.
 *
 * Deliberately NOT `ResettableFixture`: that interface's `clear()` takes no
 * arguments and `StepLedger` already has a `clear(stageRecordId)` of its own,
 * so intersecting the two would have the suite's reset call the ledger's
 * stage-scoped delete with no stage. An adapter that needs real teardown (a
 * Postgres `DELETE FROM workflow_steps`) attaches `reset`; an in-memory fake
 * needs none, because the factory builds a fresh one for every test.
 */
export type StepLedgerFixture = StepLedger & { reset?: () => Promise<void> };

export type StepLedgerFactory = () => StepLedgerFixture;

/**
 * Shared suite verifying that an implementation of `StepLedger` follows the
 * contract documented on the interface: insert-if-absent `claim`, the patch
 * rule that `undefined` leaves a field alone while any other value -- `null`
 * included -- is written, `compareAndSet` with and without a pinned attempt,
 * seq-ordered `list`, and stage-scoped `clear` / `clearExcept`.
 *
 * The null-result cases are here because an adapter that quietly drops a
 * `{ result: null }` write leaves the previous attempt's value sitting in the
 * row. That is invisible while a re-run deletes the row, and permanent once a
 * re-run preserves one: the step completes with no value, the row still holds
 * the old one, and every replay reads it back forever.
 */
export function stepLedgerConformanceSuite(
  name: string,
  factory: StepLedgerFactory,
  api: ConformanceTestApi,
) {
  const { describe, it, expect, beforeEach } = api;
  describe(`I want ${name} to conform to the StepLedger interface`, () => {
    let ledger: StepLedgerFixture;

    beforeEach(async () => {
      ledger = factory();
      await ledger.reset?.();
    });

    function claimRecord(
      overrides: Partial<Omit<StepRecord, "createdAt" | "updatedAt">> = {},
    ): Omit<StepRecord, "createdAt" | "updatedAt"> {
      return {
        stageRecordId: "stage-1",
        stepId: "step-1",
        seq: 1,
        kind: "run",
        status: "running",
        attempt: 1,
        leaseExpiresAt: null,
        deadlineAt: null,
        externalKey: null,
        ...overrides,
      };
    }

    describe("claim operation", () => {
      it("should create a record and return it with every field it was given", async () => {
        const recordData = claimRecord({
          stageRecordId: "stage-1",
          stepId: "step-1",
          seq: 1,
          kind: "run",
          status: "running",
          attempt: 1,
          externalKey: "ext-key-1",
        });
        const result = await ledger.claim(recordData);
        expect(result.created).toBe(true);
        expect(result.record.stageRecordId).toBe("stage-1");
        expect(result.record.stepId).toBe("step-1");
        expect(result.record.seq).toBe(1);
        expect(result.record.kind).toBe("run");
        expect(result.record.status).toBe("running");
        expect(result.record.attempt).toBe(1);
        expect(result.record.externalKey).toBe("ext-key-1");
        expect(result.record.createdAt).toBeInstanceOf(Date);
        expect(result.record.updatedAt).toBeInstanceOf(Date);
      });

      it("should report created:false and return the stored row when the same step is claimed twice", async () => {
        const first = await ledger.claim(
          claimRecord({
            stageRecordId: "stage-1",
            stepId: "step-1",
            status: "running",
            attempt: 1,
            externalKey: "ext-original",
          }),
        );
        expect(first.created).toBe(true);

        const second = await ledger.claim(
          claimRecord({
            stageRecordId: "stage-1",
            stepId: "step-1",
            status: "pending",
            attempt: 9,
            externalKey: "ext-different",
          }),
        );
        expect(second.created).toBe(false);
        expect(second.record.status).toBe("running");
        expect(second.record.attempt).toBe(1);
        expect(second.record.externalKey).toBe("ext-original");
      });

      it("should read back a record claimed without an external key as null", async () => {
        const { externalKey: _omitted, ...withoutKey } = claimRecord({
          stageRecordId: "stage-1",
          stepId: "step-1",
        });
        const result = await ledger.claim(withoutKey);
        expect(result.record.externalKey).toBeNull();

        const fresh = await ledger.get("stage-1", "step-1");
        expect(fresh?.externalKey).toBeNull();
      });
    });

    describe("get operation", () => {
      it("should return null for a step that was never claimed", async () => {
        const result = await ledger.get("stage-1", "non-existent-step");
        expect(result).toBeNull();
      });
    });

    describe("update operation", () => {
      it("should overwrite a previous result with null", async () => {
        await ledger.claim(
          claimRecord({
            stageRecordId: "stage-1",
            stepId: "step-1",
            kind: "run",
            status: "running",
            attempt: 1,
          }),
        );
        await ledger.update("stage-1", "step-1", {
          status: "completed",
          result: { v: "attempt-1" },
          error: null,
          leaseExpiresAt: null,
        });
        const reopened = await ledger.compareAndSet(
          "stage-1",
          "step-1",
          { status: "completed", attempt: 1 },
          { status: "running", leaseExpiresAt: null },
        );
        expect(reopened.applied).toBe(true);

        const updated = await ledger.update("stage-1", "step-1", {
          status: "completed",
          result: null,
          error: null,
          leaseExpiresAt: null,
        });
        expect(updated.result).toBeNull();

        const fresh = await ledger.get("stage-1", "step-1");
        expect(fresh?.result).toBeNull();
      });

      it("should leave a field alone when the patch omits it", async () => {
        await ledger.claim(
          claimRecord({
            stageRecordId: "stage-1",
            stepId: "step-1",
            status: "running",
            result: { value: 42 },
          }),
        );
        const updated = await ledger.update("stage-1", "step-1", {
          status: "completed",
        });
        expect(updated.status).toBe("completed");
        expect(updated.result).toEqual({ value: 42 });

        const fresh = await ledger.get("stage-1", "step-1");
        expect(fresh?.result).toEqual({ value: 42 });
      });

      it("should leave a field alone when the patch carries undefined", async () => {
        await ledger.claim(
          claimRecord({
            stageRecordId: "stage-1",
            stepId: "step-1",
            status: "running",
            result: { value: 42 },
          }),
        );
        const updated = await ledger.update("stage-1", "step-1", {
          status: "completed",
          result: undefined,
        });
        expect(updated.status).toBe("completed");
        expect(updated.result).toEqual({ value: 42 });

        const fresh = await ledger.get("stage-1", "step-1");
        expect(fresh?.result).toEqual({ value: 42 });
      });

      it("should clear leaseExpiresAt and error when the patch names null for them", async () => {
        const leaseDate = new Date(Date.now() + 60_000);
        await ledger.claim(
          claimRecord({
            stageRecordId: "stage-1",
            stepId: "step-1",
            leaseExpiresAt: leaseDate,
            error: "something failed",
          }),
        );
        const updated = await ledger.update("stage-1", "step-1", {
          leaseExpiresAt: null,
          error: null,
        });
        expect(updated.leaseExpiresAt).toBeNull();
        expect(updated.error).toBeNull();

        const fresh = await ledger.get("stage-1", "step-1");
        expect(fresh?.leaseExpiresAt).toBeNull();
        expect(fresh?.error).toBeNull();
      });

      it("should round-trip waitState", async () => {
        await ledger.claim(
          claimRecord({
            stageRecordId: "stage-1",
            stepId: "step-1",
            kind: "wait",
            status: "pending",
          }),
        );
        await ledger.update("stage-1", "step-1", {
          waitState: { everyMs: 5000, pollFailures: 2 },
        });
        const fresh = await ledger.get("stage-1", "step-1");
        expect(fresh?.waitState).toEqual({ everyMs: 5000, pollFailures: 2 });
      });

      it("should bump attempt and clear the error the way a lease re-claim does", async () => {
        await ledger.claim(
          claimRecord({
            stageRecordId: "stage-1",
            stepId: "step-1",
            status: "failed",
            attempt: 1,
            error: "lease timeout",
          }),
        );
        const newLease = new Date(Date.now() + 30_000);
        const updated = await ledger.update("stage-1", "step-1", {
          status: "running",
          attempt: 2,
          error: null,
          leaseExpiresAt: newLease,
        });
        expect(updated.status).toBe("running");
        expect(updated.attempt).toBe(2);
        expect(updated.error).toBeNull();
        expect(updated.leaseExpiresAt).toBeInstanceOf(Date);
        expect(updated.leaseExpiresAt?.getTime()).toBe(newLease.getTime());

        const fresh = await ledger.get("stage-1", "step-1");
        expect(fresh?.attempt).toBe(2);
        expect(fresh?.error).toBeNull();
        expect(fresh?.leaseExpiresAt?.getTime()).toBe(newLease.getTime());
      });
    });

    describe("compareAndSet operation", () => {
      it("should apply the patch when the status matches and no attempt is pinned", async () => {
        await ledger.claim(
          claimRecord({
            stageRecordId: "stage-1",
            stepId: "step-1",
            status: "running",
            attempt: 1,
          }),
        );
        const result = await ledger.compareAndSet(
          "stage-1",
          "step-1",
          { status: "running" },
          { status: "completed" },
        );
        expect(result.applied).toBe(true);
        expect(result.record?.status).toBe("completed");

        const fresh = await ledger.get("stage-1", "step-1");
        expect(fresh?.status).toBe("completed");
      });

      it("should apply the patch when both the status and the pinned attempt match", async () => {
        await ledger.claim(
          claimRecord({
            stageRecordId: "stage-1",
            stepId: "step-1",
            status: "running",
            attempt: 2,
          }),
        );
        const result = await ledger.compareAndSet(
          "stage-1",
          "step-1",
          { status: "running", attempt: 2 },
          { status: "completed" },
        );
        expect(result.applied).toBe(true);
        expect(result.record?.status).toBe("completed");

        const fresh = await ledger.get("stage-1", "step-1");
        expect(fresh?.status).toBe("completed");
      });

      it("should refuse and leave the row untouched when the pinned attempt differs", async () => {
        await ledger.claim(
          claimRecord({
            stageRecordId: "stage-1",
            stepId: "step-1",
            status: "running",
            attempt: 1,
          }),
        );
        const result = await ledger.compareAndSet(
          "stage-1",
          "step-1",
          { status: "running", attempt: 2 },
          { status: "completed" },
        );
        expect(result.applied).toBe(false);
        expect(result.record?.status).toBe("running");
        expect(result.record?.attempt).toBe(1);

        const fresh = await ledger.get("stage-1", "step-1");
        expect(fresh?.status).toBe("running");
        expect(fresh?.attempt).toBe(1);
      });

      it("should refuse and leave the row untouched when the status differs", async () => {
        await ledger.claim(
          claimRecord({
            stageRecordId: "stage-1",
            stepId: "step-1",
            status: "running",
            attempt: 1,
          }),
        );
        const result = await ledger.compareAndSet(
          "stage-1",
          "step-1",
          { status: "pending" },
          { status: "completed" },
        );
        expect(result.applied).toBe(false);
        expect(result.record?.status).toBe("running");

        const fresh = await ledger.get("stage-1", "step-1");
        expect(fresh?.status).toBe("running");
      });

      it("should match any attempt when none is pinned", async () => {
        await ledger.claim(
          claimRecord({
            stageRecordId: "stage-1",
            stepId: "step-1",
            status: "running",
            attempt: 1,
          }),
        );
        await ledger.update("stage-1", "step-1", { attempt: 3 });
        const result = await ledger.compareAndSet(
          "stage-1",
          "step-1",
          { status: "running" },
          { status: "completed" },
        );
        expect(result.applied).toBe(true);
        expect(result.record?.status).toBe("completed");
        expect(result.record?.attempt).toBe(3);

        const fresh = await ledger.get("stage-1", "step-1");
        expect(fresh?.status).toBe("completed");
        expect(fresh?.attempt).toBe(3);
      });

      it("should return applied:false and a null record for a step that does not exist", async () => {
        const result = await ledger.compareAndSet(
          "stage-1",
          "non-existent-step",
          { status: "running" },
          { status: "completed" },
        );
        expect(result.applied).toBe(false);
        expect(result.record).toBeNull();
      });

      it("should overwrite a previous result with null", async () => {
        await ledger.claim(
          claimRecord({
            stageRecordId: "stage-1",
            stepId: "step-1",
            kind: "run",
            status: "running",
            attempt: 1,
            result: { v: "attempt-1" },
          }),
        );
        const result = await ledger.compareAndSet(
          "stage-1",
          "step-1",
          { status: "running" },
          {
            status: "completed",
            result: null,
            error: null,
            leaseExpiresAt: null,
          },
        );
        expect(result.applied).toBe(true);
        expect(result.record?.result).toBeNull();

        const fresh = await ledger.get("stage-1", "step-1");
        expect(fresh?.result).toBeNull();
      });
    });

    describe("list operation", () => {
      it("should return the stage's steps ordered by seq", async () => {
        await ledger.claim(
          claimRecord({
            stageRecordId: "stage-1",
            stepId: "step-c",
            seq: 3,
          }),
        );
        await ledger.claim(
          claimRecord({
            stageRecordId: "stage-1",
            stepId: "step-a",
            seq: 1,
          }),
        );
        await ledger.claim(
          claimRecord({
            stageRecordId: "stage-1",
            stepId: "step-b",
            seq: 2,
          }),
        );
        const steps = await ledger.list("stage-1");
        expect(steps.map((r) => r.stepId)).toEqual([
          "step-a",
          "step-b",
          "step-c",
        ]);
      });

      it("should return only the requested stage's steps", async () => {
        await ledger.claim(
          claimRecord({
            stageRecordId: "stage-1",
            stepId: "step-1",
            seq: 1,
          }),
        );
        await ledger.claim(
          claimRecord({
            stageRecordId: "stage-2",
            stepId: "step-2",
            seq: 1,
          }),
        );
        const list1 = await ledger.list("stage-1");
        expect(list1.length).toBe(1);
        expect(list1[0]?.stepId).toBe("step-1");
        expect(list1[0]?.stageRecordId).toBe("stage-1");

        const list2 = await ledger.list("stage-2");
        expect(list2.length).toBe(1);
        expect(list2[0]?.stepId).toBe("step-2");
        expect(list2[0]?.stageRecordId).toBe("stage-2");
      });

      it("should return an empty array for a stage with no steps", async () => {
        const steps = await ledger.list("stage-empty");
        expect(steps).toEqual([]);
      });
    });

    describe("clear and clearExcept operations", () => {
      it("should delete every row of the stage and leave other stages alone", async () => {
        await ledger.claim(
          claimRecord({
            stageRecordId: "stage-1",
            stepId: "step-1",
          }),
        );
        await ledger.claim(
          claimRecord({
            stageRecordId: "stage-1",
            stepId: "step-2",
          }),
        );
        await ledger.claim(
          claimRecord({
            stageRecordId: "stage-2",
            stepId: "step-3",
          }),
        );

        await ledger.clear("stage-1");

        const stage1Steps = await ledger.list("stage-1");
        expect(stage1Steps).toEqual([]);

        const stage2Steps = await ledger.list("stage-2");
        expect(stage2Steps.length).toBe(1);
        expect(stage2Steps[0]?.stepId).toBe("step-3");
      });

      it("should keep only the named steps and leave other stages alone", async () => {
        if (!ledger.clearExcept) return;

        await ledger.claim(
          claimRecord({
            stageRecordId: "stage-1",
            stepId: "step-keep",
          }),
        );
        await ledger.claim(
          claimRecord({
            stageRecordId: "stage-1",
            stepId: "step-delete",
          }),
        );
        await ledger.claim(
          claimRecord({
            stageRecordId: "stage-2",
            stepId: "step-other",
          }),
        );

        await ledger.clearExcept("stage-1", ["step-keep"]);

        const stage1Steps = await ledger.list("stage-1");
        expect(stage1Steps.length).toBe(1);
        expect(stage1Steps[0]?.stepId).toBe("step-keep");

        const stage2Steps = await ledger.list("stage-2");
        expect(stage2Steps.length).toBe(1);
        expect(stage2Steps[0]?.stepId).toBe("step-other");
      });

      it("should clear everything when clearExcept is given an empty keep list", async () => {
        if (!ledger.clearExcept) return;

        await ledger.claim(
          claimRecord({
            stageRecordId: "stage-1",
            stepId: "step-1",
          }),
        );
        await ledger.claim(
          claimRecord({
            stageRecordId: "stage-1",
            stepId: "step-2",
          }),
        );

        await ledger.clearExcept("stage-1", []);

        const stage1Steps = await ledger.list("stage-1");
        expect(stage1Steps).toEqual([]);
      });
    });
  });
}
