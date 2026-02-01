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

// ============================================================================
// Record Types (minimal fields needed by the workflow engine)
// ============================================================================

export interface WorkflowRunRecord {
  id: string;
  createdAt: Date;
  updatedAt: Date;
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
}

export interface WorkflowStageRecord {
  id: string;
  createdAt: Date;
  updatedAt: Date;
  workflowRunId: string;
  stageId: string;
  stageName: string;
  stageNumber: number;
  executionGroup: number;
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
  /** Optional metadata for domain-specific fields */
  metadata?: Record<string, unknown>;
}

export interface UpdateRunInput {
  status?: WorkflowStatus;
  startedAt?: Date;
  completedAt?: Date;
  duration?: number;
  output?: unknown;
  totalCost?: number;
  totalTokens?: number;
}

export interface CreateStageInput {
  workflowRunId: string;
  stageId: string;
  stageName: string;
  stageNumber: number;
  executionGroup: number;
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
  stageId: string;
  priority?: number;
  payload?: Record<string, unknown>;
  scheduledFor?: Date;
}

export interface DequeueResult {
  jobId: string;
  workflowRunId: string;
  stageId: string;
  priority: number;
  attempt: number;
  payload: Record<string, unknown>;
}

// ============================================================================
// WorkflowPersistence Interface
// ============================================================================

export interface WorkflowPersistence {
  // WorkflowRun operations
  createRun(data: CreateRunInput): Promise<WorkflowRunRecord>;
  updateRun(id: string, data: UpdateRunInput): Promise<void>;
  getRun(id: string): Promise<WorkflowRunRecord | null>;
  getRunStatus(id: string): Promise<WorkflowStatus | null>;
  getRunsByStatus(status: WorkflowStatus): Promise<WorkflowRunRecord[]>;

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
  getStagesByRun(
    runId: string,
    options?: { status?: WorkflowStageStatus; orderBy?: "asc" | "desc" },
  ): Promise<WorkflowStageRecord[]>;
  getSuspendedStages(beforeDate: Date): Promise<WorkflowStageRecord[]>;
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
  loadArtifact(runId: string, key: string): Promise<unknown>;
  hasArtifact(runId: string, key: string): Promise<boolean>;
  deleteArtifact(runId: string, key: string): Promise<void>;
  listArtifacts(runId: string): Promise<WorkflowArtifactRecord[]>;
  getStageIdForArtifact(runId: string, stageId: string): Promise<string | null>;

  // Stage output convenience methods (replaces separate StageStorage)
  saveStageOutput(
    runId: string,
    workflowType: string,
    stageId: string,
    output: unknown,
  ): Promise<string>;
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
   * Mark job as failed
   */
  fail(jobId: string, error: string, shouldRetry?: boolean): Promise<void>;

  /**
   * Get suspended jobs that are ready to be checked
   */
  getSuspendedJobsReadyToPoll(): Promise<
    Array<{ jobId: string; stageId: string; workflowRunId: string }>
  >;

  /**
   * Release stale locks (for crashed workers)
   */
  releaseStaleJobs(staleThresholdMs?: number): Promise<number>;
}

// ============================================================================
// Default Implementations (lazy loaded to avoid circular deps)
// ============================================================================

// Re-export from prisma implementations for convenience
// These will be the default implementations used when no custom persistence is provided
