/**
 * Persistence Interfaces for Workflow Engine
 *
 * These interfaces abstract database operations to enable:
 * - Testing with mock implementations
 * - Future extraction into @bratsos/workflow-engine package
 * - Alternative database backends
 *
 * Implementations:
 * - PrismaWorkflowPersistence (default, in ./prisma/)
 * - InMemoryPersistence (for testing)
 */

// ============================================================================
// Unified Status Type
// ============================================================================

/**
 * Unified status type for workflows, stages, and jobs.
 *
 * - PENDING: Not started yet
 * - RUNNING: Currently executing
 * - SUSPENDED: Paused, waiting for external event (e.g., batch job completion)
 * - COMPLETED: Finished successfully
 * - FAILED: Finished with error
 * - CANCELLED: Manually stopped by user
 * - SKIPPED: Stage-specific - bypassed due to condition
 */
export type Status =
  | "PENDING"
  | "RUNNING"
  | "SUSPENDED"
  | "COMPLETED"
  | "FAILED"
  | "CANCELLED"
  | "SKIPPED";

/** @deprecated Use Status instead */
export type WorkflowStatus = Status;

/** @deprecated Use Status instead */
export type WorkflowStageStatus = Status;

/** @deprecated Use Status instead. Note: PROCESSING is now RUNNING. */
export type JobStatus = Status;

export type LogLevel = "DEBUG" | "INFO" | "WARN" | "ERROR";

export type ArtifactType = "STAGE_OUTPUT" | "ARTIFACT" | "METADATA";

export class StaleVersionError extends Error {
  constructor(
    public readonly entity: string,
    public readonly id: string,
    public readonly expected: number,
    public readonly actual: number,
  ) {
    super(
      `Stale version on ${entity} ${id}: expected ${expected}, got ${actual}`,
    );
    this.name = "StaleVersionError";
  }
}

// ============================================================================
// Record Types (minimal fields needed by the workflow engine)
// ============================================================================

/** The run statuses `run.purge` may delete. */
export type PurgeableRunStatus = "COMPLETED" | "FAILED" | "CANCELLED";

/** One run `listRunsForPurge` found eligible for deletion. */
export interface PurgeableRun {
  id: string;
  workflowType: string;
  status: PurgeableRunStatus;
  /** `WorkflowStage.id` of every stage record the run owns. */
  stageRecordIds: string[];
}

export interface WorkflowRunRecord {
  id: string;
  createdAt: Date;
  updatedAt: Date;
  version: number;
  workflowId: string;
  workflowName: string;
  workflowType: string;
  status: Status;
  startedAt: Date | null;
  completedAt: Date | null;
  duration: number | null;
  input: unknown;
  output: unknown | null;
  config: unknown;
  totalCost: number;
  totalTokens: number;
  priority: number;
  metadata: unknown | null;
  /**
   * The definition version this run is pinned to, or `null` for a run
   * created before the consumer migrated to definition versioning (or on a
   * database whose schema predates it). A `null` version is claimable and
   * executable by any host, exactly as before versioning existed.
   */
  definitionVersion: string | null;
  /** How many times `run.redrive` has re-driven this run. */
  redriveCount: number;
}

export interface WorkflowStageRecord {
  id: string;
  createdAt: Date;
  updatedAt: Date;
  version: number;
  workflowRunId: string;
  stageId: string;
  stageName: string;
  stageNumber: number;
  executionGroup: number;
  /**
   * Rerun generation. 0 for the original execution; incremented each
   * time `run.rerunFrom` recreates this stage. Annotations written by
   * `ctx.annotate(...)` during this stage inherit this value so a
   * future agent can distinguish decisions made on different attempts
   * of the same logical stage.
   */
  attempt: number;
  status: Status;
  startedAt: Date | null;
  completedAt: Date | null;
  duration: number | null;
  inputData: unknown | null;
  outputData: unknown | null;
  config: unknown | null;
  suspendedState: unknown | null;
  resumeData: unknown | null;
  nextPollAt: Date | null;
  pollInterval: number | null;
  maxWaitUntil: Date | null;
  metrics: unknown | null;
  embeddingInfo: unknown | null;
  errorMessage: string | null;
}

export interface WorkflowLogRecord {
  id: string;
  createdAt: Date;
  workflowStageId: string | null;
  workflowRunId: string | null;
  level: LogLevel;
  message: string;
  metadata: unknown | null;
}

export interface WorkflowArtifactRecord {
  id: string;
  createdAt: Date;
  updatedAt: Date;
  workflowRunId: string;
  workflowStageId: string | null;
  key: string;
  type: ArtifactType;
  data: unknown;
  size: number;
  metadata: unknown | null;
}

// ============================================================================
// WorkflowAnnotation Record Types
// ============================================================================

/**
 * Annotation actor — who or what produced this annotation.
 * `kind` is open (recommended values: "agent", "user", "system") so consumers
 * can introduce custom kinds. `id` and `version` are indexed individually for
 * cross-version queries.
 */
export interface AnnotationActor {
  kind?: string;
  id?: string;
  version?: string;
}

/**
 * Annotation scope — which entity within a run this annotation describes.
 * - "run": run-level (e.g., trigger context)
 * - "stage": tied to a specific stage execution (linked via workflowStageRecordId)
 * - "ai_call": tied to a specific AI call (custom; not used by the engine itself)
 * - other strings allowed for consumer-defined scopes
 */
export type AnnotationScope = "run" | "stage" | "ai_call" | (string & {});

export interface WorkflowAnnotationRecord {
  id: string;
  createdAt: Date;
  workflowRunId: string;
  workflowStageRecordId: string | null;
  attempt: number;
  scope: AnnotationScope;
  scopeId: string | null;
  actorKind: string | null;
  actorId: string | null;
  actorVersion: string | null;
  key: string;
  value: unknown;
  payload: unknown | null;
  idempotencyKey: string | null;
}

// ============================================================================
// Outbox and Idempotency Record Types (for kernel transactional outbox)
// ============================================================================

export interface OutboxRecord {
  id: string;
  workflowRunId: string;
  sequence: number;
  eventType: string;
  payload: unknown;
  causationId: string;
  occurredAt: Date;
  publishedAt: Date | null;
  retryCount: number;
  dlqAt: Date | null;
}

export interface CreateOutboxEventInput {
  workflowRunId: string;
  eventType: string;
  payload: unknown;
  causationId: string;
  occurredAt: Date;
}

export interface IdempotencyRecord {
  key: string;
  commandType: string;
  result: unknown;
  createdAt: Date;
}

// ============================================================================
// AI Call Record Types
// ============================================================================

export interface AICallRecord {
  id: string;
  createdAt: Date;
  topic: string;
  callType: string;
  modelKey: string;
  modelId: string;
  prompt: string;
  response: string;
  inputTokens: number;
  outputTokens: number;
  cost: number;
  batchId?: string;
  requestId?: string;
  reportedCost?: number;
  costSource?: string;
  metadata: unknown | null;
}

export interface JobRecord {
  id: string;
  createdAt: Date;
  updatedAt: Date;
  workflowRunId: string;
  workflowId: string;
  stageId: string;
  status: Status;
  priority: number;
  workerId: string | null;
  lockedAt: Date | null;
  startedAt: Date | null;
  completedAt: Date | null;
  attempt: number;
  maxAttempts: number;
  lastError: string | null;
  nextPollAt: Date | null;
  payload: Record<string, unknown>;
}

// ============================================================================
// Input Types (for creating/updating records)
// ============================================================================

export interface CreateRunInput {
  id?: string;
  workflowId: string;
  workflowName: string;
  workflowType: string;
  input: unknown;
  config?: unknown;
  priority?: number;
  /** Optional metadata stored as JSON on the run record. NOT spread into Prisma fields. */
  metadata?: Record<string, unknown>;
  /**
   * The definition version to pin this run to. Adapters whose schema
   * predates definition versioning ignore it and store `null`.
   */
  definitionVersion?: string | null;
}

export interface UpdateRunInput {
  status?: Status;
  startedAt?: Date;
  completedAt?: Date | null;
  duration?: number | null;
  output?: unknown;
  totalCost?: number;
  totalTokens?: number;
  expectedVersion?: number;
  /** Re-pin the run to a different definition version (`run.redrive`). */
  definitionVersion?: string | null;
  /** Absolute redrive count to store. `run.redrive` sets `current + 1`. */
  redriveCount?: number;
}

/** A stored workflow definition snapshot, keyed by (workflowId, version). */
export interface WorkflowDefinitionRecord {
  workflowId: string;
  version: string;
  createdAt: Date;
  /** The `DefinitionSnapshot` as written by `run.create`. */
  snapshot: unknown;
  /** Hash of `snapshot`; equals `version` for derived versions. */
  structureHash: string;
}

/** Input for {@link PersistenceCore.insertDefinitionIfAbsent}. */
export interface CreateDefinitionInput {
  workflowId: string;
  version: string;
  snapshot: unknown;
  structureHash: string;
}

/** One (workflowId, definitionVersion, status) bucket with its run count. */
export interface DefinitionVersionCount {
  workflowId: string;
  /** `null` for runs created before definition versioning. */
  definitionVersion: string | null;
  status: Status;
  count: number;
  /** Creation time of the oldest run in this bucket, for staleness reporting. */
  oldestCreatedAt: Date | null;
}

/** Filter for {@link PersistenceCore.countRunsByDefinitionVersion}. */
export interface DefinitionVersionCountFilter {
  workflowId?: string;
  definitionVersion?: string;
  status?: readonly Status[];
}

/**
 * One workflow definition a host is built to serve, as reported to
 * `claimNextPendingRun`. Compared as a pair so two workflows that declare
 * the same explicit version can never be confused for one another.
 */
export interface ServedDefinition {
  workflowId: string;
  version: string;
}

export interface CreateStageInput {
  workflowRunId: string;
  stageId: string;
  stageName: string;
  stageNumber: number;
  executionGroup: number;
  /** Rerun generation. Defaults to 0. Set by `run.rerunFrom` for recreated stages. */
  attempt?: number;
  status?: Status;
  startedAt?: Date;
  config?: unknown;
  inputData?: unknown;
}

export interface UpdateStageInput {
  status?: Status;
  startedAt?: Date;
  /** `null` clears the completion of an earlier attempt (`run.redrive`). */
  completedAt?: Date | null;
  /** `null` clears the duration of an earlier attempt (`run.redrive`). */
  duration?: number | null;
  outputData?: unknown;
  config?: unknown;
  suspendedState?: unknown;
  resumeData?: unknown;
  nextPollAt?: Date | null;
  pollInterval?: number;
  maxWaitUntil?: Date;
  metrics?: unknown;
  embeddingInfo?: unknown;
  artifacts?: unknown;
  /** `null` clears the error of an earlier attempt. */
  errorMessage?: string | null;
  /**
   * The attempt counter of the record: `run.rerunFrom` reruns and job
   * retries both bump it (the kernel writes `existingStage.attempt + 1`).
   */
  attempt?: number;
  expectedVersion?: number;
}

export interface UpsertStageInput {
  workflowRunId: string;
  stageId: string;
  create: CreateStageInput;
  update: UpdateStageInput;
}

export interface CreateLogInput {
  workflowRunId?: string;
  workflowStageId?: string;
  level: LogLevel;
  message: string;
  metadata?: unknown;
}

export interface SaveArtifactInput {
  workflowRunId: string;
  workflowStageId?: string;
  key: string;
  type: ArtifactType;
  data: unknown;
  size: number;
  metadata?: unknown;
}

/**
 * Input for appending an annotation. `attempt` defaults to 0; callers from
 * `job-execute.ts` / `stage-poll-suspended.ts` are responsible for computing
 * the correct attempt value (incremented when a stage is rerun).
 *
 * When `idempotencyKey` is set, the unique constraint on
 * `(workflowRunId, key, idempotencyKey)` ensures duplicates are skipped on
 * retry. When `idempotencyKey` is null, the constraint does not apply.
 */
export interface CreateAnnotationInput {
  workflowRunId: string;
  workflowStageRecordId?: string | null;
  attempt?: number;
  scope: AnnotationScope;
  scopeId?: string | null;
  actor?: AnnotationActor;
  key: string;
  value: unknown;
  payload?: unknown;
  idempotencyKey?: string | null;
  /**
   * If true, the engine emits an `annotation:created` outbox event when
   * this row is persisted. Plumbed through the buffered-flush path so
   * the event lands in the same transaction as the annotation row.
   * Off by default — most provenance is read-only and doesn't need to
   * be a real-time event.
   */
  emitEvent?: boolean;
}

/**
 * Filters for `listAnnotations`. All filters are AND-combined.
 * `keyPrefix` is implemented with `startsWith` (Postgres uses the
 * `(workflowRunId, key)` index; SQLite may table-scan unless the engine
 * branches to GLOB — see PrismaWorkflowPersistence).
 */
export interface AnnotationFilters {
  key?: string;
  keyPrefix?: string;
  scope?: AnnotationScope;
  scopeId?: string | null;
  actorId?: string;
  actorKind?: string;
  attempt?: number;
  since?: Date;
  until?: Date;
  limit?: number;
}

export interface CreateAICallInput {
  topic: string;
  callType: string;
  modelKey: string;
  modelId: string;
  prompt: string;
  response: string;
  inputTokens: number;
  outputTokens: number;
  cost: number;
  batchId?: string;
  requestId?: string;
  reportedCost?: number;
  costSource?: string;
  metadata?: unknown;
}

export interface EnqueueJobInput {
  workflowRunId: string;
  workflowId: string;
  stageId: string;
  priority?: number;
  payload?: Record<string, unknown>;
  scheduledFor?: Date;
  /**
   * Fairness group this job belongs to — typically a tenant id. Stored on
   * the payload as `_groupKey`; a transport with fairness enabled presents
   * only the head of each group as a dequeue candidate, so one group cannot
   * starve another. Ignored when the transport has no fairness configured,
   * which is the default.
   */
  groupKey?: string;
  /**
   * The definition version of the run this job belongs to (null for a run
   * created before the consumer migrated); stored on the payload as
   * `_definitionVersion` so a dequeue can decline a job whose run this build
   * cannot serve, without joining to workflow_runs.
   */
  definitionVersion?: string | null;
}

export interface DequeueResult {
  jobId: string;
  workflowRunId: string;
  workflowId: string;
  stageId: string;
  priority: number;
  attempt: number;
  maxAttempts: number;
  payload: Record<string, unknown>;
  /**
   * The attempt stamp this claim wrote to `startedAt`. Hand it back as a
   * `JobAckFence` on `complete`/`fail`/`suspend` so the acknowledgement
   * only lands if this attempt is still the current one.
   */
  startedAt: Date;
}

export interface DequeueOptions {
  /**
   * When supplied, only jobs whose run this caller can serve are claimed.
   * A job whose payload carries a `_definitionVersion` not in `serves` is left
   * for a host that presents that version; a job with no `_definitionVersion`
   * is claimable when `serves` names its `_workflowId`. A transport that
   * cannot express the filter MAY ignore it, because the kernel's
   * version-ghost deferral is the backstop.
   */
  serves?: readonly ServedDefinition[];
}

/**
 * Fencing token for a job acknowledgement.
 *
 * A worker that stalls past the lease threshold has its job released by
 * `releaseStaleJobs` and re-claimed by someone else. Without a fence the
 * stalled worker's eventual `complete()` marks the *new* attempt COMPLETED
 * and the work it is actually doing is thrown away. Conditioning the write
 * on the attempt stamp the claim handed out (Oban's `attempted_at`
 * predicate, one extra WHERE clause and no extra column) turns that write
 * into a no-op instead.
 */
export interface JobAckFence {
  /** `DequeueResult.startedAt` from the claim being acknowledged. */
  startedAt: Date;
  /**
   * `DequeueResult.attempt` from the same claim. The stamp alone is the
   * Oban predicate, but our timestamps are `timestamp(3)` — two claims
   * landing in the same millisecond would share a stamp. `attempt`
   * strictly increases on every claim, so the pair identifies exactly one
   * attempt at any resolution. It costs one more term in the same WHERE
   * clause and still no extra column.
   */
  attempt: number;
}

/**
 * Fairness configuration for a job transport's dequeue.
 *
 * Off by default: the dequeue is the hottest query the engine runs, and a
 * fair claim costs more than taking the first row of an index. Turn it on
 * only where one group really can flood the queue.
 *
 * Fairness here is a *concurrency cap per group*, the mechanism pg-boss v12
 * uses, not a reordering. Reordering cannot fix starvation: whatever rule
 * ranks the pending rows, the flooding group's next row is re-ranked to the
 * front the moment its previous one is claimed. Excluding a group that is
 * already at its share of the running pool does fix it — the flood is
 * skipped and a newly arrived job from a quiet group is the only candidate
 * left.
 */
export interface JobQueueFairness {
  /**
   * How many jobs one group may hold `RUNNING` at once. A group at its cap
   * is skipped by the dequeue entirely, so this is the whole fairness
   * mechanism and it has no default — size it to your worker pool, roughly
   * `workers / groups you expect to be active at once`, and never below 1.
   * Too low and a single active group cannot use the pool it has to itself;
   * too high and it can still crowd the others out.
   */
  maxConcurrentPerGroup: number;
  /**
   * Dotted path into the job payload naming the group. Defaults to
   * `"_groupKey"`, which is where `EnqueueJobInput.groupKey` is stored.
   * Point it at a field your jobs already carry — `"config.tenantId"`, say
   * — to group existing rows without re-enqueueing them. Jobs with no value
   * at the path share one anonymous group, which is then capped as a group
   * like any other.
   */
  groupBy?: string;
}

/**
 * Result of a fenced acknowledgement. `"superseded"` means nothing was
 * written: the job is no longer the RUNNING attempt this fence describes
 * (released and re-claimed, cancelled, or deleted). Callers must surface
 * it rather than treating it as success.
 */
export type JobAckOutcome = "acknowledged" | "superseded";

/**
 * `lastError` prefix written when the heartbeat tier reclaims a job: the
 * worker holding the lease stopped calling `touchJob`. The job goes back
 * to PENDING for another worker.
 */
export const LEASE_HEARTBEAT_LOST = "LEASE_HEARTBEAT_LOST";

/**
 * `lastError` prefix written when the absolute tier expires a job: it held
 * its lease past the coarse cap regardless of heartbeating, which means a
 * worker that is alive but wedged. Terminal — a job that hung for the whole
 * cap will hang again, so it is dead-lettered rather than requeued.
 */
export const LEASE_ABSOLUTE_CAP = "LEASE_ABSOLUTE_CAP";

// ============================================================================
// PersistenceCore / ArtifactPersistence / WorkflowPersistence Interfaces
// ============================================================================
//
// `WorkflowPersistence` (41 methods) is split into two focused interfaces:
//
//   - `PersistenceCore` (~26 methods) -- everything the kernel's handlers/
//     helpers and the host packages actually call. `kernel/ports.ts`'s
//     `Persistence` port derives from this instead of hand-duplicating
//     signatures, so the kernel's real requirement is visible directly in
//     the type graph.
//   - `ArtifactPersistence` (7 methods) -- artifact/blob-adjacent methods.
//     The kernel does NOT call any of these; all artifact I/O goes through
//     the `BlobStore` port instead (see
//     `kernel/helpers/create-storage-shim.ts`, which adapts `BlobStore` to
//     the `StageStorage` surface stages see, and
//     `kernel/helpers/save-stage-output.ts`). @deprecated as a group,
//     removal at 1.0.
//
// `WorkflowPersistence` still `extends PersistenceCore, ArtifactPersistence`
// (plus a handful of legacy query methods below with no kernel call site,
// kept directly on `WorkflowPersistence` since they're neither "core" nor
// artifact-related), so existing implementers and consumers of the full
// interface are unaffected by this split -- it only adds two new named
// subsets, it removes nothing.

export interface PersistenceCore {
  /**
   * Execute operations within a transaction boundary. The callback
   * receives a `PersistenceCore`-scoped handle, which is all the kernel
   * ever needs inside a transaction. (`WorkflowPersistence` redeclares
   * this method with a `WorkflowPersistence`-scoped `tx` so existing
   * callers that use artifact methods inside a transaction are
   * unaffected -- see below.)
   */
  withTransaction<T>(fn: (tx: PersistenceCore) => Promise<T>): Promise<T>;

  // WorkflowRun operations
  createRun(data: CreateRunInput): Promise<WorkflowRunRecord>;
  /**
   * Updates a run's fields. `version` is incremented on every call,
   * whether or not `expectedVersion` is supplied -- callers relying on
   * optimistic concurrency (e.g. `job.execute`'s claimed-run guard) can
   * always detect a concurrent write, including unconditional writes like
   * `run.cancel`.
   */
  updateRun(id: string, data: UpdateRunInput): Promise<void>;
  getRun(id: string): Promise<WorkflowRunRecord | null>;
  getRunStatus(id: string): Promise<Status | null>;
  getStuckRuns(stuckSince: Date): Promise<WorkflowRunRecord[]>;

  /**
   * Terminal runs eligible for retention deletion, oldest first: runs whose
   * `status` is one of `statuses` and which finished at or before `cutoff`
   * (`completedAt <= cutoff`, or `updatedAt <= cutoff` for a terminal run
   * with no `completedAt`). Returns at most `limit` runs, each with the ids
   * of its stage records so the caller can clear a pluggable `StepLedger`
   * before the row goes. Called by `run.purge`.
   */
  listRunsForPurge(
    cutoff: Date,
    statuses: readonly PurgeableRunStatus[],
    limit: number,
  ): Promise<PurgeableRun[]>;

  /**
   * Delete a run and everything the persistence owns under it: stage
   * records, logs, artifacts, annotations, and (on the reference schema,
   * through the cascade) `workflow_steps`. A missing id is a no-op. Never
   * emits an outbox event; the kernel clears the step ledger and the blob
   * store before calling it.
   */
  deleteRun(id: string): Promise<void>;

  /**
   * Atomically find and claim the next pending workflow run.
   * Uses FOR UPDATE SKIP LOCKED pattern (in Postgres) to prevent race conditions
   * when multiple workers try to claim workflows simultaneously.
   *
   * Priority ordering: higher priority first, then oldest (FIFO within same priority).
   *
   * @returns The claimed workflow run (now with status RUNNING), or null if no pending runs
   */
  claimNextPendingRun(options?: {
    /** The kernel clock's time, written as `startedAt`/`updatedAt`. */
    now?: Date;
    /**
     * The definitions the claiming host is built to serve. When supplied,
     * a run is claimable only if it is pinned to one of these
     * (workflowId, version) pairs, or is unpinned (`definitionVersion` is
     * `null`, i.e. it predates the consumer's migration) *and* one of the
     * pairs names its workflow. An empty array claims nothing: a host
     * that serves no workflow has no work.
     *
     * The workflow-id restriction on the unpinned arm matters in a fleet:
     * without it every host claims the whole pre-migration population,
     * and one whose registry lacks the workflow adopts a run only to
     * fail it with `WORKFLOW_NOT_FOUND`. Deciding it in the query is what
     * keeps a host from taking work it cannot do.
     *
     * Omit it to claim any pending run, which is the pre-1.0 behaviour.
     */
    serves?: readonly ServedDefinition[];
  }): Promise<WorkflowRunRecord | null>;

  // Definition versioning

  /**
   * Whether this adapter's schema carries the definition-versioning
   * columns and table. `false` on a database that has not been migrated:
   * the engine then behaves exactly as it did before versioning existed
   * rather than failing to start.
   */
  supportsDefinitionVersioning(): boolean;

  /**
   * Optional. Confirms {@link PersistenceCore.supportsDefinitionVersioning}
   * against the live database, once, and resolves to the answer every
   * later call will give.
   *
   * An adapter whose capability answer is derived from something other
   * than the database — the Prisma adapter reads the *generated client*,
   * which is regenerated before the migration is applied on every first
   * migration and on any rolling deploy that ships code first — implements
   * this so the disagreement is found before it becomes a `42703` on every
   * claim. The kernel awaits it on the paths that would otherwise touch
   * the versioning columns; an adapter that does not need it (the
   * in-memory one, whose answer is its own configuration) omits it.
   *
   * MUST be safe to call inside a caller's transaction, so it may not
   * issue a statement that can fail — a failed statement aborts the whole
   * transaction, including work the caller did before it.
   */
  ensureDefinitionVersioningDetected?(): Promise<boolean>;

  /**
   * Stores a definition snapshot if `(workflowId, version)` is not already
   * present, and returns the stored row either way — so a caller can tell
   * whether an explicit version is being re-registered with a different
   * structure. Returns `null` when
   * {@link PersistenceCore.supportsDefinitionVersioning} is `false`.
   */
  insertDefinitionIfAbsent(
    input: CreateDefinitionInput,
  ): Promise<WorkflowDefinitionRecord | null>;

  /** Loads one stored definition snapshot, or `null` when absent. */
  getDefinition(
    workflowId: string,
    version: string,
  ): Promise<WorkflowDefinitionRecord | null>;

  /**
   * Run counts grouped by (workflowId, definitionVersion, status) — the
   * query behind "has this version drained?". Returns an empty array when
   * {@link PersistenceCore.supportsDefinitionVersioning} is `false`.
   */
  countRunsByDefinitionVersion(
    filter?: DefinitionVersionCountFilter,
  ): Promise<DefinitionVersionCount[]>;

  // WorkflowStage operations
  createStage(data: CreateStageInput): Promise<WorkflowStageRecord>;
  upsertStage(data: UpsertStageInput): Promise<WorkflowStageRecord>;
  updateStage(id: string, data: UpdateStageInput): Promise<void>;
  getStage(runId: string, stageId: string): Promise<WorkflowStageRecord | null>;
  /**
   * Ordered by `executionGroup` (actual execution/dependency order), with
   * `stageNumber` (definition order) as a tiebreaker for stages that share
   * an execution group (parallel stages).
   */
  getStagesByRun(
    runId: string,
    options?: { status?: Status; orderBy?: "asc" | "desc" },
  ): Promise<WorkflowStageRecord[]>;
  /**
   * Suspended stages whose `nextPollAt` has come due, oldest deadline
   * first, capped at `limit`.
   *
   * Both narrowings belong here rather than in the caller. Without the
   * ordering and the cap the adapter returns *every* ready row and the
   * handler slices in JS, so a row that keeps coming back — a stage this
   * build cannot serve, released for another host to take — permanently
   * occupies a candidate slot and pushes servable stages out of the
   * window. `serves` is the same filter `claimNextPendingRun` applies to
   * runs, evaluated against the stage's run, so an unserving host does not
   * even claim the poll lease of a stage that is not its work. An adapter
   * whose schema has no `definitionVersion` column ignores `serves`; such
   * a database has no pinned runs, so ignoring it is exact.
   */
  getSuspendedStages(
    beforeDate: Date,
    options?: {
      limit?: number;
      serves?: readonly ServedDefinition[];
    },
  ): Promise<WorkflowStageRecord[]>;
  deleteStage(id: string): Promise<void>;

  // WorkflowLog operations
  createLog(data: CreateLogInput): Promise<void>;

  // WorkflowAnnotation operations
  /**
   * Append one or more annotations. Designed to be called both standalone
   * (fire-and-forget from external attach) and inside an existing
   * transaction (buffered during stage execution, flushed in the
   * stage-completion transaction) -- called from `run.create`, external
   * attach, and the stage-completion transactions in `job-execute` and
   * `stage-poll-suspended`.
   *
   * Rows with the same `(workflowRunId, key, idempotencyKey)` are deduped
   * via the unique constraint; duplicates are silently skipped.
   */
  appendAnnotations(inputs: CreateAnnotationInput[]): Promise<void>;

  /**
   * List annotations for a run, optionally filtered. Returns rows ordered
   * by `createdAt` ascending (so consumers get a timeline by default).
   */
  listAnnotations(
    workflowRunId: string,
    filters?: AnnotationFilters,
  ): Promise<WorkflowAnnotationRecord[]>;

  // Outbox DLQ operations
  /** Increment retry count for a failed outbox event. Returns new count. */
  incrementOutboxRetryCount(id: string): Promise<number>;

  /** Move an outbox event to DLQ (sets dlqAt). */
  moveOutboxEventToDLQ(id: string): Promise<void>;

  /** Reset DLQ events so they can be reprocessed by outbox.flush. Returns count reset. */
  replayDLQEvents(maxEvents: number): Promise<number>;

  // Outbox operations
  /** Write events to the outbox. Sequences are auto-assigned per workflowRunId. */
  appendOutboxEvents(events: CreateOutboxEventInput[]): Promise<void>;

  /** Read unpublished events ordered by (workflowRunId, sequence). */
  getUnpublishedOutboxEvents(limit?: number): Promise<OutboxRecord[]>;

  /**
   * Atomically claim up to `limit` unpublished events for this caller by
   * setting `publishedAt`, ordered by (workflowRunId, sequence). Two
   * processes flushing the same outbox concurrently must never both
   * receive the same event: on Postgres this is one
   * `UPDATE ... FROM (SELECT ... FOR UPDATE SKIP LOCKED) RETURNING`; other
   * stores use a compare-and-set on `publishedAt IS NULL` per row. Events
   * whose publication then fails are handed back with
   * `releaseOutboxEvents`.
   */
  claimUnpublishedOutboxEvents(limit?: number): Promise<OutboxRecord[]>;

  /** Un-claim events (clear `publishedAt`) so a later flush retries them. */
  releaseOutboxEvents(ids: string[]): Promise<void>;

  /** Mark events as published. */
  markOutboxEventsPublished(ids: string[]): Promise<void>;

  // Idempotency operations
  /**
   * Atomically acquire an idempotency key for command execution.
   *
   * If the key is currently `in_progress` (e.g. a previous dispatcher
   * crashed between committing its transaction and calling
   * `completeIdempotencyKey`), passing `staleInProgressAfterMs` allows the
   * key to be reclaimed once it has been in progress for at least that
   * long, measured against `options.now` (defaults to `new Date()`).
   * Reclaiming is atomic: only one caller wins when multiple dispatchers
   * race to reclaim the same stale key. When `staleInProgressAfterMs` is
   * omitted, a stuck `in_progress` key is never reclaimed (matches prior
   * behavior).
   */
  acquireIdempotencyKey(
    key: string,
    commandType: string,
    options?: { now?: Date; staleInProgressAfterMs?: number },
  ): Promise<
    | { status: "acquired" }
    | { status: "replay"; result: unknown }
    | { status: "in_progress" }
  >;

  /** Mark an idempotency key as completed and cache the command result. */
  completeIdempotencyKey(
    key: string,
    commandType: string,
    result: unknown,
  ): Promise<void>;

  /** Release an in-progress idempotency key after command failure. */
  releaseIdempotencyKey(key: string, commandType: string): Promise<void>;
}

// ============================================================================
// WorkflowPersistence Interface
// ============================================================================

/**
 * Full persistence contract: `PersistenceCore` (what the kernel calls) plus
 * a transaction boundary that hands the callback this same surface. The
 * pre-1.0 artifact methods (`saveArtifact`, `loadArtifact`, ... — replaced
 * by the `BlobStore` port) and query helpers (`getRunsByStatus`,
 * `claimPendingRun`, `getStageById`, ...) are no longer part of the
 * contract; the built-in adapters still implement them as plain class
 * methods.
 */
export interface WorkflowPersistence extends PersistenceCore {
  /**
   * Execute operations within a transaction boundary. Redeclared (not
   * merely inherited from `PersistenceCore`) so the callback receives the
   * full `WorkflowPersistence` surface.
   */
  withTransaction<T>(fn: (tx: WorkflowPersistence) => Promise<T>): Promise<T>;
}

// ============================================================================
// AICallLogger Interface
// ============================================================================

export interface AIHelperStats {
  totalCalls: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCost: number;
  perModel: Record<
    string,
    { calls: number; inputTokens: number; outputTokens: number; cost: number }
  >;
}

export interface AICallLogger {
  /**
   * Log a single AI call (fire and forget)
   */
  logCall(call: CreateAICallInput): void;

  /**
   * Log batch results (for recording batch API results)
   */
  logBatchResults(batchId: string, results: CreateAICallInput[]): Promise<void>;

  /**
   * Get aggregated stats for a topic prefix
   */
  getStats(topicPrefix: string): Promise<AIHelperStats>;

  /**
   * Check if batch results are already recorded
   */
  isRecorded(batchId: string): Promise<boolean>;
}

// ============================================================================
// JobQueue Interface
// ============================================================================

export interface JobQueue {
  /**
   * The dotted `groupBy` path this queue's fairness cap reads, or `null` when
   * fairness is off (or undefined when unsupported). Read by
   * `createSpillingJobTransport` so a spilled payload still carries its group
   * key.
   */
  readonly fairnessGroupBy?: string | null;

  /**
   * Enqueue multiple stages in parallel (same execution group).
   *
   * Idempotent on `(workflowRunId, stageId)`: at most one job row may
   * exist per stage per run, so an implementation MUST replace any row(s)
   * already queued for a pair it is asked to enqueue, resetting `attempt`,
   * `status`, `workerId`, `lockedAt`, `lastError` and `nextPollAt`. That
   * makes `run.rerunFrom`'s re-enqueue and `run.reapStuck`'s
   * PENDING-without-job recovery sweep safe to run over a stage that
   * still carries a terminal job row from a previous execution.
   */
  enqueueParallel(jobs: EnqueueJobInput[]): Promise<string[]>;

  /**
   * Remove every job row for the given stages of a run, whatever their
   * status. Returns the number of rows removed.
   *
   * Called by `run.rerunFrom` for the stage records it deletes, so a
   * rerun does not leave the retired stages' job rows behind (including
   * the downstream stages it deletes without recreating, which nothing
   * would ever re-enqueue). An empty `stageIds` is a no-op.
   */
  deleteByRunAndStages(
    workflowRunId: string,
    stageIds: string[],
  ): Promise<number>;

  /**
   * Atomically dequeue the next available job
   */
  dequeue(options?: DequeueOptions): Promise<DequeueResult | null>;

  /**
   * Mark job as completed.
   *
   * Passing a `fence` conditions the write on the job still being the RUNNING
   * attempt with that `startedAt`; omitting it keeps the previous unconditional
   * behaviour and always returns `"acknowledged"`. Note that the fenced form is
   * the recommended one and that the unfenced form exists for transports that
   * cannot carry the stamp.
   */
  complete(jobId: string, fence?: JobAckFence): Promise<JobAckOutcome>;

  /**
   * Mark job as suspended (for async-batch).
   *
   * Passing a `fence` conditions the write on the job still being the RUNNING
   * attempt with that `startedAt`; omitting it keeps the previous unconditional
   * behaviour and always returns `"acknowledged"`. Note that the fenced form is
   * the recommended one and that the unfenced form exists for transports that
   * cannot carry the stamp.
   */
  suspend(
    jobId: string,
    nextPollAt: Date,
    fence?: JobAckFence,
  ): Promise<JobAckOutcome>;

  /**
   * Return a claimed job to PENDING with a later nextPollAt WITHOUT counting
   * the claim as an attempt (the dequeue incremented attempt; this undoes it).
   * `fail(id, err, true)` is the wrong shape for work a host declines rather
   * than fails: declining is not a failed attempt, and a condition that lasts
   * for a whole deploy — a run pinned to a version this build does not
   * present — exhausts the three-attempt budget in about fifteen seconds and
   * takes the job row terminal.
   *
   * Optional: a transport that does not implement it falls back to fail with
   * retry, which is correct but bounded by the budget.
   */
  defer?(
    jobId: string,
    nextPollAt: Date,
    reason: string,
    fence?: JobAckFence,
  ): Promise<JobAckOutcome>;

  /**
   * Mark job as failed. `shouldRetry` defaults to `false` -- callers must
   * opt in to a retry rather than risk an unbounded retry loop for
   * adapters/hosts that omit the argument.
   *
   * Passing a `fence` conditions the write on the job still being the RUNNING
   * attempt with that `startedAt`; omitting it keeps the previous unconditional
   * behaviour and always returns `"acknowledged"`. Note that the fenced form is
   * the recommended one and that the unfenced form exists for transports that
   * cannot carry the stamp.
   */
  fail(
    jobId: string,
    error: string,
    shouldRetry?: boolean,
    fence?: JobAckFence,
  ): Promise<JobAckOutcome>;

  /**
   * Release stale locks (for crashed workers). Stamps `lastError` with
   * the `LEASE_HEARTBEAT_LOST` prefix so an operator can tell a reclaimed
   * lease from a stage-level failure. The fine-grained tier of a two-tier
   * expiry whose coarse tier is `expireRunawayJobs`.
   */
  releaseStaleJobs(staleThresholdMs?: number): Promise<number>;

  /**
   * Fail every RUNNING job whose claim (`startedAt`, stamped once and never
   * refreshed) is older than `absoluteTimeoutMs`, stamping `lastError` with
   * the `LEASE_ABSOLUTE_CAP` prefix; returns how many. The coarse tier of a
   * two-tier expiry: `releaseStaleJobs` is the fine-grained heartbeat
   * signal and is defeated by a worker that is alive but wedged, because
   * such a worker keeps calling `touchJob`. Optional — a transport that
   * does not implement it simply has no absolute cap.
   */
  expireRunawayJobs?(absoluteTimeoutMs: number): Promise<number>;

  /**
   * Cancel all pending/suspended jobs for a workflow run.
   * Returns count of cancelled jobs.
   */
  cancelByRun(workflowRunId: string): Promise<number>;

  /**
   * Get all job rows for a workflow run (any status). Used to detect
   * pending/in-flight retries for a stage (so `run.transition` doesn't
   * treat a FAILED stage with a queued retry as terminal) and to find
   * orphaned SUSPENDED job rows or PENDING stages missing a queued job.
   */
  getJobsByWorkflowRun(workflowRunId: string): Promise<JobRecord[]>;

  /**
   * Refresh a running job's lease (`lockedAt`) without changing status.
   * Called periodically by hosts while a long-running stage executes so
   * `releaseStaleJobs` doesn't duplicate work still in-flight.
   */
  touchJob(jobId: string): Promise<void>;

  /**
   * Optional. Offer a host's `workerId` to the queue so it is the id
   * written to `job_queue.workerId`. A queue explicitly configured with
   * its own worker id keeps it. Returns the id the queue will stamp,
   * whichever way it went, so the caller can warn on a mismatch.
   */
  adoptWorkerId?(workerId: string): string;
}

// ============================================================================
// Default Implementations (lazy loaded to avoid circular deps)
// ============================================================================

// Re-export from prisma implementations for convenience
// These will be the default implementations used when no custom persistence is provided
