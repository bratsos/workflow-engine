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

import { z } from "zod";
import type { ServedDefinition } from "../../persistence/interface.js";
import type { EventSinkStatus, OutboxFlushResult } from "../commands.js";
import type { Kernel } from "../kernel.js";
import type { JobTransport } from "../ports.js";
import { toErrorMessage } from "./error-message.js";

// ============================================================================
// Shared defaults
// ============================================================================

/** Default tuning knobs shared by every host implementation. */
export const HOST_DEFAULTS = {
  /** Worker id used when a caller does not supply one. */
  workerId: "worker",
  /** `console.error` prefix used when a caller does not supply one. */
  logPrefix: "[Host]",
  /** Stale lease threshold (ms) past which a job's lease is reclaimed. */
  staleLeaseThresholdMs: 300_000,
  /**
   * Absolute cap (ms) on one job claim, measured from the claim itself and
   * so unaffected by heartbeating: twelve times the default stale-lease
   * threshold, i.e. one hour. The heartbeat tier alone cannot recover a
   * worker that is alive but wedged, because such a worker keeps
   * heartbeating; this is the backstop that always fires. A stage that
   * legitimately runs longer than an hour must raise it; 0 disables the
   * tier entirely and restores the heartbeat-only behaviour.
   */
  jobAbsoluteTimeoutMs: 3_600_000,
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
   * Delay (ms) before a job declined for a definition-version mismatch is
   * offered again. A mismatch clears when a deploy finishes, not on the
   * next tick, so re-delivering sooner is pure churn against a database
   * every host in the fleet is polling.
   */
  versionDeferMs: 30_000,
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
  /**
   * The attempt stamp from `DequeueResult`, forwarded as the acknowledgement
   * fence; a transport that cannot carry it (e.g. a JSON push bridge) simply
   * omits it and gets today's unfenced behaviour.
   */
  startedAt?: Date;
}

export interface ExecuteJobWithHeartbeatOptions {
  /** Job transport for touchJob/complete/suspend/fail. */
  jobTransport: JobTransport;
  /** The dequeued job to execute. */
  job: HostJobMessage;
  /**
   * Job lease heartbeat interval in milliseconds. Defaults to
   * `HOST_DEFAULTS.jobHeartbeatIntervalMs`.
   */
  jobHeartbeatIntervalMs?: number;
  /**
   * Prefix for this host's `console.error` diagnostics, e.g. "[NodeHost]".
   * Defaults to `HOST_DEFAULTS.logPrefix`.
   */
  logPrefix?: string;
}

export interface ExecuteJobOutcome {
  outcome: "completed" | "suspended" | "failed";
  error?: string;
  /**
   * The job referred to a run, workflow or stage that no longer exists (an
   * orphan queue row), or the message itself was malformed. It was failed
   * terminally and acknowledged; nothing was executed and no run was
   * transitioned.
   */
  dead?: boolean;
  /**
   * The job must run again — either the stage failed with attempts left
   * and was left `PENDING`, or the job was dequeued ahead of the claim
   * that enqueued it (a still-PENDING run; see `ghostReason: "race"` on
   * `JobExecuteResult`). The built-in transports re-enqueue it
   * themselves from `fail(jobId, error, true)`; a push transport whose
   * `fail()` cannot re-enqueue (a queue consumer that has to `retry()` the
   * message) must retry the message after `retryDelayMs`, and acknowledge
   * it when this is false.
   */
  willRetry?: boolean;
  /** The job attempt that ran (1 on the first execution). */
  attempt?: number;
  /** The attempt budget the retry decision used. */
  maxAttempts?: number;
  /**
   * Backoff before the retry, when `willRetry` is true: the exponential
   * delay the built-in transports apply (`2^attempt` seconds).
   */
  retryDelayMs?: number;
  /**
   * The job was returned to the queue *without* counting an attempt,
   * because this host declined it rather than failing it — today only for
   * a run pinned to a definition version this build does not present.
   * A push-transport consumer should redeliver the message after
   * `retryDelayMs` and must not count it against its own retry budget.
   */
  deferred?: boolean;
}

const DEAD_JOB_PATTERN =
  /^(WorkflowRun .* not found|Workflow .* not found in registry|Stage .* not found in workflow)/;

const JobMessageSchema = z.object({
  jobId: z.string().min(1),
  workflowRunId: z.string().min(1),
  workflowId: z.string().min(1),
  stageId: z.string().min(1),
  attempt: z.number().int().nonnegative(),
  maxAttempts: z.number().int().positive().optional(),
  payload: z.record(z.string(), z.unknown()),
  startedAt: z.date().optional(),
});

/** The backoff the built-in transports apply before redelivering a retry. */
export function retryBackoffMs(attempt: number): number {
  return 2 ** Math.max(0, attempt) * 1000;
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
  const {
    jobTransport,
    job,
    jobHeartbeatIntervalMs = HOST_DEFAULTS.jobHeartbeatIntervalMs,
    logPrefix = HOST_DEFAULTS.logPrefix,
  } = options;

  // A malformed message (a bridge that dropped `payload` or `workflowId`)
  // is a dead job: reject it up front with a clear message instead of
  // throwing from inside job.execute, which a push consumer retries forever.
  const parsed = JobMessageSchema.safeParse(job);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
      .join("; ");
    const message = `Invalid job message: ${issues}`;
    const jobId = typeof job?.jobId === "string" ? job.jobId : undefined;
    console.error(`${logPrefix} dead job ${jobId ?? "<no jobId>"}: ${message}`);
    if (jobId) {
      try {
        await jobTransport.fail(jobId, message, false);
      } catch (failError) {
        console.error(`${logPrefix} could not fail dead job:`, failError);
      }
    }
    return { outcome: "failed", error: message, dead: true };
  }

  const fence = job.startedAt
    ? { startedAt: job.startedAt, attempt: job.attempt }
    : undefined;

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
      // Lets the kernel record a retryable failure as a pending retry
      // (stage PENDING, ledger kept) instead of FAILED.
      attempt: job.attempt,
      maxAttempts: job.maxAttempts ?? HOST_DEFAULTS.maxAttempts,
    });
  } catch (error) {
    // A job whose run / workflow / stage no longer exists is an orphan
    // queue row: fail and acknowledge it so it stops re-delivering, and
    // return instead of throwing — for a consumer that runs a whole tick
    // inside one transaction, a throw here aborted every other job.
    const message = error instanceof Error ? error.message : String(error);
    if (!DEAD_JOB_PATTERN.test(message)) throw error;
    console.error(
      `${logPrefix} dead job ${job.jobId} (run ${job.workflowRunId}, stage ${job.stageId}): ${message}`,
    );
    try {
      // Deliberately unfenced: an orphan queue row should acknowledge unconditionally.
      await jobTransport.fail(job.jobId, message, false);
    } catch (failError) {
      console.error(`${logPrefix} could not fail dead job:`, failError);
    }
    return { outcome: "failed", error: message, dead: true };
  } finally {
    clearInterval(heartbeat);
  }

  if (result.outcome === "completed") {
    const outcome = await jobTransport.complete(job.jobId, fence);
    if (outcome === "superseded") {
      console.warn(
        `${logPrefix} job ${job.jobId} acknowledgement superseded: the lease was rescued and re-claimed while this attempt ran; its result was discarded`,
      );
      return { outcome: "completed" };
    }
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
    const outcome = await jobTransport.suspend(job.jobId, nextPollAt, fence);
    if (outcome === "superseded") {
      console.warn(
        `${logPrefix} job ${job.jobId} acknowledgement superseded: the lease was rescued and re-claimed while this attempt ran; its result was discarded`,
      );
    }
    return { outcome: "suspended" };
  }

  // failed — a ghost job (the kernel did not execute it because it could
  // not run the stage) splits three ways, on `ghostReason`:
  //  - "orphan": the run is CANCELLED/COMPLETED/FAILED. Retrying would
  //    fail identically forever, so the job is failed terminally.
  //  - "race": the run is still PENDING — this job was dequeued before
  //    the claim that enqueued it committed. Nothing else will re-enqueue
  //    it, so discarding it wedges the run RUNNING with no job until
  //    run.reapStuck sweeps it minutes later. Re-deliver it instead (the
  //    built-in transports re-queue it with their usual backoff), while
  //    the attempt budget lasts.
  //  - "version": the run is pinned to a definition version this build
  //    does not serve. The job is valid and belongs to another build, so
  //    it is *deferred*, not failed: put back PENDING with a delay and
  //    with the attempt the dequeue counted given back
  //    (`jobTransport.defer`). Retrying it through `fail(..., true)` like
  //    "race" is wrong here — "race" clears in milliseconds when a claim
  //    commits, while this clears only when a deploy finishes, so the
  //    three-attempt budget was exhausted in about fifteen seconds and
  //    the job row went terminal, leaving recovery to run.reapStuck's
  //    stuck-run threshold minutes later. A transport with no `defer`
  //    falls back to the bounded retry, which is still correct.
  //    This is a backstop: the dequeue itself now filters on `serves`, so
  //    a pull transport rarely hands this host such a job at all.
  // A deterministic (non-retryable) stage error — e.g. Zod input
  // validation — will fail identically on every attempt, so it is
  // treated the same as an exhausted retry budget.
  // The kernel decided from the same attempt/maxAttempts (`willRetry`) and
  // already left the stage PENDING for that case; the transport contract
  // is that `fail(jobId, error, true)` re-enqueues the job with backoff.
  const maxAttempts = job.maxAttempts ?? HOST_DEFAULTS.maxAttempts;
  if (
    result.ghost === true &&
    result.ghostReason === "version" &&
    jobTransport.defer
  ) {
    const error = result.error ?? "definition version not served here";
    const outcome = await jobTransport.defer(
      job.jobId,
      new Date(Date.now() + HOST_DEFAULTS.versionDeferMs),
      error,
      fence,
    );
    if (outcome === "superseded") {
      console.warn(
        `${logPrefix} job ${job.jobId} acknowledgement superseded: the lease was rescued and re-claimed while this attempt ran; its result was discarded`,
      );
    }
    return {
      outcome: "failed",
      error,
      willRetry: true,
      deferred: true,
      attempt: job.attempt,
      maxAttempts,
      retryDelayMs: HOST_DEFAULTS.versionDeferMs,
    };
  }
  const redeliverableGhost =
    result.ghost === true &&
    (result.ghostReason === "race" || result.ghostReason === "version");
  const canRetry = result.ghost
    ? redeliverableGhost && job.attempt < maxAttempts
    : (result.willRetry ??
      (result.retryable !== false && job.attempt < maxAttempts));
  const outcome = await jobTransport.fail(
    job.jobId,
    result.error ?? "Unknown error",
    canRetry,
    fence,
  );
  if (outcome === "superseded") {
    console.warn(
      `${logPrefix} job ${job.jobId} acknowledgement superseded: the lease was rescued and re-claimed while this attempt ran; its result was discarded`,
    );
  }
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
  return {
    outcome: "failed",
    error: result.error,
    willRetry: canRetry,
    attempt: job.attempt,
    maxAttempts,
    ...(canRetry ? { retryDelayMs: retryBackoffMs(job.attempt) } : {}),
  };
}

// ============================================================================
// runMaintenanceTick
// ============================================================================

/**
 * Every field is optional; anything omitted falls back to `HOST_DEFAULTS`,
 * so a caller can pass `{}` (or just the one knob it cares about) and still
 * get the tuning the built-in hosts use.
 */
export interface RunMaintenanceTickOptions {
  /**
   * Unique worker identifier passed to `run.claimPending`. Defaults to
   * `HOST_DEFAULTS.workerId` — pass a distinct id when more than one
   * process runs maintenance.
   */
  workerId?: string;
  /** Defaults to `HOST_DEFAULTS.maxClaimsPerTick`. */
  maxClaimsPerTick?: number;
  /**
   * Which definition versions this host may adopt and poll, forwarded
   * verbatim to `run.claimPending` and `stage.pollSuspended`.
   *
   * Left unset, the kernel derives it from the registry, which is the
   * behaviour you want. Pass `"all"` to claim and poll regardless of
   * version — the pre-1.0 behaviour, and the documented escape hatch for a
   * fleet that is deliberately homogeneous. Pass an explicit list to run
   * maintenance on behalf of another build.
   */
  serves?: readonly ServedDefinition[] | "all";
  /** Defaults to `HOST_DEFAULTS.maxSuspendedChecksPerTick`. */
  maxSuspendedChecksPerTick?: number;
  /** Defaults to `HOST_DEFAULTS.maxOutboxFlushPerTick`. */
  maxOutboxFlushPerTick?: number;
  /** Defaults to `HOST_DEFAULTS.staleLeaseThresholdMs`. */
  staleLeaseThresholdMs?: number;
  /** Defaults to `HOST_DEFAULTS.jobAbsoluteTimeoutMs`. Pass 0 to disable the absolute tier. */
  jobAbsoluteTimeoutMs?: number;
  /**
   * Prefix for this host's `console.error` diagnostics, e.g. "[NodeHost]".
   * Defaults to `HOST_DEFAULTS.logPrefix`.
   */
  logPrefix?: string;
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
  /** Jobs the absolute cap failed as runaways. */
  staleExpired: number;
  eventsFlushed: number;
  stuckReaped: number;
  /**
   * Events the flush claimed but could not publish. They stay committed in
   * the outbox and the next flush retries them.
   */
  eventsFailed: number;
  /** Events the flush moved to the DLQ (retry budget exhausted). */
  eventsDeadLettered: number;
  /**
   * `"degraded"` when the sink refused at least one event this tick. Runs
   * keep progressing regardless — the poller, not the sink, advances a run.
   * A tick whose `outbox.flush` itself threw also reports `"degraded"`.
   */
  eventSinkStatus: EventSinkStatus;
  /** First publish failure of this tick, when degraded. */
  eventSinkError?: string;
}

/**
 * Runs one bounded maintenance pass: claim pending runs, poll suspended
 * stages (transitioning any that resumed), reap stale leases, flush the
 * outbox, and reap stuck runs. Each command's error is caught and logged
 * independently so a failure in one doesn't block the rest of the tick.
 */
export async function runMaintenanceTick(
  kernel: Kernel,
  options: RunMaintenanceTickOptions = {},
): Promise<MaintenanceTickCounts> {
  const {
    workerId = HOST_DEFAULTS.workerId,
    maxClaimsPerTick = HOST_DEFAULTS.maxClaimsPerTick,
    maxSuspendedChecksPerTick = HOST_DEFAULTS.maxSuspendedChecksPerTick,
    maxOutboxFlushPerTick = HOST_DEFAULTS.maxOutboxFlushPerTick,
    staleLeaseThresholdMs = HOST_DEFAULTS.staleLeaseThresholdMs,
    jobAbsoluteTimeoutMs = HOST_DEFAULTS.jobAbsoluteTimeoutMs,
    logPrefix = HOST_DEFAULTS.logPrefix,
    serves,
  } = options;

  let claimed = 0;
  let suspendedChecked = 0;
  let staleReleased = 0;
  let staleExpired = 0;
  let eventsFlushed = 0;
  let stuckReaped = 0;
  let eventsFailed = 0;
  let eventsDeadLettered = 0;
  let eventSinkStatus: EventSinkStatus = "healthy";
  let eventSinkError: string | undefined;

  // 1. Claim pending runs → enqueue first-stage jobs
  try {
    const claimResult = await kernel.dispatch({
      type: "run.claimPending",
      workerId,
      maxClaims: maxClaimsPerTick,
      ...(serves !== undefined ? { serves } : {}),
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
      ...(serves !== undefined ? { serves } : {}),
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
      absoluteTimeoutMs: jobAbsoluteTimeoutMs,
    });
    staleReleased = reapResult.released;
    staleExpired = reapResult.expired;
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
    eventsFailed = flushResult.failed;
    eventsDeadLettered = flushResult.deadLettered;
    eventSinkStatus = flushResult.eventSinkStatus;
    eventSinkError = flushResult.eventSinkError;
  } catch (error) {
    // The flush itself failed (the outbox query, not an individual emit).
    // Nothing was delivered this tick either, so the sink is degraded from
    // an observer's point of view.
    console.error(`${logPrefix} outbox.flush error:`, error);
    eventSinkStatus = "degraded";
    eventSinkError = toErrorMessage(error);
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
    staleExpired,
    eventsFlushed,
    stuckReaped,
    eventsFailed,
    eventsDeadLettered,
    eventSinkStatus,
    ...(eventSinkError !== undefined ? { eventSinkError } : {}),
  };
}

// ============================================================================
// Event-sink health
// ============================================================================

/**
 * The event sink's state as a host reports it.
 *
 * `"degraded"` is the named state for "the sink is refusing events". It is
 * deliberately not an error: an event sink is a *notification* channel, and
 * the committed poller is the truth that advances a run, so a degraded sink
 * costs delivery latency and nothing else. What it must not do is stay
 * invisible until the dead-letter queue fills, which is what this report is
 * for — surface it from wherever the host reports its status, alert on
 * `status === "degraded"` and on `deadLettered` growing.
 */
export interface EventSinkHealth {
  status: EventSinkStatus;
  /**
   * When the current `status` began (epoch ms), or `null` before the first
   * flush this process observed.
   */
  since: number | null;
  /** Consecutive observed flushes that failed to publish at least one event. */
  consecutiveFailures: number;
  /**
   * Events this process has watched exhaust their retry budget and move to
   * the dead-letter queue. These stop retrying on their own — replay them
   * with the `plugin.replayDLQ` command.
   */
  deadLettered: number;
  /** Message of the most recent publish failure, or `null` while healthy. */
  lastError: string | null;
}

/** What `EventSinkMonitor.observe` needs from one flush. */
export interface EventSinkObservation {
  failed: number;
  deadLettered: number;
  eventSinkStatus: EventSinkStatus;
  eventSinkError?: string;
}

/**
 * Tracks event-sink health across flushes for a long-lived host.
 *
 * Logs only on a state *transition* (healthy → degraded and back), so a sink
 * that is down for an hour produces two lines rather than one per tick, and
 * unconditionally whenever events were dead-lettered — that is the point at
 * which delivery genuinely cannot proceed on its own and needs a human or a
 * `plugin.replayDLQ`.
 */
export interface EventSinkMonitor {
  observe(flush: EventSinkObservation): void;
  /** Record that a flush attempt threw outright. */
  observeError(error: unknown): void;
  report(): EventSinkHealth;
}

export interface CreateEventSinkMonitorOptions {
  /** `console.error` prefix, e.g. "[NodeHost]". */
  logPrefix?: string;
  /** Injectable clock for tests. Defaults to `Date.now`. */
  now?: () => number;
  /** Sink for the transition lines. Defaults to `console.error`. */
  log?: (message: string) => void;
}

export function createEventSinkMonitor(
  options: CreateEventSinkMonitorOptions = {},
): EventSinkMonitor {
  const logPrefix = options.logPrefix ?? HOST_DEFAULTS.logPrefix;
  const now = options.now ?? (() => Date.now());
  const log = options.log ?? ((message: string) => console.error(message));

  let status: EventSinkStatus = "healthy";
  let since: number | null = null;
  let consecutiveFailures = 0;
  let deadLettered = 0;
  let lastError: string | null = null;

  function transition(next: EventSinkStatus): void {
    if (next === status && since !== null) return;
    status = next;
    since = now();
    if (next === "degraded") {
      log(
        `${logPrefix} event sink DEGRADED: events are staying in the outbox and will be retried; runs keep progressing through the poller. Last error: ${
          lastError ?? "unknown"
        }`,
      );
    } else if (consecutiveFailures > 0 || lastError !== null) {
      log(`${logPrefix} event sink recovered: publishing again`);
    }
  }

  return {
    observe(flush) {
      if (flush.eventSinkStatus === "degraded") {
        consecutiveFailures++;
        lastError = flush.eventSinkError ?? lastError ?? "unknown";
        transition("degraded");
      } else {
        consecutiveFailures = 0;
        const wasDegraded = status === "degraded";
        transition("healthy");
        if (wasDegraded) lastError = null;
      }
      if (flush.deadLettered > 0) {
        deadLettered += flush.deadLettered;
        // Always loud: a dead-lettered event no longer retries by itself.
        log(
          `${logPrefix} event sink DEAD-LETTERED ${flush.deadLettered} event(s) (${deadLettered} total in this process): they will not be delivered until replayed with the plugin.replayDLQ command`,
        );
      }
    },
    observeError(error) {
      consecutiveFailures++;
      lastError = toErrorMessage(error);
      transition("degraded");
    },
    report() {
      return {
        status,
        since,
        consecutiveFailures,
        deadLettered,
        lastError,
      };
    },
  };
}

/** Narrow an `outbox.flush` result to what the monitor observes. */
export function toEventSinkObservation(
  result: OutboxFlushResult,
): EventSinkObservation {
  return {
    failed: result.failed,
    deadLettered: result.deadLettered,
    eventSinkStatus: result.eventSinkStatus,
    ...(result.eventSinkError !== undefined
      ? { eventSinkError: result.eventSinkError }
      : {}),
  };
}
