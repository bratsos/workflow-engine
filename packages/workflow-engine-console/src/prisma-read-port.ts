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
  cutStageEventError,
  type DeadLetter,
  decodeCursor,
  encodeCursor,
  isConsoleStatus,
  type LogEntry,
  type QueueHealth,
  RUN_BOUNDARY_EVENT_TYPES,
  type RunDetail,
  type RunDetailOptions,
  type RunEvent,
  type RunListPage,
  type RunListQuery,
  type RunSummary,
  STAGE_EVENT_ERROR_LIMIT,
  STAGE_EVENT_LIMIT,
  STAGE_EVENT_WINDOW,
  STAGE_LIFECYCLE_EVENT_TYPES,
  type StageEvent,
  type StageEventLog,
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
  $transaction?<T>(
    fn: (tx: ConsolePrismaClient) => Promise<T>,
    options?: {
      isolationLevel?: "RepeatableRead";
      timeout?: number;
      maxWait?: number;
    },
  ): Promise<T>;
  /** Set by `fromPrisma8` from the wrapped client's contract target. */
  readonly $databaseType?: "postgresql" | "sqlite";
  /**
   * Prisma 8 (`fromPrisma8`): a client whose raw reads return these columns,
   * since Prisma 8 drops the ones a raw read does not declare.
   */
  $withColumns?(columns: RawColumns): ConsolePrismaClient;
}

type RawType =
  | "text"
  | "int"
  | "bigint"
  | "float"
  | "bool"
  | "json"
  | "timestamp";
type RawColumns = Record<string, RawType>;

/** The client to read on: with `columns` declared on Prisma 8, as it is on 6 and 7. */
function rawFor(client: ConsolePrismaClient, columns: RawColumns) {
  return client.$withColumns?.(columns) ?? client;
}

const RUN_COLUMNS: RawColumns = {
  id: "text",
  createdAt: "timestamp",
  updatedAt: "timestamp",
  workflowId: "text",
  workflowName: "text",
  workflowType: "text",
  status: "text",
  startedAt: "timestamp",
  completedAt: "timestamp",
  duration: "int",
  totalCost: "float",
  totalTokens: "int",
  priority: "int",
  definitionVersion: "text",
  redriveCount: "int",
};
const RUN_DETAIL_COLUMNS: RawColumns = {
  ...RUN_COLUMNS,
  input: "json",
  output: "json",
  config: "json",
  metadata: "json",
};
const STAGE_COLUMNS: RawColumns = {
  id: "text",
  workflowRunId: "text",
  stageId: "text",
  stageName: "text",
  stageNumber: "int",
  executionGroup: "int",
  attempt: "int",
  status: "text",
  startedAt: "timestamp",
  completedAt: "timestamp",
  duration: "int",
  nextPollAt: "timestamp",
  pollInterval: "int",
  maxWaitUntil: "timestamp",
  errorMessage: "text",
};
const STEP_COLUMNS: RawColumns = {
  id: "text",
  stageRecordId: "text",
  stepId: "text",
  seq: "int",
  kind: "text",
  status: "text",
  attempt: "int",
  leaseExpiresAt: "timestamp",
  deadlineAt: "timestamp",
  externalKey: "text",
  error: "text",
  createdAt: "timestamp",
  updatedAt: "timestamp",
};
const ANNOTATION_COLUMNS: RawColumns = {
  id: "text",
  createdAt: "timestamp",
  workflowRunId: "text",
  workflowStageRecordId: "text",
  attempt: "int",
  scope: "text",
  scopeId: "text",
  actorKind: "text",
  actorId: "text",
  key: "text",
  value: "json",
};
const LOG_COLUMNS: RawColumns = {
  id: "text",
  createdAt: "timestamp",
  workflowRunId: "text",
  workflowStageId: "text",
  level: "text",
  message: "text",
};
const EVENT_COLUMNS: RawColumns = {
  id: "text",
  workflowRunId: "text",
  sequence: "int",
  eventType: "text",
  occurredAt: "timestamp",
  publishedAt: "timestamp",
  retryCount: "int",
  dlqAt: "timestamp",
};
const STAGE_EVENT_COLUMNS: RawColumns = {
  sequence: "int",
  eventType: "text",
  occurredAt: "timestamp",
  stageId: "text",
  error: "text",
  causationId: "text",
};
const EVENT_TOP_COLUMNS: RawColumns = { sequence: "int" };
const EVENT_COUNT_COLUMNS: RawColumns = { total: "bigint" };
const SUSPENDED_STAGE_COLUMNS: RawColumns = {
  id: "text",
  workflowRunId: "text",
  workflowId: "text",
  stageId: "text",
  stageName: "text",
  attempt: "int",
  nextPollAt: "timestamp",
  pollInterval: "int",
  maxWaitUntil: "timestamp",
};
const DEAD_LETTER_COLUMNS: RawColumns = {
  id: "text",
  workflowRunId: "text",
  sequence: "int",
  eventType: "text",
  retryCount: "int",
  occurredAt: "timestamp",
  dlqAt: "timestamp",
};
const WORKER_COLUMNS: RawColumns = {
  workerId: "text",
  running: "bigint",
  oldest: "timestamp",
  newest: "timestamp",
};
const COST_COLUMNS: RawColumns = {
  key: "text",
  runs: "bigint",
  cost: "float",
  tokens: "bigint",
};
const OLDEST_COLUMNS: RawColumns = { oldest: "timestamp" };
const COUNT_COLUMNS: RawColumns = { count: "bigint" };

export interface PrismaConsoleReadPortOptions {
  statusEnumName?: string; // default "Status"
  /** PostgreSQL statement timeout; SQLite has no statement_timeout support. Default 15000; 0 disables. */
  statementTimeoutMs?: number;
  databaseType?: "postgresql" | "sqlite"; // default "postgresql"
  now?: () => Date; // default () => new Date()
}

/**
 * Wraps a positional parameter carrying an ISO-8601 timestamp string in a
 * timestamptz-to-UTC conversion.
 *
 * Mirrors `utc-timestamps.ts` in the engine's Prisma adapter: Postgres converts a
 * timestamptz through the session timezone, which skews against naive timestamp
 * columns unless explicitly converted via AT TIME ZONE 'UTC'. Callers bind
 * `date.toISOString()` rather than a Date because driver-level Date binding differs
 * between Prisma majors (7's pg adapter sends zone-less text that Postgres reads in
 * the session timezone).
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

/** Converts Date, SQLite epoch-millisecond values, ISO strings, null, or undefined into Date or null. */
function toDate(value: unknown): Date | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value;
  if (typeof value === "number" || typeof value === "bigint") {
    const parsed = new Date(Number(value));
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  if (typeof value === "string") {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  return null;
}

interface RawRunRow {
  id: string;
  createdAt: RawTimestamp;
  updatedAt: RawTimestamp;
  workflowId: string;
  workflowName: string;
  workflowType: string;
  status: string;
  startedAt: RawNullableTimestamp;
  completedAt: RawNullableTimestamp;
  duration: number | null;
  totalCost: number | null;
  totalTokens: number | bigint | null;
  priority: number | bigint | null;
  definitionVersion?: string | null;
  redriveCount?: number | bigint | null;
}

type RawTimestamp = Date | string | number | bigint;
type RawNullableTimestamp = RawTimestamp | null;

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
  startedAt: RawNullableTimestamp;
  completedAt: RawNullableTimestamp;
  duration: number | null;
  nextPollAt: RawNullableTimestamp;
  pollInterval: number | null;
  maxWaitUntil: RawNullableTimestamp;
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
  leaseExpiresAt: RawNullableTimestamp;
  deadlineAt: RawNullableTimestamp;
  externalKey: string | null;
  error: string | null;
  createdAt: RawTimestamp;
  updatedAt: RawTimestamp;
}

interface RawAnnotationRow {
  id: string;
  createdAt: RawTimestamp;
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
  createdAt: RawTimestamp;
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
  occurredAt: RawTimestamp;
  publishedAt: RawNullableTimestamp;
  retryCount: number | bigint;
  dlqAt: RawNullableTimestamp;
}

interface RawStageEventRow {
  sequence: number | bigint;
  eventType: string;
  occurredAt: RawTimestamp;
  stageId: string | null;
  error: string | null;
  causationId: string | null;
}

interface RawEventTopRow {
  sequence: number | bigint;
}

interface RawEventCountRow {
  total: number | bigint | null;
}

interface RawSuspendedStageRow {
  id: string;
  workflowRunId: string;
  workflowId: string;
  stageId: string;
  stageName: string;
  attempt: number | bigint;
  nextPollAt: RawNullableTimestamp;
  pollInterval: number | null;
  maxWaitUntil: RawNullableTimestamp;
}

interface RawDeadLetterRow {
  id: string;
  workflowRunId: string;
  sequence: number | bigint;
  eventType: string;
  retryCount: number | bigint;
  occurredAt: RawTimestamp;
  dlqAt: RawNullableTimestamp;
}

interface RawWorkerRow {
  workerId: string;
  running: number | bigint;
  oldest: RawNullableTimestamp;
  newest: RawNullableTimestamp;
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

function mapStageEvent(row: RawStageEventRow): StageEvent {
  return {
    sequence: toNumber(row.sequence),
    eventType: String(row.eventType) as StageEvent["eventType"],
    occurredAt: toDate(row.occurredAt) ?? new Date(0),
    stageId:
      row.stageId !== null && row.stageId !== undefined
        ? String(row.stageId)
        : null,
    ...cutStageEventError(
      row.error !== null && row.error !== undefined ? String(row.error) : null,
    ),
    causationId:
      row.causationId !== null && row.causationId !== undefined
        ? String(row.causationId)
        : null,
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

/**
 * The longest a client timer can wait: Node fires a longer `setTimeout`
 * at once. A transaction limit of "none" is this.
 */
const NO_LIMIT_MS = 2_147_483_647;
let cursorCount = 0;
// Drawn once per copy of this module: two copies (a duplicated bundle) on
// one connection never name a cursor, or its FETCH text, alike. Prisma 6
// caches a prepared statement by its text with the columns it returned.
const cursorPrefix = `workflow_console_${Math.random().toString(36).slice(2, 10).padEnd(8, "0")}`;
/** The largest value of `outbox_events.sequence` (an `Int`). */
const SEQUENCE_MAX = 2_147_483_647;

/**
 * More than the statements one read issues: the run detail's on Postgres
 * are at most 18 (the run, stages, steps, two annotation cursors of three
 * statements each and the tie group's, logs, events, three of the stage
 * events, and the timeout's `SHOW`, `SET LOCAL` and restore). A read's
 * transaction may last as long as its statements may run.
 */
const MAX_STATEMENTS_PER_READ = 20;

/**
 * The limit a client's error says ended the read's transaction: Prisma's
 * P2028 is a transaction past its `timeout` ("expired", or `fromPrisma8`'s
 * "timeout passed"), or one not started within `maxWait` ("Unable to start
 * a transaction in the given time"); `ConnectionWait` is this port's own
 * `maxWait` for `fromPrisma8`, which takes none.
 */
function transactionLimitOf(
  error: unknown,
): "transaction" | "connection" | null {
  if (error instanceof ConnectionWait) return "connection";
  if (
    typeof error !== "object" ||
    error === null ||
    (error as { code?: unknown }).code !== "P2028"
  )
    return null;
  const message = String((error as { message?: unknown }).message ?? "");
  return /unable to start a transaction/i.test(message)
    ? "connection"
    : "transaction";
}

/** SQLite refused an `INDEXED BY`: the index is gone or cannot serve. */
function isIndexError(error: unknown): boolean {
  return /no such index|no query solution/i.test(
    String((error as Error | undefined)?.message ?? error),
  );
}

/** ` INDEXED BY "<index>"` for SQLite, or nothing. */
function indexedBy(index: string | undefined): string {
  return index ? ` INDEXED BY "${index.replace(/"/g, '""')}"` : "";
}

/** No connection began the read's transaction within its `maxWait`. */
class ConnectionWait extends Error {}

/** A transaction that began after its read gave up on it: rolled back at once. */
class Abandoned extends Error {}

/**
 * Whether an error came from the server (it carries a SQLSTATE, at one of
 * the paths `isStatementTimeout` reads). After one, the caller's
 * transaction takes no further statement but a rollback.
 */
function fromServer(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const e = error as {
    sqlState?: unknown;
    code?: unknown;
    meta?: {
      code?: unknown;
      driverAdapterError?: { cause?: { originalCode?: unknown } };
    };
  };
  return [
    e.sqlState,
    e.code,
    e.meta?.code,
    e.meta?.driverAdapterError?.cause?.originalCode,
  ].some((code) => typeof code === "string" && /^[0-9A-Z]{5}$/.test(code));
}

export class PrismaConsoleReadPort implements ConsoleReadPort {
  readonly capabilities: ConsoleCapabilities = ALL_CAPABILITIES;

  private readonly prisma: ConsolePrismaClient;
  private readonly statusEnumName: string;
  private readonly databaseType: "postgresql" | "sqlite";
  private readonly statementTimeoutMs: number;
  private readonly now: () => Date;
  private indexes?: Promise<{
    annotations?: string;
    logs?: string;
    steps?: string;
  }>;

  constructor(
    prisma: ConsolePrismaClient,
    options?: PrismaConsoleReadPortOptions,
  ) {
    this.prisma = prisma;
    this.databaseType = options?.databaseType ?? "postgresql";
    if (
      prisma.$databaseType !== undefined &&
      prisma.$databaseType !== this.databaseType
    ) {
      throw new Error(
        `createPrismaConsoleReadPort: the Prisma 8 contract targets "${prisma.$databaseType}", but databaseType is "${this.databaseType}". Set databaseType: "${prisma.$databaseType}" to match the contract.`,
      );
    }

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
    // Postgres's largest `statement_timeout`, and Node's longest timer.
    this.statementTimeoutMs = Math.min(Math.floor(timeoutMs), NO_LIMIT_MS);

    this.now = options?.now ?? (() => new Date());
  }

  /** One `SELECT` against whichever client the surrounding `read` gave us. */
  private async select<T>(
    client: ConsolePrismaClient,
    columns: RawColumns,
    sql: string,
    params: unknown[],
  ): Promise<T[]> {
    const json = Object.keys(columns).filter((k) => columns[k] === "json");
    if (this.databaseType !== "sqlite" || json.length === 0)
      return rawFor(client, columns).$queryRawUnsafe<T[]>(sql, ...params);
    // A JSON column holds a JSON number as a SQLite number (its type's
    // affinity is NUMERIC), which Prisma 7 refuses to read as JSON. These
    // columns are selected as `json(column)` (`jsonColumn`): text on every
    // major, parsed here.
    const rows = await rawFor(client, {
      ...columns,
      ...Object.fromEntries(json.map((k) => [k, "text" as const])),
    }).$queryRawUnsafe<Record<string, unknown>[]>(sql, ...params);
    for (const row of rows)
      for (const k of json)
        if (typeof row[k] === "string") row[k] = JSON.parse(row[k]);
    return rows as T[];
  }

  /** A JSON column as `select` reads it: on SQLite as `json(column)`. */
  private jsonColumn(name: string): string {
    return this.databaseType === "sqlite" ? `json(${name}) AS ${name}` : name;
  }

  /**
   * A statement that reads the first rows of an index order, planned for
   * them alone. On Postgres, inside a transaction (`cursor`), it runs as a
   * cursor: a cursor is planned for its first rows
   * (`cursor_tuple_fraction`), so an index in the statement's order is
   * walked and the walk stops at the limit, in every state of the table's
   * statistics. A cursor needs a transaction block; outside one (a client
   * with no `$transaction` that is not a transaction client) the same
   * statement runs as it is, with the same rows, planned by the statistics.
   *
   * The cursor is closed when the read fails on the client side (the
   * transaction still takes statements; see `closeIfOpen`). After a server
   * error the transaction is aborted and takes none: the cursor ends with
   * it, or with the savepoint Prisma 7 rolls back.
   */
  private async firstRows<T>(
    client: ConsolePrismaClient,
    columns: RawColumns,
    sql: string,
    params: unknown[],
    cursor: boolean,
  ): Promise<T[]> {
    if (
      this.databaseType !== "postgresql" ||
      !cursor ||
      !client.$executeRawUnsafe
    )
      return this.select<T>(client, columns, sql, params);
    // Unique per statement: two reads may share a caller's transaction.
    const name = `${cursorPrefix}_${++cursorCount}`;
    let rows: T[];
    try {
      await client.$executeRawUnsafe(
        `DECLARE ${name} NO SCROLL CURSOR FOR ${sql}`,
        ...params,
      );
      rows = await this.select<T>(
        client,
        columns,
        `FETCH ALL FROM ${name}`,
        [],
      );
      await client.$executeRawUnsafe(`CLOSE ${name}`);
    } catch (error) {
      if (!fromServer(error)) await this.closeIfOpen(client, name);
      throw error;
    }
    return rows;
  }

  /**
   * Closes the cursor `name` if the server holds it: a client-side failure
   * can come before or after the server ran the `DECLARE`, and a `CLOSE` of
   * a cursor that does not exist is an error that aborts the transaction.
   * Best effort: a transaction that takes no statement ends the cursor itself.
   */
  private async closeIfOpen(
    client: ConsolePrismaClient,
    name: string,
  ): Promise<void> {
    try {
      const [row] = await this.select<{ open: unknown }>(
        client,
        { open: "bool" },
        "SELECT count(*) > 0 AS open FROM pg_cursors WHERE name = $1",
        [name],
      );
      if (row?.open === true || row?.open === "t")
        await client.$executeRawUnsafe!(`CLOSE ${name}`);
    } catch {
      // The transaction is closed or aborted: the cursor ended with it.
    }
  }

  /** SQLite 6/7 adapters use `?`; the Prisma 8 shim expands `$n` itself. */
  private param(position: number): string {
    if (
      this.databaseType === "sqlite" &&
      this.prisma.$databaseType !== "sqlite"
    ) {
      return "?";
    }
    return `$${position}`;
  }

  private timestampParam(position: number): string {
    return this.databaseType === "postgresql"
      ? utcParam(position)
      : this.param(position);
  }

  private timestampValue(value: Date): Date | string {
    return this.databaseType === "postgresql" ? value.toISOString() : value;
  }

  private statusParam(position: number): string {
    const param = this.param(position);
    return this.databaseType === "postgresql"
      ? `${param}::"${this.statusEnumName}"`
      : param;
  }

  /**
   * Runs one console read, whatever number of statements it takes, and
   * translates a cancelled statement into `ConsoleQueryTimeoutError`.
   *
   * The callback receives the client to issue statements on, and every read
   * that needs more than one statement issues all of them here, inside a
   * single transaction — a run-detail page is up to eighteen statements,
   * and giving each its own interactive transaction would take that many
   * connections out of the consumer's pool to render one page.
   *
   * One transaction is not by itself one moment: at Postgres's default READ
   * COMMITTED each statement sees what was committed when it began. A read
   * whose statements are checked against each other (`snapshot`, the run
   * detail: the stage rows against the run's events) therefore opens its
   * transaction REPEATABLE READ on Postgres, so every statement sees the
   * moment of the first. A SQLite transaction is one moment already: a
   * writer cannot commit while it reads, or (in WAL mode) commits a version
   * it does not see.
   *
   * The transaction is opened only when the client has `$transaction`, and
   * the level is asked of the client (`isolationLevel`), never sent as a
   * statement: whether the client is already inside a transaction is the
   * client's to know. A Prisma 6 or Prisma 8 (`fromPrisma8`) transaction
   * client has no `$transaction`, so the read runs on it as it is. A Prisma
   * 7 transaction client has one, which opens a savepoint and does not apply
   * `isolationLevel`. A root client of any major begins its transaction at
   * that level. No statement the server refuses is sent either way.
   *
   * Inside the caller's transaction — the row-level-security case this
   * package exists for — its isolation level decides what the statements
   * see, and one moment needs it to be REPEATABLE READ. The caller's
   * `statement_timeout` is left as it was: with no `$transaction` the read
   * does not set it; in a Prisma 7 savepoint it sets it for its own
   * statements and restores the previous value before the savepoint is
   * released (a savepoint rolled back on an error restores it by itself).
   * A cancellation is reported honestly whoever set the limit.
   *
   * The client's own transaction limits (`timeout`, `maxWait`; Prisma's
   * defaults are 5 s and 2 s) are derived from `statementTimeoutMs`: the
   * transaction may last as long as its statements may run, and wait for a
   * connection as long as one statement may; with 0, neither is limited.
   * A client that gives up on the transaction (P2028) is reported as
   * `ConsoleQueryTimeoutError` too.
   */
  private async read<T>(
    label: string,
    fn: (client: ConsolePrismaClient, inTransaction: boolean) => Promise<T>,
    snapshot = false,
  ): Promise<T> {
    const ms = this.statementTimeoutMs;
    const postgres = this.databaseType === "postgresql";
    // Each within Node's longest timer and Postgres's `statement_timeout`.
    const timeout =
      ms > 0
        ? Math.min(ms * MAX_STATEMENTS_PER_READ, NO_LIMIT_MS)
        : NO_LIMIT_MS;
    const maxWait = ms > 0 ? ms : NO_LIMIT_MS;
    try {
      if (
        (ms > 0 || snapshot) &&
        typeof this.prisma.$transaction === "function"
      ) {
        // `fromPrisma8` takes no `maxWait`: the port bounds the wait itself
        // (and on SQLite on every major, see below).
        const shim = this.prisma.$databaseType !== undefined;
        const options = {
          ...(snapshot && postgres
            ? { isolationLevel: "RepeatableRead" as const }
            : {}),
          timeout,
          ...(shim ? {} : { maxWait }),
        };
        let began = false;
        let abandoned = false;
        const transaction = this.prisma.$transaction(async (tx) => {
          if (abandoned) throw new Abandoned();
          began = true;
          if (!postgres || ms === 0 || !tx.$executeRawUnsafe)
            return fn(tx, postgres);
          const [previous] = await this.select<{ statement_timeout: string }>(
            tx,
            { statement_timeout: "text" },
            "SHOW statement_timeout",
            [],
          );
          // `ms` is a validated integer, and a bare number here is
          // milliseconds. It is the one interpolated value in this file
          // besides the enum name.
          await tx.$executeRawUnsafe(`SET LOCAL statement_timeout = ${ms}`);
          const result = await fn(tx, true);
          // Inside a caller's transaction (a Prisma 7 savepoint) the setting
          // would outlive the read; in the read's own transaction this is a
          // no-op before the commit.
          await this.select(
            tx,
            { set_config: "text" },
            "SELECT set_config('statement_timeout', $1, true)",
            [previous!.statement_timeout],
          );
          return result;
        }, options);
        // On SQLite the port bounds the wait on every major: an engine adapter
        // built on a Prisma 6 or 7 client queues each transaction's begin
        // behind the one before, and that queue is outside `maxWait`.
        if (ms === 0 || (!shim && postgres)) return await transaction;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const wait = new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            if (began) return;
            abandoned = true;
            reject(new ConnectionWait());
          }, maxWait);
        });
        try {
          return await Promise.race([transaction, wait]);
        } finally {
          clearTimeout(timer);
          if (abandoned) transaction.catch(() => {});
        }
      }
      return await fn(
        this.prisma,
        postgres && snapshot && (await this.inCallersTransaction()),
      );
    } catch (error) {
      const limit = isStatementTimeout(error)
        ? "statement_timeout"
        : transactionLimitOf(error);
      if (limit) {
        throw new ConsoleQueryTimeoutError(label, ms, {
          cause: error,
          limit,
          limitMs:
            limit === "transaction"
              ? timeout
              : limit === "connection"
                ? maxWait
                : ms,
        });
      }
      throw error;
    }
  }

  /**
   * Whether a client with no `$transaction` (Prisma 6's transaction client,
   * `fromPrisma8(tx)`, or a wrapper that forwards none) runs inside a
   * transaction block. A setting made local by `set_config(..., true)` lasts
   * to the end of the transaction it was made in: the next statement still
   * sees it inside a block, and not after a statement that was a
   * transaction of its own (or ran on another connection of a pool). The
   * second statement clears it again, so the caller's transaction keeps
   * nothing of it. Neither statement can fail.
   */
  private async inCallersTransaction(): Promise<boolean> {
    await this.select(
      this.prisma,
      { set_config: "text" },
      "SELECT set_config('workflow_console.in_transaction', 'on', true)",
      [],
    );
    const [row] = await this.select<{ nested: unknown; set_config: string }>(
      this.prisma,
      { nested: "bool", set_config: "text" },
      `SELECT coalesce(current_setting('workflow_console.in_transaction', true), '') = 'on' AS nested,
       set_config('workflow_console.in_transaction', '', true)`,
      [],
    );
    return row?.nested === true || row?.nested === "t";
  }

  /** Convenience for the reads that are a single statement. */
  private query<T>(
    label: string,
    columns: RawColumns,
    sql: string,
    params: unknown[],
  ): Promise<T[]> {
    return this.read(label, (client) =>
      this.select<T>(client, columns, sql, params),
    );
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
        `("createdAt", id) < (${this.timestampParam(paramIdx)}, ${this.param(paramIdx + 1)})`,
      );
      params.push(this.timestampValue(cursor.createdAt), cursor.id);
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
        const placeholder = this.statusParam(paramIdx);
        paramIdx += 1;
        return placeholder;
      });
      where.push(`status IN (${placeholders.join(", ")})`);
    }

    if (query.filters?.workflowId !== undefined) {
      where.push(`"workflowId" = ${this.param(paramIdx)}`);
      params.push(query.filters.workflowId);
      paramIdx += 1;
    }

    if (query.filters?.workflowType !== undefined) {
      where.push(`"workflowType" = ${this.param(paramIdx)}`);
      params.push(query.filters.workflowType);
      paramIdx += 1;
    }

    if (query.filters?.definitionVersion !== undefined) {
      where.push(`"definitionVersion" = ${this.param(paramIdx)}`);
      params.push(query.filters.definitionVersion);
      paramIdx += 1;
    }

    if (query.filters?.createdAfter !== undefined) {
      where.push(`"createdAt" >= ${this.timestampParam(paramIdx)}`);
      params.push(this.timestampValue(query.filters.createdAfter));
      paramIdx += 1;
    }

    if (query.filters?.createdBefore !== undefined) {
      where.push(`"createdAt" < ${this.timestampParam(paramIdx)}`);
      params.push(this.timestampValue(query.filters.createdBefore));
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

    const rows = await this.query<RawRunRow>(
      "runs.list",
      RUN_COLUMNS,
      sql,
      params,
    );
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

  /**
   * The attempt history's events of one run with a sequence above `after`.
   *
   * What a read costs is bounded whatever the run's size, in every state of
   * the table's statistics (none, empty, current, stale): the highest
   * sequence is one backward probe of the `(workflowRunId, sequence)` unique
   * index, and the other statements are range scans on it of at most
   * `STAGE_EVENT_WINDOW` sequences past `after`. `eventType`
   * has no index, so the lifecycle statement filters the heap rows of its
   * range; the window caps that, and the page passing the last sequence it
   * has read makes a poll read only the rows written since the previous one.
   * A first read of a long run is a few bounded reads, each continuing from
   * the last.
   *
   * The read is closed at the run's highest sequence, taken first: inside a
   * caller's READ COMMITTED transaction a row committed between the
   * statements would be seen by the later ones, and must not be skipped by
   * the page's next read. At most
   * `STAGE_EVENT_LIMIT` events come back; when more match, the read ends at
   * its last event. Either cut says `more`, and the page asks again from
   * `lastSequence`. The range check counts only the rows the read covers. A
   * first read that finds no row is not complete: the run has an outbox row
   * from its creation, so none means its events were removed.
   */
  private async readStageEvents(
    client: ConsolePrismaClient,
    runId: string,
    afterRaw: number,
  ): Promise<StageEventLog> {
    const after = Number.isFinite(afterRaw)
      ? Math.min(Math.max(0, Math.floor(afterRaw)), SEQUENCE_MAX)
      : 0;
    // Not `max(sequence)`: Postgres plans that aggregate as a backward probe
    // of the index only when its statistics show the run as more than one
    // row, and otherwise reads the run's whole index range. This form is the
    // backward probe whatever the statistics say.
    const top = await this.select<RawEventTopRow>(
      client,
      EVENT_TOP_COLUMNS,
      `SELECT sequence FROM "outbox_events" WHERE "workflowRunId" = ${this.param(1)}
ORDER BY sequence DESC LIMIT 1`,
      [runId],
    );
    const maxSeq = top[0] ? toNumber(top[0].sequence) : 0;
    if (maxSeq <= after) {
      // Below `after`: rows past what the page holds were removed, and what
      // it holds may no longer be the run's rows.
      return maxSeq < after
        ? {
            events: [],
            after,
            lastSequence: maxSeq,
            complete: false,
            more: false,
          }
        : {
            events: [],
            after,
            lastSequence: after,
            complete: after > 0,
            more: false,
          };
    }
    const upper = Math.min(maxSeq, after + STAGE_EVENT_WINDOW);

    // Two payload fields are extracted in SQL and nothing else of the payload
    // is read (`workflow:completed` carries the run's output). The error text
    // comes back one character over its limit so a cut is visible.
    const payloadField = (name: string) =>
      this.databaseType === "postgresql"
        ? `payload->>'${name}'`
        : `json_extract(payload, '$.${name}')`;
    const types = [...STAGE_LIFECYCLE_EVENT_TYPES, ...RUN_BOUNDARY_EVENT_TYPES]
      .map((type) => `'${type}'`)
      .join(", ");
    const rows = await this.select<RawStageEventRow>(
      client,
      STAGE_EVENT_COLUMNS,
      `SELECT sequence, "eventType", "occurredAt",
       ${payloadField("stageId")} AS "stageId",
       CASE WHEN "eventType" IN ('stage:retrying', 'stage:failed') THEN substr(${payloadField("error")}, 1, ${STAGE_EVENT_ERROR_LIMIT + 1}) END AS error,
       CASE WHEN "eventType" LIKE 'stage:%' THEN "causationId" END AS "causationId"
FROM "outbox_events"
WHERE "workflowRunId" = ${this.param(1)} AND sequence > ${this.param(2)} AND sequence <= ${this.param(3)}
  AND "eventType" IN (${types})
ORDER BY sequence ASC
LIMIT ${STAGE_EVENT_LIMIT + 1}`,
      [runId, after, upper],
    );
    const cut = rows.length > STAGE_EVENT_LIMIT;
    const events = rows.slice(0, STAGE_EVENT_LIMIT).map(mapStageEvent);
    const lastSequence = cut ? events[events.length - 1]!.sequence : upper;
    const more = lastSequence < maxSeq;

    // With no gap the rows in `(after, lastSequence]` are exactly
    // `after + 1 .. lastSequence`, so a count equal to the difference says the
    // range is unbroken. It reads the index entries of this read's range only.
    const counted = await this.select<RawEventCountRow>(
      client,
      EVENT_COUNT_COLUMNS,
      `SELECT count(*) AS total FROM "outbox_events"
WHERE "workflowRunId" = ${this.param(1)} AND sequence > ${this.param(2)} AND sequence <= ${this.param(3)}`,
      [runId, after, lastSequence],
    );
    return {
      events,
      after,
      lastSequence,
      complete: lastSequence - after === toNumber(counted[0]?.total),
      more,
    };
  }

  async getRunDetail(
    runId: string,
    options?: RunDetailOptions,
  ): Promise<RunDetail | null> {
    const stepLimit = clampLimit(options?.stepLimit, 200);
    const annotationLimit = clampLimit(options?.annotationLimit, 200);
    const logLimit = clampLimit(options?.logLimit, 200);
    const eventLimit = clampLimit(options?.eventLimit, 200);

    // All statements share one transaction, at one moment (see `read`): that
    // many interactive transactions to render one page would take as many
    // connections out of the consumer's pool, and a stage that changes
    // between two of them would read as rows and events that disagree.
    // On SQLite an index named by `INDEXED BY` that no longer serves (dropped
    // or changed since it was looked up) fails the statement: the read runs
    // again with no index named, and the next read looks the indexes up anew.
    try {
      return await this.readRunDetail(runId, options, true, {
        stepLimit,
        annotationLimit,
        logLimit,
        eventLimit,
      });
    } catch (error) {
      if (this.databaseType !== "sqlite" || !isIndexError(error)) throw error;
      this.indexes = undefined;
      return this.readRunDetail(runId, options, false, {
        stepLimit,
        annotationLimit,
        logLimit,
        eventLimit,
      });
    }
  }

  private readRunDetail(
    runId: string,
    options: RunDetailOptions | undefined,
    named: boolean,
    limits: {
      stepLimit: number;
      annotationLimit: number;
      logLimit: number;
      eventLimit: number;
    },
  ): Promise<RunDetail | null> {
    const { stepLimit, annotationLimit, logLimit, eventLimit } = limits;
    return this.read(
      "run.detail",
      async (client, inTransaction) => {
        const runRows = await this.select<RawRunDetailRow>(
          client,
          RUN_DETAIL_COLUMNS,
          `SELECT id, "createdAt", "updatedAt", "workflowId", "workflowName", "workflowType",
       status, "startedAt", "completedAt", duration, "totalCost", "totalTokens", priority,
       "definitionVersion", "redriveCount",
       ${["input", "output", "config", "metadata"].map((c) => this.jsonColumn(c)).join(", ")}
FROM "workflow_runs" WHERE id = ${this.param(1)}`,
          [runId],
        );

        // A run that does not exist costs one statement, not six.
        const runRow = runRows[0];
        if (!runRow) return null;
        const run = {
          ...mapRunSummary(runRow),
          input: runRow.input,
          output: runRow.output,
          config: runRow.config,
          metadata: runRow.metadata,
        };
        const after = Math.max(0, Math.floor(options?.stageEventsAfter ?? 0));
        // The next part of a long history: two statements, not nine.
        if (options?.stageEventsOnly) {
          return {
            run,
            stages: [],
            steps: [],
            annotations: [],
            logs: [],
            events: [],
            stageEvents: await this.readStageEvents(client, runId, after),
            truncated: {
              steps: false,
              annotations: false,
              logs: false,
              events: false,
            },
          } satisfies RunDetail;
        }

        const stageRows = await this.select<RawStageRow>(
          client,
          STAGE_COLUMNS,
          `SELECT id, "workflowRunId", "stageId", "stageName", "stageNumber", "executionGroup",
       attempt, status, "startedAt", "completedAt", duration, "nextPollAt",
       "pollInterval", "maxWaitUntil", "errorMessage"
FROM "workflow_stages" WHERE "workflowRunId" = ${this.param(1)}
ORDER BY "stageNumber" ASC, "stageId" ASC`,
          [runId],
        );

        const hints = named ? await this.sqliteIndexes(client) : {};
        const stepRows = await this.readSteps(
          client,
          stageRows,
          stepLimit,
          hints.steps,
        );

        const annotationPage = await this.readAnnotations(
          client,
          runId,
          annotationLimit,
          inTransaction,
          hints.annotations,
        );

        const logRows = await this.select<RawLogRow>(
          client,
          LOG_COLUMNS,
          `SELECT id, "createdAt", "workflowRunId", "workflowStageId", level, message
FROM "workflow_logs"${indexedBy(hints.logs)} WHERE "workflowRunId" = ${this.param(1)}
ORDER BY "createdAt" DESC, id DESC
LIMIT ${logLimit + 1}`,
          [runId],
        );

        const eventRows = await this.select<RawEventRow>(
          client,
          EVENT_COLUMNS,
          `SELECT id, "workflowRunId", sequence, "eventType", "occurredAt", "publishedAt",
       "retryCount", "dlqAt"
FROM "outbox_events" WHERE "workflowRunId" = ${this.param(1)}
ORDER BY sequence ASC
LIMIT ${eventLimit + 1}`,
          [runId],
        );

        const stageEvents = await this.readStageEvents(client, runId, after);

        // Each list asked for one row more than it will show, so "there is
        // more than this" is known without a second count.
        const truncated = {
          steps: stepRows.length > stepLimit,
          annotations: annotationPage.more,
          logs: logRows.length > logLimit,
          events: eventRows.length > eventLimit,
        };

        return {
          run,
          stages: stageRows.map(mapStageSummary),
          steps: stepRows.slice(0, stepLimit).map(mapStepSummary),
          annotations: annotationPage.rows.map(mapAnnotationSummary),
          logs: logRows.slice(0, logLimit).map(mapLogEntry),
          events: eventRows.slice(0, eventLimit).map(mapRunEvent),
          stageEvents,
          truncated,
        } satisfies RunDetail;
      },
      true,
    );
  }

  /**
   * A page of the run's steps in stage order (the stages statement's order,
   * then `seq`), read by the stage ids that statement returned, so no plan
   * reads another run's rows. No index orders a stage's steps by `seq`, so
   * each stage's steps are read whole and sorted: the cost is one index
   * probe per stage and at most one page per step of the run.
   *
   * On Postgres each stage is read through a `LATERAL` subquery with its own
   * limit: a nested loop over the stage list whose inner side is a lookup by
   * `"stageRecordId"`. A join to the stages table, or one `IN` list over the
   * stage ids, is planned as a scan of the whole steps table for a run of
   * many stages or with no statistics. On SQLite the stage list is the
   * outer side of a `CROSS JOIN` (which SQLite never reorders) and each
   * stage's steps are found through the named `"stageRecordId"` index
   * (`INDEXED BY`): no statistics can make the planner scan a table for each
   * step (statistics taken while the stages table held one row planned a
   * scan of it per step when the stages table was joined).
   *
   * The stage ids go as one parameter (a `text[]` on Postgres, a JSON array
   * on SQLite), so a run of any number of stages is one statement, under
   * every store's parameter limit.
   */
  private async readSteps(
    client: ConsolePrismaClient,
    stages: RawStageRow[],
    stepLimit: number,
    index: string | undefined,
  ): Promise<RawStepRow[]> {
    if (stages.length === 0) return [];
    const columns = `s.id, s."stageRecordId", s."stepId", s.seq, s.kind, s.status, s.attempt,
       s."leaseExpiresAt", s."deadlineAt", s."externalKey", s.error, s."createdAt", s."updatedAt"`;
    const ids = stages.map((stage) => stage.id);
    if (this.databaseType === "postgresql")
      return this.select<RawStepRow>(
        client,
        STEP_COLUMNS,
        `SELECT ${columns}
FROM unnest(${this.param(1)}::text[]) WITH ORDINALITY AS st(id, position)
CROSS JOIN LATERAL (
  SELECT * FROM "workflow_steps" x WHERE x."stageRecordId" = st.id
  ORDER BY x.seq ASC LIMIT ${stepLimit + 1}
) s
ORDER BY st.position ASC, s.seq ASC
LIMIT ${stepLimit + 1}`,
        [ids],
      );
    return this.select<RawStepRow>(
      client,
      STEP_COLUMNS,
      `SELECT ${columns}
FROM json_each(${this.param(1)}) AS st
CROSS JOIN "workflow_steps" AS s${indexedBy(index)} ON s."stageRecordId" = st.value
ORDER BY st.key ASC, s.seq ASC
LIMIT ${stepLimit + 1}`,
      [JSON.stringify(ids)],
    );
  }

  /**
   * The newest `limit` annotations of the run, newest first, those that
   * share a time ordered by id (by its bytes, as Postgres's `"C"` collation
   * and SQLite compare), and one more to say whether more remain. No index
   * holds `id` after `"createdAt"`, and `ORDER BY "createdAt" DESC, id DESC
   * LIMIT n` in one statement is planned, when the statistics expect few
   * rows for the run, as a read and sort of every annotation of the run.
   *
   * 1. The times of the newest `limit + 1`, in the order of the run's
   *    ("workflowRunId", "createdAt") index alone: a backward walk of the
   *    index that stops at the limit (on Postgres a cursor, see `firstRows`;
   *    on SQLite `INDEXED BY` that index).
   * 2. The rows newer than the page's oldest time, the same way, with a
   *    limit of their count.
   * 3. When the page ends inside a group of annotations that share a time,
   *    the first ids of that group, with a limit of the rows still missing.
   *    No index orders a group by id: the group is read through the run's
   *    index and sorted, keeping only that many rows.
   *
   * So at most `limit` rows are fetched, and `limit + 1` times; the cost is
   * a few index pages per page of rows (one heap page per row where the
   * run's rows are spread among other runs'), plus, when the page ends
   * inside a group, a read of every row of that group.
   */
  private async readAnnotations(
    client: ConsolePrismaClient,
    runId: string,
    limit: number,
    inTransaction: boolean,
    index: string | undefined,
  ): Promise<{ rows: RawAnnotationRow[]; more: boolean }> {
    const from = `FROM "workflow_annotations"${indexedBy(index)} WHERE "workflowRunId" = ${this.param(1)}`;
    const columns = `id, "createdAt", "workflowRunId", "workflowStageRecordId", attempt, scope,
       "scopeId", "actorKind", "actorId", key, ${this.jsonColumn("value")}`;
    const times = await this.firstRows<{ createdAt: unknown }>(
      client,
      { createdAt: "timestamp" },
      `SELECT "createdAt" ${from}\nORDER BY "createdAt" DESC\nLIMIT ${limit + 1}`,
      [runId],
      inTransaction,
    );
    const time = (row: { createdAt: unknown }) =>
      toDate(row.createdAt)!.getTime();
    const sorted = (rows: RawAnnotationRow[]) =>
      rows.sort(
        (a, b) =>
          time(b) - time(a) ||
          Buffer.compare(Buffer.from(b.id), Buffer.from(a.id)),
      );
    if (times.length === 0) return { rows: [], more: false };
    if (times.length <= limit) {
      // Every annotation of the run: at most `limit` rows.
      const rows = await this.firstRows<RawAnnotationRow>(
        client,
        ANNOTATION_COLUMNS,
        `SELECT ${columns} ${from}\nORDER BY "createdAt" DESC\nLIMIT ${limit}`,
        [runId],
        inTransaction,
      );
      return { rows: sorted(rows), more: false };
    }
    // The page's oldest time, and how many of its rows are newer.
    const oldest = times[limit - 1]!;
    const newer = times
      .slice(0, limit)
      .filter((row) => time(row) > time(oldest)).length;
    const at = this.timestampValue(toDate(oldest.createdAt)!);
    const rows =
      newer > 0
        ? await this.firstRows<RawAnnotationRow>(
            client,
            ANNOTATION_COLUMNS,
            `SELECT ${columns} ${from} AND "createdAt" > ${this.timestampParam(2)}\nORDER BY "createdAt" DESC\nLIMIT ${newer}`,
            [runId, at],
            inTransaction,
          )
        : [];
    if (newer === limit) return { rows: sorted(rows), more: true };
    // The page ends inside the group at `oldest`: its first ids. The fence
    // keeps the planner from walking the primary key in id order and
    // filtering the whole table for the group's rows.
    const fence = this.databaseType === "postgresql" ? "OFFSET 0" : "LIMIT -1";
    const order =
      this.databaseType === "postgresql" ? `id COLLATE "C" DESC` : "id DESC";
    const group = await this.select<RawAnnotationRow>(
      client,
      ANNOTATION_COLUMNS,
      `SELECT * FROM (SELECT ${columns} ${from} AND "createdAt" = ${this.timestampParam(2)} ${fence}) g
ORDER BY ${order}
LIMIT ${limit - newer}`,
      [runId, at],
    );
    return { rows: sorted([...rows, ...group]), more: true };
  }

  /**
   * SQLite: the indexes the run detail names with `INDEXED BY`, found by
   * their columns (Prisma 8 adds a hash to an index's name). Statistics
   * taken while a table held a few rows plan a run's lookup as a scan of
   * the whole table; naming the index leaves the planner no other choice.
   * Only a full index (not partial) whose leading key columns are the
   * statement's, by plain column and the default collation, can serve it;
   * the one with the fewest key columns is named. A schema without one
   * reads that table unnamed. Read once, and again after a statement fails
   * on an index (see `getRunDetail`).
   */
  private sqliteIndexes(
    client: ConsolePrismaClient,
  ): Promise<{ annotations?: string; logs?: string; steps?: string }> {
    if (this.databaseType !== "sqlite") return Promise.resolve({});
    this.indexes ??= this.select<{ tbl: string; name: string; cols: string }>(
      client,
      { tbl: "text", name: "text", cols: "text" },
      // An expression key column has no name; another collation is written
      // after the column, so neither matches a plain column name.
      `SELECT t.tbl AS tbl, l.name AS name,
       (SELECT group_concat(coalesce(x.name, '(expression)') || CASE WHEN x.coll = 'BINARY' THEN '' ELSE ' ' || x.coll END, ',')
        FROM (SELECT * FROM pragma_index_xinfo(l.name) WHERE key = 1 ORDER BY seqno) x) AS cols
FROM (SELECT 'workflow_annotations' AS tbl UNION ALL SELECT 'workflow_logs' UNION ALL SELECT 'workflow_steps') t,
     pragma_index_list(t.tbl) l
WHERE l.partial = 0
ORDER BY l.name`,
      [],
    ).then(
      (rows) => {
        const find = (table: string, cols: string) =>
          rows
            .filter(
              (row) =>
                row.tbl === table &&
                (row.cols === cols || row.cols?.startsWith(`${cols},`)),
            )
            .sort(
              (a, b) => a.cols.split(",").length - b.cols.split(",").length,
            )[0]?.name;
        return {
          annotations: find("workflow_annotations", "workflowRunId,createdAt"),
          logs: find("workflow_logs", "workflowRunId"),
          steps: find("workflow_steps", "stageRecordId"),
        };
      },
      (error: unknown) => {
        this.indexes = undefined;
        throw error;
      },
    );
    return this.indexes;
  }

  async listRunEvents(
    runId: string,
    afterSequence: number,
    limit?: number,
  ): Promise<RunEvent[]> {
    if (typeof afterSequence !== "number" || Number.isNaN(afterSequence))
      throw new ConsoleBadRequestError(
        `afterSequence must be a number, got ${String(afterSequence)}`,
      );
    const clampedLimit = clampLimit(limit, 200);
    // A sequence is a 32-bit integer column: no row lies past its largest
    // value, and a bound past it would be refused by Postgres.
    const after = Math.max(-1, Math.floor(afterSequence));
    if (after >= SEQUENCE_MAX) return [];
    // Two statements, so that neither plan depends on the table's
    // statistics: the first row after the cursor is a forward probe of the
    // run's index, and the page is read within the next `limit` sequences
    // from it. A single `sequence > $2 ORDER BY sequence LIMIT n` is planned as
    // a sort of the run's whole remaining range when the planner expects
    // fewer than `n` rows (no statistics, or stale ones).
    const rows = await this.read("run.events.tail", async (client) => {
      const start = await this.select<RawEventTopRow>(
        client,
        EVENT_TOP_COLUMNS,
        `SELECT sequence FROM "outbox_events" WHERE "workflowRunId" = ${this.param(1)} AND sequence > ${this.param(2)}
ORDER BY sequence ASC LIMIT 1`,
        [runId, after],
      );
      if (!start[0]) return [];
      const first = toNumber(start[0].sequence);
      return this.select<RawEventRow>(
        client,
        EVENT_COLUMNS,
        `SELECT id, "workflowRunId", sequence, "eventType", "occurredAt", "publishedAt",
       "retryCount", "dlqAt"
FROM "outbox_events" WHERE "workflowRunId" = ${this.param(1)} AND sequence >= ${this.param(2)} AND sequence <= ${this.param(3)}
ORDER BY sequence ASC LIMIT ${clampedLimit}`,
        [runId, first, Math.min(first + clampedLimit - 1, SEQUENCE_MAX)],
      );
    });
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
          { status: "text", count: "bigint" },
          `SELECT ${this.databaseType === "postgresql" ? "status::text" : "status"} AS status, count(*) AS count FROM "job_queue" GROUP BY status`,
          [],
        ),
        this.select<{ oldest: RawNullableTimestamp }>(
          client,
          OLDEST_COLUMNS,
          `SELECT min("createdAt") AS oldest FROM "job_queue" WHERE status = ${this.statusParam(1)}`,
          ["PENDING"],
        ),
        this.select<{ oldest: RawNullableTimestamp }>(
          client,
          OLDEST_COLUMNS,
          `SELECT min("lockedAt") AS oldest FROM "job_queue" WHERE status = ${this.statusParam(1)} AND "lockedAt" IS NOT NULL`,
          ["RUNNING"],
        ),
        this.select<{ count: unknown }>(
          client,
          COUNT_COLUMNS,
          `SELECT count(*) AS count FROM "job_queue" WHERE status = ${this.statusParam(1)} AND "nextPollAt" IS NOT NULL AND "nextPollAt" <= ${this.timestampParam(2)}`,
          ["SUSPENDED", this.timestampValue(this.now())],
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
      SUSPENDED_STAGE_COLUMNS,
      `SELECT st.id, st."workflowRunId", r."workflowId", st."stageId", st."stageName",
       st.attempt, st."nextPollAt", st."pollInterval", st."maxWaitUntil"
FROM "workflow_stages" st
JOIN "workflow_runs" r ON r.id = st."workflowRunId"
WHERE st.status = ${this.statusParam(1)} AND st."nextPollAt" IS NOT NULL
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
      DEAD_LETTER_COLUMNS,
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
      WORKER_COLUMNS,
      `SELECT "workerId", count(*) AS running, min("lockedAt") AS oldest, max("lockedAt") AS newest
FROM "job_queue"
WHERE status = ${this.statusParam(1)} AND "workerId" IS NOT NULL
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
        COST_COLUMNS,
        `SELECT "workflowId" AS key, count(*) AS runs, sum("totalCost") AS cost, sum("totalTokens") AS tokens
FROM "workflow_runs" WHERE "createdAt" >= ${this.timestampParam(1)} AND "createdAt" < ${this.timestampParam(2)}
GROUP BY "workflowId" ORDER BY sum("totalCost") DESC`,
        [this.timestampValue(from), this.timestampValue(to)],
      );
      return rows.map(mapCostBucket);
    } else {
      const sql =
        this.databaseType === "postgresql"
          ? `SELECT to_char(date_trunc('day', "createdAt"), 'YYYY-MM-DD') AS key,
       count(*) AS runs, sum("totalCost") AS cost, sum("totalTokens") AS tokens
FROM "workflow_runs" WHERE "createdAt" >= ${this.timestampParam(1)} AND "createdAt" < ${this.timestampParam(2)}
GROUP BY 1 ORDER BY 1 DESC`
          : `SELECT CASE
         WHEN typeof("createdAt") IN ('integer', 'real')
           THEN strftime('%Y-%m-%d', "createdAt" / 1000.0, 'unixepoch')
         ELSE strftime('%Y-%m-%d', "createdAt")
       END AS key,
       count(*) AS runs, sum("totalCost") AS cost, sum("totalTokens") AS tokens
FROM "workflow_runs" WHERE "createdAt" >= ${this.timestampParam(1)} AND "createdAt" < ${this.timestampParam(2)}
GROUP BY 1 ORDER BY 1 DESC`;
      const rows = await this.query<RawCostRow>(
        "costs.byDay",
        COST_COLUMNS,
        sql,
        [this.timestampValue(from), this.timestampValue(to)],
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
