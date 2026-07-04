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

export interface WorkflowRunRecord {
  id: string;
  createdAt: Date;
  updatedAt: Date;
  version: number;
  workflowId: string;
  workflowName: string;
  workflowType: string;
  status: WorkflowStatus;
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
  status: WorkflowStageStatus;
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
  metadata: unknown | null;
}

export interface JobRecord {
  id: string;
  createdAt: Date;
  updatedAt: Date;
  workflowRunId: string;
  workflowId: string;
  stageId: string;
  status: JobStatus;
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
}

export interface UpdateRunInput {
  status?: WorkflowStatus;
  startedAt?: Date;
  completedAt?: Date | null;
  duration?: number | null;
  output?: unknown;
  totalCost?: number;
  totalTokens?: number;
  expectedVersion?: number;
}

export interface CreateStageInput {
  workflowRunId: string;
  stageId: string;
  stageName: string;
  stageNumber: number;
  executionGroup: number;
  /** Rerun generation. Defaults to 0. Set by `run.rerunFrom` for recreated stages. */
  attempt?: number;
  status?: WorkflowStageStatus;
  startedAt?: Date;
  config?: unknown;
  inputData?: unknown;
}

export interface UpdateStageInput {
  status?: WorkflowStageStatus;
  startedAt?: Date;
  completedAt?: Date;
  duration?: number;
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
  errorMessage?: string;
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
  metadata?: unknown;
}

export interface EnqueueJobInput {
  workflowRunId: string;
  workflowId: string;
  stageId: string;
  priority?: number;
  payload?: Record<string, unknown>;
  scheduledFor?: Date;
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
}

// ============================================================================
// WorkflowPersistence Interface
// ============================================================================

export interface WorkflowPersistence {
  /** Execute operations within a transaction boundary. */
  withTransaction<T>(fn: (tx: WorkflowPersistence) => Promise<T>): Promise<T>;

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
  getRunStatus(id: string): Promise<WorkflowStatus | null>;
  getRunsByStatus(status: WorkflowStatus): Promise<WorkflowRunRecord[]>;
  getStuckRuns(stuckSince: Date): Promise<WorkflowRunRecord[]>;

  /**
   * Atomically claim a pending workflow run for processing.
   * Uses atomic update with WHERE status = 'PENDING' to prevent race conditions.
   *
   * @param id - The workflow run ID to claim
   * @returns true if successfully claimed, false if already claimed by another worker
   */
  claimPendingRun(id: string): Promise<boolean>;

  /**
   * Atomically find and claim the next pending workflow run.
   * Uses FOR UPDATE SKIP LOCKED pattern (in Postgres) to prevent race conditions
   * when multiple workers try to claim workflows simultaneously.
   *
   * Priority ordering: higher priority first, then oldest (FIFO within same priority).
   *
   * @returns The claimed workflow run (now with status RUNNING), or null if no pending runs
   */
  claimNextPendingRun(): Promise<WorkflowRunRecord | null>;

  // WorkflowStage operations
  createStage(data: CreateStageInput): Promise<WorkflowStageRecord>;
  upsertStage(data: UpsertStageInput): Promise<WorkflowStageRecord>;
  updateStage(id: string, data: UpdateStageInput): Promise<void>;
  updateStageByRunAndStageId(
    workflowRunId: string,
    stageId: string,
    data: UpdateStageInput,
  ): Promise<void>;
  getStage(runId: string, stageId: string): Promise<WorkflowStageRecord | null>;
  getStageById(id: string): Promise<WorkflowStageRecord | null>;
  /**
   * Ordered by `executionGroup` (actual execution/dependency order), with
   * `stageNumber` (definition order) as a tiebreaker for stages that share
   * an execution group (parallel stages).
   */
  getStagesByRun(
    runId: string,
    options?: { status?: WorkflowStageStatus; orderBy?: "asc" | "desc" },
  ): Promise<WorkflowStageRecord[]>;
  getSuspendedStages(beforeDate: Date): Promise<WorkflowStageRecord[]>;
  /**
   * Find the first SUSPENDED stage whose `nextPollAt` has been explicitly
   * cleared (set to `null`) by the orchestrator -- i.e. "ready to resume"
   * means the poll loop already determined the suspend condition is
   * satisfied, not merely that a poll deadline has elapsed. Use
   * `getSuspendedStages` to find stages whose poll deadline has passed.
   */
  getFirstSuspendedStageReadyToResume(
    runId: string,
  ): Promise<WorkflowStageRecord | null>;
  getFirstFailedStage(runId: string): Promise<WorkflowStageRecord | null>;
  getLastCompletedStage(runId: string): Promise<WorkflowStageRecord | null>;
  getLastCompletedStageBefore(
    runId: string,
    executionGroup: number,
  ): Promise<WorkflowStageRecord | null>;
  deleteStage(id: string): Promise<void>;

  // WorkflowLog operations
  createLog(data: CreateLogInput): Promise<void>;

  // WorkflowArtifact operations (for StageStorage)
  saveArtifact(data: SaveArtifactInput): Promise<void>;
  /**
   * Load an artifact's stored data. Returns `undefined` (not a throw) when
   * no artifact exists for `(runId, key)` -- callers that need to
   * distinguish "missing" from "present but empty" should check
   * `hasArtifact` first.
   */
  loadArtifact(runId: string, key: string): Promise<unknown>;
  hasArtifact(runId: string, key: string): Promise<boolean>;
  deleteArtifact(runId: string, key: string): Promise<void>;
  listArtifacts(runId: string): Promise<WorkflowArtifactRecord[]>;
  getStageIdForArtifact(runId: string, stageId: string): Promise<string | null>;

  // WorkflowAnnotation operations
  /**
   * Append one or more annotations. Designed to be called both standalone
   * (fire-and-forget from external attach) and inside an existing
   * transaction (buffered during stage execution, flushed in the
   * stage-completion transaction).
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

  // Stage output convenience methods (replaces separate StageStorage)
  saveStageOutput(
    runId: string,
    workflowType: string,
    stageId: string,
    output: unknown,
  ): Promise<string>;

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
   * Add a new job to the queue
   */
  enqueue(options: EnqueueJobInput): Promise<string>;

  /**
   * Enqueue multiple stages in parallel (same execution group)
   */
  enqueueParallel(jobs: EnqueueJobInput[]): Promise<string[]>;

  /**
   * Atomically dequeue the next available job
   */
  dequeue(): Promise<DequeueResult | null>;

  /**
   * Mark job as completed
   */
  complete(jobId: string): Promise<void>;

  /**
   * Mark job as suspended (for async-batch)
   */
  suspend(jobId: string, nextPollAt: Date): Promise<void>;

  /**
   * Mark job as failed. `shouldRetry` defaults to `false` -- callers must
   * opt in to a retry rather than risk an unbounded retry loop for
   * adapters/hosts that omit the argument.
   */
  fail(jobId: string, error: string, shouldRetry?: boolean): Promise<void>;

  /**
   * Release stale locks (for crashed workers)
   */
  releaseStaleJobs(staleThresholdMs?: number): Promise<number>;

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
}

// ============================================================================
// Default Implementations (lazy loaded to avoid circular deps)
// ============================================================================

// Re-export from prisma implementations for convenience
// These will be the default implementations used when no custom persistence is provided
