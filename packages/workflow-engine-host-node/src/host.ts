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
  executeJobWithHeartbeat,
  HOST_DEFAULTS,
  type JobTransport,
  type Kernel,
  runMaintenanceTick as runMaintenanceTickCommands,
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

  private readonly kernel: Kernel;
  private readonly jobTransport: JobTransport;
  private readonly workerId: string;
  private readonly orchestrationIntervalMs: number;
  private readonly jobPollIntervalMs: number;
  private readonly staleLeaseThresholdMs: number;
  private readonly maxClaimsPerTick: number;
  private readonly maxSuspendedChecksPerTick: number;
  private readonly maxOutboxFlushPerTick: number;
  private readonly jobHeartbeatIntervalMs: number;
  private readonly shutdownTimeoutMs: number;
  private readonly flushOutboxOnStop: boolean;

  constructor(config: NodeHostConfig) {
    this.kernel = config.kernel;
    this.jobTransport = config.jobTransport;
    this.workerId = config.workerId;
    this.orchestrationIntervalMs = config.orchestrationIntervalMs ?? 10_000;
    this.jobPollIntervalMs = config.jobPollIntervalMs ?? 1_000;
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
  }

  // --------------------------------------------------------------------------
  // Lifecycle
  // --------------------------------------------------------------------------

  async start(): Promise<void> {
    if (this.running) return;

    this.running = true;
    this.startTime = Date.now();

    // Start orchestration timer
    this.orchestrationTimer = setInterval(
      () => void this.orchestrationTick(),
      this.orchestrationIntervalMs,
    );

    // Immediate first tick
    void this.orchestrationTick();

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

    // Let the job in flight finish (bounded) so its completion events are
    // in the outbox, then publish them from this process. Without the
    // flush, `workflow:completed` for a run this process finished sits in
    // the outbox until whichever process ticks next.
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
        if (flushed.published < this.maxOutboxFlushPerTick) return;
      }
    } catch (error) {
      console.error("[NodeHost] outbox.flush on stop() error:", error);
    }
  }

  getStats(): HostStats {
    return {
      workerId: this.workerId,
      jobsProcessed: this.jobsProcessed,
      orchestrationTicks: this.orchestrationTicks,
      isRunning: this.running,
      uptimeMs: this.running ? Date.now() - this.startTime : 0,
    };
  }

  // --------------------------------------------------------------------------
  // Orchestration timer
  // --------------------------------------------------------------------------

  private async orchestrationTick(): Promise<void> {
    this.orchestrationTicks++;

    // Claim pending runs, poll suspended stages, reap stale leases, flush
    // the outbox, and reap stuck runs. The Node host fires this on a timer
    // and doesn't need the per-command counts (unlike the serverless host,
    // which returns them to its caller) — see runMaintenanceTick in
    // @bratsos/workflow-engine/kernel for the shared command sequence.
    await runMaintenanceTickCommands(this.kernel, {
      workerId: this.workerId,
      maxClaimsPerTick: this.maxClaimsPerTick,
      maxSuspendedChecksPerTick: this.maxSuspendedChecksPerTick,
      maxOutboxFlushPerTick: this.maxOutboxFlushPerTick,
      staleLeaseThresholdMs: this.staleLeaseThresholdMs,
      logPrefix: "[NodeHost]",
    });
  }

  // --------------------------------------------------------------------------
  // Job processing loop
  // --------------------------------------------------------------------------

  private async processJobs(): Promise<void> {
    while (this.running) {
      try {
        const job = await this.jobTransport.dequeue();

        if (!job) {
          await this.sleep(this.jobPollIntervalMs);
          continue;
        }

        // Dispatch job.execute under a lease heartbeat and route the
        // outcome (complete/suspend/fail + terminal run.transition) — see
        // executeJobWithHeartbeat in @bratsos/workflow-engine/kernel for
        // the shared command sequence.
        await executeJobWithHeartbeat(this.kernel, {
          jobTransport: this.jobTransport,
          job,
          jobHeartbeatIntervalMs: this.jobHeartbeatIntervalMs,
          logPrefix: "[NodeHost]",
        });

        this.jobsProcessed++;
      } catch (error) {
        // Job processing errors are non-fatal — back off and retry
        console.error("[NodeHost] Job processing error:", error);
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
