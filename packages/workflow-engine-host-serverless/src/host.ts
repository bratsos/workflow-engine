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
  assertTimerMs,
  type EventSinkStatus,
  executeJobWithHeartbeat,
  flushOutboxWithin,
  HOST_DEFAULTS,
  type JobTransport,
  type Kernel,
  type MaintenanceTickHook,
  type RetentionOptions,
  runMaintenanceTick as runMaintenanceTickCommands,
  runTickHook,
  type ServedDefinition,
  toErrorMessage,
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

  /** Absolute cap (ms) on one job claim (default: HOST_DEFAULTS.jobAbsoluteTimeoutMs). */
  jobAbsoluteTimeoutMs?: number;

  /** Max pending runs to claim per maintenance tick (default: 10). */
  maxClaimsPerTick?: number;

  /**
   * Which definition versions this host may adopt and poll. Forwarded to
   * `run.claimPending` and `stage.pollSuspended`.
   *
   * Left unset — the right default — the kernel derives it from the
   * registry: a registry built with `createWorkflowRegistry` claims only
   * runs this build can execute, which is what makes a rolling deploy safe.
   * Pass `"all"` to claim and poll regardless of version (the pre-1.0
   * behaviour), or an explicit list to run maintenance on behalf of
   * another build.
   */
  serves?: readonly ServedDefinition[] | "all";

  /** Max suspended stages to check per tick (default: 10). */
  maxSuspendedChecksPerTick?: number;

  /** Max outbox events to flush per tick (default: 100). */
  maxOutboxFlushPerTick?: number;

  /**
   * Delete finished runs older than `retention.olderThanMs` (with their
   * stages, logs, artifacts, annotations, step ledger, job rows and blobs)
   * through `run.purge` at the end of every maintenance tick. Off by
   * default: nothing is deleted unless this is set.
   */
  retention?: RetentionOptions;

  /**
   * Called at the end of every `runMaintenanceTick()` with a copy of the
   * counts it computed (changing it affects nothing the method returns), before
   * the method returns them. Use it to export gauges or counters (combine it
   * with the `engine.stats` command for queue depth and age).
   *
   * A hook that throws or rejects is caught and logged; the tick still
   * returns its counts. The hook is awaited for at most `onTickTimeoutMs`:
   * after that the counts are returned, one warning is logged and the hook
   * keeps running in the background (an invocation that ends may cut it off).
   */
  onTick?: MaintenanceTickHook;

  /**
   * Publish this job's outbox events right after `handleJob` settles it
   * (default: true). There is no process lifecycle to hook a final flush
   * on, so without this a run completed by this invocation is announced by
   * whichever invocation runs the next maintenance tick. Bounded by
   * `outboxFlushTimeoutMs`; errors are logged, never thrown.
   */
  flushOutboxAfterJob?: boolean;

  /**
   * Upper bound (ms) on post-job and maintenance outbox flushes (default: 5_000). Must be a number from 1 to 2147483647 (a timer honours nothing else); anything else throws a `RangeError` from `createServerlessHost`. Nothing
   * switches the bound off: pass 2147483647 to wait for practically any flush.
   */
  outboxFlushTimeoutMs?: number;

  /**
   * Upper bound (ms) on how long `runMaintenanceTick()` waits for `onTick`
   * (default: 5_000, the same as `outboxFlushTimeoutMs`: both bound optional
   * work this host awaits after its own commands have finished, inside an
   * invocation that has a time limit). A hook that never settles then costs
   * one bounded wait per tick and never withholds the counts. Must be a
   * number from 1 to 2147483647 (the longest delay a timer honours, about 24.8
   * days); anything else, `Infinity`, `NaN`, zero or a negative number
   * included, throws a `RangeError` from `createServerlessHost`. Nothing
   * switches the bound off: pass 2147483647 to wait for practically any hook.
   */
  onTickTimeoutMs?: number;

  /**
   * Job lease heartbeat interval in milliseconds (default: 60_000). Must be a number from 1 to 2147483647 (a timer honours nothing else); anything else throws a `RangeError` from `createServerlessHost`.
   */
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
  /** Outbox delivery waits for the caller transaction to commit. */
  outboxDeferred?: true;
  stuckReaped: number;
  /** Terminal runs deleted by `run.purge`; 0 unless `retention` is configured. */
  purged: number;
  /** Events claimed but not published this tick; the next flush retries them. */
  eventsFailed: number;
  /** Events that exhausted their retry budget and moved to the DLQ. */
  eventsDeadLettered: number;
  /**
   * `"degraded"` when the event sink refused at least one event this tick.
   * There is no process to carry the state across invocations, so a
   * serverless caller reports this per tick (and alerts on a run of them);
   * runs keep progressing either way.
   */
  eventSinkStatus: EventSinkStatus;
  /** First publish failure of this tick, when degraded. */
  eventSinkError?: string;
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
  private readonly jobAbsoluteTimeoutMs: number;
  private readonly maxClaimsPerTick: number;
  /** See `HostConfig.serves`; `undefined` means "derive from the registry". */
  private readonly serves: readonly ServedDefinition[] | "all" | undefined;
  private readonly maxSuspendedChecksPerTick: number;
  private readonly maxOutboxFlushPerTick: number;
  private readonly retention: RetentionOptions | undefined;
  private readonly onTick: MaintenanceTickHook | undefined;
  private readonly jobHeartbeatIntervalMs: number;
  private readonly flushOutboxAfterJob: boolean;
  private readonly outboxFlushTimeoutMs: number;
  private readonly onTickTimeoutMs: number;

  constructor(config: ServerlessHostConfig) {
    this.kernel = config.kernel;
    this.jobTransport = config.jobTransport;
    this.workerId = config.workerId;
    this.staleLeaseThresholdMs =
      config.staleLeaseThresholdMs ?? HOST_DEFAULTS.staleLeaseThresholdMs;
    this.jobAbsoluteTimeoutMs =
      config.jobAbsoluteTimeoutMs ?? HOST_DEFAULTS.jobAbsoluteTimeoutMs;
    this.maxClaimsPerTick =
      config.maxClaimsPerTick ?? HOST_DEFAULTS.maxClaimsPerTick;
    this.serves = config.serves;
    this.maxSuspendedChecksPerTick =
      config.maxSuspendedChecksPerTick ??
      HOST_DEFAULTS.maxSuspendedChecksPerTick;
    this.maxOutboxFlushPerTick =
      config.maxOutboxFlushPerTick ?? HOST_DEFAULTS.maxOutboxFlushPerTick;
    this.retention = config.retention;
    if (config.onTick !== undefined && typeof config.onTick !== "function") {
      throw new TypeError(
        `onTick must be a function, got ${toErrorMessage(config.onTick)}.`,
      );
    }
    this.onTick = config.onTick;
    this.jobHeartbeatIntervalMs = assertTimerMs(
      "jobHeartbeatIntervalMs",
      config.jobHeartbeatIntervalMs ?? HOST_DEFAULTS.jobHeartbeatIntervalMs,
    );
    this.flushOutboxAfterJob = config.flushOutboxAfterJob ?? true;
    this.outboxFlushTimeoutMs = assertTimerMs(
      "outboxFlushTimeoutMs",
      config.outboxFlushTimeoutMs ?? 5_000,
      {
        hint: "The bound cannot be switched off; pass 2147483647 (about 24.8 days) to wait for practically any flush.",
      },
    );
    this.onTickTimeoutMs = assertTimerMs(
      "onTickTimeoutMs",
      config.onTickTimeoutMs ?? 5_000,
      {
        hint: "The bound cannot be switched off, because a hook that never settles would then withhold the counts; pass 2147483647 (about 24.8 days) to wait for practically any hook.",
      },
    );
  }

  /**
   * There is no `start()` here, so every call of an entry point (`handleJob`,
   * `processAvailableJobs`, `runMaintenanceTick`) checks that the storage may
   * be used before it dispatches anything, and throws if not (a SQLite file
   * another Prisma major wrote: `SqliteDateStorageError`; a check that could
   * not be made: `SqliteDateStorageUnverifiedError`), instead of every command
   * logging it. Nothing is remembered here: the adapter remembers a conclusive
   * pass itself (one statement per client), and asks again after a check that
   * failed or saw an empty file.
   */
  private async ready(): Promise<void> {
    await this.jobTransport.verifyStorage?.();
  }

  async handleJob(msg: JobMessage): Promise<JobResult> {
    await this.ready();
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
    try {
      const outcome = await flushOutboxWithin(
        this.kernel,
        this.maxOutboxFlushPerTick,
        this.outboxFlushTimeoutMs,
      );
      if (outcome === undefined) {
        console.error(
          "[ServerlessHost] outbox.flush after job timed out. Pending events remain for a later flush.",
        );
      } else if (outcome.eventSinkStatus === "degraded") {
        // Stateless: no transition to detect, so say it every time.
        console.error(
          `[ServerlessHost] event sink DEGRADED: ${outcome.failed} event(s) stayed in the outbox for a later flush; runs keep progressing. Last error: ${
            outcome.eventSinkError ?? "unknown"
          }`,
        );
      }
      if (outcome && outcome.deadLettered > 0) {
        console.error(
          `[ServerlessHost] event sink DEAD-LETTERED ${outcome.deadLettered} event(s): they will not be delivered until replayed with the plugin.replayDLQ command`,
        );
      }
    } catch (error) {
      console.error("[ServerlessHost] outbox.flush after job error:", error);
    }
  }

  async processAvailableJobs(opts?: {
    maxJobs?: number;
  }): Promise<ProcessJobsResult> {
    await this.ready();
    const maxJobs = opts?.maxJobs ?? 1;
    let processed = 0;
    let succeeded = 0;
    let failed = 0;

    while (processed < maxJobs) {
      const serves = this.dequeueServes();
      const job = await this.jobTransport.dequeue(
        serves !== undefined ? { serves } : undefined,
      );
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

  /**
   * What to pass to `jobTransport.dequeue`. `"all"` means claim regardless
   * of version, which is expressed by passing nothing; otherwise the
   * kernel's registry answers, so the dequeue narrows on exactly what
   * `run.claimPending` narrows on.
   */
  private dequeueServes(): readonly ServedDefinition[] | undefined {
    if (this.serves === "all") return undefined;
    return this.serves ?? this.kernel.servedDefinitions?.();
  }

  async runMaintenanceTick(): Promise<MaintenanceTickResult> {
    await this.ready();
    // Claim pending runs, poll suspended stages, reap stale leases, flush
    // the outbox, and reap stuck runs — see runMaintenanceTick in
    // @bratsos/workflow-engine/kernel for the shared command sequence. The
    // serverless host returns the per-command counts to its caller (unlike
    // the Node host, which fires this on a timer and ignores them).
    const counts = await runMaintenanceTickCommands(this.kernel, {
      workerId: this.workerId,
      maxClaimsPerTick: this.maxClaimsPerTick,
      ...(this.serves !== undefined ? { serves: this.serves } : {}),
      maxSuspendedChecksPerTick: this.maxSuspendedChecksPerTick,
      maxOutboxFlushPerTick: this.maxOutboxFlushPerTick,
      outboxFlushTimeoutMs: this.outboxFlushTimeoutMs,
      staleLeaseThresholdMs: this.staleLeaseThresholdMs,
      jobAbsoluteTimeoutMs: this.jobAbsoluteTimeoutMs,
      ...(this.retention !== undefined ? { retention: this.retention } : {}),
      logPrefix: "[ServerlessHost]",
    });
    if (counts.eventSinkStatus === "degraded") {
      console.error(
        `[ServerlessHost] event sink DEGRADED: ${counts.eventsFailed} event(s) stayed in the outbox for a later flush; runs keep progressing. Last error: ${
          counts.eventSinkError ?? "unknown"
        }`,
      );
    }
    if (counts.eventsDeadLettered > 0) {
      console.error(
        `[ServerlessHost] event sink DEAD-LETTERED ${counts.eventsDeadLettered} event(s): they will not be delivered until replayed with the plugin.replayDLQ command`,
      );
    }
    await runTickHook(
      this.onTick,
      counts,
      "[ServerlessHost]",
      this.onTickTimeoutMs,
    );
    return counts;
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
