import {
  ConsoleBadRequestError,
  ConsoleQueryTimeoutError,
  isStatementTimeout,
} from "./errors";
import {
  ALL_CAPABILITIES,
  type AnnotationSummary,
  CONSOLE_STATUSES,
  type ConsoleCapabilities,
  type ConsoleReadPort,
  type ConsoleStatus,
  type CostBucket,
  type CostQuery,
  clampLimit,
  type DeadLetter,
  decodeCursor,
  encodeCursor,
  isConsoleStatus,
  type LogEntry,
  type QueueHealth,
  type RunDetail,
  type RunDetailOptions,
  type RunEvent,
  type RunListPage,
  type RunListQuery,
  type RunSummary,
  type StageSummary,
  type StepSummary,
  type SuspendedStage,
  type WorkerInstance,
} from "./read-port";

/**
 * Minimal structural client contract.
 *
 * This avoids a hard dependency on `@prisma/client` or the engine's internals,
 * letting callers pass either their root PrismaClient or an existing interactive
 * transaction client.
 */
export interface ConsolePrismaClient {
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>;
  $executeRawUnsafe?(query: string, ...values: unknown[]): Promise<number>;
  $transaction?<T>(fn: (tx: ConsolePrismaClient) => Promise<T>): Promise<T>;
}

export interface PrismaConsoleReadPortOptions {
  statusEnumName?: string; // default "Status"
  statementTimeoutMs?: number; // default 15000; 0 disables
  now?: () => Date; // default () => new Date()
}

/**
 * Wraps a positional parameter carrying a JS Date in a timestamptz-to-UTC conversion.
 *
 * Mirrors `utc-timestamps.ts` in the engine's Prisma adapter: Prisma binds a Date
 * as timestamptz and Postgres converts it through the session timezone, which skews
 * against naive timestamp columns unless explicitly converted via AT TIME ZONE 'UTC'.
 */
function utcParam(position: number): string {
  if (!Number.isInteger(position) || position < 1) {
    throw new Error(
      `utcParam: position must be a positive integer, got ${position}`,
    );
  }
  return `($${position}::timestamptz AT TIME ZONE 'UTC')`;
}

/** Converts bigint, number, string, null, or undefined values into numbers, defaulting to 0. */
function toNumber(value: unknown): number {
  if (value === null || value === undefined) return 0;
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

/** Converts Date, string, null, or undefined values into Date or null. */
function toDate(value: unknown): Date | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value;
  if (typeof value === "string") {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  return null;
}

interface RawRunRow {
  id: string;
  createdAt: Date | string;
  updatedAt: Date | string;
  workflowId: string;
  workflowName: string;
  workflowType: string;
  status: string;
  startedAt: Date | string | null;
  completedAt: Date | string | null;
  duration: number | null;
  totalCost: number | null;
  totalTokens: number | bigint | null;
  priority: number | bigint | null;
  definitionVersion?: string | null;
  redriveCount?: number | bigint | null;
}

interface RawRunDetailRow extends RawRunRow {
  input: unknown;
  output: unknown;
  config: unknown;
  metadata: unknown;
}

interface RawStageRow {
  id: string;
  workflowRunId: string;
  stageId: string;
  stageName: string;
  stageNumber: number | bigint;
  executionGroup: number | bigint;
  attempt: number | bigint;
  status: string;
  startedAt: Date | string | null;
  completedAt: Date | string | null;
  duration: number | null;
  nextPollAt: Date | string | null;
  pollInterval: number | null;
  maxWaitUntil: Date | string | null;
  errorMessage: string | null;
}

interface RawStepRow {
  id: string;
  stageRecordId: string;
  stepId: string;
  seq: number | bigint;
  kind: string;
  status: string;
  attempt: number | bigint;
  leaseExpiresAt: Date | string | null;
  deadlineAt: Date | string | null;
  externalKey: string | null;
  error: string | null;
  createdAt: Date | string;
  updatedAt: Date | string;
}

interface RawAnnotationRow {
  id: string;
  createdAt: Date | string;
  workflowRunId: string;
  workflowStageRecordId: string | null;
  attempt: number | bigint;
  scope: string;
  scopeId: string | null;
  actorKind: string | null;
  actorId: string | null;
  key: string;
  value: unknown;
}

interface RawLogRow {
  id: string;
  createdAt: Date | string;
  workflowRunId: string | null;
  workflowStageId: string | null;
  level: string;
  message: string;
}

interface RawEventRow {
  id: string;
  workflowRunId: string;
  sequence: number | bigint;
  eventType: string;
  occurredAt: Date | string;
  publishedAt: Date | string | null;
  retryCount: number | bigint;
  dlqAt: Date | string | null;
}

interface RawSuspendedStageRow {
  id: string;
  workflowRunId: string;
  workflowId: string;
  stageId: string;
  stageName: string;
  attempt: number | bigint;
  nextPollAt: Date | string | null;
  pollInterval: number | null;
  maxWaitUntil: Date | string | null;
}

interface RawDeadLetterRow {
  id: string;
  workflowRunId: string;
  sequence: number | bigint;
  eventType: string;
  retryCount: number | bigint;
  occurredAt: Date | string;
  dlqAt: Date | string | null;
}

interface RawWorkerRow {
  workerId: string;
  running: number | bigint;
  oldest: Date | string | null;
  newest: Date | string | null;
}

interface RawCostRow {
  key: string;
  runs: number | bigint;
  cost: number | null;
  tokens: number | bigint | null;
}

function mapRunSummary(row: RawRunRow): RunSummary {
  return {
    id: String(row.id),
    createdAt: toDate(row.createdAt) ?? new Date(0),
    updatedAt: toDate(row.updatedAt) ?? new Date(0),
    workflowId: String(row.workflowId),
    workflowName: String(row.workflowName),
    workflowType: String(row.workflowType),
    status: row.status as ConsoleStatus,
    startedAt: toDate(row.startedAt),
    completedAt: toDate(row.completedAt),
    duration:
      row.duration !== null && row.duration !== undefined
        ? toNumber(row.duration)
        : null,
    totalCost: toNumber(row.totalCost),
    totalTokens: toNumber(row.totalTokens),
    priority: toNumber(row.priority),
    definitionVersion:
      row.definitionVersion !== null && row.definitionVersion !== undefined
        ? String(row.definitionVersion)
        : null,
    redriveCount: toNumber(row.redriveCount),
  };
}

function mapStageSummary(row: RawStageRow): StageSummary {
  return {
    id: String(row.id),
    workflowRunId: String(row.workflowRunId),
    stageId: String(row.stageId),
    stageName: String(row.stageName),
    stageNumber: toNumber(row.stageNumber),
    executionGroup: toNumber(row.executionGroup),
    attempt: toNumber(row.attempt),
    status: row.status as ConsoleStatus,
    startedAt: toDate(row.startedAt),
    completedAt: toDate(row.completedAt),
    duration:
      row.duration !== null && row.duration !== undefined
        ? toNumber(row.duration)
        : null,
    nextPollAt: toDate(row.nextPollAt),
    pollInterval:
      row.pollInterval !== null && row.pollInterval !== undefined
        ? toNumber(row.pollInterval)
        : null,
    maxWaitUntil: toDate(row.maxWaitUntil),
    errorMessage:
      row.errorMessage !== null && row.errorMessage !== undefined
        ? String(row.errorMessage)
        : null,
  };
}

function mapStepSummary(row: RawStepRow): StepSummary {
  return {
    id: String(row.id),
    stageRecordId: String(row.stageRecordId),
    stepId: String(row.stepId),
    seq: toNumber(row.seq),
    kind: String(row.kind),
    status: String(row.status),
    attempt: toNumber(row.attempt),
    leaseExpiresAt: toDate(row.leaseExpiresAt),
    deadlineAt: toDate(row.deadlineAt),
    externalKey:
      row.externalKey !== null && row.externalKey !== undefined
        ? String(row.externalKey)
        : null,
    error:
      row.error !== null && row.error !== undefined ? String(row.error) : null,
    createdAt: toDate(row.createdAt) ?? new Date(0),
    updatedAt: toDate(row.updatedAt) ?? new Date(0),
  };
}

function mapAnnotationSummary(row: RawAnnotationRow): AnnotationSummary {
  return {
    id: String(row.id),
    createdAt: toDate(row.createdAt) ?? new Date(0),
    workflowRunId: String(row.workflowRunId),
    workflowStageRecordId:
      row.workflowStageRecordId !== null &&
      row.workflowStageRecordId !== undefined
        ? String(row.workflowStageRecordId)
        : null,
    attempt: toNumber(row.attempt),
    scope: String(row.scope),
    scopeId:
      row.scopeId !== null && row.scopeId !== undefined
        ? String(row.scopeId)
        : null,
    actorKind:
      row.actorKind !== null && row.actorKind !== undefined
        ? String(row.actorKind)
        : null,
    actorId:
      row.actorId !== null && row.actorId !== undefined
        ? String(row.actorId)
        : null,
    key: String(row.key),
    value: row.value,
  };
}

function mapLogEntry(row: RawLogRow): LogEntry {
  return {
    id: String(row.id),
    createdAt: toDate(row.createdAt) ?? new Date(0),
    workflowRunId:
      row.workflowRunId !== null && row.workflowRunId !== undefined
        ? String(row.workflowRunId)
        : null,
    workflowStageId:
      row.workflowStageId !== null && row.workflowStageId !== undefined
        ? String(row.workflowStageId)
        : null,
    level: String(row.level),
    message: String(row.message),
  };
}

function mapRunEvent(row: RawEventRow): RunEvent {
  return {
    id: String(row.id),
    workflowRunId: String(row.workflowRunId),
    sequence: toNumber(row.sequence),
    eventType: String(row.eventType),
    occurredAt: toDate(row.occurredAt) ?? new Date(0),
    publishedAt: toDate(row.publishedAt),
    retryCount: toNumber(row.retryCount),
    dlqAt: toDate(row.dlqAt),
  };
}

function mapSuspendedStage(row: RawSuspendedStageRow): SuspendedStage {
  return {
    id: String(row.id),
    workflowRunId: String(row.workflowRunId),
    workflowId: String(row.workflowId),
    stageId: String(row.stageId),
    stageName: String(row.stageName),
    attempt: toNumber(row.attempt),
    nextPollAt: toDate(row.nextPollAt),
    pollInterval:
      row.pollInterval !== null && row.pollInterval !== undefined
        ? toNumber(row.pollInterval)
        : null,
    maxWaitUntil: toDate(row.maxWaitUntil),
  };
}

function mapDeadLetter(row: RawDeadLetterRow): DeadLetter {
  return {
    id: String(row.id),
    workflowRunId: String(row.workflowRunId),
    sequence: toNumber(row.sequence),
    eventType: String(row.eventType),
    retryCount: toNumber(row.retryCount),
    occurredAt: toDate(row.occurredAt) ?? new Date(0),
    dlqAt: toDate(row.dlqAt),
  };
}

function mapWorkerInstance(row: RawWorkerRow): WorkerInstance {
  return {
    workerId: String(row.workerId),
    runningJobs: toNumber(row.running),
    oldestLockedAt: toDate(row.oldest),
    lastSeenAt: toDate(row.newest),
  };
}

function mapCostBucket(row: RawCostRow): CostBucket {
  return {
    key: String(row.key),
    runs: toNumber(row.runs),
    cost: toNumber(row.cost),
    tokens: toNumber(row.tokens),
  };
}

export class PrismaConsoleReadPort implements ConsoleReadPort {
  readonly capabilities: ConsoleCapabilities = ALL_CAPABILITIES;

  private readonly prisma: ConsolePrismaClient;
  private readonly statusEnumName: string;
  private readonly statementTimeoutMs: number;
  private readonly now: () => Date;

  constructor(
    prisma: ConsolePrismaClient,
    options?: PrismaConsoleReadPortOptions,
  ) {
    this.prisma = prisma;

    const statusEnumName = options?.statusEnumName ?? "Status";
    // The enum name is interpolated directly into SQL as an identifier cast
    // (e.g. $1::"Status"). Validate against Postgres identifier syntax to guarantee
    // safe interpolation and prevent SQL injection.
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(statusEnumName)) {
      throw new Error(
        `Invalid statusEnumName: "${statusEnumName}". Must match /^[A-Za-z_][A-Za-z0-9_]*$/`,
      );
    }
    this.statusEnumName = statusEnumName;

    const timeoutMs = options?.statementTimeoutMs ?? 15000;
    if (
      typeof timeoutMs !== "number" ||
      !Number.isFinite(timeoutMs) ||
      timeoutMs < 0
    ) {
      throw new Error(
        `statementTimeoutMs must be a non-negative number, got ${timeoutMs}`,
      );
    }
    this.statementTimeoutMs = Math.floor(timeoutMs);

    this.now = options?.now ?? (() => new Date());
  }

  /** One `SELECT` against whichever client the surrounding `read` gave us. */
  private select<T>(
    client: ConsolePrismaClient,
    sql: string,
    params: unknown[],
  ): Promise<T[]> {
    return client.$queryRawUnsafe<T[]>(sql, ...params);
  }

  /**
   * Runs one console read, whatever number of statements it takes, and
   * translates a cancelled statement into `ConsoleQueryTimeoutError`.
   *
   * The callback receives the client to issue statements on, and every read
   * that needs more than one statement issues all of them here, inside a
   * single transaction — a run-detail page is six queries, and giving each
   * its own interactive transaction would take six connections out of the
   * consumer's pool to render one page. One transaction also means the six
   * results are a coherent snapshot rather than six moments.
   *
   * The transaction is opened only when we were handed a root client. When
   * `$transaction` is absent we are already inside the caller's transaction
   * — the row-level-security case this package exists for — and we neither
   * open another nor touch `statement_timeout`: `SET LOCAL` there would
   * silently re-time the remainder of a transaction the console did not
   * open and does not get to reconfigure. Timeouts in that case are the
   * caller's to set, and a cancellation is still reported honestly because
   * the catch below does not care who set the limit.
   */
  private async read<T>(
    label: string,
    fn: (client: ConsolePrismaClient) => Promise<T>,
  ): Promise<T> {
    try {
      if (
        this.statementTimeoutMs > 0 &&
        typeof this.prisma.$transaction === "function"
      ) {
        const ms = this.statementTimeoutMs;
        return await this.prisma.$transaction(async (tx) => {
          if (typeof tx.$executeRawUnsafe === "function") {
            // `ms` is a validated integer, and a bare number here is
            // milliseconds. It is the one interpolated value in this file
            // besides the enum name.
            await tx.$executeRawUnsafe(`SET LOCAL statement_timeout = ${ms}`);
          }
          return await fn(tx);
        });
      }
      return await fn(this.prisma);
    } catch (error) {
      if (isStatementTimeout(error)) {
        throw new ConsoleQueryTimeoutError(label, this.statementTimeoutMs, {
          cause: error,
        });
      }
      throw error;
    }
  }

  /** Convenience for the reads that are a single statement. */
  private query<T>(
    label: string,
    sql: string,
    params: unknown[],
  ): Promise<T[]> {
    return this.read(label, (client) => this.select<T>(client, sql, params));
  }

  async listRuns(query: RunListQuery): Promise<RunListPage> {
    const limit = clampLimit(query.limit);
    const where: string[] = [];
    const params: unknown[] = [];
    let paramIdx = 1;

    if (query.cursor !== undefined && query.cursor !== "") {
      const cursor = decodeCursor(query.cursor);
      if (cursor === null) {
        throw new ConsoleBadRequestError("Invalid cursor.");
      }
      // Row-wise comparison is load-bearing: Postgres evaluates (a, b) < (c, d)
      // using an index range scan on the composite index ("createdAt" DESC, id DESC).
      // Rewriting as `a < c OR (a = c AND b < d)` prevents Postgres from using the index
      // efficiently and degrades into a bitmap scan or sequential scan.
      where.push(
        `("createdAt", id) < (${utcParam(paramIdx)}, $${paramIdx + 1})`,
      );
      params.push(cursor.createdAt, cursor.id);
      paramIdx += 2;
    }

    const statuses = query.filters?.status ?? [];
    if (statuses.length > 0) {
      // One placeholder per status rather than `= ANY($1::"Status"[])`.
      // Passing a JS array through `$queryRawUnsafe` leaves array encoding to
      // the driver, and the list is a bounded enum of at most seven values,
      // so expanding it keeps every value a bound parameter with no
      // serialisation question and the same plan.
      const placeholders = statuses.map((status) => {
        params.push(status);
        const placeholder = `$${paramIdx}::"${this.statusEnumName}"`;
        paramIdx += 1;
        return placeholder;
      });
      where.push(`status IN (${placeholders.join(", ")})`);
    }

    if (query.filters?.workflowId !== undefined) {
      where.push(`"workflowId" = $${paramIdx}`);
      params.push(query.filters.workflowId);
      paramIdx += 1;
    }

    if (query.filters?.workflowType !== undefined) {
      where.push(`"workflowType" = $${paramIdx}`);
      params.push(query.filters.workflowType);
      paramIdx += 1;
    }

    if (query.filters?.definitionVersion !== undefined) {
      where.push(`"definitionVersion" = $${paramIdx}`);
      params.push(query.filters.definitionVersion);
      paramIdx += 1;
    }

    if (query.filters?.createdAfter !== undefined) {
      where.push(`"createdAt" >= ${utcParam(paramIdx)}`);
      params.push(query.filters.createdAfter);
      paramIdx += 1;
    }

    if (query.filters?.createdBefore !== undefined) {
      where.push(`"createdAt" < ${utcParam(paramIdx)}`);
      params.push(query.filters.createdBefore);
      paramIdx += 1;
    }

    const whereClause =
      where.length > 0 ? `\nWHERE ${where.join(" AND ")}` : "";
    const sql = `SELECT id, "createdAt", "updatedAt", "workflowId", "workflowName", "workflowType",
       status, "startedAt", "completedAt", duration, "totalCost", "totalTokens", priority,
       "definitionVersion", "redriveCount"
FROM "workflow_runs"${whereClause}
ORDER BY "createdAt" DESC, id DESC
LIMIT ${limit + 1}`;

    const rows = await this.query<RawRunRow>("runs.list", sql, params);
    const hasNextPage = rows.length > limit;
    const returnedRows = hasNextPage ? rows.slice(0, limit) : rows;
    const runs = returnedRows.map(mapRunSummary);

    const last = runs.at(-1);
    const nextCursor =
      hasNextPage && last !== undefined
        ? encodeCursor({ createdAt: last.createdAt, id: last.id })
        : null;

    return { runs, nextCursor };
  }

  async getRunDetail(
    runId: string,
    options?: RunDetailOptions,
  ): Promise<RunDetail | null> {
    const stepLimit = clampLimit(options?.stepLimit, 200);
    const annotationLimit = clampLimit(options?.annotationLimit, 200);
    const logLimit = clampLimit(options?.logLimit, 200);
    const eventLimit = clampLimit(options?.eventLimit, 200);

    // All six statements share one transaction: six interactive transactions
    // to render one page would take six connections out of the consumer's
    // pool, and the results would be six different moments.
    return this.read("run.detail", async (client) => {
      const runRows = await this.select<RawRunDetailRow>(
        client,
        `SELECT id, "createdAt", "updatedAt", "workflowId", "workflowName", "workflowType",
       status, "startedAt", "completedAt", duration, "totalCost", "totalTokens", priority,
       "definitionVersion", "redriveCount",
       input, output, config, metadata
FROM "workflow_runs" WHERE id = $1`,
        [runId],
      );

      // A run that does not exist costs one statement, not six.
      const runRow = runRows[0];
      if (!runRow) return null;

      const stageRows = await this.select<RawStageRow>(
        client,
        `SELECT id, "workflowRunId", "stageId", "stageName", "stageNumber", "executionGroup",
       attempt, status, "startedAt", "completedAt", duration, "nextPollAt",
       "pollInterval", "maxWaitUntil", "errorMessage"
FROM "workflow_stages" WHERE "workflowRunId" = $1
ORDER BY "stageNumber" ASC, "stageId" ASC`,
        [runId],
      );

      const stepRows = await this.select<RawStepRow>(
        client,
        `SELECT s.id, s."stageRecordId", s."stepId", s.seq, s.kind, s.status, s.attempt,
       s."leaseExpiresAt", s."deadlineAt", s."externalKey", s.error, s."createdAt", s."updatedAt"
FROM "workflow_steps" s
JOIN "workflow_stages" st ON st.id = s."stageRecordId"
WHERE st."workflowRunId" = $1
ORDER BY st."stageNumber" ASC, s.seq ASC
LIMIT ${stepLimit + 1}`,
        [runId],
      );

      const annotationRows = await this.select<RawAnnotationRow>(
        client,
        `SELECT id, "createdAt", "workflowRunId", "workflowStageRecordId", attempt, scope,
       "scopeId", "actorKind", "actorId", key, value
FROM "workflow_annotations" WHERE "workflowRunId" = $1
ORDER BY "createdAt" DESC, id DESC
LIMIT ${annotationLimit + 1}`,
        [runId],
      );

      const logRows = await this.select<RawLogRow>(
        client,
        `SELECT id, "createdAt", "workflowRunId", "workflowStageId", level, message
FROM "workflow_logs" WHERE "workflowRunId" = $1
ORDER BY "createdAt" DESC, id DESC
LIMIT ${logLimit + 1}`,
        [runId],
      );

      const eventRows = await this.select<RawEventRow>(
        client,
        `SELECT id, "workflowRunId", sequence, "eventType", "occurredAt", "publishedAt",
       "retryCount", "dlqAt"
FROM "outbox_events" WHERE "workflowRunId" = $1
ORDER BY sequence ASC
LIMIT ${eventLimit + 1}`,
        [runId],
      );

      // Each list asked for one row more than it will show, so "there is
      // more than this" is known without a second count.
      const truncated = {
        steps: stepRows.length > stepLimit,
        annotations: annotationRows.length > annotationLimit,
        logs: logRows.length > logLimit,
        events: eventRows.length > eventLimit,
      };

      return {
        run: {
          ...mapRunSummary(runRow),
          input: runRow.input,
          output: runRow.output,
          config: runRow.config,
          metadata: runRow.metadata,
        },
        stages: stageRows.map(mapStageSummary),
        steps: stepRows.slice(0, stepLimit).map(mapStepSummary),
        annotations: annotationRows
          .slice(0, annotationLimit)
          .map(mapAnnotationSummary),
        logs: logRows.slice(0, logLimit).map(mapLogEntry),
        events: eventRows.slice(0, eventLimit).map(mapRunEvent),
        truncated,
      } satisfies RunDetail;
    });
  }

  async listRunEvents(
    runId: string,
    afterSequence: number,
    limit?: number,
  ): Promise<RunEvent[]> {
    const clampedLimit = clampLimit(limit, 200);
    const rows = await this.query<RawEventRow>(
      "run.events.tail",
      `SELECT id, "workflowRunId", sequence, "eventType", "occurredAt", "publishedAt",
       "retryCount", "dlqAt"
FROM "outbox_events" WHERE "workflowRunId" = $1 AND sequence > $2
ORDER BY sequence ASC LIMIT ${clampedLimit}`,
      [runId, Math.floor(afterSequence)],
    );
    return rows.map(mapRunEvent);
  }

  async getQueueHealth(): Promise<QueueHealth> {
    const [
      countsResult,
      oldestPendingResult,
      leasesResult,
      overduePollsResult,
    ] = await this.read("queue.health", async (client) =>
      Promise.all([
        this.select<{ status: string; count: unknown }>(
          client,
          `SELECT status::text AS status, count(*) AS count FROM "job_queue" GROUP BY status`,
          [],
        ),
        this.select<{ oldest: Date | string | null }>(
          client,
          `SELECT min("createdAt") AS oldest FROM "job_queue" WHERE status = $1::"${this.statusEnumName}"`,
          ["PENDING"],
        ),
        this.select<{ oldest: Date | string | null }>(
          client,
          `SELECT min("lockedAt") AS oldest FROM "job_queue" WHERE status = $1::"${this.statusEnumName}" AND "lockedAt" IS NOT NULL`,
          ["RUNNING"],
        ),
        this.select<{ count: unknown }>(
          client,
          `SELECT count(*) AS count FROM "job_queue" WHERE status = $1::"${this.statusEnumName}" AND "nextPollAt" IS NOT NULL AND "nextPollAt" <= ${utcParam(2)}`,
          ["SUSPENDED", this.now()],
        ),
      ]),
    );

    const countsByStatus = Object.fromEntries(
      CONSOLE_STATUSES.map((status) => [status, 0]),
    ) as Record<ConsoleStatus, number>;

    for (const row of countsResult) {
      if (isConsoleStatus(row.status)) {
        countsByStatus[row.status] = toNumber(row.count);
      }
    }

    return {
      countsByStatus,
      oldestPendingAt: toDate(oldestPendingResult[0]?.oldest),
      oldestLeaseAt: toDate(leasesResult[0]?.oldest),
      overduePolls: toNumber(overduePollsResult[0]?.count),
    };
  }

  async listSuspendedStages(limit?: number): Promise<SuspendedStage[]> {
    const clampedLimit = clampLimit(limit, 50);
    const rows = await this.query<RawSuspendedStageRow>(
      "stages.suspended",
      `SELECT st.id, st."workflowRunId", r."workflowId", st."stageId", st."stageName",
       st.attempt, st."nextPollAt", st."pollInterval", st."maxWaitUntil"
FROM "workflow_stages" st
JOIN "workflow_runs" r ON r.id = st."workflowRunId"
WHERE st.status = $1::"${this.statusEnumName}" AND st."nextPollAt" IS NOT NULL
ORDER BY st."nextPollAt" ASC
LIMIT ${clampedLimit}`,
      ["SUSPENDED"],
    );
    return rows.map(mapSuspendedStage);
  }

  async listDeadLetters(limit?: number): Promise<DeadLetter[]> {
    const clampedLimit = clampLimit(limit, 50);
    const rows = await this.query<RawDeadLetterRow>(
      "outbox.deadLetters",
      `SELECT id, "workflowRunId", sequence, "eventType", "retryCount", "occurredAt", "dlqAt"
FROM "outbox_events" WHERE "dlqAt" IS NOT NULL
ORDER BY "dlqAt" DESC LIMIT ${clampedLimit}`,
      [],
    );
    return rows.map(mapDeadLetter);
  }

  async listWorkers(): Promise<WorkerInstance[]> {
    const rows = await this.query<RawWorkerRow>(
      "workers.list",
      `SELECT "workerId", count(*) AS running, min("lockedAt") AS oldest, max("lockedAt") AS newest
FROM "job_queue"
WHERE status = $1::"${this.statusEnumName}" AND "workerId" IS NOT NULL
GROUP BY "workerId" ORDER BY "workerId" ASC`,
      ["RUNNING"],
    );
    return rows.map(mapWorkerInstance);
  }

  async getCosts(query: CostQuery): Promise<CostBucket[]> {
    const now = this.now();
    const to = query.to ?? now;
    const defaultDays = query.by === "workflow" ? 7 : 30;
    const from =
      query.from ?? new Date(now.getTime() - defaultDays * 24 * 60 * 60 * 1000);

    if (query.by === "workflow") {
      const rows = await this.query<RawCostRow>(
        "costs.byWorkflow",
        `SELECT "workflowId" AS key, count(*) AS runs, sum("totalCost") AS cost, sum("totalTokens") AS tokens
FROM "workflow_runs" WHERE "createdAt" >= ${utcParam(1)} AND "createdAt" < ${utcParam(2)}
GROUP BY "workflowId" ORDER BY sum("totalCost") DESC`,
        [from, to],
      );
      return rows.map(mapCostBucket);
    } else {
      const rows = await this.query<RawCostRow>(
        "costs.byDay",
        `SELECT to_char(date_trunc('day', "createdAt"), 'YYYY-MM-DD') AS key,
       count(*) AS runs, sum("totalCost") AS cost, sum("totalTokens") AS tokens
FROM "workflow_runs" WHERE "createdAt" >= ${utcParam(1)} AND "createdAt" < ${utcParam(2)}
GROUP BY 1 ORDER BY 1 DESC`,
        [from, to],
      );
      return rows.map(mapCostBucket);
    }
  }
}

export function createPrismaConsoleReadPort(
  prisma: ConsolePrismaClient,
  options?: PrismaConsoleReadPortOptions,
): ConsoleReadPort {
  return new PrismaConsoleReadPort(prisma, options);
}
