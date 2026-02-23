/**
 * In-Memory Workflow Persistence
 *
 * A complete in-memory implementation of WorkflowPersistence for testing.
 * All data is stored in Maps and lost when the instance is garbage collected.
 *
 * @example
 * ```typescript
 * import { InMemoryWorkflowPersistence } from '@bratsos/workflow-engine/testing';
 *
 * const persistence = new InMemoryWorkflowPersistence();
 * // Use in tests...
 * persistence.clear(); // Reset between tests
 * ```
 */

import { randomUUID } from "crypto";
import {
  type CreateLogInput,
  type CreateOutboxEventInput,
  type CreateRunInput,
  type CreateStageInput,
  type IdempotencyRecord,
  type OutboxRecord,
  type SaveArtifactInput,
  StaleVersionError,
  type UpdateRunInput,
  type UpdateStageInput,
  type UpsertStageInput,
  type WorkflowArtifactRecord,
  type WorkflowLogRecord,
  type WorkflowPersistence,
  type WorkflowRunRecord,
  type WorkflowStageRecord,
  type WorkflowStageStatus,
  type WorkflowStatus,
} from "../persistence/interface.js";

export class InMemoryWorkflowPersistence implements WorkflowPersistence {
  private runs = new Map<string, WorkflowRunRecord>();
  private stages = new Map<string, WorkflowStageRecord>();
  private logs = new Map<string, WorkflowLogRecord>();
  private artifacts = new Map<string, WorkflowArtifactRecord>();
  private outbox: OutboxRecord[] = [];
  private idempotencyKeys = new Map<string, IdempotencyRecord>();
  private idempotencyInProgress = new Set<string>();
  private outboxSequences = new Map<string, number>();

  // Helper to generate composite keys for stages
  private stageKey(runId: string, stageId: string): string {
    return `${runId}:${stageId}`;
  }

  // Helper to generate composite keys for artifacts
  private artifactKey(runId: string, key: string): string {
    return `${runId}:${key}`;
  }

  private idempotencyCompositeKey(commandType: string, key: string): string {
    return `${commandType}:${key}`;
  }

  async withTransaction<T>(
    fn: (tx: WorkflowPersistence) => Promise<T>,
  ): Promise<T> {
    return fn(this);
  }

  // ============================================================================
  // WorkflowRun Operations
  // ============================================================================

  async createRun(data: CreateRunInput): Promise<WorkflowRunRecord> {
    const now = new Date();
    const record: WorkflowRunRecord = {
      id: data.id ?? randomUUID(),
      createdAt: now,
      updatedAt: now,
      version: 1,
      workflowId: data.workflowId,
      workflowName: data.workflowName,
      workflowType: data.workflowType,
      status: "PENDING",
      startedAt: null,
      completedAt: null,
      duration: null,
      input: data.input,
      output: null,
      config: data.config ?? {},
      totalCost: 0,
      totalTokens: 0,
      priority: data.priority ?? 5,
    };
    this.runs.set(record.id, record);
    return { ...record };
  }

  async updateRun(id: string, data: UpdateRunInput): Promise<void> {
    const run = this.runs.get(id);
    if (!run) {
      throw new Error(`WorkflowRun not found: ${id}`);
    }

    if (
      data.expectedVersion !== undefined &&
      run.version !== data.expectedVersion
    ) {
      throw new StaleVersionError(
        "WorkflowRun",
        id,
        data.expectedVersion,
        run.version,
      );
    }

    const { expectedVersion: _, ...rest } = data;
    const updated: WorkflowRunRecord = {
      ...run,
      ...rest,
      updatedAt: new Date(),
      version: run.version + 1,
    };
    this.runs.set(id, updated);
  }

  async getRun(id: string): Promise<WorkflowRunRecord | null> {
    const run = this.runs.get(id);
    return run ? { ...run } : null;
  }

  async getRunStatus(id: string): Promise<WorkflowStatus | null> {
    const run = this.runs.get(id);
    return run?.status ?? null;
  }

  async getRunsByStatus(status: WorkflowStatus): Promise<WorkflowRunRecord[]> {
    return Array.from(this.runs.values())
      .filter((run) => run.status === status)
      .map((run) => ({ ...run }));
  }

  async claimPendingRun(id: string): Promise<boolean> {
    const run = this.runs.get(id);
    if (!run || run.status !== "PENDING") {
      return false;
    }

    // Atomically update status to RUNNING
    const updated: WorkflowRunRecord = {
      ...run,
      status: "RUNNING",
      startedAt: new Date(),
      updatedAt: new Date(),
      version: run.version + 1,
    };
    this.runs.set(id, updated);
    return true;
  }

  async claimNextPendingRun(): Promise<WorkflowRunRecord | null> {
    // Find all pending runs
    const pendingRuns = Array.from(this.runs.values())
      .filter((run) => run.status === "PENDING")
      // Sort by priority (highest first), then by createdAt (oldest first - FIFO)
      .sort((a, b) => {
        if (a.priority !== b.priority) {
          return b.priority - a.priority; // Higher priority first
        }
        return a.createdAt.getTime() - b.createdAt.getTime(); // Oldest first
      });

    if (pendingRuns.length === 0) {
      return null;
    }

    // Get the first one and atomically claim it
    const runToClaim = pendingRuns[0];

    // Double-check it's still pending (simulates FOR UPDATE SKIP LOCKED behavior)
    const currentRun = this.runs.get(runToClaim.id);
    if (!currentRun || currentRun.status !== "PENDING") {
      // Another worker claimed it between our query and now
      // In real FOR UPDATE SKIP LOCKED, this row would be skipped
      // Try the next one recursively
      return this.claimNextPendingRun();
    }

    // Atomically update status to RUNNING
    const claimed: WorkflowRunRecord = {
      ...currentRun,
      status: "RUNNING",
      startedAt: new Date(),
      updatedAt: new Date(),
      version: currentRun.version + 1,
    };
    this.runs.set(claimed.id, claimed);

    return { ...claimed };
  }

  // ============================================================================
  // WorkflowStage Operations
  // ============================================================================

  async createStage(data: CreateStageInput): Promise<WorkflowStageRecord> {
    const now = new Date();
    const id = randomUUID();
    const record: WorkflowStageRecord = {
      id,
      createdAt: now,
      updatedAt: now,
      version: 1,
      workflowRunId: data.workflowRunId,
      stageId: data.stageId,
      stageName: data.stageName,
      stageNumber: data.stageNumber,
      executionGroup: data.executionGroup,
      status: data.status ?? "PENDING",
      startedAt: data.startedAt ?? null,
      completedAt: null,
      duration: null,
      inputData: data.inputData ?? null,
      outputData: null,
      config: data.config ?? null,
      suspendedState: null,
      resumeData: null,
      nextPollAt: null,
      pollInterval: null,
      maxWaitUntil: null,
      metrics: null,
      embeddingInfo: null,
      errorMessage: null,
    };

    this.stages.set(id, record);
    // Also index by composite key for lookups
    this.stages.set(this.stageKey(data.workflowRunId, data.stageId), record);
    return { ...record };
  }

  async upsertStage(data: UpsertStageInput): Promise<WorkflowStageRecord> {
    const key = this.stageKey(data.workflowRunId, data.stageId);
    const existing = this.stages.get(key);

    if (existing) {
      const updated: WorkflowStageRecord = {
        ...existing,
        ...data.update,
        updatedAt: new Date(),
        version: existing.version + 1,
      };
      this.stages.set(existing.id, updated);
      this.stages.set(key, updated);
      return { ...updated };
    } else {
      return this.createStage(data.create);
    }
  }

  async updateStage(id: string, data: UpdateStageInput): Promise<void> {
    const stage = this.stages.get(id);
    if (!stage) {
      throw new Error(`WorkflowStage not found: ${id}`);
    }

    if (
      data.expectedVersion !== undefined &&
      stage.version !== data.expectedVersion
    ) {
      throw new StaleVersionError(
        "WorkflowStage",
        id,
        data.expectedVersion,
        stage.version,
      );
    }

    const { expectedVersion: _, ...rest } = data;
    const updated: WorkflowStageRecord = {
      ...stage,
      ...rest,
      updatedAt: new Date(),
      version: stage.version + 1,
    };
    this.stages.set(id, updated);
    this.stages.set(this.stageKey(stage.workflowRunId, stage.stageId), updated);
  }

  async updateStageByRunAndStageId(
    workflowRunId: string,
    stageId: string,
    data: UpdateStageInput,
  ): Promise<void> {
    const key = this.stageKey(workflowRunId, stageId);
    const stage = this.stages.get(key);
    if (!stage) {
      throw new Error(`WorkflowStage not found: ${workflowRunId}/${stageId}`);
    }

    if (
      data.expectedVersion !== undefined &&
      stage.version !== data.expectedVersion
    ) {
      throw new StaleVersionError(
        "WorkflowStage",
        `${workflowRunId}/${stageId}`,
        data.expectedVersion,
        stage.version,
      );
    }

    const { expectedVersion: _, ...rest } = data;
    const updated: WorkflowStageRecord = {
      ...stage,
      ...rest,
      updatedAt: new Date(),
      version: stage.version + 1,
    };
    this.stages.set(stage.id, updated);
    this.stages.set(key, updated);
  }

  async getStage(
    runId: string,
    stageId: string,
  ): Promise<WorkflowStageRecord | null> {
    const key = this.stageKey(runId, stageId);
    const stage = this.stages.get(key);
    return stage ? { ...stage } : null;
  }

  async getStageById(id: string): Promise<WorkflowStageRecord | null> {
    const stage = this.stages.get(id);
    return stage ? { ...stage } : null;
  }

  async getStagesByRun(
    runId: string,
    options?: { status?: WorkflowStageStatus; orderBy?: "asc" | "desc" },
  ): Promise<WorkflowStageRecord[]> {
    // Use a Set to track seen IDs and avoid duplicates from composite keys
    const seenIds = new Set<string>();
    let stages = Array.from(this.stages.values()).filter((s) => {
      if (s.workflowRunId !== runId) return false;
      if (seenIds.has(s.id)) return false;
      seenIds.add(s.id);
      return true;
    });

    if (options?.status) {
      stages = stages.filter((s) => s.status === options.status);
    }

    // Sort by stageNumber
    stages.sort((a, b) => {
      const diff = a.stageNumber - b.stageNumber;
      return options?.orderBy === "desc" ? -diff : diff;
    });

    return stages.map((s) => ({ ...s }));
  }

  async getSuspendedStages(beforeDate: Date): Promise<WorkflowStageRecord[]> {
    const seenIds = new Set<string>();
    return Array.from(this.stages.values())
      .filter((s) => {
        if (seenIds.has(s.id)) return false;
        seenIds.add(s.id);
        return (
          s.status === "SUSPENDED" &&
          s.nextPollAt !== null &&
          s.nextPollAt <= beforeDate
        );
      })
      .map((s) => ({ ...s }));
  }

  async getFirstSuspendedStageReadyToResume(
    runId: string,
  ): Promise<WorkflowStageRecord | null> {
    const stages = await this.getStagesByRun(runId, { status: "SUSPENDED" });
    const now = new Date();
    const ready = stages.find((s) => s.nextPollAt && s.nextPollAt <= now);
    return ready ?? null;
  }

  async getFirstFailedStage(
    runId: string,
  ): Promise<WorkflowStageRecord | null> {
    const stages = await this.getStagesByRun(runId, { status: "FAILED" });
    return stages[0] ?? null;
  }

  async getLastCompletedStage(
    runId: string,
  ): Promise<WorkflowStageRecord | null> {
    const stages = await this.getStagesByRun(runId, {
      status: "COMPLETED",
      orderBy: "desc",
    });
    return stages[0] ?? null;
  }

  async getLastCompletedStageBefore(
    runId: string,
    executionGroup: number,
  ): Promise<WorkflowStageRecord | null> {
    const stages = await this.getStagesByRun(runId, {
      status: "COMPLETED",
      orderBy: "desc",
    });
    const before = stages.filter((s) => s.executionGroup < executionGroup);
    return before[0] ?? null;
  }

  async deleteStage(id: string): Promise<void> {
    const stage = this.stages.get(id);
    if (stage) {
      this.stages.delete(id);
      this.stages.delete(this.stageKey(stage.workflowRunId, stage.stageId));
    }
  }

  // ============================================================================
  // WorkflowLog Operations
  // ============================================================================

  async createLog(data: CreateLogInput): Promise<void> {
    const record: WorkflowLogRecord = {
      id: randomUUID(),
      createdAt: new Date(),
      workflowRunId: data.workflowRunId ?? null,
      workflowStageId: data.workflowStageId ?? null,
      level: data.level,
      message: data.message,
      metadata: data.metadata ?? null,
    };
    this.logs.set(record.id, record);
  }

  // ============================================================================
  // Outbox Operations
  // ============================================================================

  async appendOutboxEvents(events: CreateOutboxEventInput[]): Promise<void> {
    for (const event of events) {
      const currentSeq = this.outboxSequences.get(event.workflowRunId) ?? 0;
      const nextSeq = currentSeq + 1;
      this.outboxSequences.set(event.workflowRunId, nextSeq);

      const record: OutboxRecord = {
        id: randomUUID(),
        workflowRunId: event.workflowRunId,
        sequence: nextSeq,
        eventType: event.eventType,
        payload: event.payload,
        causationId: event.causationId,
        occurredAt: event.occurredAt,
        publishedAt: null,
        retryCount: 0,
        dlqAt: null,
      };
      this.outbox.push(record);
    }
  }

  async getUnpublishedOutboxEvents(limit?: number): Promise<OutboxRecord[]> {
    const effectiveLimit = limit ?? 100;
    return this.outbox
      .filter((r) => r.publishedAt === null && r.dlqAt === null)
      .sort((a, b) => {
        const runCmp = a.workflowRunId.localeCompare(b.workflowRunId);
        if (runCmp !== 0) return runCmp;
        return a.sequence - b.sequence;
      })
      .slice(0, effectiveLimit)
      .map((r) => ({ ...r }));
  }

  async markOutboxEventsPublished(ids: string[]): Promise<void> {
    const idSet = new Set(ids);
    for (const record of this.outbox) {
      if (idSet.has(record.id)) {
        record.publishedAt = new Date();
      }
    }
  }

  async incrementOutboxRetryCount(id: string): Promise<number> {
    const record = this.outbox.find((r) => r.id === id);
    if (!record) throw new Error(`Outbox event not found: ${id}`);
    record.retryCount++;
    return record.retryCount;
  }

  async moveOutboxEventToDLQ(id: string): Promise<void> {
    const record = this.outbox.find((r) => r.id === id);
    if (!record) throw new Error(`Outbox event not found: ${id}`);
    record.dlqAt = new Date();
  }

  async replayDLQEvents(maxEvents: number): Promise<number> {
    const dlqEvents = this.outbox
      .filter((r) => r.dlqAt !== null)
      .slice(0, maxEvents);
    for (const record of dlqEvents) {
      record.dlqAt = null;
      record.retryCount = 0;
    }
    return dlqEvents.length;
  }

  // ============================================================================
  // Idempotency Operations
  // ============================================================================

  async acquireIdempotencyKey(
    key: string,
    commandType: string,
  ): Promise<
    | { status: "acquired" }
    | { status: "replay"; result: unknown }
    | { status: "in_progress" }
  > {
    const compositeKey = this.idempotencyCompositeKey(commandType, key);
    const record = this.idempotencyKeys.get(compositeKey);
    if (record) {
      return { status: "replay", result: record.result };
    }
    if (this.idempotencyInProgress.has(compositeKey)) {
      return { status: "in_progress" };
    }
    this.idempotencyInProgress.add(compositeKey);
    return { status: "acquired" };
  }

  async completeIdempotencyKey(
    key: string,
    commandType: string,
    result: unknown,
  ): Promise<void> {
    const compositeKey = this.idempotencyCompositeKey(commandType, key);
    this.idempotencyInProgress.delete(compositeKey);
    this.idempotencyKeys.set(compositeKey, {
      key,
      commandType,
      result,
      createdAt: new Date(),
    });
  }

  async releaseIdempotencyKey(key: string, commandType: string): Promise<void> {
    this.idempotencyInProgress.delete(
      this.idempotencyCompositeKey(commandType, key),
    );
  }

  // ============================================================================
  // WorkflowArtifact Operations
  // ============================================================================

  async saveArtifact(data: SaveArtifactInput): Promise<void> {
    const now = new Date();
    const key = this.artifactKey(data.workflowRunId, data.key);
    const existing = this.artifacts.get(key);

    const record: WorkflowArtifactRecord = {
      id: existing?.id ?? randomUUID(),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      workflowRunId: data.workflowRunId,
      workflowStageId: data.workflowStageId ?? null,
      key: data.key,
      type: data.type,
      data: data.data,
      size: data.size,
      metadata: data.metadata ?? null,
    };
    this.artifacts.set(key, record);
  }

  async loadArtifact(runId: string, key: string): Promise<unknown> {
    const artifact = this.artifacts.get(this.artifactKey(runId, key));
    if (!artifact) {
      throw new Error(`Artifact not found: ${runId}/${key}`);
    }
    return artifact.data;
  }

  async hasArtifact(runId: string, key: string): Promise<boolean> {
    return this.artifacts.has(this.artifactKey(runId, key));
  }

  async deleteArtifact(runId: string, key: string): Promise<void> {
    this.artifacts.delete(this.artifactKey(runId, key));
  }

  async listArtifacts(runId: string): Promise<WorkflowArtifactRecord[]> {
    return Array.from(this.artifacts.values())
      .filter((a) => a.workflowRunId === runId)
      .map((a) => ({ ...a }));
  }

  async getStageIdForArtifact(
    runId: string,
    stageId: string,
  ): Promise<string | null> {
    const stage = await this.getStage(runId, stageId);
    return stage?.id ?? null;
  }

  // ============================================================================
  // Stage Output Convenience Method
  // ============================================================================

  async saveStageOutput(
    runId: string,
    workflowType: string,
    stageId: string,
    output: unknown,
  ): Promise<string> {
    const key = `workflow-v2/${workflowType}/${runId}/${stageId}/output.json`;
    const stageDbId = await this.getStageIdForArtifact(runId, stageId);

    await this.saveArtifact({
      workflowRunId: runId,
      workflowStageId: stageDbId ?? undefined,
      key,
      type: "STAGE_OUTPUT",
      data: output,
      size: JSON.stringify(output).length,
    });

    return key;
  }

  // ============================================================================
  // Test Helpers
  // ============================================================================

  /**
   * Clear all data - useful between tests
   */
  clear(): void {
    this.runs.clear();
    this.stages.clear();
    this.logs.clear();
    this.artifacts.clear();
    this.outbox = [];
    this.idempotencyKeys.clear();
    this.idempotencyInProgress.clear();
    this.outboxSequences.clear();
  }

  /**
   * Get all runs for inspection
   */
  getAllRuns(): WorkflowRunRecord[] {
    return Array.from(this.runs.values()).map((r) => ({ ...r }));
  }

  /**
   * Get all stages for inspection
   */
  getAllStages(): WorkflowStageRecord[] {
    // Filter out composite key duplicates
    return Array.from(this.stages.values())
      .filter((s) => this.stages.get(s.id) === s)
      .map((s) => ({ ...s }));
  }

  /**
   * Get all logs for inspection
   */
  getAllLogs(): WorkflowLogRecord[] {
    return Array.from(this.logs.values()).map((l) => ({ ...l }));
  }

  /**
   * Get all artifacts for inspection
   */
  getAllArtifacts(): WorkflowArtifactRecord[] {
    return Array.from(this.artifacts.values()).map((a) => ({ ...a }));
  }
}
