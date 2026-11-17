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

/** The stage lifecycle events a stage's attempt history is built from. */
export const STAGE_LIFECYCLE_EVENT_TYPES = [
  "stage:started",
  "stage:suspended",
  "stage:retrying",
  "stage:failed",
  "stage:completed",
] as const;

/**
 * The run-level events the attempt history reads. `workflow:created` is the
 * run's first outbox row (sequence 1): a range that begins with it starts
 * where the run did. `workflow:started` is written by the claim and by every
 * redrive (`run.redrive`, `run.rerunFrom`), which reopen or recreate stages
 * without a stage event; `workflow:completed`, `workflow:failed` and
 * `workflow:cancelled` are written with every terminal status of the run.
 * `run.cancel` marks every non-terminal stage CANCELLED and emits only
 * `workflow:cancelled`. A redrive takes only a terminal run, so in a run's
 * events each `workflow:started` after the first follows one of those three.
 */
export const RUN_BOUNDARY_EVENT_TYPES = [
  "workflow:created",
  "workflow:started",
  "workflow:completed",
  "workflow:failed",
  "workflow:cancelled",
] as const;

export type StageLifecycleEventType =
  (typeof STAGE_LIFECYCLE_EVENT_TYPES)[number];
export type RunBoundaryEventType = (typeof RUN_BOUNDARY_EVENT_TYPES)[number];

/** Ceiling on the events one run-detail read returns for the attempt history. */
export const STAGE_EVENT_LIMIT = 2000;
/**
 * Outbox sequences of a run that one read of the attempt history covers at
 * most, so a read goes through at most this many rows of the run whatever
 * its size (`eventType` has no index, so the rows of the range are read).
 */
export const STAGE_EVENT_WINDOW = 10_000;
/** Characters of a lifecycle event's error text that a read returns; the rest is cut. */
export const STAGE_EVENT_ERROR_LIMIT = 2000;

/**
 * One outbox row of the attempt history with the two payload fields it
 * needs. The rest of the payload is never read: `workflow:completed` carries
 * the run's output, and the console's lists are payload-free by design.
 */
export interface StageEvent {
  sequence: number;
  eventType: StageLifecycleEventType | RunBoundaryEventType;
  occurredAt: Date;
  /**
   * The stage definition's id (`StageSummary.stageId`), not the stage record
   * id. Null on the run-level events, which concern every stage of the run.
   */
  stageId: string | null;
  /**
   * Carried by `stage:retrying` and `stage:failed`; null on the others. At
   * most `STAGE_EVENT_ERROR_LIMIT` characters.
   */
  error: string | null;
  /** True when `error` was cut at `STAGE_EVENT_ERROR_LIMIT` characters. */
  errorTruncated: boolean;
}

/**
 * Cuts an error text to `STAGE_EVENT_ERROR_LIMIT` characters (code points, as
 * both databases count them). Readers fetch one character more than the limit
 * so that a cut is known without a second read.
 */
export function cutStageEventError(text: string | null): {
  error: string | null;
  errorTruncated: boolean;
} {
  if (text === null) return { error: null, errorTruncated: false };
  const chars = [...text];
  if (chars.length <= STAGE_EVENT_ERROR_LIMIT) {
    return { error: text, errorTruncated: false };
  }
  return {
    error: chars.slice(0, STAGE_EVENT_ERROR_LIMIT).join(""),
    errorTruncated: true,
  };
}

/**
 * The attempt history's input: the stage lifecycle events and run-level
 * boundary events of a run with a sequence greater than `after`. The page
 * keeps what it has read and asks only for the rows after its last sequence,
 * so one read costs the new rows of the run, never all of them. A read
 * covers at most `STAGE_EVENT_WINDOW` sequences and returns at most
 * `STAGE_EVENT_LIMIT` events; when rows remain past either it stops there
 * (`more`) and the page asks again from `lastSequence`, so a long history is
 * read in bounded chunks.
 */
export interface StageEventLog {
  /** Ascending by sequence, at most `STAGE_EVENT_LIMIT`. */
  events: StageEvent[];
  /** The `stageEventsAfter` this read was made with; 0 for a first read. */
  after: number;
  /**
   * The highest outbox sequence this read covers: the run's highest sequence,
   * `after + STAGE_EVENT_WINDOW` when that is lower, or the sequence of its
   * last event when it stopped at `STAGE_EVENT_LIMIT`. `after` when no row is
   * newer. The run's highest sequence when that is below `after`: rows past
   * the page's position were removed, and `complete` is false.
   */
  lastSequence: number;
  /**
   * True only when every sequence in `(after, lastSequence]` has a retained
   * row. A first read that finds no row is false. False means rows were
   * removed (by SQL, such as a pruning job), and a grouping built from them could be
   * wrong. True with `after` 0 is not enough for the page: a run's outbox
   * starts at sequence 1 with `workflow:created`, and a store numbers rows
   * from 1 again after every row of a run was removed, so the page also needs
   * that first event among `events`.
   */
  complete: boolean;
  /** True when rows past `lastSequence` remain: the read stopped at its window or its limit. */
  more: boolean;
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
  /**
   * Input to the per-attempt stage history, read after
   * `RunDetailOptions.stageEventsAfter`. Optional so a custom reader that
   * predates it keeps compiling; without it the UI shows each stage's latest
   * attempt only and says the per-attempt history is unavailable.
   */
  stageEvents?: StageEventLog;
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
  /**
   * Return only the stage events with a sequence greater than this. The
   * console page passes the last sequence it has read, so a poll reads the
   * run's new outbox rows and a first load reads the run once.
   */
  stageEventsAfter?: number;
  /**
   * Read only the run and its `stageEvents`; `stages`, `steps`,
   * `annotations`, `logs` and `events` come back empty. The page asks this
   * way for the next part of a long history, and uses nothing else of the
   * answer, so a reader that ignores it keeps working.
   */
  stageEventsOnly?: boolean;
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
