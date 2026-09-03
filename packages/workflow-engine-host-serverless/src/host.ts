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

  /**
   * Publish this job's outbox events right after `handleJob` settles it
   * (default: true). There is no process lifecycle to hook a final flush
   * on, so without this a run completed by this invocation is announced by
   * whichever invocation runs the next maintenance tick. Bounded by
   * `outboxFlushTimeoutMs`; errors are logged, never thrown.
   */
  flushOutboxAfterJob?: boolean;

  /** Upper bound (ms) on the post-job outbox flush (default: 5_000). */
  outboxFlushTimeoutMs?: number;

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

/**
 * Outcome of `handleJob`. The consumer's ack/retry decision reads
 * `willRetry`: when true the stage was left `PENDING` and the job must run
 * again — a transport whose `fail()` re-enqueues (the built-in queues) has
 * already done so and the message can be acknowledged; a push transport
 * whose `fail()` cannot (a queue consumer that must `retry()` the message
 * itself) retries the message after `retryDelayMs`. When false the job is
 * settled: acknowledge it.
 */
export interface JobResult {
  outcome: "completed" | "suspended" | "failed";
  error?: string;
  /** The message was an orphan or malformed; it was failed and acknowledged. */
  dead?: boolean;
  willRetry?: boolean;
  /** The job attempt that ran (1 on the first execution). */
  attempt?: number;
  maxAttempts?: number;
  /** Backoff before the retry (`2^attempt` seconds), when `willRetry`. */
  retryDelayMs?: number;
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
  private readonly flushOutboxAfterJob: boolean;
  private readonly outboxFlushTimeoutMs: number;

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
    this.flushOutboxAfterJob = config.flushOutboxAfterJob ?? true;
    this.outboxFlushTimeoutMs = config.outboxFlushTimeoutMs ?? 5_000;
  }

  async handleJob(msg: JobMessage): Promise<JobResult> {
    // Dispatch job.execute under a lease heartbeat and route the outcome
    // (complete/suspend/fail + terminal run.transition) — see
    // executeJobWithHeartbeat in @bratsos/workflow-engine/kernel for the
    // shared command sequence.
    const result = await executeJobWithHeartbeat(this.kernel, {
      jobTransport: this.jobTransport,
      job: msg,
      jobHeartbeatIntervalMs: this.jobHeartbeatIntervalMs,
      logPrefix: "[ServerlessHost]",
    });
    if (this.flushOutboxAfterJob) {
      await this.flushOutbox();
    }
    return result;
  }

  /** Publish pending outbox events, bounded by `outboxFlushTimeoutMs`. */
  private async flushOutbox(): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), this.outboxFlushTimeoutMs);
    });
    try {
      const outcome = await Promise.race([
        this.kernel.dispatch({
          type: "outbox.flush",
          maxEvents: this.maxOutboxFlushPerTick,
        }),
        timeout,
      ]);
      if (outcome === "timeout") {
        console.error(
          "[ServerlessHost] outbox.flush after job: timed out; the next maintenance tick publishes the rest",
        );
      }
    } catch (error) {
      console.error("[ServerlessHost] outbox.flush after job error:", error);
    } finally {
      if (timer) clearTimeout(timer);
    }
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
