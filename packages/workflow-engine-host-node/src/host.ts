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
  assertTimerMs,
  createEventSinkMonitor,
  type EventSinkHealth,
  type EventSinkMonitor,
  executeJobWithHeartbeat,
  flushOutboxWithin,
  HOST_DEFAULTS,
  type JobTransport,
  type Kernel,
  type MaintenanceTickCounts,
  type MaintenanceTickHook,
  type RetentionOptions,
  runMaintenanceTick as runMaintenanceTickCommands,
  runTickHook,
  type ServedDefinition,
  toErrorMessage,
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

  /**
   * Orchestration poll interval in milliseconds (default: 10_000). Must be a number from 1 to 2147483647 (a timer honours nothing else); anything else throws a `RangeError` from `createNodeHost`.
   */
  orchestrationIntervalMs?: number;

  /**
   * Job dequeue poll interval when queue is empty (default: 1_000). Must be a number from 1 to 2147483647 (a timer honours nothing else); anything else throws a `RangeError` from `createNodeHost`.
   */
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
   * Must be a number from 0 to 2147483647; anything else throws a
   * `RangeError` from `createNodeHost`.
   *
   * Set to `0` to disable it entirely and restore the pre-0.4.4 behaviour
   * (lowest latency for a single-worker deployment; a multi-worker one
   * goes back to pinning each run to one worker).
   */
  postJobYieldMs?: number;

  /** Stale lease threshold in milliseconds (default: 300_000). */
  staleLeaseThresholdMs?: number;

  /** Absolute cap (ms) on one job claim (default: HOST_DEFAULTS.jobAbsoluteTimeoutMs). */
  jobAbsoluteTimeoutMs?: number;

  /** Max pending runs to claim per orchestration tick (default: 10). */
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
  /** Maximum time a maintenance tick waits for the outbox flush (default: 5,000 ms). */
  outboxFlushTimeoutMs?: number;

  /**
   * Delete finished runs older than `retention.olderThanMs` (with their
   * stages, logs, artifacts, annotations, step ledger, job rows and blobs)
   * through `run.purge` at the end of every maintenance tick. Off by
   * default: nothing is deleted unless this is set.
   */
  retention?: RetentionOptions;

  /**
   * Called after every orchestration tick with a copy of the counts that tick
   * computed (changing it affects nothing else). Use it to export gauges or
   * counters (combine it with the `engine.stats` command for queue depth and
   * age).
   *
   * The hook runs outside the tick: ticks never wait for it, so whatever it
   * does cannot delay claiming, polling, lease reaping or the outbox flush. At
   * most one call is in flight. A tick that finds the previous call still
   * running skips the hook and logs one warning (with how long the call has
   * run) the first time that happens, then calls it again after it settles.
   * The warning is not repeated while the hook stays slower than the interval:
   * it is logged again only after a call has finished without any tick
   * skipping it. A hook that throws or rejects is caught and logged; it never
   * stops the loop.
   *
   * `stop()` waits for a running hook for at most `shutdownTimeoutMs` and no
   * hook starts once it began, so a hook must not await `host.stop()`: the
   * call waits for the hook that is waiting for it until the timeout elapses
   * (a hook may call `void host.stop()`).
   */
  onTick?: MaintenanceTickHook;

  /**
   * Job lease heartbeat interval in milliseconds (default: 60_000). Must be a number from 1 to 2147483647 (a timer honours nothing else); anything else throws a `RangeError` from `createNodeHost`.
   */
  jobHeartbeatIntervalMs?: number;

  /**
   * Upper bound (ms) on `stop()`: how long to wait for the in-flight tick
   * and `onTick` call, then for the in-flight job to finish, and separately
   * for the final `outbox.flush`, before giving up on each (default:
   * 10_000). Errors are logged, never thrown. Must be a number from 1 to
   * 2147483647; anything else throws a `RangeError` from `createNodeHost`,
   * and nothing switches the bound off (pass 2147483647 to wait for
   * practically anything).
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
  /**
   * Ask the host to look for work now instead of at its next timer: it ends
   * the job loop's idle wait (`jobPollIntervalMs`) and runs an orchestration
   * tick at once, whose claimed runs the job loop then picks up. Wire it to
   * whatever learns of new work (a Postgres `LISTEN`, a webhook); the timers
   * remain the fallback when no wake arrives.
   *
   * Calls coalesce. A wake that arrives while a tick or a job pass is running
   * is remembered and exactly one more pass follows it, so a burst of wakes
   * is one extra pass and two passes of a kind never overlap. A job loop that
   * is pausing after a completed job (`postJobYieldMs`) or backing off after
   * an error finishes that pause first. Does nothing before `start()` and
   * after `stop()`.
   */
  wake(): void;
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
  /** A `wake()` came while a tick ran: one more tick follows it. */
  private tickWakePending = false;
  /** A `wake()` came since the job loop's current pass began: its next idle wait is skipped. */
  private jobWakePending = false;
  /** Ends the job loop's idle wait early; set only while the loop is waiting. */
  private endIdleWait: (() => void) | null = null;
  /** `start()` while it is still verifying the storage, so a second call joins it. */
  private starting: Promise<void> | null = null;
  /** Incremented by every stop(), so a start whose storage check settles after it does not begin. */
  private lifecycle = 0;
  /** The `onTick` call currently running, if any. */
  private hookInFlight: Promise<void> | null = null;
  private hookStartedAt = 0;
  /** A tick skipped the hook while the current call ran. */
  private hookSkippedDuringCall = false;
  /**
   * The skip warning was logged and no call has since finished without a
   * tick skipping it: a hook slower than the interval is one episode, however
   * many calls it takes.
   */
  private hookSkipLogged = false;

  private readonly kernel: Kernel;
  private readonly jobTransport: JobTransport;
  private readonly workerId: string;
  private readonly orchestrationIntervalMs: number;
  private readonly jobPollIntervalMs: number;
  private readonly postJobYieldMs: number;
  private readonly staleLeaseThresholdMs: number;
  private readonly jobAbsoluteTimeoutMs: number;
  private readonly maxClaimsPerTick: number;
  /** See `HostConfig.serves`; `undefined` means "derive from the registry". */
  private readonly serves: readonly ServedDefinition[] | "all" | undefined;
  private readonly maxSuspendedChecksPerTick: number;
  private readonly maxOutboxFlushPerTick: number;
  private readonly outboxFlushTimeoutMs: number;
  private readonly retention: RetentionOptions | undefined;
  private readonly onTick: MaintenanceTickHook | undefined;
  private readonly jobHeartbeatIntervalMs: number;
  private readonly shutdownTimeoutMs: number;
  private readonly flushOutboxOnStop: boolean;
  private readonly eventSinkMonitor: EventSinkMonitor;

  constructor(config: NodeHostConfig) {
    this.kernel = config.kernel;
    this.jobTransport = config.jobTransport;
    this.workerId = config.workerId;
    this.orchestrationIntervalMs = assertTimerMs(
      "orchestrationIntervalMs",
      config.orchestrationIntervalMs ?? 10_000,
    );
    this.jobPollIntervalMs = assertTimerMs(
      "jobPollIntervalMs",
      config.jobPollIntervalMs ?? 1_000,
    );
    // `0` turns the pause off (see the option); nothing is then timed.
    this.postJobYieldMs = assertTimerMs(
      "postJobYieldMs",
      config.postJobYieldMs ?? this.jobPollIntervalMs,
      { allowZero: true },
    );
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
    this.outboxFlushTimeoutMs = assertTimerMs(
      "outboxFlushTimeoutMs",
      config.outboxFlushTimeoutMs ?? HOST_DEFAULTS.outboxFlushTimeoutMs,
    );
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
    this.shutdownTimeoutMs = assertTimerMs(
      "shutdownTimeoutMs",
      config.shutdownTimeoutMs ?? 10_000,
      {
        hint: "The bound cannot be switched off; pass 2147483647 (about 24.8 days) to wait for practically anything.",
      },
    );
    this.flushOutboxOnStop = config.flushOutboxOnStop ?? true;
    this.eventSinkMonitor = createEventSinkMonitor({ logPrefix: "[NodeHost]" });
  }

  // --------------------------------------------------------------------------
  // Lifecycle
  // --------------------------------------------------------------------------

  async start(): Promise<void> {
    if (this.running) return;
    if (!this.starting) {
      const starting = this.verifyThenBegin(this.lifecycle).finally(() => {
        if (this.starting === starting) this.starting = null;
      });
      this.starting = starting;
    }
    return this.starting;
  }

  /**
   * A host whose storage refuses to be used fails here, before any timer,
   * loop or signal handler exists, instead of running and logging the same
   * error on every tick: a SQLite file another Prisma major wrote makes
   * `verifyStorage` reject with `SqliteDateStorageError` (a transport with no
   * such check starts as before). A `stop()` while the check is pending
   * cancels the start: when the check settles, nothing is installed and the
   * pending `start()` resolves with the host stopped.
   */
  private async verifyThenBegin(lifecycle: number): Promise<void> {
    await this.jobTransport.verifyStorage?.();
    if (this.running || lifecycle !== this.lifecycle) return;
    this.begin(lifecycle);
  }

  private isCurrent(lifecycle: number): boolean {
    return this.running && lifecycle === this.lifecycle;
  }

  private begin(lifecycle: number): void {
    this.running = true;
    this.startTime = Date.now();
    this.tickWakePending = false;
    this.jobWakePending = false;

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
      () => this.startOrchestrationTick(lifecycle),
      this.orchestrationIntervalMs,
    );

    // Immediate first tick
    if (this.tickInFlight) {
      void this.tickInFlight.then(() => this.startOrchestrationTick(lifecycle));
    } else {
      this.startOrchestrationTick(lifecycle);
    }

    // Start job processing loop (runs until stop())
    // A timed-out dequeue or job can still be settling from the last start.
    // Queue its replacement behind it so we never have two job loops.
    const loop = (this.jobLoop ?? Promise.resolve())
      .then(() => this.processJobs(lifecycle))
      .finally(() => {
        if (this.jobLoop === loop) this.jobLoop = null;
      });
    this.jobLoop = loop;

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
    // Cancels a start() whose storage check is still pending (see verifyThenBegin).
    this.lifecycle++;
    this.starting = null;
    if (!this.running) return;

    this.running = false;
    // A job loop parked in its idle wait leaves now, not after jobPollIntervalMs.
    this.endIdleWait?.();

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
    // their poll lease; the next poller picks them up when it elapses. The
    // `onTick` call in flight shares that bound; none starts after this point.
    const jobLoop = this.jobLoop;
    const winding = [this.tickInFlight, this.hookInFlight].filter(
      (call) => call !== null,
    );
    if (winding.length > 0) {
      await withTimeout(Promise.all(winding), this.shutdownTimeoutMs);
    }
    if (jobLoop) {
      await withTimeout(jobLoop, this.shutdownTimeoutMs);
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
        const flushed = await flushOutboxWithin(
          this.kernel,
          this.maxOutboxFlushPerTick,
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

  wake(): void {
    if (!this.running) return;
    this.wakeJobLoop();
    if (this.tickInFlight) this.tickWakePending = true;
    else this.startOrchestrationTick(this.lifecycle, true);
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
   * only ticks that ran. A tick that `wake()` asked for wakes the job loop
   * when it ends, because its claim may have enqueued the jobs to run; a
   * `wake()` that arrived while it ran starts one more tick.
   */
  private startOrchestrationTick(lifecycle: number, woken = false): void {
    if (this.tickInFlight || !this.isCurrent(lifecycle)) return;
    this.tickInFlight = this.orchestrationTick(lifecycle)
      .catch((error) => {
        console.error("[NodeHost] orchestration tick error:", error);
      })
      .finally(() => {
        this.tickInFlight = null;
        if (!this.isCurrent(lifecycle)) return;
        if (woken) this.wakeJobLoop();
        if (this.tickWakePending) {
          this.tickWakePending = false;
          this.startOrchestrationTick(lifecycle, true);
        }
      });
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

  private async orchestrationTick(lifecycle: number): Promise<void> {
    this.orchestrationTicks++;

    // Claim pending runs, poll suspended stages, reap stale leases, flush
    // the outbox, and reap stuck runs. The Node host fires this on a timer
    // and doesn't need the per-command counts (unlike the serverless host,
    // which returns them to its caller) — see runMaintenanceTick in
    // @bratsos/workflow-engine/kernel for the shared command sequence.
    const host = this;
    const counts = await runMaintenanceTickCommands(this.kernel, {
      outboxFlushSignal: {
        get aborted() {
          return !host.isCurrent(lifecycle);
        },
      },
      workerId: this.workerId,
      maxClaimsPerTick: this.maxClaimsPerTick,
      ...(this.serves !== undefined ? { serves: this.serves } : {}),
      maxSuspendedChecksPerTick: this.maxSuspendedChecksPerTick,
      maxOutboxFlushPerTick: this.maxOutboxFlushPerTick,
      outboxFlushTimeoutMs: this.outboxFlushTimeoutMs,
      staleLeaseThresholdMs: this.staleLeaseThresholdMs,
      jobAbsoluteTimeoutMs: this.jobAbsoluteTimeoutMs,
      ...(this.retention !== undefined ? { retention: this.retention } : {}),
      logPrefix: "[NodeHost]",
    });
    if (!this.isCurrent(lifecycle)) return;
    if (!counts.outboxDeferred) {
      this.eventSinkMonitor.observe({
        failed: counts.eventsFailed,
        deadLettered: counts.eventsDeadLettered,
        eventSinkStatus: counts.eventSinkStatus,
        ...(counts.eventSinkError !== undefined
          ? { eventSinkError: counts.eventSinkError }
          : {}),
      });
    }
    this.startTickHook(counts, lifecycle);
  }

  /**
   * Calls `onTick` without waiting for it, so the hook cannot hold a tick
   * open. One call at a time: a tick that finds the previous call running
   * skips the hook and, the first time in a row, says so. None starts once
   * `stop()` has begun.
   */
  private startTickHook(
    counts: MaintenanceTickCounts,
    lifecycle: number,
  ): void {
    if (!this.onTick || !this.isCurrent(lifecycle)) return;
    if (this.hookInFlight) {
      this.hookSkippedDuringCall = true;
      if (!this.hookSkipLogged) {
        this.hookSkipLogged = true;
        console.warn(
          `[NodeHost] onTick hook is still running after ${Date.now() - this.hookStartedAt} ms and ticks skip it while it runs; this is logged once until a call finishes without being skipped`,
        );
      }
      return;
    }
    this.hookStartedAt = Date.now();
    this.hookSkippedDuringCall = false;
    // Started a microtask later so `hookInFlight` is already set when the hook
    // body first runs: a hook that calls `stop()` is then always waited for.
    const hook = this.onTick;
    this.hookInFlight = Promise.resolve()
      .then(() => {
        if (this.isCurrent(lifecycle))
          return runTickHook(hook, counts, "[NodeHost]");
      })
      .finally(() => {
        this.hookInFlight = null;
        if (!this.hookSkippedDuringCall) this.hookSkipLogged = false;
      });
  }

  // --------------------------------------------------------------------------
  // Job processing loop
  // --------------------------------------------------------------------------

  private async processJobs(lifecycle: number): Promise<void> {
    // Run of the job this loop completed last, and whether the queue has
    // since handed it work from a different run. Together they separate
    // "I am following the run I just advanced" (yield, so another worker
    // gets a fair shot at the stage this process enqueued) from "I am
    // draining a backlog" (don't — the queue has work of its own and the
    // pause would be pure latency). Both reset when the queue runs dry.
    let lastRunId: string | null = null;
    let drainingBacklog = false;

    while (this.isCurrent(lifecycle)) {
      // A wake from here on is for a pass that has not looked yet.
      this.jobWakePending = false;
      try {
        const serves = this.dequeueServes();
        const job = await this.jobTransport.dequeue(
          serves !== undefined ? { serves } : undefined,
        );
        if (!this.isCurrent(lifecycle)) {
          // The dequeue counted an attempt. Give it back instead of leaving
          // the job RUNNING for the reaper, which keeps the attempt.
          if (job) await this.returnUnstartedJob(job);
          return;
        }

        if (!job) {
          lastRunId = null;
          drainingBacklog = false;
          await this.idleWait(this.jobPollIntervalMs);
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

  /**
   * Put a job this stopped loop dequeued but will not run back to PENDING
   * with its attempt refunded (`defer`, fenced on this claim). A transport
   * without `defer` leaves it RUNNING; the stale-lease reaper then releases
   * it with the attempt still counted.
   */
  private async returnUnstartedJob(
    job: NonNullable<Awaited<ReturnType<JobTransport["dequeue"]>>>,
  ): Promise<void> {
    if (!this.jobTransport.defer) return;
    const fence = job.startedAt
      ? { startedAt: job.startedAt, attempt: job.attempt }
      : undefined;
    try {
      // A replacement job loop waits for this one: bound the wait. A defer
      // that commits later is still fenced on this claim.
      const returned = this.jobTransport
        .defer(
          job.jobId,
          new Date(),
          "host stopped before running the job",
          fence,
        )
        .then(() => true);
      if (!(await withTimeout(returned, this.shutdownTimeoutMs))) {
        returned.catch(() => {});
        console.error(
          `[NodeHost] Returning an unstarted job took longer than shutdownTimeoutMs (${this.shutdownTimeoutMs} ms); the job is recovered when its lease expires if the return did not commit.`,
        );
      }
    } catch (error) {
      console.error("[NodeHost] Could not return an unstarted job:", error);
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private wakeJobLoop(): void {
    this.jobWakePending = true;
    this.endIdleWait?.();
  }

  /**
   * The job loop's wait on an empty queue: `ms`, unless a wake came while the
   * loop was busy or comes during the wait, or `stop()` is called.
   */
  private idleWait(ms: number): Promise<void> {
    if (this.jobWakePending) return Promise.resolve();
    return new Promise((resolve) => {
      const end = () => {
        clearTimeout(timer);
        if (this.endIdleWait === end) this.endIdleWait = null;
        resolve();
      };
      const timer = setTimeout(end, ms);
      this.endIdleWait = end;
    });
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
