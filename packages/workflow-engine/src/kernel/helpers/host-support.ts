/**
 * Host support helpers — shared by the Node and Serverless hosts.
 *
 * Both hosts wrap the same kernel command sequences — dequeue-and-execute a
 * job under a lease heartbeat, and run one bounded claim/poll/reap/flush
 * maintenance pass — in different process models: the Node host loops
 * forever with backoff and OS signal handling, the Serverless host exposes
 * each pass as a single stateless invocation. That process-model code stays
 * host-local; this module holds the command-dispatch logic in between so it
 * isn't hand-maintained twice.
 */

import type { Kernel } from "../kernel.js";
import type { JobTransport } from "../ports.js";

// ============================================================================
// Shared defaults
// ============================================================================

/** Default tuning knobs shared by every host implementation. */
export const HOST_DEFAULTS = {
  /** Stale lease threshold (ms) past which a job's lease is reclaimed. */
  staleLeaseThresholdMs: 300_000,
  /** Max pending runs to claim per maintenance tick. */
  maxClaimsPerTick: 10,
  /** Max suspended stages to check per maintenance tick. */
  maxSuspendedChecksPerTick: 10,
  /** Max outbox events to flush per maintenance tick. */
  maxOutboxFlushPerTick: 100,
  /** Job lease heartbeat interval (ms). */
  jobHeartbeatIntervalMs: 60_000,
  /** Fallback max attempts when a job/queue doesn't specify one. */
  maxAttempts: 3,
  /**
   * Fallback delay (ms), added to "now", for a suspended job's next poll
   * when the stage result didn't provide its own `nextPollAt`.
   */
  suspendFallbackMs: 60_000,
  /**
   * Stuck-run threshold for `run.reapStuck`: at least 3x the stale-lease
   * threshold — so a run isn't reaped out from under a legitimately
   * long-running stage that's still heartbeating — floored at 5 minutes.
   */
  computeStuckThresholdMs(staleLeaseThresholdMs: number): number {
    return Math.max(staleLeaseThresholdMs * 3, 5 * 60_000);
  },
} as const;

// ============================================================================
// executeJobWithHeartbeat
// ============================================================================

/** Minimal job shape both hosts' job messages structurally satisfy. */
export interface HostJobMessage {
  jobId: string;
  workflowRunId: string;
  workflowId: string;
  stageId: string;
  attempt: number;
  maxAttempts?: number;
  payload: Record<string, unknown>;
}

export interface ExecuteJobWithHeartbeatOptions {
  /** Job transport for touchJob/complete/suspend/fail. */
  jobTransport: JobTransport;
  /** The dequeued job to execute. */
  job: HostJobMessage;
  /** Job lease heartbeat interval in milliseconds. */
  jobHeartbeatIntervalMs: number;
  /** Prefix for this host's `console.error` diagnostics, e.g. "[NodeHost]". */
  logPrefix: string;
}

export interface ExecuteJobOutcome {
  outcome: "completed" | "suspended" | "failed";
  error?: string;
}

/**
 * Dispatches `job.execute` for one job, holding a lease heartbeat for its
 * duration, then routes the outcome through the job transport and (when
 * terminal) `run.transition` — the sequence both hosts used to hand-maintain
 * identically after every hardening fix.
 */
export async function executeJobWithHeartbeat(
  kernel: Kernel,
  options: ExecuteJobWithHeartbeatOptions,
): Promise<ExecuteJobOutcome> {
  const { jobTransport, job, jobHeartbeatIntervalMs, logPrefix } = options;

  const config =
    (job.payload as { config?: Record<string, unknown> }).config || {};

  // Heartbeat: periodically renew the job's lease while it executes so a
  // long-running stage (> staleLeaseThresholdMs) isn't picked up as stale
  // and duplicated by releaseStaleJobs.
  const heartbeat = setInterval(
    () => void jobTransport.touchJob(job.jobId).catch(() => {}),
    jobHeartbeatIntervalMs,
  );

  let result;
  try {
    result = await kernel.dispatch({
      type: "job.execute",
      idempotencyKey: `job:${job.jobId}:attempt:${job.attempt}`,
      workflowRunId: job.workflowRunId,
      workflowId: job.workflowId,
      stageId: job.stageId,
      config,
    });
  } finally {
    clearInterval(heartbeat);
  }

  if (result.outcome === "completed") {
    await jobTransport.complete(job.jobId);
    await kernel.dispatch({
      type: "run.transition",
      workflowRunId: job.workflowRunId,
    });
    return { outcome: "completed" };
  }

  if (result.outcome === "suspended") {
    const nextPollAt =
      result.nextPollAt ??
      new Date(Date.now() + HOST_DEFAULTS.suspendFallbackMs);
    await jobTransport.suspend(job.jobId, nextPollAt);
    return { outcome: "suspended" };
  }

  // failed — ghost jobs (discarded by kernel because run is not RUNNING)
  // should never be retried — they'll just fail again.
  // A deterministic (non-retryable) stage error — e.g. Zod input
  // validation — will fail identically on every attempt, so it is
  // treated the same as an exhausted retry budget.
  const canRetry =
    !result.ghost &&
    result.retryable !== false &&
    job.attempt < (job.maxAttempts ?? HOST_DEFAULTS.maxAttempts);
  await jobTransport.fail(job.jobId, result.error ?? "Unknown error", canRetry);
  // Terminal failure: without this, the run lingers RUNNING until
  // run.reapStuck kills it minutes later with a generic "STUCK_RUN_REAPED"
  // error, losing the real stage error. Dispatch run.transition so the run
  // fails promptly with the actual error from the FAILED stage record.
  if (!canRetry && !result.ghost) {
    try {
      await kernel.dispatch({
        type: "run.transition",
        workflowRunId: job.workflowRunId,
      });
    } catch (error) {
      console.error(
        `${logPrefix} run.transition (terminal failure) error:`,
        error,
      );
    }
  }
  return { outcome: "failed", error: result.error };
}

// ============================================================================
// runMaintenanceTick
// ============================================================================

export interface RunMaintenanceTickOptions {
  /** Unique worker identifier passed to `run.claimPending`. */
  workerId: string;
  maxClaimsPerTick: number;
  maxSuspendedChecksPerTick: number;
  maxOutboxFlushPerTick: number;
  staleLeaseThresholdMs: number;
  /** Prefix for this host's `console.error` diagnostics, e.g. "[NodeHost]". */
  logPrefix: string;
}

/**
 * Per-command counts from one maintenance tick. The serverless host returns
 * these to its caller; the Node host ignores them (fire-and-forget on a
 * timer).
 */
export interface MaintenanceTickCounts {
  claimed: number;
  suspendedChecked: number;
  staleReleased: number;
  eventsFlushed: number;
  stuckReaped: number;
}

/**
 * Runs one bounded maintenance pass: claim pending runs, poll suspended
 * stages (transitioning any that resumed), reap stale leases, flush the
 * outbox, and reap stuck runs. Each command's error is caught and logged
 * independently so a failure in one doesn't block the rest of the tick.
 */
export async function runMaintenanceTick(
  kernel: Kernel,
  options: RunMaintenanceTickOptions,
): Promise<MaintenanceTickCounts> {
  const {
    workerId,
    maxClaimsPerTick,
    maxSuspendedChecksPerTick,
    maxOutboxFlushPerTick,
    staleLeaseThresholdMs,
    logPrefix,
  } = options;

  let claimed = 0;
  let suspendedChecked = 0;
  let staleReleased = 0;
  let eventsFlushed = 0;
  let stuckReaped = 0;

  // 1. Claim pending runs → enqueue first-stage jobs
  try {
    const claimResult = await kernel.dispatch({
      type: "run.claimPending",
      workerId,
      maxClaims: maxClaimsPerTick,
    });
    claimed = claimResult.claimed.length;
  } catch (error) {
    console.error(`${logPrefix} run.claimPending error:`, error);
  }

  // 2. Poll suspended stages → resume if ready
  try {
    const pollResult = await kernel.dispatch({
      type: "stage.pollSuspended",
      maxChecks: maxSuspendedChecksPerTick,
    });
    suspendedChecked = pollResult.checked;
    for (const workflowRunId of pollResult.resumedWorkflowRunIds) {
      await kernel.dispatch({
        type: "run.transition",
        workflowRunId,
      });
    }
  } catch (error) {
    console.error(`${logPrefix} stage.pollSuspended error:`, error);
  }

  // 3. Reap stale leases → release crashed worker locks
  try {
    const reapResult = await kernel.dispatch({
      type: "lease.reapStale",
      staleThresholdMs: staleLeaseThresholdMs,
    });
    staleReleased = reapResult.released;
  } catch (error) {
    console.error(`${logPrefix} lease.reapStale error:`, error);
  }

  // 4. Flush outbox → publish pending events through EventSink
  try {
    const flushResult = await kernel.dispatch({
      type: "outbox.flush",
      maxEvents: maxOutboxFlushPerTick,
    });
    eventsFlushed = flushResult.published;
  } catch (error) {
    console.error(`${logPrefix} outbox.flush error:`, error);
  }

  // 5. Reap stuck runs → fail runs with no activity past threshold
  try {
    const reapStuckResult = await kernel.dispatch({
      type: "run.reapStuck",
      stuckThresholdMs: HOST_DEFAULTS.computeStuckThresholdMs(
        staleLeaseThresholdMs,
      ),
    });
    stuckReaped = reapStuckResult.failed;
  } catch (error) {
    console.error(`${logPrefix} run.reapStuck error:`, error);
  }

  return {
    claimed,
    suspendedChecked,
    staleReleased,
    eventsFlushed,
    stuckReaped,
  };
}
