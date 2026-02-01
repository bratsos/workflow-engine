/**
 * In-Memory Workflow Persistence
 *
 * A complete in-memory implementation of WorkflowPersistence for testing.
 * All data is stored in Maps and lost when the instance is garbage collected.
 */

import { randomUUID } from "crypto";
import type {
  WorkflowPersistence,
  WorkflowRunRecord,
  WorkflowStageRecord,
  WorkflowLogRecord,
  WorkflowArtifactRecord,
  WorkflowStatus,
  WorkflowStageStatus,
  CreateRunInput,
  UpdateRunInput,
  CreateStageInput,
  UpdateStageInput,
  UpsertStageInput,
  CreateLogInput,
  SaveArtifactInput,
} from "../../persistence/interface.js";

export class InMemoryWorkflowPersistence implements WorkflowPersistence {
  private runs = new Map<string, WorkflowRunRecord>();
  private stages = new Map<string, WorkflowStageRecord>();
  private logs = new Map<string, WorkflowLogRecord>();
  private artifacts = new Map<string, WorkflowArtifactRecord>();

  // Helper to generate composite keys for stages
  private stageKey(runId: string, stageId: string): string {
    return `${runId}:${stageId}`;
  }

  // Helper to generate composite keys for artifacts
  private artifactKey(runId: string, key: string): string {
    return `${runId}:${key}`;
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

    const updated: WorkflowRunRecord = {
      ...run,
      ...data,
      updatedAt: new Date(),
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

    const updated: WorkflowStageRecord = {
      ...stage,
      ...data,
      updatedAt: new Date(),
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

    const updated: WorkflowStageRecord = {
      ...stage,
      ...data,
      updatedAt: new Date(),
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
    return Array.from(this.stages.values())
      .filter(
        (s) =>
          s.status === "SUSPENDED" &&
          s.nextPollAt &&
          s.nextPollAt <= beforeDate &&
          this.stages.get(s.id) === s,
      )
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
  // Test Helpers (not part of interface)
  // ============================================================================

  /**
   * Clear all data - useful between tests
   */
  clear(): void {
    this.runs.clear();
    this.stages.clear();
    this.logs.clear();
    this.artifacts.clear();
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
