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
 *  - Persistence    – metadata storage (runs, stages, logs, artifacts)
 *  - BlobStore      – large payload storage
 *  - JobTransport   – job queue abstraction
 *  - EventSink      – event publishing
 *  - Scheduler      – deferred command triggers
 */

import type {
  WorkflowRunRecord,
  WorkflowStageRecord,
  WorkflowLogRecord,
  OutboxRecord,
  CreateOutboxEventInput,
  IdempotencyRecord,
  CreateRunInput,
  UpdateRunInput,
  CreateStageInput,
  UpdateStageInput,
  UpsertStageInput,
  CreateLogInput,
  EnqueueJobInput,
  DequeueResult,
  Status,
} from "../persistence/interface";

import type { KernelEvent } from "./events";

// Re-export record and input types for convenience
export type {
  WorkflowRunRecord,
  WorkflowStageRecord,
  WorkflowLogRecord,
  OutboxRecord,
  CreateOutboxEventInput,
  IdempotencyRecord,
  CreateRunInput,
  UpdateRunInput,
  CreateStageInput,
  UpdateStageInput,
  UpsertStageInput,
  CreateLogInput,
  EnqueueJobInput,
  DequeueResult,
  Status,
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
 * Metadata storage port.
 *
 * Run, stage, and log CRUD operations. Artifact payloads are handled
 * by the BlobStore port.
 */
export interface Persistence {
  // -- Run operations --------------------------------------------------------

  createRun(data: CreateRunInput): Promise<WorkflowRunRecord>;
  updateRun(id: string, data: UpdateRunInput): Promise<void>;
  getRun(id: string): Promise<WorkflowRunRecord | null>;
  getRunStatus(id: string): Promise<Status | null>;
  getRunsByStatus(status: Status): Promise<WorkflowRunRecord[]>;

  /**
   * Atomically claim a pending workflow run for processing.
   * Uses atomic update with WHERE status = 'PENDING' to prevent race conditions.
   */
  claimPendingRun(id: string): Promise<boolean>;

  /**
   * Atomically find and claim the next pending workflow run.
   * Uses FOR UPDATE SKIP LOCKED pattern (in Postgres) to prevent race conditions
   * when multiple workers try to claim workflows simultaneously.
   *
   * Priority ordering: higher priority first, then oldest (FIFO within same priority).
   */
  claimNextPendingRun(): Promise<WorkflowRunRecord | null>;

  // -- Stage operations ------------------------------------------------------

  createStage(data: CreateStageInput): Promise<WorkflowStageRecord>;
  upsertStage(data: UpsertStageInput): Promise<WorkflowStageRecord>;
  updateStage(id: string, data: UpdateStageInput): Promise<void>;
  updateStageByRunAndStageId(
    workflowRunId: string,
    stageId: string,
    data: UpdateStageInput,
  ): Promise<void>;
  getStage(
    runId: string,
    stageId: string,
  ): Promise<WorkflowStageRecord | null>;
  getStageById(id: string): Promise<WorkflowStageRecord | null>;
  getStagesByRun(
    runId: string,
    options?: { status?: Status; orderBy?: "asc" | "desc" },
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

  // -- Log operations --------------------------------------------------------

  createLog(data: CreateLogInput): Promise<void>;

  // -- Outbox operations ----------------------------------------------------

  /** Write events to the outbox. Sequences are auto-assigned per workflowRunId. */
  appendOutboxEvents(events: CreateOutboxEventInput[]): Promise<void>;

  /** Read unpublished events ordered by (workflowRunId, sequence). */
  getUnpublishedOutboxEvents(limit?: number): Promise<OutboxRecord[]>;

  /** Mark events as published. */
  markOutboxEventsPublished(ids: string[]): Promise<void>;

  /** Increment retry count for a failed outbox event. Returns new count. */
  incrementOutboxRetryCount(id: string): Promise<number>;

  /** Move an outbox event to DLQ (sets dlqAt). */
  moveOutboxEventToDLQ(id: string): Promise<void>;

  /** Reset DLQ events so they can be reprocessed by outbox.flush. Returns count reset. */
  replayDLQEvents(maxEvents: number): Promise<number>;

  // -- Idempotency operations -----------------------------------------------

  /** Check if an idempotency key exists. Returns cached result if found. */
  checkIdempotencyKey(
    key: string,
    commandType: string,
  ): Promise<{ exists: boolean; result?: unknown }>;

  /** Store an idempotency key with its command result (success only). */
  setIdempotencyKey(
    key: string,
    commandType: string,
    result: unknown,
  ): Promise<void>;
}

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
  /** Add a new job to the queue. */
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

  /** Get suspended jobs that are ready to be checked. */
  getSuspendedJobsReadyToPoll(): Promise<
    Array<{ jobId: string; stageId: string; workflowRunId: string }>
  >;

  /** Release stale locks (for crashed workers). */
  releaseStaleJobs(staleThresholdMs?: number): Promise<number>;
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
