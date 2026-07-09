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

import {
  executeJobWithHeartbeat,
  HOST_DEFAULTS,
  type JobTransport,
  type Kernel,
  runMaintenanceTick as runMaintenanceTickCommands,
} from "@bratsos/workflow-engine/kernel";

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
    this.staleLeaseThresholdMs =
      config.staleLeaseThresholdMs ?? HOST_DEFAULTS.staleLeaseThresholdMs;
    this.maxClaimsPerTick =
      config.maxClaimsPerTick ?? HOST_DEFAULTS.maxClaimsPerTick;
    this.maxSuspendedChecksPerTick =
      config.maxSuspendedChecksPerTick ??
      HOST_DEFAULTS.maxSuspendedChecksPerTick;
    this.maxOutboxFlushPerTick =
      config.maxOutboxFlushPerTick ?? HOST_DEFAULTS.maxOutboxFlushPerTick;
    this.jobHeartbeatIntervalMs =
      config.jobHeartbeatIntervalMs ?? HOST_DEFAULTS.jobHeartbeatIntervalMs;
  }

  async handleJob(msg: JobMessage): Promise<JobResult> {
    // Dispatch job.execute under a lease heartbeat and route the outcome
    // (complete/suspend/fail + terminal run.transition) — see
    // executeJobWithHeartbeat in @bratsos/workflow-engine/kernel for the
    // shared command sequence.
    return executeJobWithHeartbeat(this.kernel, {
      jobTransport: this.jobTransport,
      job: msg,
      jobHeartbeatIntervalMs: this.jobHeartbeatIntervalMs,
      logPrefix: "[ServerlessHost]",
    });
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
    // Claim pending runs, poll suspended stages, reap stale leases, flush
    // the outbox, and reap stuck runs — see runMaintenanceTick in
    // @bratsos/workflow-engine/kernel for the shared command sequence. The
    // serverless host returns the per-command counts to its caller (unlike
    // the Node host, which fires this on a timer and ignores them).
    return runMaintenanceTickCommands(this.kernel, {
      workerId: this.workerId,
      maxClaimsPerTick: this.maxClaimsPerTick,
      maxSuspendedChecksPerTick: this.maxSuspendedChecksPerTick,
      maxOutboxFlushPerTick: this.maxOutboxFlushPerTick,
      staleLeaseThresholdMs: this.staleLeaseThresholdMs,
      logPrefix: "[ServerlessHost]",
    });
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
