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
import type {
  DequeueResult,
  EnqueueJobInput,
  JobQueue,
  JobRecord,
  Status,
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
}

export class InMemoryJobQueue implements JobQueue {
  private jobs = new Map<string, JobRecord>();
  private workerId: string;
  private defaultMaxAttempts = 3;
  private readonly now: () => Date;
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
    this.workerId = opts.workerId ?? `worker-${randomUUID().slice(0, 8)}`;
    this.now = opts.now ?? (() => new Date());
  }

  // ============================================================================
  // Core Operations
  // ============================================================================

  async enqueue(options: EnqueueJobInput): Promise<string> {
    const now = this.now();
    const id = randomUUID();

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
      payload: options.payload ?? {},
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

  async dequeue(): Promise<DequeueResult | null> {
    // Find the highest priority PENDING job
    const now = this.now();
    const pendingJobs = Array.from(this.jobs.values())
      .filter(
        (j) =>
          j.status === "PENDING" &&
          (j.nextPollAt === null || j.nextPollAt <= now),
      )
      .sort((a, b) => {
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
      });

    if (pendingJobs.length === 0) {
      return null;
    }

    const job = pendingJobs[0]!;

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

    return {
      jobId: job.id,
      workflowRunId: job.workflowRunId,
      workflowId: job.workflowId,
      stageId: job.stageId,
      priority: job.priority,
      attempt: newAttempt,
      maxAttempts: job.maxAttempts,
      payload: job.payload,
    };
  }

  async complete(jobId: string): Promise<void> {
    const job = this.jobs.get(jobId);
    if (!job) {
      throw new Error(`Job not found: ${jobId}`);
    }

    const now = this.now();
    const updated: JobRecord = {
      ...job,
      status: "COMPLETED",
      completedAt: now,
      updatedAt: now,
    };
    this.jobs.set(jobId, updated);
  }

  async suspend(jobId: string, nextPollAt: Date): Promise<void> {
    const job = this.jobs.get(jobId);
    if (!job) {
      throw new Error(`Job not found: ${jobId}`);
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
  }

  async fail(
    jobId: string,
    error: string,
    shouldRetry: boolean = false,
  ): Promise<void> {
    const job = this.jobs.get(jobId);
    if (!job) {
      throw new Error(`Job not found: ${jobId}`);
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
  }

  async releaseStaleJobs(staleThresholdMs: number = 300000): Promise<number> {
    const now = this.now();
    const threshold = new Date(now.getTime() - staleThresholdMs);
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

  async getJobsByWorkflowRun(workflowRunId: string): Promise<JobRecord[]> {
    return Array.from(this.jobs.values())
      .filter((j) => j.workflowRunId === workflowRunId)
      .map((j) => ({ ...j }));
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
