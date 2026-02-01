/**
 * In-Memory Job Queue
 *
 * A complete in-memory implementation of JobQueue for testing.
 * Supports priority ordering, locking, and stale job recovery.
 */

import { randomUUID } from "crypto";
import type {
  DequeueResult,
  EnqueueJobInput,
  JobQueue,
  JobRecord,
  JobStatus,
} from "../../persistence/interface.js";

export class InMemoryJobQueue implements JobQueue {
  private jobs = new Map<string, JobRecord>();
  private workerId: string;
  private defaultMaxAttempts = 3;

  constructor(workerId?: string) {
    this.workerId = workerId ?? `worker-${randomUUID().slice(0, 8)}`;
  }

  // ============================================================================
  // Core Operations
  // ============================================================================

  async enqueue(options: EnqueueJobInput): Promise<string> {
    const now = new Date();
    const id = randomUUID();

    const job: JobRecord = {
      id,
      createdAt: now,
      updatedAt: now,
      workflowRunId: options.workflowRunId,
      stageId: options.stageId,
      status: "PENDING",
      priority: options.priority ?? 5,
      workerId: null,
      lockedAt: null,
      startedAt: null,
      completedAt: null,
      attempt: 1,
      maxAttempts: this.defaultMaxAttempts,
      lastError: null,
      nextPollAt: options.scheduledFor ?? null,
      payload: options.payload ?? {},
    };

    this.jobs.set(id, job);
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
    const now = new Date();
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
        return a.createdAt.getTime() - b.createdAt.getTime();
      });

    if (pendingJobs.length === 0) {
      return null;
    }

    const job = pendingJobs[0]!;

    // Lock the job
    const updated: JobRecord = {
      ...job,
      status: "RUNNING",
      workerId: this.workerId,
      lockedAt: now,
      startedAt: now,
      updatedAt: now,
    };
    this.jobs.set(job.id, updated);

    return {
      jobId: job.id,
      workflowRunId: job.workflowRunId,
      stageId: job.stageId,
      priority: job.priority,
      attempt: job.attempt,
      payload: job.payload,
    };
  }

  async complete(jobId: string): Promise<void> {
    const job = this.jobs.get(jobId);
    if (!job) {
      throw new Error(`Job not found: ${jobId}`);
    }

    const now = new Date();
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
      updatedAt: new Date(),
    };
    this.jobs.set(jobId, updated);
  }

  async fail(
    jobId: string,
    error: string,
    shouldRetry: boolean = true,
  ): Promise<void> {
    const job = this.jobs.get(jobId);
    if (!job) {
      throw new Error(`Job not found: ${jobId}`);
    }

    const now = new Date();

    if (shouldRetry && job.attempt < job.maxAttempts) {
      // Retry: move back to PENDING with incremented attempt
      const updated: JobRecord = {
        ...job,
        status: "PENDING",
        attempt: job.attempt + 1,
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

  async getSuspendedJobsReadyToPoll(): Promise<
    Array<{ jobId: string; stageId: string; workflowRunId: string }>
  > {
    const now = new Date();
    return Array.from(this.jobs.values())
      .filter(
        (j) => j.status === "SUSPENDED" && j.nextPollAt && j.nextPollAt <= now,
      )
      .map((j) => ({
        jobId: j.id,
        stageId: j.stageId,
        workflowRunId: j.workflowRunId,
      }));
  }

  async releaseStaleJobs(staleThresholdMs: number = 60000): Promise<number> {
    const now = new Date();
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

  // ============================================================================
  // Test Helpers (not part of interface)
  // ============================================================================

  /**
   * Clear all jobs - useful between tests
   */
  clear(): void {
    this.jobs.clear();
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
  getJobsByStatus(status: JobStatus): JobRecord[] {
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
        updatedAt: new Date(),
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
