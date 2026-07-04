/**
 * Serverless Host for Workflow Engine Command Kernel
 *
 * Platform-agnostic host for serverless environments (Cloudflare Workers,
 * AWS Lambda, Vercel Edge, Deno Deploy, etc.). Unlike the Node host, there
 * are no timers, loops, or signal handlers — every method is a single
 * stateless invocation.
 *
 * Consumers wire platform-specific glue (queue ack/retry, waitUntil,
 * cron triggers) around these methods.
 */

import type { JobTransport, Kernel } from "@bratsos/workflow-engine/kernel";

// ============================================================================
// Public interfaces
// ============================================================================

export interface ServerlessHostConfig {
  /** Kernel instance to dispatch commands to. */
  kernel: Kernel;

  /** Job transport for complete/suspend/fail lifecycle. */
  jobTransport: JobTransport;

  /** Unique worker identifier (e.g. function name, worker name). */
  workerId: string;

  /** Stale lease threshold in milliseconds (default: 300_000). */
  staleLeaseThresholdMs?: number;

  /** Max pending runs to claim per maintenance tick (default: 10). */
  maxClaimsPerTick?: number;

  /** Max suspended stages to check per tick (default: 10). */
  maxSuspendedChecksPerTick?: number;

  /** Max outbox events to flush per tick (default: 100). */
  maxOutboxFlushPerTick?: number;

  /** Job lease heartbeat interval in milliseconds (default: 60_000). */
  jobHeartbeatIntervalMs?: number;
}

/** Message shape representing a job to execute. Matches DequeueResult fields. */
export interface JobMessage {
  jobId: string;
  workflowRunId: string;
  workflowId: string;
  stageId: string;
  attempt: number;
  maxAttempts?: number;
  payload: Record<string, unknown>;
}

export interface JobResult {
  outcome: "completed" | "suspended" | "failed";
  error?: string;
}

export interface ProcessJobsResult {
  processed: number;
  succeeded: number;
  failed: number;
}

export interface MaintenanceTickResult {
  claimed: number;
  suspendedChecked: number;
  staleReleased: number;
  eventsFlushed: number;
  stuckReaped: number;
}

export interface ServerlessHost {
  /** Execute a single pre-dequeued job. Returns outcome so consumer can ack/retry. */
  handleJob(msg: JobMessage): Promise<JobResult>;

  /**
   * Dequeue and process jobs from the jobTransport.
   * Defaults to 1 job per call (safe for edge runtimes with CPU limits).
   * Pass maxJobs for longer-running environments like Lambda.
   */
  processAvailableJobs(opts?: { maxJobs?: number }): Promise<ProcessJobsResult>;

  /** Run one bounded maintenance tick (claim, poll, reap, flush). */
  runMaintenanceTick(): Promise<MaintenanceTickResult>;
}

// ============================================================================
// Implementation
// ============================================================================

class ServerlessHostImpl implements ServerlessHost {
  private readonly kernel: Kernel;
  private readonly jobTransport: JobTransport;
  private readonly workerId: string;
  private readonly staleLeaseThresholdMs: number;
  private readonly maxClaimsPerTick: number;
  private readonly maxSuspendedChecksPerTick: number;
  private readonly maxOutboxFlushPerTick: number;
  private readonly jobHeartbeatIntervalMs: number;

  constructor(config: ServerlessHostConfig) {
    this.kernel = config.kernel;
    this.jobTransport = config.jobTransport;
    this.workerId = config.workerId;
    this.staleLeaseThresholdMs = config.staleLeaseThresholdMs ?? 300_000;
    this.maxClaimsPerTick = config.maxClaimsPerTick ?? 10;
    this.maxSuspendedChecksPerTick = config.maxSuspendedChecksPerTick ?? 10;
    this.maxOutboxFlushPerTick = config.maxOutboxFlushPerTick ?? 100;
    this.jobHeartbeatIntervalMs = config.jobHeartbeatIntervalMs ?? 60_000;
  }

  async handleJob(msg: JobMessage): Promise<JobResult> {
    const config =
      (msg.payload as { config?: Record<string, unknown> }).config || {};

    // Heartbeat: periodically renew the job's lease while it executes so
    // a long-running stage isn't picked up as stale and duplicated by
    // releaseStaleJobs.
    const heartbeat = setInterval(
      () => void this.jobTransport.touchJob(msg.jobId).catch(() => {}),
      this.jobHeartbeatIntervalMs,
    );

    let result;
    try {
      result = await this.kernel.dispatch({
        type: "job.execute",
        idempotencyKey: `job:${msg.jobId}:attempt:${msg.attempt}`,
        workflowRunId: msg.workflowRunId,
        workflowId: msg.workflowId,
        stageId: msg.stageId,
        config,
      });
    } finally {
      clearInterval(heartbeat);
    }

    if (result.outcome === "completed") {
      await this.jobTransport.complete(msg.jobId);
      await this.kernel.dispatch({
        type: "run.transition",
        workflowRunId: msg.workflowRunId,
      });
      return { outcome: "completed" };
    }

    if (result.outcome === "suspended") {
      const nextPollAt = result.nextPollAt ?? new Date(Date.now() + 60_000);
      await this.jobTransport.suspend(msg.jobId, nextPollAt);
      return { outcome: "suspended" };
    }

    // failed — ghost jobs and non-retryable (deterministic) errors should
    // never be retried.
    const canRetry =
      !result.ghost &&
      result.retryable !== false &&
      msg.attempt < (msg.maxAttempts ?? 3);
    await this.jobTransport.fail(
      msg.jobId,
      result.error ?? "Unknown error",
      canRetry,
    );
    // Terminal failure: without this, the run lingers RUNNING until
    // run.reapStuck kills it minutes later with a generic
    // "STUCK_RUN_REAPED" error, losing the real stage error. Dispatch
    // run.transition so the run fails promptly with the actual error
    // from the FAILED stage record.
    if (!canRetry && !result.ghost) {
      try {
        await this.kernel.dispatch({
          type: "run.transition",
          workflowRunId: msg.workflowRunId,
        });
      } catch (error) {
        console.error(
          "[ServerlessHost] run.transition (terminal failure) error:",
          error,
        );
      }
    }
    return { outcome: "failed", error: result.error };
  }

  async processAvailableJobs(opts?: {
    maxJobs?: number;
  }): Promise<ProcessJobsResult> {
    const maxJobs = opts?.maxJobs ?? 1;
    let processed = 0;
    let succeeded = 0;
    let failed = 0;

    while (processed < maxJobs) {
      const job = await this.jobTransport.dequeue();
      if (!job) break;

      const result = await this.handleJob({
        jobId: job.jobId,
        workflowRunId: job.workflowRunId,
        workflowId: job.workflowId,
        stageId: job.stageId,
        attempt: job.attempt,
        maxAttempts: job.maxAttempts,
        payload: job.payload,
      });

      processed++;
      if (result.outcome === "failed") {
        failed++;
      } else {
        succeeded++;
      }
    }

    return { processed, succeeded, failed };
  }

  async runMaintenanceTick(): Promise<MaintenanceTickResult> {
    let claimed = 0;
    let suspendedChecked = 0;
    let staleReleased = 0;
    let eventsFlushed = 0;

    // 1. Claim pending runs → enqueue first-stage jobs
    try {
      const claimResult = await this.kernel.dispatch({
        type: "run.claimPending",
        workerId: this.workerId,
        maxClaims: this.maxClaimsPerTick,
      });
      claimed = claimResult.claimed.length;
    } catch (error) {
      console.error("[ServerlessHost] run.claimPending error:", error);
    }

    // 2. Poll suspended stages → resume if ready
    try {
      const pollResult = await this.kernel.dispatch({
        type: "stage.pollSuspended",
        maxChecks: this.maxSuspendedChecksPerTick,
      });
      suspendedChecked = pollResult.checked;
      for (const workflowRunId of pollResult.resumedWorkflowRunIds) {
        await this.kernel.dispatch({
          type: "run.transition",
          workflowRunId,
        });
      }
    } catch (error) {
      console.error("[ServerlessHost] stage.pollSuspended error:", error);
    }

    // 3. Reap stale leases → release crashed worker locks
    try {
      const reapResult = await this.kernel.dispatch({
        type: "lease.reapStale",
        staleThresholdMs: this.staleLeaseThresholdMs,
      });
      staleReleased = reapResult.released;
    } catch (error) {
      console.error("[ServerlessHost] lease.reapStale error:", error);
    }

    // 4. Flush outbox → publish pending events through EventSink
    try {
      const flushResult = await this.kernel.dispatch({
        type: "outbox.flush",
        maxEvents: this.maxOutboxFlushPerTick,
      });
      eventsFlushed = flushResult.published;
    } catch (error) {
      console.error("[ServerlessHost] outbox.flush error:", error);
    }

    // 5. Reap stuck runs → fail runs with no activity past threshold
    let stuckReaped = 0;
    try {
      const reapStuckResult = await this.kernel.dispatch({
        type: "run.reapStuck",
        stuckThresholdMs: Math.max(this.staleLeaseThresholdMs * 3, 5 * 60_000),
      });
      stuckReaped = reapStuckResult.failed;
    } catch (error) {
      console.error("[ServerlessHost] run.reapStuck error:", error);
    }

    return {
      claimed,
      suspendedChecked,
      staleReleased,
      eventsFlushed,
      stuckReaped,
    };
  }
}

// ============================================================================
// Factory
// ============================================================================

export function createServerlessHost(
  config: ServerlessHostConfig,
): ServerlessHost {
  return new ServerlessHostImpl(config);
}
