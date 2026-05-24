/**
 * PrismaWorkflowPersistence - Prisma implementation of WorkflowPersistence
 *
 * This is the default persistence implementation used by the workflow engine.
 * It wraps Prisma client operations to match the WorkflowPersistence interface.
 */

import type {
  AnnotationFilters,
  CreateAnnotationInput,
  CreateLogInput,
  CreateOutboxEventInput,
  CreateRunInput,
  CreateStageInput,
  OutboxRecord,
  SaveArtifactInput,
  UpdateRunInput,
  UpdateStageInput,
  UpsertStageInput,
  WorkflowAnnotationRecord,
  WorkflowArtifactRecord,
  WorkflowPersistence,
  WorkflowRunRecord,
  WorkflowStageRecord,
  WorkflowStageStatus,
  WorkflowStatus,
} from "../interface";
import { StaleVersionError } from "../interface";
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
  /**
   * Skip interactive transactions. Defaults to false.
   * Set to true in single-process environments where transactions are not needed.
   */
  skipInteractiveTransactions?: boolean;
}

const IDEMPOTENCY_IN_PROGRESS_MARKER = {
  __workflowEngineState: "in_progress",
};

function isInProgressResult(result: unknown): boolean {
  if (!result || typeof result !== "object") return false;
  return (
    (result as Record<string, unknown>).__workflowEngineState === "in_progress"
  );
}

export class PrismaWorkflowPersistence implements WorkflowPersistence {
  private enums: PrismaEnumHelper;
  private databaseType: DatabaseType;
  private skipTransactions: boolean;

  constructor(
    private readonly prisma: PrismaClient,
    options: PrismaWorkflowPersistenceOptions = {},
  ) {
    this.enums = createEnumHelper(prisma);
    this.databaseType = options.databaseType ?? "postgresql";
    this.skipTransactions = options.skipInteractiveTransactions ?? false;
  }

  async withTransaction<T>(
    fn: (tx: WorkflowPersistence) => Promise<T>,
  ): Promise<T> {
    if (
      this.skipTransactions ||
      typeof this.prisma.$transaction !== "function"
    ) {
      return fn(this);
    }
    return this.prisma.$transaction(async (tx: PrismaClient) => {
      const txPersistence = new PrismaWorkflowPersistence(tx, {
        databaseType: this.databaseType,
        skipInteractiveTransactions: this.skipTransactions,
      });
      return fn(txPersistence);
    });
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
        metadata: (data.metadata ?? null) as unknown,
      },
    });
    return this.mapWorkflowRun(run);
  }

  async updateRun(id: string, data: UpdateRunInput): Promise<void> {
    const updateData = this.buildRunUpdateData(data);

    if (data.expectedVersion === undefined) {
      await this.prisma.workflowRun.update({
        where: { id },
        data: updateData,
      });
      return;
    }

    const result = await this.prisma.workflowRun.updateMany({
      where: { id, version: data.expectedVersion },
      data: {
        ...updateData,
        version: { increment: 1 },
      },
    });

    if (result.count === 0) {
      const current = await this.prisma.workflowRun.findUnique({
        where: { id },
        select: { version: true },
      });
      throw new StaleVersionError(
        "WorkflowRun",
        id,
        data.expectedVersion,
        current?.version ?? -1,
      );
    }
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

  async getStuckRuns(stuckSince: Date): Promise<WorkflowRunRecord[]> {
    // Find RUNNING runs where both the run and ALL its stages
    // have not been updated since the threshold.
    const runs = await this.prisma.workflowRun.findMany({
      where: {
        status: this.enums.status("RUNNING"),
        updatedAt: { lte: stuckSince },
        // No stage updated after the threshold
        stages: {
          none: {
            updatedAt: { gt: stuckSince },
          },
        },
      },
      orderBy: { updatedAt: "asc" },
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
        attempt: data.attempt ?? 0,
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
        attempt: data.create.attempt ?? 0,
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
    const updateData = this.buildStageUpdateData(data);

    if (data.expectedVersion === undefined) {
      await this.prisma.workflowStage.update({
        where: { id },
        data: updateData,
      });
      return;
    }

    const result = await this.prisma.workflowStage.updateMany({
      where: { id, version: data.expectedVersion },
      data: {
        ...updateData,
        version: { increment: 1 },
      },
    });

    if (result.count === 0) {
      const current = await this.prisma.workflowStage.findUnique({
        where: { id },
        select: { version: true },
      });
      throw new StaleVersionError(
        "WorkflowStage",
        id,
        data.expectedVersion,
        current?.version ?? -1,
      );
    }
  }

  async updateStageByRunAndStageId(
    workflowRunId: string,
    stageId: string,
    data: UpdateStageInput,
  ): Promise<void> {
    const updateData = this.buildStageUpdateData(data);

    if (data.expectedVersion === undefined) {
      await this.prisma.workflowStage.update({
        where: {
          workflowRunId_stageId: { workflowRunId, stageId },
        },
        data: updateData,
      });
      return;
    }

    const result = await this.prisma.workflowStage.updateMany({
      where: {
        workflowRunId,
        stageId,
        version: data.expectedVersion,
      },
      data: {
        ...updateData,
        version: { increment: 1 },
      },
    });

    if (result.count === 0) {
      const current = await this.prisma.workflowStage.findFirst({
        where: { workflowRunId, stageId },
        select: { id: true, version: true },
      });
      throw new StaleVersionError(
        "WorkflowStage",
        current?.id ?? `${workflowRunId}/${stageId}`,
        data.expectedVersion,
        current?.version ?? -1,
      );
    }
  }

  private buildRunUpdateData(data: UpdateRunInput): Record<string, unknown> {
    return {
      status: data.status ? this.enums.status(data.status) : undefined,
      startedAt: data.startedAt,
      completedAt: data.completedAt,
      duration: data.duration,
      output: data.output as unknown,
      totalCost: data.totalCost,
      totalTokens: data.totalTokens,
    };
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
  // WorkflowAnnotation Operations
  // ============================================================================

  async appendAnnotations(inputs: CreateAnnotationInput[]): Promise<void> {
    if (inputs.length === 0) return;

    const rows = inputs.map((input) => ({
      workflowRunId: input.workflowRunId,
      workflowStageRecordId: input.workflowStageRecordId ?? null,
      attempt: input.attempt ?? 0,
      scope: input.scope,
      scopeId: input.scopeId ?? null,
      actorKind: input.actor?.kind ?? null,
      actorId: input.actor?.id ?? null,
      actorVersion: input.actor?.version ?? null,
      key: input.key,
      value: input.value as unknown,
      payload: (input.payload ?? null) as unknown,
      idempotencyKey: input.idempotencyKey ?? null,
    }));

    const hasIdempotencyKey = rows.some((r) => r.idempotencyKey !== null);

    // Fast path: no idempotency keys → no dedup needed (NULL values are
    // distinct under the unique constraint). Plain createMany works on
    // both Postgres and SQLite.
    if (!hasIdempotencyKey) {
      await this.prisma.workflowAnnotation.createMany({ data: rows });
      return;
    }

    // Slow path: at least one row has an idempotency key, so the unique
    // constraint on (workflowRunId, key, idempotencyKey) may trigger.
    if (this.databaseType === "postgresql") {
      // Postgres: `createMany({ skipDuplicates: true })` compiles to
      // INSERT ... ON CONFLICT DO NOTHING — single statement, safe
      // inside a transaction. (skipDuplicates is NOT supported on
      // SQLite in Prisma, so we can't use it cross-DB.)
      await this.prisma.workflowAnnotation.createMany({
        data: rows,
        skipDuplicates: true,
      });
      return;
    }

    // SQLite: per-row create + catch P2002. Unlike Postgres, SQLite
    // does not abort the surrounding transaction on a constraint
    // violation, so swallowing the JS error is safe here.
    for (const row of rows) {
      try {
        await this.prisma.workflowAnnotation.create({ data: row });
      } catch (error: any) {
        if (error?.code === "P2002") continue;
        throw error;
      }
    }
  }

  async listAnnotations(
    workflowRunId: string,
    filters: AnnotationFilters = {},
  ): Promise<WorkflowAnnotationRecord[]> {
    const where: Record<string, unknown> = { workflowRunId };

    if (filters.key !== undefined) {
      where.key = filters.key;
    } else if (filters.keyPrefix !== undefined) {
      // NOTE: Prisma's `startsWith` compiles to `LIKE 'prefix%'`. On
      // Postgres this uses the (workflowRunId, key) index. On SQLite the
      // default `LIKE` is case-insensitive and will not use the btree
      // index; high-volume SQLite consumers should keep keys lowercase
      // (engine convention) and accept the scan cost. Documented in the
      // RFC.
      where.key = { startsWith: filters.keyPrefix };
    }

    if (filters.scope !== undefined) where.scope = filters.scope;
    if (filters.scopeId !== undefined) where.scopeId = filters.scopeId;
    if (filters.actorId !== undefined) where.actorId = filters.actorId;
    if (filters.actorKind !== undefined) where.actorKind = filters.actorKind;
    if (filters.attempt !== undefined) where.attempt = filters.attempt;

    if (filters.since !== undefined || filters.until !== undefined) {
      const createdAt: Record<string, Date> = {};
      if (filters.since !== undefined) createdAt.gte = filters.since;
      if (filters.until !== undefined) createdAt.lte = filters.until;
      where.createdAt = createdAt;
    }

    const records = await this.prisma.workflowAnnotation.findMany({
      where,
      // Secondary order by `id` keeps timeline deterministic when many
      // rows are inserted in the same transaction (same `createdAt`).
      // CUIDs are roughly chronological, so this preserves insert order.
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: filters.limit ?? 1000,
    });
    return records.map((r: any) => this.mapWorkflowAnnotation(r));
  }

  private mapWorkflowAnnotation(record: any): WorkflowAnnotationRecord {
    return {
      id: record.id,
      createdAt: record.createdAt,
      workflowRunId: record.workflowRunId,
      workflowStageRecordId: record.workflowStageRecordId ?? null,
      attempt: record.attempt ?? 0,
      scope: record.scope,
      scopeId: record.scopeId ?? null,
      actorKind: record.actorKind ?? null,
      actorId: record.actorId ?? null,
      actorVersion: record.actorVersion ?? null,
      key: record.key,
      value: record.value,
      payload: record.payload ?? null,
      idempotencyKey: record.idempotencyKey ?? null,
    };
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
  // Outbox Operations
  // ============================================================================

  async appendOutboxEvents(events: CreateOutboxEventInput[]): Promise<void> {
    if (events.length === 0) return;

    // Group by workflowRunId to assign sequences per-run
    const byRun = new Map<string, CreateOutboxEventInput[]>();
    for (const event of events) {
      const list = byRun.get(event.workflowRunId) ?? [];
      list.push(event);
      byRun.set(event.workflowRunId, list);
    }

    const rows: Array<{
      workflowRunId: string;
      sequence: number;
      eventType: string;
      payload: unknown;
      causationId: string;
      occurredAt: Date;
    }> = [];

    for (const [workflowRunId, runEvents] of byRun) {
      if (
        this.databaseType === "postgresql" &&
        typeof this.prisma.$executeRaw === "function"
      ) {
        // Serialize per-run sequence assignment inside the transaction.
        await this.prisma.$executeRaw`
          SELECT pg_advisory_xact_lock(hashtext(${workflowRunId}))
        `;
      }

      // Get the current max sequence for this run
      const maxResult = await this.prisma.outboxEvent.aggregate({
        where: { workflowRunId },
        _max: { sequence: true },
      });
      let seq = maxResult._max.sequence ?? 0;

      for (const event of runEvents) {
        seq++;
        rows.push({
          workflowRunId: event.workflowRunId,
          sequence: seq,
          eventType: event.eventType,
          payload: event.payload as any,
          causationId: event.causationId,
          occurredAt: event.occurredAt,
        });
      }
    }

    await this.prisma.outboxEvent.createMany({ data: rows });
  }

  async getUnpublishedOutboxEvents(limit?: number): Promise<OutboxRecord[]> {
    const effectiveLimit = limit ?? 100;
    const records = await this.prisma.outboxEvent.findMany({
      where: { publishedAt: null, dlqAt: null },
      orderBy: [{ workflowRunId: "asc" }, { sequence: "asc" }],
      take: effectiveLimit,
    });
    return records.map((r: any) => this.mapOutboxEvent(r));
  }

  async markOutboxEventsPublished(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    await this.prisma.outboxEvent.updateMany({
      where: { id: { in: ids } },
      data: { publishedAt: new Date() },
    });
  }

  // ============================================================================
  // Outbox DLQ Operations
  // ============================================================================

  async incrementOutboxRetryCount(id: string): Promise<number> {
    const record = await this.prisma.outboxEvent.update({
      where: { id },
      data: { retryCount: { increment: 1 } },
      select: { retryCount: true },
    });
    return record.retryCount;
  }

  async moveOutboxEventToDLQ(id: string): Promise<void> {
    await this.prisma.outboxEvent.update({
      where: { id },
      data: { dlqAt: new Date() },
    });
  }

  async replayDLQEvents(maxEvents: number): Promise<number> {
    const dlqEvents = await this.prisma.outboxEvent.findMany({
      where: { dlqAt: { not: null } },
      take: maxEvents,
      select: { id: true },
    });

    if (dlqEvents.length === 0) return 0;

    const result = await this.prisma.outboxEvent.updateMany({
      where: { id: { in: dlqEvents.map((e: any) => e.id) } },
      data: { dlqAt: null, retryCount: 0 },
    });
    return result.count;
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
    try {
      await this.prisma.idempotencyKey.create({
        data: {
          key,
          commandType,
          result: IDEMPOTENCY_IN_PROGRESS_MARKER as any,
        },
      });
      return { status: "acquired" };
    } catch (error: any) {
      if (error?.code !== "P2002") {
        throw error;
      }
    }

    const existing = await this.prisma.idempotencyKey.findUnique({
      where: { key_commandType: { key, commandType } },
      select: { result: true },
    });

    if (!existing || isInProgressResult(existing.result)) {
      return { status: "in_progress" };
    }

    return { status: "replay", result: existing.result };
  }

  async completeIdempotencyKey(
    key: string,
    commandType: string,
    result: unknown,
  ): Promise<void> {
    await this.prisma.idempotencyKey.update({
      where: { key_commandType: { key, commandType } },
      data: { result: result as any },
    });
  }

  async releaseIdempotencyKey(key: string, commandType: string): Promise<void> {
    await this.prisma.idempotencyKey.deleteMany({
      where: { key, commandType },
    });
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
      metadata: run.metadata ?? null,
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
      attempt: stage.attempt ?? 0,
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

  private mapOutboxEvent(record: any): OutboxRecord {
    return {
      id: record.id,
      workflowRunId: record.workflowRunId,
      sequence: record.sequence,
      eventType: record.eventType,
      payload: record.payload,
      causationId: record.causationId,
      occurredAt: record.occurredAt,
      publishedAt: record.publishedAt,
      retryCount: record.retryCount,
      dlqAt: record.dlqAt,
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
