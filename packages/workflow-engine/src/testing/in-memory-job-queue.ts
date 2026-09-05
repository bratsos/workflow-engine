/**
 * In-Memory Job Queue
 *
 * A complete in-memory implementation of JobQueue for testing.
 * Supports priority ordering, locking, and stale job recovery.
 *
 * @example
 * ```typescript
 * import { InMemoryJobQueue } from '@bratsos/workflow-engine/testing';
 *
 * const jobQueue = new InMemoryJobQueue();
 * // Use in tests...
 * jobQueue.clear(); // Reset between tests
 * ```
 */

import { randomUUID } from "crypto";
import {
  type DequeueOptions,
  type DequeueResult,
  type EnqueueJobInput,
  type JobAckFence,
  type JobAckOutcome,
  type JobQueue,
  type JobQueueFairness,
  type JobRecord,
  LEASE_ABSOLUTE_CAP,
  LEASE_HEARTBEAT_LOST,
  type ServedDefinition,
  type Status,
} from "../persistence/interface.js";

/** Options accepted by `InMemoryJobQueue`'s constructor. */
export interface InMemoryJobQueueOptions {
  /** Unique worker identifier. Defaults to an auto-generated ID. */
  workerId?: string;
  /**
   * Injectable clock, used for every timestamp this fake writes
   * (`createdAt`/`updatedAt`/`lockedAt`/etc.). Defaults to
   * `() => new Date()`. Inject a fixed/advancing clock in tests that need
   * deterministic timestamps instead of relying on wall-clock time.
   */
  now?: () => Date;
  /**
   * Per-group fairness for the dequeue. Omit (the default) to preserve
   * plain priority-then-FIFO ordering. See `JobQueueFairness`.
   */
  fairness?: JobQueueFairness;
}

/**
 * Splits a dotted payload path into segments.
 */
function requireGroupLimit(maxConcurrentPerGroup: number): number {
  if (!Number.isInteger(maxConcurrentPerGroup) || maxConcurrentPerGroup < 1) {
    throw new Error(
      `JobQueueFairness.maxConcurrentPerGroup must be an integer of at least 1, got ${maxConcurrentPerGroup}`,
    );
  }
  return maxConcurrentPerGroup;
}

function splitGroupPath(groupBy: string): string[] {
  const segments = groupBy.split(".").filter((s) => s.length > 0);
  if (segments.length === 0) {
    throw new Error(
      `JobQueueFairness.groupBy must name at least one payload field, got ${JSON.stringify(groupBy)}`,
    );
  }
  return segments;
}

/**
 * Resolves the group key for a job from its payload along the fairness path.
 * Absent or non-string values resolve to "" (the anonymous group).
 */
function resolveGroupKey(
  payload: Record<string, unknown> | undefined,
  path: string[],
): string {
  let current: unknown = payload;
  for (const segment of path) {
    if (
      current === null ||
      current === undefined ||
      typeof current !== "object"
    ) {
      return "";
    }
    current = (current as Record<string, unknown>)[segment];
  }
  if (current === null || current === undefined) {
    return "";
  }
  if (typeof current === "string") {
    return current;
  }
  if (
    typeof current === "number" ||
    typeof current === "boolean" ||
    typeof current === "bigint"
  ) {
    return String(current);
  }
  return "";
}

export class InMemoryJobQueue implements JobQueue {
  private jobs = new Map<string, JobRecord>();
  private workerId: string;
  /** Whether `workerId` came from the caller (see `adoptWorkerId`). */
  private readonly workerIdWasConfigured: boolean;
  private defaultMaxAttempts = 3;
  private readonly now: () => Date;
  private readonly fairnessPath: string[] | null;
  private readonly fairnessLimit: number;
  /**
   * Monotonic insertion counter, keyed by job id. `dequeue`'s ordering is
   * priority DESC, then `createdAt` ASC -- when two jobs share both
   * (common with an injected/frozen clock, or same-millisecond real-time
   * enqueues), this breaks the tie explicitly by enqueue order instead of
   * leaning on `Array.prototype.sort`'s stability as an implicit,
   * easy-to-accidentally-break contract.
   */
  private insertionSequence = new Map<string, number>();
  private nextSequence = 0;

  /**
   * @param workerIdOrOpts - Either a worker id string (backwards
   * compatible with the original single-argument constructor) or an
   * options object.
   * @param maybeOpts - Options, only consulted when the first argument is
   * a worker id string.
   */
  constructor(
    workerIdOrOpts?: string | InMemoryJobQueueOptions,
    maybeOpts?: InMemoryJobQueueOptions,
  ) {
    const opts: InMemoryJobQueueOptions =
      typeof workerIdOrOpts === "string"
        ? { workerId: workerIdOrOpts, ...maybeOpts }
        : (workerIdOrOpts ?? {});
    this.workerIdWasConfigured = opts.workerId !== undefined;
    this.workerId = opts.workerId ?? `worker-${randomUUID().slice(0, 8)}`;
    this.now = opts.now ?? (() => new Date());
    this.fairnessPath = opts.fairness
      ? splitGroupPath(opts.fairness.groupBy ?? "_groupKey")
      : null;
    this.fairnessLimit = opts.fairness
      ? requireGroupLimit(opts.fairness.maxConcurrentPerGroup)
      : 0;
  }

  /**
   * Take the host's worker id unless this queue was constructed with one
   * of its own; returns the id it will stamp on claimed jobs.
   */
  adoptWorkerId(workerId: string): string {
    if (!this.workerIdWasConfigured) this.workerId = workerId;
    return this.workerId;
  }

  // ============================================================================
  // Core Operations
  // ============================================================================

  /**
   * Add a job to the queue.
   *
   * Idempotent on `(workflowRunId, stageId)` per the `JobQueue` contract:
   * any row already queued for that pair is removed first, so exactly one
   * job row exists per stage per run with `attempt` back at 0 — matching
   * the `@@unique([workflowRunId, stageId])` the reference Prisma schema
   * declares, so `run.rerunFrom` and `run.reapStuck` behave here exactly
   * as they do against a real database.
   */
  async enqueue(options: EnqueueJobInput): Promise<string> {
    const now = this.now();
    const id = randomUUID();

    this.removeByRunAndStage(options.workflowRunId, options.stageId);

    const job: JobRecord = {
      id,
      createdAt: now,
      updatedAt: now,
      workflowRunId: options.workflowRunId,
      workflowId: options.workflowId,
      stageId: options.stageId,
      status: "PENDING",
      priority: options.priority ?? 5,
      workerId: null,
      lockedAt: null,
      startedAt: null,
      completedAt: null,
      attempt: 0,
      maxAttempts: this.defaultMaxAttempts,
      lastError: null,
      nextPollAt: options.scheduledFor ?? null,
      payload: {
        ...options.payload,
        ...(options.groupKey !== undefined
          ? { _groupKey: options.groupKey }
          : {}),
        // Only when the run is pinned, matching the Prisma adapter: an
        // unpinned job's payload is unchanged from every earlier release.
        ...(options.definitionVersion != null
          ? { _definitionVersion: options.definitionVersion }
          : {}),
      },
    };

    this.jobs.set(id, job);
    this.insertionSequence.set(id, this.nextSequence++);
    return id;
  }

  async enqueueParallel(jobs: EnqueueJobInput[]): Promise<string[]> {
    const ids: string[] = [];
    for (const job of jobs) {
      const id = await this.enqueue(job);
      ids.push(id);
    }
    return ids;
  }

  async deleteByRunAndStages(
    workflowRunId: string,
    stageIds: string[],
  ): Promise<number> {
    let removed = 0;
    for (const stageId of stageIds) {
      removed += this.removeByRunAndStage(workflowRunId, stageId);
    }
    return removed;
  }

  /** Drops every row for one `(run, stage)` pair; returns how many. */
  private removeByRunAndStage(workflowRunId: string, stageId: string): number {
    let removed = 0;
    for (const job of Array.from(this.jobs.values())) {
      if (job.workflowRunId !== workflowRunId || job.stageId !== stageId) {
        continue;
      }
      this.jobs.delete(job.id);
      this.insertionSequence.delete(job.id);
      removed++;
    }
    return removed;
  }

  async dequeue(options?: DequeueOptions): Promise<DequeueResult | null> {
    // Find the highest priority PENDING job
    const now = this.now();
    const serves = options?.serves;
    // The same predicate the Prisma dequeue expresses in SQL: a pinned job
    // needs an exact (workflowId, version) match; an unpinned one needs
    // only the workflow; a row that names no workflow is malformed and is
    // left claimable so the dead-job path can fail it. This fake keeps
    // `workflowId` as a column where the Prisma row keeps it on the
    // payload, so it reads the column and only the version from the body.
    const canServe = (job: JobRecord): boolean => {
      if (serves === undefined) return true;
      if (!job.workflowId) return true;
      const version = job.payload._definitionVersion;
      return serves.some(
        (s: ServedDefinition) =>
          s.workflowId === job.workflowId &&
          (typeof version !== "string" || s.version === version),
      );
    };
    const comparator = (a: JobRecord, b: JobRecord) => {
      // Higher priority first
      if (b.priority !== a.priority) {
        return b.priority - a.priority;
      }
      // Earlier creation first (FIFO for same priority)
      const timeDiff = a.createdAt.getTime() - b.createdAt.getTime();
      if (timeDiff !== 0) return timeDiff;
      // Equal priority AND equal timestamp (frozen/injected clock, or
      // same-millisecond real-time enqueues) -- break the tie by
      // explicit enqueue order.
      const seqA = this.insertionSequence.get(a.id) ?? 0;
      const seqB = this.insertionSequence.get(b.id) ?? 0;
      return seqA - seqB;
    };

    const pendingJobs = Array.from(this.jobs.values())
      .filter(
        (j) =>
          j.status === "PENDING" &&
          (j.nextPollAt === null || j.nextPollAt <= now) &&
          canServe(j),
      )
      .sort(comparator);

    let candidates = pendingJobs;
    if (this.fairnessPath) {
      // Skip any group already holding its share of the RUNNING pool — the
      // same cap the Prisma adapter applies in SQL, and the only rule that
      // actually stops a flood (see `JobQueueFairness`).
      const path = this.fairnessPath;
      const running = new Map<string, number>();
      for (const job of this.jobs.values()) {
        if (job.status !== "RUNNING") continue;
        const group = resolveGroupKey(job.payload, path);
        running.set(group, (running.get(group) ?? 0) + 1);
      }
      candidates = pendingJobs.filter(
        (job) =>
          (running.get(resolveGroupKey(job.payload, path)) ?? 0) <
          this.fairnessLimit,
      );
    }

    if (candidates.length === 0) {
      return null;
    }

    const job = candidates[0]!;

    // Lock the job and increment attempt (matches Prisma dequeue semantics)
    const newAttempt = job.attempt + 1;
    const updated: JobRecord = {
      ...job,
      status: "RUNNING",
      workerId: this.workerId,
      lockedAt: now,
      startedAt: now,
      updatedAt: now,
      attempt: newAttempt,
    };
    this.jobs.set(job.id, updated);

    const { _groupKey, _definitionVersion, ...payload } = job.payload;
    return {
      jobId: job.id,
      workflowRunId: job.workflowRunId,
      workflowId: job.workflowId,
      stageId: job.stageId,
      priority: job.priority,
      attempt: newAttempt,
      maxAttempts: job.maxAttempts,
      payload,
      startedAt: now,
    };
  }

  async complete(jobId: string, fence?: JobAckFence): Promise<JobAckOutcome> {
    const job = this.jobs.get(jobId);
    // A row deleted underneath the worker is superseded like any other stale
    // ack: `JobAckOutcome` names deletion explicitly, and the Prisma adapter
    // reports it that way because its fenced ack is an `updateMany` whose
    // WHERE simply matches nothing. Unfenced, naming a job that does not
    // exist stays an error.
    if (!job) {
      if (fence) return "superseded";
      throw new Error(`Job not found: ${jobId}`);
    }

    // A fenced acknowledgement only lands if the job is still RUNNING and
    // still on the attempt that handed out fence.startedAt; otherwise it has
    // been rescued/re-claimed or cancelled and this attempt's write is a no-op.
    if (
      fence &&
      (job.status !== "RUNNING" ||
        job.attempt !== fence.attempt ||
        job.startedAt?.getTime() !== fence.startedAt.getTime())
    ) {
      return "superseded";
    }

    const now = this.now();
    const updated: JobRecord = {
      ...job,
      status: "COMPLETED",
      completedAt: now,
      updatedAt: now,
    };
    this.jobs.set(jobId, updated);
    return "acknowledged";
  }

  async suspend(
    jobId: string,
    nextPollAt: Date,
    fence?: JobAckFence,
  ): Promise<JobAckOutcome> {
    const job = this.jobs.get(jobId);
    // A row deleted underneath the worker is superseded like any other stale
    // ack: `JobAckOutcome` names deletion explicitly, and the Prisma adapter
    // reports it that way because its fenced ack is an `updateMany` whose
    // WHERE simply matches nothing. Unfenced, naming a job that does not
    // exist stays an error.
    if (!job) {
      if (fence) return "superseded";
      throw new Error(`Job not found: ${jobId}`);
    }

    // A fenced acknowledgement only lands if the job is still RUNNING and
    // still on the attempt that handed out fence.startedAt; otherwise it has
    // been rescued/re-claimed or cancelled and this attempt's write is a no-op.
    if (
      fence &&
      (job.status !== "RUNNING" ||
        job.attempt !== fence.attempt ||
        job.startedAt?.getTime() !== fence.startedAt.getTime())
    ) {
      return "superseded";
    }

    const updated: JobRecord = {
      ...job,
      status: "SUSPENDED",
      nextPollAt,
      workerId: null,
      lockedAt: null,
      updatedAt: this.now(),
    };
    this.jobs.set(jobId, updated);
    return "acknowledged";
  }

  /**
   * Return a claimed job to PENDING with a later `nextPollAt` without
   * counting the claim as an attempt. See `JobQueue.defer`.
   */
  async defer(
    jobId: string,
    nextPollAt: Date,
    reason: string,
    fence?: JobAckFence,
  ): Promise<JobAckOutcome> {
    const job = this.jobs.get(jobId);
    if (!job) {
      throw new Error(`Job not found: ${jobId}`);
    }

    if (
      fence &&
      (job.status !== "RUNNING" ||
        job.attempt !== fence.attempt ||
        job.startedAt?.getTime() !== fence.startedAt.getTime())
    ) {
      return "superseded";
    }

    const updated: JobRecord = {
      ...job,
      status: "PENDING",
      nextPollAt,
      workerId: null,
      lockedAt: null,
      lastError: reason,
      // The dequeue incremented this; declining the work gives it back.
      attempt: Math.max(0, job.attempt - 1),
      updatedAt: this.now(),
    };
    this.jobs.set(jobId, updated);
    return "acknowledged";
  }

  async fail(
    jobId: string,
    error: string,
    shouldRetry: boolean = false,
    fence?: JobAckFence,
  ): Promise<JobAckOutcome> {
    const job = this.jobs.get(jobId);
    // A row deleted underneath the worker is superseded like any other stale
    // ack: `JobAckOutcome` names deletion explicitly, and the Prisma adapter
    // reports it that way because its fenced ack is an `updateMany` whose
    // WHERE simply matches nothing. Unfenced, naming a job that does not
    // exist stays an error.
    if (!job) {
      if (fence) return "superseded";
      throw new Error(`Job not found: ${jobId}`);
    }

    // A fenced acknowledgement only lands if the job is still RUNNING and
    // still on the attempt that handed out fence.startedAt; otherwise it has
    // been rescued/re-claimed or cancelled and this attempt's write is a no-op.
    if (
      fence &&
      (job.status !== "RUNNING" ||
        job.attempt !== fence.attempt ||
        job.startedAt?.getTime() !== fence.startedAt.getTime())
    ) {
      return "superseded";
    }

    const now = this.now();

    if (shouldRetry && job.attempt < job.maxAttempts) {
      // Retry: move back to PENDING (attempt was already incremented during dequeue)
      const updated: JobRecord = {
        ...job,
        status: "PENDING",
        lastError: error,
        workerId: null,
        lockedAt: null,
        updatedAt: now,
      };
      this.jobs.set(jobId, updated);
    } else {
      // No more retries: mark as FAILED
      const updated: JobRecord = {
        ...job,
        status: "FAILED",
        lastError: error,
        completedAt: now,
        updatedAt: now,
      };
      this.jobs.set(jobId, updated);
    }
    return "acknowledged";
  }

  async releaseStaleJobs(staleThresholdMs: number = 300000): Promise<number> {
    const now = this.now();
    const threshold = new Date(now.getTime() - staleThresholdMs);
    const reason = `${LEASE_HEARTBEAT_LOST}: no heartbeat for more than ${staleThresholdMs}ms; lease released for another worker`;
    let released = 0;

    for (const job of this.jobs.values()) {
      if (
        job.status === "RUNNING" &&
        job.lockedAt &&
        job.lockedAt < threshold
      ) {
        // Release the stale lock
        const updated: JobRecord = {
          ...job,
          status: "PENDING",
          lastError: reason,
          workerId: null,
          lockedAt: null,
          updatedAt: now,
        };
        this.jobs.set(job.id, updated);
        released++;
      }
    }

    return released;
  }

  /**
   * The coarse tier of the two-tier expiry — see `JobQueue.expireRunawayJobs`.
   * Keyed on `startedAt`, which the heartbeat never refreshes, so it fires on
   * a worker that is alive but wedged as readily as on one that died.
   */
  async expireRunawayJobs(absoluteTimeoutMs: number): Promise<number> {
    const now = this.now();
    const cutoff = new Date(now.getTime() - absoluteTimeoutMs);
    const reason = `${LEASE_ABSOLUTE_CAP}: held its lease for more than ${absoluteTimeoutMs}ms while still heartbeating; failed as a runaway`;
    let expired = 0;

    for (const job of this.jobs.values()) {
      if (
        job.status === "RUNNING" &&
        job.startedAt !== null &&
        job.startedAt < cutoff
      ) {
        const updated: JobRecord = {
          ...job,
          status: "FAILED",
          completedAt: now,
          updatedAt: now,
          lastError: reason,
        };
        this.jobs.set(job.id, updated);
        expired++;
      }
    }

    return expired;
  }

  async getJobsByWorkflowRun(workflowRunId: string): Promise<JobRecord[]> {
    return Array.from(this.jobs.values())
      .filter((j) => j.workflowRunId === workflowRunId)
      .map((j) => {
        const { _groupKey, _definitionVersion, ...payload } = j.payload;
        return { ...j, payload };
      });
  }

  async touchJob(jobId: string): Promise<void> {
    const job = this.jobs.get(jobId);
    if (!job || job.status !== "RUNNING") return;
    const now = this.now();
    this.jobs.set(jobId, {
      ...job,
      lockedAt: now,
      updatedAt: now,
    });
  }

  async cancelByRun(workflowRunId: string): Promise<number> {
    const now = this.now();
    let count = 0;
    for (const job of this.jobs.values()) {
      if (
        job.workflowRunId === workflowRunId &&
        (job.status === "PENDING" || job.status === "SUSPENDED")
      ) {
        const updated: JobRecord = {
          ...job,
          status: "CANCELLED",
          completedAt: now,
          updatedAt: now,
        };
        this.jobs.set(job.id, updated);
        count++;
      }
    }
    return count;
  }

  // ============================================================================
  // Test Helpers
  // ============================================================================

  /**
   * Clear all jobs - useful between tests
   */
  clear(): void {
    this.jobs.clear();
    this.insertionSequence.clear();
    this.nextSequence = 0;
  }

  /**
   * Get all jobs for inspection
   */
  getAllJobs(): JobRecord[] {
    return Array.from(this.jobs.values()).map((j) => ({ ...j }));
  }

  /**
   * Get jobs by status for inspection
   */
  getJobsByStatus(status: Status): JobRecord[] {
    return Array.from(this.jobs.values())
      .filter((j) => j.status === status)
      .map((j) => ({ ...j }));
  }

  /**
   * Get a specific job by ID
   */
  getJob(jobId: string): JobRecord | null {
    const job = this.jobs.get(jobId);
    return job ? { ...job } : null;
  }

  /**
   * Get the worker ID for this queue instance
   */
  getWorkerId(): string {
    return this.workerId;
  }

  /**
   * Set max attempts for new jobs
   */
  setDefaultMaxAttempts(maxAttempts: number): void {
    this.defaultMaxAttempts = maxAttempts;
  }

  /**
   * Simulate a worker crash by releasing a job's lock without completing it
   */
  simulateCrash(jobId: string): void {
    const job = this.jobs.get(jobId);
    if (job && job.status === "RUNNING") {
      // Don't change status - just leave it locked by the "crashed" worker
      // releaseStaleJobs() will clean it up
    }
  }

  /**
   * Move a suspended job back to pending (for manual resume testing)
   */
  resumeJob(jobId: string): void {
    const job = this.jobs.get(jobId);
    if (job && job.status === "SUSPENDED") {
      const updated: JobRecord = {
        ...job,
        status: "PENDING",
        nextPollAt: null,
        updatedAt: this.now(),
      };
      this.jobs.set(jobId, updated);
    }
  }

  /**
   * Set lockedAt for testing stale job scenarios
   */
  setJobLockedAt(jobId: string, lockedAt: Date): void {
    const job = this.jobs.get(jobId);
    if (job) {
      const updated: JobRecord = {
        ...job,
        lockedAt,
      };
      this.jobs.set(jobId, updated);
    }
  }

  /**
   * Set startedAt for testing the absolute lease cap. Unlike `lockedAt`,
   * `startedAt` is stamped once per claim and no heartbeat refreshes it, so
   * this is the dial for "a worker that is alive but wedged".
   */
  setJobStartedAt(jobId: string, startedAt: Date): void {
    const job = this.jobs.get(jobId);
    if (job) {
      this.jobs.set(jobId, { ...job, startedAt });
    }
  }

  /**
   * Set nextPollAt for testing suspended job polling
   */
  setJobNextPollAt(jobId: string, nextPollAt: Date | null): void {
    const job = this.jobs.get(jobId);
    if (job) {
      const updated: JobRecord = {
        ...job,
        nextPollAt,
      };
      this.jobs.set(jobId, updated);
    }
  }
}
