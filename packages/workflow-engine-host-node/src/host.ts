/**
 * Node Host for Workflow Engine Command Kernel
 *
 * Wraps the environment-agnostic kernel with Node.js process loops,
 * signal handling, and job processing. The host dispatches kernel
 * commands on intervals and manages the job dequeue/execute cycle.
 *
 * The kernel remains unaware of process state — all timers, signals,
 * and loop pacing live here.
 */

import {
  createEventSinkMonitor,
  type EventSinkHealth,
  type EventSinkMonitor,
  executeJobWithHeartbeat,
  HOST_DEFAULTS,
  type JobTransport,
  type Kernel,
  runMaintenanceTick as runMaintenanceTickCommands,
  toEventSinkObservation,
} from "@bratsos/workflow-engine/kernel";

// ============================================================================
// Public interfaces
// ============================================================================

export interface NodeHostConfig {
  /** Kernel instance to dispatch commands to. */
  kernel: Kernel;

  /** Job transport for dequeue/complete/suspend/fail. */
  jobTransport: JobTransport;

  /** Unique worker identifier. */
  workerId: string;

  /** Orchestration poll interval in milliseconds (default: 10_000). */
  orchestrationIntervalMs?: number;

  /** Job dequeue poll interval when queue is empty (default: 1_000). */
  jobPollIntervalMs?: number;

  /**
   * Upper bound (ms) on the randomised pause this worker takes after
   * completing a job, before asking for the next one (default:
   * `jobPollIntervalMs`). The actual pause is uniform in
   * `[0, postJobYieldMs)`.
   *
   * Why it exists: the host that completes a job is the one that
   * dispatches `run.transition`, so it enqueues the next stage of that
   * run in-process and would otherwise be back at `dequeue()` microseconds
   * later while every other worker is still parked in its
   * `jobPollIntervalMs` timer. It won the stage it had just created
   * essentially every time, and a sequential pipeline ran end-to-end on
   * one worker no matter how many were alive. Pausing for a uniform draw
   * over the same window gives this worker the same phase every other
   * worker has, so the next stage goes to whichever asks first.
   *
   * It costs latency only while the worker is following a run it just
   * advanced: the pause is skipped as soon as the loop sees work from
   * another run (a backlog), and resumes when the queue next runs dry.
   *
   * Set to `0` to disable it entirely and restore the pre-0.4.4 behaviour
   * (lowest latency for a single-worker deployment; a multi-worker one
   * goes back to pinning each run to one worker).
   */
  postJobYieldMs?: number;

  /** Stale lease threshold in milliseconds (default: 300_000). */
  staleLeaseThresholdMs?: number;

  /** Max pending runs to claim per orchestration tick (default: 10). */
  maxClaimsPerTick?: number;

  /** Max suspended stages to check per tick (default: 10). */
  maxSuspendedChecksPerTick?: number;

  /** Max outbox events to flush per tick (default: 100). */
  maxOutboxFlushPerTick?: number;

  /** Job lease heartbeat interval in milliseconds (default: 60_000). */
  jobHeartbeatIntervalMs?: number;

  /**
   * Upper bound (ms) on `stop()`: how long to wait for the in-flight job
   * to finish, and separately for the final `outbox.flush`, before giving
   * up on each (default: 10_000). Errors are logged, never thrown.
   */
  shutdownTimeoutMs?: number;

  /** Run a final `outbox.flush` in `stop()` (default: true). */
  flushOutboxOnStop?: boolean;
}

export interface HostStats {
  workerId: string;
  jobsProcessed: number;
  orchestrationTicks: number;
  isRunning: boolean;
  uptimeMs: number;
  /**
   * State of the event sink as of this host's last outbox flush. A
   * `"degraded"` sink does not stall runs — the poller advances them and
   * events stay committed in the outbox — but it is worth alerting on
   * before `deadLettered` starts climbing.
   */
  eventSink: EventSinkHealth;
}

export interface NodeHost {
  start(): Promise<void>;
  stop(): Promise<void>;
  getStats(): HostStats;
}

// ============================================================================
// Implementation
// ============================================================================

class NodeHostImpl implements NodeHost {
  private running = false;
  private jobsProcessed = 0;
  private orchestrationTicks = 0;
  private startTime = 0;
  private orchestrationTimer: ReturnType<typeof setInterval> | null = null;
  private signalHandlers: { signal: string; handler: () => void }[] = [];
  private jobLoop: Promise<void> | null = null;
  /** The orchestration tick currently running, if any. */
  private tickInFlight: Promise<void> | null = null;

  private readonly kernel: Kernel;
  private readonly jobTransport: JobTransport;
  private readonly workerId: string;
  private readonly orchestrationIntervalMs: number;
  private readonly jobPollIntervalMs: number;
  private readonly postJobYieldMs: number;
  private readonly staleLeaseThresholdMs: number;
  private readonly maxClaimsPerTick: number;
  private readonly maxSuspendedChecksPerTick: number;
  private readonly maxOutboxFlushPerTick: number;
  private readonly jobHeartbeatIntervalMs: number;
  private readonly shutdownTimeoutMs: number;
  private readonly flushOutboxOnStop: boolean;
  private readonly eventSinkMonitor: EventSinkMonitor;

  constructor(config: NodeHostConfig) {
    this.kernel = config.kernel;
    this.jobTransport = config.jobTransport;
    this.workerId = config.workerId;
    this.orchestrationIntervalMs = config.orchestrationIntervalMs ?? 10_000;
    this.jobPollIntervalMs = config.jobPollIntervalMs ?? 1_000;
    this.postJobYieldMs = config.postJobYieldMs ?? this.jobPollIntervalMs;
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
    this.shutdownTimeoutMs = config.shutdownTimeoutMs ?? 10_000;
    this.flushOutboxOnStop = config.flushOutboxOnStop ?? true;
    this.eventSinkMonitor = createEventSinkMonitor({ logPrefix: "[NodeHost]" });
  }

  // --------------------------------------------------------------------------
  // Lifecycle
  // --------------------------------------------------------------------------

  async start(): Promise<void> {
    if (this.running) return;

    this.running = true;
    this.startTime = Date.now();

    // Hand this host's id to the job transport, so `job_queue.workerId`
    // names the same worker `run.claimPending` does. A transport built
    // with its own explicit `workerId` keeps it and reports it back —
    // then say so once, rather than silently labelling every job row with
    // an id that does not match any host.
    const transportWorkerId = this.jobTransport.adoptWorkerId?.(this.workerId);
    if (
      transportWorkerId !== undefined &&
      transportWorkerId !== this.workerId
    ) {
      console.error(
        `[NodeHost] workerId mismatch: this host is "${this.workerId}" but its job transport stamps "${transportWorkerId}" on the jobs it claims. ` +
          "Drop the workerId option from the transport (e.g. createPrismaJobQueue(prisma)) to let the host supply it.",
      );
    }

    // Start orchestration timer
    this.orchestrationTimer = setInterval(
      () => this.startOrchestrationTick(),
      this.orchestrationIntervalMs,
    );

    // Immediate first tick
    this.startOrchestrationTick();

    // Start job processing loop (runs until stop())
    this.jobLoop = this.processJobs();

    // Signal handlers — use wrapper functions so we can remove them on stop
    const onSignal = () => void this.stop();
    this.signalHandlers = [
      { signal: "SIGTERM", handler: onSignal },
      { signal: "SIGINT", handler: onSignal },
    ];
    for (const { signal, handler } of this.signalHandlers) {
      process.once(signal as NodeJS.Signals, handler);
    }
  }

  async stop(): Promise<void> {
    if (!this.running) return;

    this.running = false;

    if (this.orchestrationTimer) {
      clearInterval(this.orchestrationTimer);
      this.orchestrationTimer = null;
    }

    // Remove signal handlers to avoid leaks
    for (const { signal, handler } of this.signalHandlers) {
      process.removeListener(signal, handler);
    }
    this.signalHandlers = [];

    // Let the tick and the job in flight finish (each bounded) so their
    // completion events are in the outbox, then publish them from this
    // process. Without the flush, `workflow:completed` for a run this
    // process finished sits in the outbox until whichever process ticks
    // next. A tick cut short here leaves its claimed suspended stages on
    // their poll lease; the next poller picks them up when it elapses.
    if (this.tickInFlight) {
      await withTimeout(this.tickInFlight, this.shutdownTimeoutMs);
    }
    if (this.jobLoop) {
      await withTimeout(this.jobLoop, this.shutdownTimeoutMs);
      this.jobLoop = null;
    }
    if (this.flushOutboxOnStop) {
      await this.flushOutbox();
    }
  }

  /** Publish pending outbox events, bounded by `shutdownTimeoutMs`. */
  private async flushOutbox(): Promise<void> {
    const deadline = Date.now() + this.shutdownTimeoutMs;
    try {
      // Drain in pages until a page comes back short or the deadline passes.
      for (;;) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
          console.error(
            "[NodeHost] outbox.flush on stop(): timed out before the outbox was empty",
          );
          return;
        }
        const flushed = await withTimeout(
          this.kernel.dispatch({
            type: "outbox.flush",
            maxEvents: this.maxOutboxFlushPerTick,
          }),
          remaining,
        );
        if (flushed === undefined) {
          console.error(
            "[NodeHost] outbox.flush on stop(): timed out before the outbox was empty",
          );
          return;
        }
        this.eventSinkMonitor.observe(toEventSinkObservation(flushed));
        if (flushed.published < this.maxOutboxFlushPerTick) return;
      }
    } catch (error) {
      console.error("[NodeHost] outbox.flush on stop() error:", error);
      this.eventSinkMonitor.observeError(error);
    }
  }

  getStats(): HostStats {
    return {
      workerId: this.workerId,
      jobsProcessed: this.jobsProcessed,
      orchestrationTicks: this.orchestrationTicks,
      isRunning: this.running,
      uptimeMs: this.running ? Date.now() - this.startTime : 0,
      eventSink: this.eventSinkMonitor.report(),
    };
  }

  // --------------------------------------------------------------------------
  // Orchestration timer
  // --------------------------------------------------------------------------

  /**
   * Runs a tick unless one is still in flight, in which case this firing
   * is skipped (not queued): a replay that outlasts the interval must not
   * overlap the next tick in the same process. `orchestrationTicks` counts
   * only ticks that ran.
   */
  private startOrchestrationTick(): void {
    if (this.tickInFlight) return;
    this.tickInFlight = this.orchestrationTick()
      .catch((error) => {
        console.error("[NodeHost] orchestration tick error:", error);
      })
      .finally(() => {
        this.tickInFlight = null;
      });
  }

  private async orchestrationTick(): Promise<void> {
    this.orchestrationTicks++;

    // Claim pending runs, poll suspended stages, reap stale leases, flush
    // the outbox, and reap stuck runs. The Node host fires this on a timer
    // and doesn't need the per-command counts (unlike the serverless host,
    // which returns them to its caller) — see runMaintenanceTick in
    // @bratsos/workflow-engine/kernel for the shared command sequence.
    const counts = await runMaintenanceTickCommands(this.kernel, {
      workerId: this.workerId,
      maxClaimsPerTick: this.maxClaimsPerTick,
      maxSuspendedChecksPerTick: this.maxSuspendedChecksPerTick,
      maxOutboxFlushPerTick: this.maxOutboxFlushPerTick,
      staleLeaseThresholdMs: this.staleLeaseThresholdMs,
      logPrefix: "[NodeHost]",
    });
    this.eventSinkMonitor.observe({
      failed: counts.eventsFailed,
      deadLettered: counts.eventsDeadLettered,
      eventSinkStatus: counts.eventSinkStatus,
      ...(counts.eventSinkError !== undefined
        ? { eventSinkError: counts.eventSinkError }
        : {}),
    });
  }

  // --------------------------------------------------------------------------
  // Job processing loop
  // --------------------------------------------------------------------------

  private async processJobs(): Promise<void> {
    // Run of the job this loop completed last, and whether the queue has
    // since handed it work from a different run. Together they separate
    // "I am following the run I just advanced" (yield, so another worker
    // gets a fair shot at the stage this process enqueued) from "I am
    // draining a backlog" (don't — the queue has work of its own and the
    // pause would be pure latency). Both reset when the queue runs dry.
    let lastRunId: string | null = null;
    let drainingBacklog = false;

    while (this.running) {
      try {
        const job = await this.jobTransport.dequeue();

        if (!job) {
          lastRunId = null;
          drainingBacklog = false;
          await this.sleep(this.jobPollIntervalMs);
          continue;
        }

        if (lastRunId !== null && job.workflowRunId !== lastRunId) {
          drainingBacklog = true;
        }

        // Dispatch job.execute under a lease heartbeat and route the
        // outcome (complete/suspend/fail + terminal run.transition) — see
        // executeJobWithHeartbeat in @bratsos/workflow-engine/kernel for
        // the shared command sequence.
        const outcome = await executeJobWithHeartbeat(this.kernel, {
          jobTransport: this.jobTransport,
          job,
          jobHeartbeatIntervalMs: this.jobHeartbeatIntervalMs,
          logPrefix: "[NodeHost]",
        });

        this.jobsProcessed++;
        lastRunId = job.workflowRunId;

        // Only a completed job enqueues its successor from this process
        // (a retry re-queues itself with backoff, a suspension waits on a
        // poll deadline, a terminal failure enqueues nothing), so that is
        // the only outcome worth yielding after.
        if (
          outcome.outcome === "completed" &&
          !drainingBacklog &&
          this.postJobYieldMs > 0
        ) {
          await this.sleep(Math.random() * this.postJobYieldMs);
        }
      } catch (error) {
        // Job processing errors are non-fatal — back off and retry
        console.error("[NodeHost] Job processing error:", error);
        lastRunId = null;
        drainingBacklog = false;
        await this.sleep(5_000);
      }
    }
  }

  // --------------------------------------------------------------------------
  // Helpers
  // --------------------------------------------------------------------------

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

/** Resolve with the promise's value, or `undefined` once `ms` elapses. */
function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

// ============================================================================
// Factory
// ============================================================================

export function createNodeHost(config: NodeHostConfig): NodeHost {
  return new NodeHostImpl(config);
}
