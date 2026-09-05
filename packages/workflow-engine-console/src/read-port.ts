/**
 * The console's read contract.
 *
 * Everything the console can show is expressed here, and nothing else in
 * the package reaches for a database. An implementation is handed the
 * connection its caller already has — a Prisma client, or the transaction
 * client the caller opened — and never opens one of its own. That is the
 * property the whole design exists to preserve: a consumer running the
 * kernel inside one transaction per tenant, under row-level security, gets
 * the console's reads inside that same transaction, evaluated against the
 * same policies, with authentication already decided upstream. A reader
 * that dialled the database itself would be a second session and therefore
 * a second security context, and no amount of configuration recovers the
 * tenant scoping once that happens.
 *
 * The interface is declared here rather than added to the engine's
 * `PersistenceCore` on purpose — see the note in the package README. It is
 * a small, optional surface; making it a required part of the persistence
 * port would break every third-party adapter for a feature that is
 * explicitly optional.
 */

/** Run/stage/job lifecycle states, mirroring the engine's `Status` enum. */
export type ConsoleStatus =
  | "PENDING"
  | "RUNNING"
  | "SUSPENDED"
  | "COMPLETED"
  | "FAILED"
  | "CANCELLED"
  | "SKIPPED";

export const CONSOLE_STATUSES: readonly ConsoleStatus[] = [
  "PENDING",
  "RUNNING",
  "SUSPENDED",
  "COMPLETED",
  "FAILED",
  "CANCELLED",
  "SKIPPED",
] as const;

export function isConsoleStatus(value: string): value is ConsoleStatus {
  return (CONSOLE_STATUSES as readonly string[]).includes(value);
}

/** One row of the runs list. Deliberately excludes `input`/`output`/`config`: a list page must not carry payloads. */
export interface RunSummary {
  id: string;
  createdAt: Date;
  updatedAt: Date;
  workflowId: string;
  workflowName: string;
  workflowType: string;
  status: ConsoleStatus;
  startedAt: Date | null;
  completedAt: Date | null;
  duration: number | null;
  totalCost: number;
  totalTokens: number;
  priority: number;
  definitionVersion: string | null;
  redriveCount: number;
}

export interface StageSummary {
  id: string;
  workflowRunId: string;
  stageId: string;
  stageName: string;
  stageNumber: number;
  executionGroup: number;
  attempt: number;
  status: ConsoleStatus;
  startedAt: Date | null;
  completedAt: Date | null;
  duration: number | null;
  nextPollAt: Date | null;
  pollInterval: number | null;
  maxWaitUntil: Date | null;
  errorMessage: string | null;
}

/** A durable-step ledger entry. `status` is a free-form string in the schema, so it stays one here. */
export interface StepSummary {
  id: string;
  stageRecordId: string;
  stepId: string;
  seq: number;
  kind: string;
  status: string;
  attempt: number;
  leaseExpiresAt: Date | null;
  deadlineAt: Date | null;
  /** Deterministic name of the external effect a `run` step creates; null for other kinds. */
  externalKey: string | null;
  error: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface AnnotationSummary {
  id: string;
  createdAt: Date;
  workflowRunId: string;
  workflowStageRecordId: string | null;
  attempt: number;
  scope: string;
  scopeId: string | null;
  actorKind: string | null;
  actorId: string | null;
  key: string;
  value: unknown;
}

export interface LogEntry {
  id: string;
  createdAt: Date;
  workflowRunId: string | null;
  workflowStageId: string | null;
  level: string;
  message: string;
}

/**
 * One retained outbox row, read as a run's event timeline. The engine marks
 * events published rather than deleting them, and `(workflowRunId, sequence)`
 * is unique, so a run timeline is an index range scan.
 */
export interface RunEvent {
  id: string;
  workflowRunId: string;
  sequence: number;
  eventType: string;
  occurredAt: Date;
  publishedAt: Date | null;
  retryCount: number;
  dlqAt: Date | null;
}

export interface RunDetail {
  run: RunSummary & {
    input: unknown;
    output: unknown;
    config: unknown;
    metadata: unknown;
  };
  stages: StageSummary[];
  steps: StepSummary[];
  annotations: AnnotationSummary[];
  logs: LogEntry[];
  events: RunEvent[];
  /** True when a list was cut off by its limit, so the UI can say so instead of implying completeness. */
  truncated: {
    steps: boolean;
    annotations: boolean;
    logs: boolean;
    events: boolean;
  };
}

export interface RunListFilters {
  status?: ConsoleStatus[];
  workflowId?: string;
  workflowType?: string;
  createdAfter?: Date;
  createdBefore?: Date;
  definitionVersion?: string;
}

export interface RunListQuery {
  filters?: RunListFilters;
  /** Opaque cursor from a previous page's `nextCursor`. Keyset, not offset. */
  cursor?: string;
  limit?: number;
}

export interface RunListPage {
  runs: RunSummary[];
  nextCursor: string | null;
}

export interface QueueHealth {
  countsByStatus: Record<ConsoleStatus, number>;
  /** Enqueue time of the oldest job still waiting to be picked up. */
  oldestPendingAt: Date | null;
  /** `lockedAt` of the longest-held lease among running jobs — a lease older than your reaper's threshold is a stuck worker. */
  oldestLeaseAt: Date | null;
  /** Suspended jobs whose `nextPollAt` is already in the past. */
  overduePolls: number;
}

/**
 * A worker, derived from the leases it holds. The engine has no worker
 * registry table; `touchJob` refreshes `job_queue.lockedAt`, so the newest
 * lease a worker holds is the best available heartbeat, and a worker with
 * no running job is invisible here by construction.
 */
export interface WorkerInstance {
  workerId: string;
  runningJobs: number;
  oldestLockedAt: Date | null;
  /** Most recent `touchJob`; the console renders `now - lastSeenAt` as heartbeat age. */
  lastSeenAt: Date | null;
}

export interface SuspendedStage {
  id: string;
  workflowRunId: string;
  workflowId: string;
  stageId: string;
  stageName: string;
  attempt: number;
  nextPollAt: Date | null;
  pollInterval: number | null;
  maxWaitUntil: Date | null;
}

export interface DeadLetter {
  id: string;
  workflowRunId: string;
  sequence: number;
  eventType: string;
  retryCount: number;
  occurredAt: Date;
  dlqAt: Date | null;
}

export interface CostBucket {
  /** A workflow id, or an ISO date (`YYYY-MM-DD`) when bucketing by day. */
  key: string;
  runs: number;
  cost: number;
  tokens: number;
}

export interface CostQuery {
  by: "workflow" | "day";
  from?: Date;
  to?: Date;
}

/**
 * What a given reader can actually serve, so the UI hides what is not there
 * rather than rendering an empty page. Adapters that predate a view, or
 * schemas whose migrations lag, report `false` and the tab disappears.
 */
export interface ConsoleCapabilities {
  runs: boolean;
  steps: boolean;
  annotations: boolean;
  queue: boolean;
  suspended: boolean;
  deadLetters: boolean;
  workers: boolean;
  costs: boolean;
}

export const ALL_CAPABILITIES: ConsoleCapabilities = {
  runs: true,
  steps: true,
  annotations: true,
  queue: true,
  suspended: true,
  deadLetters: true,
  workers: true,
  costs: true,
};

export interface RunDetailOptions {
  stepLimit?: number;
  annotationLimit?: number;
  logLimit?: number;
  eventLimit?: number;
}

export interface ConsoleReadPort {
  readonly capabilities: ConsoleCapabilities;

  listRuns(query: RunListQuery): Promise<RunListPage>;
  getRunDetail(
    runId: string,
    options?: RunDetailOptions,
  ): Promise<RunDetail | null>;
  /** Incremental tail of one run's timeline. `afterSequence` of 0 returns from the start. */
  listRunEvents(
    runId: string,
    afterSequence: number,
    limit?: number,
  ): Promise<RunEvent[]>;
  getQueueHealth(): Promise<QueueHealth>;
  listSuspendedStages(limit?: number): Promise<SuspendedStage[]>;
  listDeadLetters(limit?: number): Promise<DeadLetter[]>;
  listWorkers(): Promise<WorkerInstance[]>;
  getCosts(query: CostQuery): Promise<CostBucket[]>;
}

/** Default page size for the runs list. */
export const DEFAULT_RUN_LIMIT = 50;
/** Hard ceiling on any page size, whatever the request asks for. */
export const MAX_LIMIT = 200;

export function clampLimit(
  requested: number | undefined,
  fallback = DEFAULT_RUN_LIMIT,
): number {
  if (requested === undefined || !Number.isFinite(requested)) return fallback;
  return Math.min(MAX_LIMIT, Math.max(1, Math.floor(requested)));
}

/**
 * Keyset cursors are `(createdAt, id)` — the exact tuple the composite
 * indexes carry — encoded as opaque text so callers cannot turn one into an
 * offset. Offset pagination is what makes page 400 a sequential scan.
 */
export interface RunCursor {
  createdAt: Date;
  id: string;
}

export function encodeCursor(cursor: RunCursor): string {
  return Buffer.from(
    `${cursor.createdAt.toISOString()}|${cursor.id}`,
    "utf8",
  ).toString("base64url");
}

export function decodeCursor(raw: string): RunCursor | null {
  let decoded: string;
  try {
    decoded = Buffer.from(raw, "base64url").toString("utf8");
  } catch {
    return null;
  }
  const separator = decoded.indexOf("|");
  if (separator <= 0) return null;
  const createdAt = new Date(decoded.slice(0, separator));
  const id = decoded.slice(separator + 1);
  if (Number.isNaN(createdAt.getTime()) || id.length === 0) return null;
  return { createdAt, id };
}
