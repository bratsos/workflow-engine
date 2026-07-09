/**
 * Kernel Port Interfaces
 *
 * These interfaces define the dependency-inversion boundary for the workflow
 * kernel. Every external capability the kernel needs is expressed as a port
 * interface here. Concrete implementations are injected at composition time,
 * making the kernel fully testable with in-memory fakes.
 *
 * Ports:
 *  - Clock          – injectable time source
 *  - Persistence    – metadata storage (runs, stages, logs, annotations,
 *                     outbox, idempotency keys). Artifact payloads are
 *                     handled by BlobStore, not this port.
 *  - BlobStore      – large payload storage
 *  - JobTransport   – job queue abstraction
 *  - EventSink      – event publishing
 *  - Scheduler      – deferred command triggers
 */

import type { StageResult, SuspendedResult } from "../core/types";

import type {
  CreateAnnotationInput,
  DequeueResult,
  EnqueueJobInput,
  JobRecord,
  PersistenceCore,
} from "../persistence/interface";

import type { KernelEvent } from "./events";

// Re-export record and input types for convenience
export type {
  AnnotationActor,
  AnnotationFilters,
  AnnotationScope,
  CreateAnnotationInput,
  CreateLogInput,
  CreateOutboxEventInput,
  CreateRunInput,
  CreateStageInput,
  DequeueResult,
  EnqueueJobInput,
  IdempotencyRecord,
  JobRecord,
  OutboxRecord,
  Status,
  UpdateRunInput,
  UpdateStageInput,
  UpsertStageInput,
  WorkflowAnnotationRecord,
  WorkflowLogRecord,
  WorkflowRunRecord,
  WorkflowStageRecord,
} from "../persistence/interface";

export type { KernelEvent } from "./events";

// ============================================================================
// Clock
// ============================================================================

/** Injectable time source. */
export interface Clock {
  now(): Date;
}

// ============================================================================
// Persistence
// ============================================================================

/**
 * Metadata storage port: run, stage, log, annotation, outbox, and
 * idempotency-key operations. Artifact payloads are handled by the
 * BlobStore port instead (see `kernel/helpers/create-storage-shim.ts`).
 *
 * Derives from `PersistenceCore` (`persistence/interface.ts`) -- the ~26
 * methods the kernel's handlers/helpers actually call -- instead of
 * hand-duplicating signatures here. Keeping this as a distinct name (not
 * just an alias) lets kernel code read `Persistence` while the rest of
 * the package reasons about `PersistenceCore` directly; the two are
 * structurally identical. `WorkflowPersistence` (the full 41-method
 * contract implemented by `PrismaWorkflowPersistence` /
 * `InMemoryWorkflowPersistence`) is a structural superset of
 * `PersistenceCore`, so both satisfy this port with no adapter needed --
 * narrowing the port's declared surface to what the kernel actually calls
 * only loosens what `createKernel` demands, it doesn't break anything
 * that already provided the full contract.
 *
 * Annotation append call sites (for context): `run.create`, external
 * `kernel.annotations.attach`, and the stage-completion transactions in
 * `job-execute` and `stage-poll-suspended`.
 */
export interface Persistence extends PersistenceCore {}

// ============================================================================
// BlobStore
// ============================================================================

/** Large payload storage. */
export interface BlobStore {
  put(key: string, data: unknown): Promise<void>;
  get(key: string): Promise<unknown>;
  has(key: string): Promise<boolean>;
  delete(key: string): Promise<void>;
  list(prefix: string): Promise<string[]>;
}

// ============================================================================
// JobTransport
// ============================================================================

/**
 * Job queue abstraction.
 *
 * Same shape as the existing `JobQueue` interface so that current
 * implementations (`InMemoryJobQueue`, `PrismaJobQueue`) structurally satisfy
 * this port without adapters.
 */
export interface JobTransport {
  /**
   * Add a new job to the queue.
   *
   * @deprecated Unused by the kernel -- enqueueParallel is used even for
   * single-job enqueues. Removal at 1.0.
   */
  enqueue(options: EnqueueJobInput): Promise<string>;

  /** Enqueue multiple stages in parallel (same execution group). */
  enqueueParallel(jobs: EnqueueJobInput[]): Promise<string[]>;

  /** Atomically dequeue the next available job. */
  dequeue(): Promise<DequeueResult | null>;

  /** Mark job as completed. */
  complete(jobId: string): Promise<void>;

  /** Mark job as suspended (for async-batch). */
  suspend(jobId: string, nextPollAt: Date): Promise<void>;

  /** Mark job as failed. */
  fail(jobId: string, error: string, shouldRetry?: boolean): Promise<void>;

  /** Release stale locks (for crashed workers). */
  releaseStaleJobs(staleThresholdMs?: number): Promise<number>;

  /** Cancel all pending/suspended jobs for a workflow run. Returns count cancelled. */
  cancelByRun(workflowRunId: string): Promise<number>;

  /**
   * Get all job rows for a workflow run (any status). Used to detect
   * pending/in-flight retries for a stage and to find orphaned job rows.
   */
  getJobsByWorkflowRun(workflowRunId: string): Promise<JobRecord[]>;

  /** Refresh a running job's lease without changing status. */
  touchJob(jobId: string): Promise<void>;
}

// ============================================================================
// EventSink
// ============================================================================

/** Event publishing (replaces global EventBus). */
export interface EventSink {
  emit(event: KernelEvent): Promise<void>;
}

// ============================================================================
// Scheduler
// ============================================================================

/** Deferred command triggers (minimal in Phase 1). */
export interface Scheduler {
  schedule(commandType: string, payload: unknown, runAt: Date): Promise<void>;
  cancel(commandType: string, correlationId: string): Promise<void>;
}

// ============================================================================
// ActivityExecutor
// ============================================================================

/**
 * Minimal structural type for a stage definition as seen by the executor.
 * LocalExecutor uses the full Stage; RemoteExecutor (host-remote) ships only
 * ids and ignores stageDef.execute. Using `any` Zod schemas keeps the port
 * free of Stage's type parameters.
 */
export interface SyncStageDefinitionLike {
  id: string;
  name: string;
  inputSchema: { parse(v: unknown): unknown };
  outputSchema?: { parse(v: unknown): unknown } | null;
  configSchema?: { parse(v: unknown): unknown } | null;
  execute(ctx: any): Promise<StageResult<unknown> | SuspendedResult>;
}

/** A log entry buffered by the executor for the handler to persist. */
export interface BufferedLog {
  level: string;
  message: string;
  meta?: Record<string, unknown>;
}

/** Input passed to ActivityExecutor.run(). */
export interface ActivityRunInput {
  stageDef: SyncStageDefinitionLike;
  workflowId: string;
  workflowRunId: string;
  workflowType: string;
  stageId: string;
  stageName: string;
  stageNumber: number;
  stageRecordId: string;
  attempt: number;
  rawInput: unknown;
  config: Record<string, unknown>;
  resumeState?: unknown;
  workflowContext: Record<string, unknown>;
}

/** Result from ActivityExecutor.run(). Exactly one of result / error is set. */
export interface ActivityRunResult {
  result?: StageResult<unknown> | SuspendedResult;
  error?: string;
  /** Constructor name of the thrown error (e.g. "ZodError", "TypeError"), when known. */
  errorName?: string;
  /** Stack trace of the thrown error, when available — for diagnostics only. */
  errorStack?: string;
  /**
   * Whether the failure is worth retrying. `false` marks a deterministic
   * failure (e.g. Zod input/config validation) that will fail identically
   * on every attempt — hosts should fail the job terminally instead of
   * burning retry attempts. `undefined`/`true` preserves default retry
   * behavior.
   */
  retryable?: boolean;
  progress: KernelEvent[];
  annotations: CreateAnnotationInput[];
  /**
   * Log entries for the handler to persist after run completes.
   * LocalExecutor writes logs live during execute(), so it returns [].
   * RemoteExecutor captures worker logs and returns them here.
   */
  logs: BufferedLog[];
}

/**
 * Subset of KernelDeps that ActivityExecutor.run() needs.
 * KernelDeps in kernel.ts structurally satisfies this interface; no adapter
 * is needed when passing deps from the handler.
 */
export interface ExecutorDeps {
  persistence: Persistence;
  blobStore: BlobStore;
  clock: Clock;
}

/**
 * Port: controls where a stage body runs.
 * Default implementation = LocalExecutor (inline, current-process).
 * Swap for RemoteExecutor to run stages on remote workers.
 */
export interface ActivityExecutor {
  run(input: ActivityRunInput, deps: ExecutorDeps): Promise<ActivityRunResult>;
}
