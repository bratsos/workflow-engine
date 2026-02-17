/**
 * PrismaWorkflowPersistence - Prisma implementation of WorkflowPersistence
 *
 * This is the default persistence implementation used by the workflow engine.
 * It wraps Prisma client operations to match the WorkflowPersistence interface.
 */

import type {
  CreateLogInput,
  CreateRunInput,
  CreateStageInput,
  SaveArtifactInput,
  UpdateRunInput,
  UpdateStageInput,
  UpsertStageInput,
  WorkflowArtifactRecord,
  WorkflowPersistence,
  WorkflowRunRecord,
  WorkflowStageRecord,
  WorkflowStageStatus,
  WorkflowStatus,
} from "../interface";
import { createEnumHelper, type PrismaEnumHelper } from "./enum-compat";

// Type for prisma client - using any to avoid dependency on specific prisma client
type PrismaClient = any;

export type DatabaseType = "postgresql" | "sqlite";

export interface PrismaWorkflowPersistenceOptions {
  /**
   * Database type. Defaults to "postgresql".
   * Set to "sqlite" when using SQLite (uses optimistic locking instead of FOR UPDATE SKIP LOCKED).
   */
  databaseType?: DatabaseType;
}

export class PrismaWorkflowPersistence implements WorkflowPersistence {
  private enums: PrismaEnumHelper;
  private databaseType: DatabaseType;

  constructor(
    private readonly prisma: PrismaClient,
    options: PrismaWorkflowPersistenceOptions = {},
  ) {
    this.enums = createEnumHelper(prisma);
    this.databaseType = options.databaseType ?? "postgresql";
  }

  // ============================================================================
  // WorkflowRun Operations
  // ============================================================================

  async createRun(data: CreateRunInput): Promise<WorkflowRunRecord> {
    const run = await this.prisma.workflowRun.create({
      data: {
        id: data.id,
        workflowId: data.workflowId,
        workflowName: data.workflowName,
        workflowType: data.workflowType,
        input: data.input as unknown,
        config: (data.config ?? {}) as unknown,
        priority: data.priority ?? 5,
        // Spread metadata for domain-specific fields (certificateId, etc.)
        ...(data.metadata ?? {}),
      },
    });
    return this.mapWorkflowRun(run);
  }

  async updateRun(id: string, data: UpdateRunInput): Promise<void> {
    await this.prisma.workflowRun.update({
      where: { id },
      data: {
        status: data.status ? this.enums.status(data.status) : undefined,
        startedAt: data.startedAt,
        completedAt: data.completedAt,
        duration: data.duration,
        output: data.output as unknown,
        totalCost: data.totalCost,
        totalTokens: data.totalTokens,
      },
    });
  }

  async getRun(id: string): Promise<WorkflowRunRecord | null> {
    const run = await this.prisma.workflowRun.findUnique({ where: { id } });
    return run ? this.mapWorkflowRun(run) : null;
  }

  async getRunStatus(id: string): Promise<WorkflowStatus | null> {
    const run = await this.prisma.workflowRun.findUnique({
      where: { id },
      select: { status: true },
    });
    return run?.status ?? null;
  }

  async getRunsByStatus(status: WorkflowStatus): Promise<WorkflowRunRecord[]> {
    const runs = await this.prisma.workflowRun.findMany({
      where: { status: this.enums.status(status) },
      orderBy: { createdAt: "asc" },
    });
    return runs.map((run: any) => this.mapWorkflowRun(run));
  }

  async claimPendingRun(id: string): Promise<boolean> {
    // Atomic update: only succeeds if status is still PENDING
    // This prevents race conditions when multiple workers try to claim the same run
    const result = await this.prisma.workflowRun.updateMany({
      where: {
        id,
        status: this.enums.status("PENDING"),
      },
      data: {
        status: this.enums.status("RUNNING"),
        startedAt: new Date(),
      },
    });

    // updateMany returns { count: N } - if count is 0, another worker already claimed it
    return result.count > 0;
  }

  async claimNextPendingRun(): Promise<WorkflowRunRecord | null> {
    if (this.databaseType === "sqlite") {
      return this.claimNextPendingRunSqlite();
    }
    return this.claimNextPendingRunPostgres();
  }

  /**
   * PostgreSQL implementation using FOR UPDATE SKIP LOCKED for zero-contention claiming.
   * This atomically:
   * 1. Finds the highest priority PENDING run (FIFO within same priority)
   * 2. Locks it exclusively (other workers skip locked rows)
   * 3. Updates it to RUNNING
   * 4. Returns the claimed run
   */
  private async claimNextPendingRunPostgres(): Promise<WorkflowRunRecord | null> {
    // Note: Table name is "workflow_runs" (snake_case per Prisma @@map convention)
    // Column names are camelCase (e.g., "createdAt", "startedAt")
    const results = await this.prisma.$queryRaw<any[]>`
      WITH claimed AS (
        SELECT id
        FROM "workflow_runs"
        WHERE status = ${this.enums.status("PENDING")}
        ORDER BY priority DESC, "createdAt" ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      )
      UPDATE "workflow_runs"
      SET status = ${this.enums.status("RUNNING")},
          "startedAt" = NOW(),
          "updatedAt" = NOW()
      FROM claimed
      WHERE "workflow_runs".id = claimed.id
      RETURNING "workflow_runs".*
    `;

    if (results.length === 0) {
      return null;
    }

    return this.mapWorkflowRun(results[0]);
  }

  /**
   * SQLite implementation using optimistic locking.
   * SQLite doesn't support FOR UPDATE SKIP LOCKED, so we use a two-step approach:
   * 1. Find a PENDING run
   * 2. Atomically update it (only succeeds if still PENDING)
   * 3. If another worker claimed it, retry
   */
  private async claimNextPendingRunSqlite(): Promise<WorkflowRunRecord | null> {
    // Step 1: Find the next PENDING run
    const run = await this.prisma.workflowRun.findFirst({
      where: { status: this.enums.status("PENDING") },
      orderBy: [{ priority: "desc" }, { createdAt: "asc" }],
    });

    if (!run) {
      return null;
    }

    // Step 2: Atomically claim it (only succeeds if still PENDING)
    const result = await this.prisma.workflowRun.updateMany({
      where: {
        id: run.id,
        status: this.enums.status("PENDING"), // Optimistic lock
      },
      data: {
        status: this.enums.status("RUNNING"),
        startedAt: new Date(),
        updatedAt: new Date(),
      },
    });

    if (result.count === 0) {
      // Another worker claimed it, retry
      return this.claimNextPendingRunSqlite();
    }

    // Fetch the updated record
    const claimedRun = await this.prisma.workflowRun.findUnique({
      where: { id: run.id },
    });

    return claimedRun ? this.mapWorkflowRun(claimedRun) : null;
  }

  // ============================================================================
  // WorkflowStage Operations
  // ============================================================================

  async createStage(data: CreateStageInput): Promise<WorkflowStageRecord> {
    const stage = await this.prisma.workflowStage.create({
      data: {
        workflowRunId: data.workflowRunId,
        stageId: data.stageId,
        stageName: data.stageName,
        stageNumber: data.stageNumber,
        executionGroup: data.executionGroup,
        status: data.status
          ? this.enums.status(data.status)
          : this.enums.status("PENDING"),
        startedAt: data.startedAt,
        config: data.config as unknown,
        inputData: data.inputData as unknown,
      },
    });
    return this.mapWorkflowStage(stage);
  }

  async upsertStage(data: UpsertStageInput): Promise<WorkflowStageRecord> {
    const stage = await this.prisma.workflowStage.upsert({
      where: {
        workflowRunId_stageId: {
          workflowRunId: data.workflowRunId,
          stageId: data.stageId,
        },
      },
      create: {
        workflowRunId: data.create.workflowRunId,
        stageId: data.create.stageId,
        stageName: data.create.stageName,
        stageNumber: data.create.stageNumber,
        executionGroup: data.create.executionGroup,
        status: data.create.status
          ? this.enums.status(data.create.status)
          : this.enums.status("RUNNING"),
        startedAt: data.create.startedAt ?? new Date(),
        config: data.create.config as unknown,
        inputData: data.create.inputData as unknown,
      },
      update: {
        status: data.update.status
          ? this.enums.status(data.update.status)
          : undefined,
        startedAt: data.update.startedAt,
      },
    });
    return this.mapWorkflowStage(stage);
  }

  async updateStage(id: string, data: UpdateStageInput): Promise<void> {
    await this.prisma.workflowStage.update({
      where: { id },
      data: this.buildStageUpdateData(data),
    });
  }

  async updateStageByRunAndStageId(
    workflowRunId: string,
    stageId: string,
    data: UpdateStageInput,
  ): Promise<void> {
    await this.prisma.workflowStage.update({
      where: {
        workflowRunId_stageId: { workflowRunId, stageId },
      },
      data: this.buildStageUpdateData(data),
    });
  }

  private buildStageUpdateData(
    data: UpdateStageInput,
  ): Record<string, unknown> {
    return {
      status: data.status ? this.enums.status(data.status) : undefined,
      startedAt: data.startedAt,
      completedAt: data.completedAt,
      duration: data.duration,
      outputData: data.outputData as unknown,
      config: data.config as unknown,
      suspendedState: data.suspendedState as unknown,
      resumeData: data.resumeData as unknown,
      nextPollAt: data.nextPollAt,
      pollInterval: data.pollInterval,
      maxWaitUntil: data.maxWaitUntil,
      metrics: data.metrics as unknown,
      embeddingInfo: data.embeddingInfo as unknown,
      errorMessage: data.errorMessage,
    };
  }

  async getStage(
    runId: string,
    stageId: string,
  ): Promise<WorkflowStageRecord | null> {
    const stage = await this.prisma.workflowStage.findUnique({
      where: {
        workflowRunId_stageId: { workflowRunId: runId, stageId },
      },
    });
    return stage ? this.mapWorkflowStage(stage) : null;
  }

  async getStageById(id: string): Promise<WorkflowStageRecord | null> {
    const stage = await this.prisma.workflowStage.findUnique({ where: { id } });
    return stage ? this.mapWorkflowStage(stage) : null;
  }

  async getStagesByRun(
    runId: string,
    options?: { status?: WorkflowStageStatus; orderBy?: "asc" | "desc" },
  ): Promise<WorkflowStageRecord[]> {
    const stages = await this.prisma.workflowStage.findMany({
      where: {
        workflowRunId: runId,
        ...(options?.status && { status: this.enums.status(options.status) }),
      },
      orderBy: { executionGroup: options?.orderBy ?? "asc" },
    });
    return stages.map((s: Record<string, unknown>) => this.mapWorkflowStage(s));
  }

  async getSuspendedStages(beforeDate: Date): Promise<WorkflowStageRecord[]> {
    const stages = await this.prisma.workflowStage.findMany({
      where: {
        status: this.enums.status("SUSPENDED"),
        nextPollAt: { lte: beforeDate },
      },
      include: {
        workflowRun: { select: { workflowType: true } },
      },
    });
    return stages.map((s: Record<string, unknown>) => this.mapWorkflowStage(s));
  }

  async getFirstSuspendedStageReadyToResume(
    runId: string,
  ): Promise<WorkflowStageRecord | null> {
    const stage = await this.prisma.workflowStage.findFirst({
      where: {
        workflowRunId: runId,
        status: this.enums.status("SUSPENDED"),
        nextPollAt: null, // Ready to resume (poll cleared by orchestrator)
      },
      orderBy: { executionGroup: "asc" },
    });
    return stage ? this.mapWorkflowStage(stage) : null;
  }

  async getFirstFailedStage(
    runId: string,
  ): Promise<WorkflowStageRecord | null> {
    const stage = await this.prisma.workflowStage.findFirst({
      where: {
        workflowRunId: runId,
        status: this.enums.status("FAILED"),
      },
      orderBy: { executionGroup: "desc" },
    });
    return stage ? this.mapWorkflowStage(stage) : null;
  }

  async getLastCompletedStage(
    runId: string,
  ): Promise<WorkflowStageRecord | null> {
    const stage = await this.prisma.workflowStage.findFirst({
      where: {
        workflowRunId: runId,
        status: this.enums.status("COMPLETED"),
      },
      orderBy: { executionGroup: "desc" },
    });
    return stage ? this.mapWorkflowStage(stage) : null;
  }

  async getLastCompletedStageBefore(
    runId: string,
    executionGroup: number,
  ): Promise<WorkflowStageRecord | null> {
    const stage = await this.prisma.workflowStage.findFirst({
      where: {
        workflowRunId: runId,
        status: this.enums.status("COMPLETED"),
        executionGroup: { lt: executionGroup },
      },
      orderBy: { executionGroup: "desc" },
    });
    return stage ? this.mapWorkflowStage(stage) : null;
  }

  async deleteStage(id: string): Promise<void> {
    await this.prisma.workflowStage.delete({ where: { id } });
  }

  // ============================================================================
  // WorkflowLog Operations
  // ============================================================================

  async createLog(data: CreateLogInput): Promise<void> {
    await this.prisma.workflowLog.create({
      data: {
        workflowRunId: data.workflowRunId,
        workflowStageId: data.workflowStageId,
        level: this.enums.logLevel(data.level),
        message: data.message,
        metadata: data.metadata as unknown,
      },
    });
  }

  // ============================================================================
  // WorkflowArtifact Operations
  // ============================================================================

  async saveArtifact(data: SaveArtifactInput): Promise<void> {
    await this.prisma.workflowArtifact.upsert({
      where: {
        workflowRunId_key: {
          workflowRunId: data.workflowRunId,
          key: data.key,
        },
      },
      create: {
        workflowRunId: data.workflowRunId,
        workflowStageId: data.workflowStageId,
        key: data.key,
        type: this.enums.artifactType(data.type),
        data: data.data as unknown,
        size: data.size,
        metadata: data.metadata as unknown,
      },
      update: {
        data: data.data as unknown,
        size: data.size,
        metadata: data.metadata as unknown,
      },
    });
  }

  async loadArtifact(runId: string, key: string): Promise<unknown> {
    const artifact = await this.prisma.workflowArtifact.findUnique({
      where: {
        workflowRunId_key: { workflowRunId: runId, key },
      },
    });
    return artifact?.data;
  }

  async hasArtifact(runId: string, key: string): Promise<boolean> {
    const artifact = await this.prisma.workflowArtifact.findUnique({
      where: {
        workflowRunId_key: { workflowRunId: runId, key },
      },
      select: { id: true },
    });
    return artifact !== null;
  }

  async deleteArtifact(runId: string, key: string): Promise<void> {
    await this.prisma.workflowArtifact.delete({
      where: {
        workflowRunId_key: { workflowRunId: runId, key },
      },
    });
  }

  async listArtifacts(runId: string): Promise<WorkflowArtifactRecord[]> {
    const artifacts = await this.prisma.workflowArtifact.findMany({
      where: { workflowRunId: runId },
    });
    return artifacts.map((a: Record<string, unknown>) =>
      this.mapWorkflowArtifact(a),
    );
  }

  async getStageIdForArtifact(
    runId: string,
    stageId: string,
  ): Promise<string | null> {
    const stage = await this.prisma.workflowStage.findUnique({
      where: {
        workflowRunId_stageId: { workflowRunId: runId, stageId },
      },
      select: { id: true },
    });
    return stage?.id ?? null;
  }

  // ============================================================================
  // Stage Output Convenience Methods
  // ============================================================================

  async saveStageOutput(
    runId: string,
    workflowType: string,
    stageId: string,
    output: unknown,
  ): Promise<string> {
    // Generate key with consistent pattern: workflow-v2/{type}/{runId}/{stageId}/output.json
    const key = `workflow-v2/${workflowType}/${runId}/${stageId}/output.json`;

    const json = JSON.stringify(output);
    const size = Buffer.byteLength(json, "utf8");

    // Get the workflowStage record ID for linking
    const workflowStageId = await this.getStageIdForArtifact(runId, stageId);

    await this.prisma.workflowArtifact.upsert({
      where: {
        workflowRunId_key: { workflowRunId: runId, key },
      },
      update: {
        data: output as unknown,
        size,
        workflowStageId,
      },
      create: {
        workflowRunId: runId,
        workflowStageId,
        key,
        type: this.enums.artifactType("STAGE_OUTPUT"),
        data: output as unknown,
        size,
      },
    });

    return key;
  }

  // ============================================================================
  // Outbox DLQ Operations (stubs - not yet implemented for Prisma)
  // ============================================================================

  async incrementOutboxRetryCount(_id: string): Promise<number> {
    throw new Error("Not implemented: incrementOutboxRetryCount");
  }

  async moveOutboxEventToDLQ(_id: string): Promise<void> {
    throw new Error("Not implemented: moveOutboxEventToDLQ");
  }

  async replayDLQEvents(_maxEvents: number): Promise<number> {
    throw new Error("Not implemented: replayDLQEvents");
  }

  // ============================================================================
  // Type Mappers
  // ============================================================================

  private mapWorkflowRun(run: any): WorkflowRunRecord {
    return {
      id: run.id,
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
      workflowId: run.workflowId,
      workflowName: run.workflowName,
      workflowType: run.workflowType,
      status: run.status,
      startedAt: run.startedAt,
      completedAt: run.completedAt,
      duration: run.duration,
      input: run.input,
      output: run.output,
      config: run.config,
      totalCost: run.totalCost,
      totalTokens: run.totalTokens,
      priority: run.priority,
      version: run.version ?? 0,
    };
  }

  private mapWorkflowStage(stage: any): WorkflowStageRecord {
    return {
      id: stage.id,
      createdAt: stage.createdAt,
      updatedAt: stage.updatedAt,
      workflowRunId: stage.workflowRunId,
      stageId: stage.stageId,
      stageName: stage.stageName,
      stageNumber: stage.stageNumber,
      executionGroup: stage.executionGroup,
      status: stage.status,
      startedAt: stage.startedAt,
      completedAt: stage.completedAt,
      duration: stage.duration,
      inputData: stage.inputData,
      outputData: stage.outputData,
      config: stage.config,
      suspendedState: stage.suspendedState,
      resumeData: stage.resumeData,
      nextPollAt: stage.nextPollAt,
      pollInterval: stage.pollInterval,
      maxWaitUntil: stage.maxWaitUntil,
      metrics: stage.metrics,
      embeddingInfo: stage.embeddingInfo,
      errorMessage: stage.errorMessage,
      version: stage.version ?? 0,
    };
  }

  private mapWorkflowArtifact(artifact: any): WorkflowArtifactRecord {
    return {
      id: artifact.id,
      createdAt: artifact.createdAt,
      updatedAt: artifact.updatedAt,
      workflowRunId: artifact.workflowRunId,
      workflowStageId: artifact.workflowStageId,
      key: artifact.key,
      type: artifact.type,
      data: artifact.data,
      size: artifact.size,
      metadata: artifact.metadata,
    };
  }
}

/**
 * Factory function to create PrismaWorkflowPersistence
 */
export function createPrismaWorkflowPersistence(
  prisma: PrismaClient,
  options?: PrismaWorkflowPersistenceOptions,
): PrismaWorkflowPersistence {
  return new PrismaWorkflowPersistence(prisma, options);
}
