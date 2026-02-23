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

import type { JobTransport, Kernel } from "@bratsos/workflow-engine/kernel";

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

  /** Stale lease threshold in milliseconds (default: 60_000). */
  staleLeaseThresholdMs?: number;

  /** Max pending runs to claim per orchestration tick (default: 10). */
  maxClaimsPerTick?: number;

  /** Max suspended stages to check per tick (default: 10). */
  maxSuspendedChecksPerTick?: number;

  /** Max outbox events to flush per tick (default: 100). */
  maxOutboxFlushPerTick?: number;
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

  private readonly kernel: Kernel;
  private readonly jobTransport: JobTransport;
  private readonly workerId: string;
  private readonly orchestrationIntervalMs: number;
  private readonly jobPollIntervalMs: number;
  private readonly staleLeaseThresholdMs: number;
  private readonly maxClaimsPerTick: number;
  private readonly maxSuspendedChecksPerTick: number;
  private readonly maxOutboxFlushPerTick: number;

  constructor(config: NodeHostConfig) {
    this.kernel = config.kernel;
    this.jobTransport = config.jobTransport;
    this.workerId = config.workerId;
    this.orchestrationIntervalMs = config.orchestrationIntervalMs ?? 10_000;
    this.jobPollIntervalMs = config.jobPollIntervalMs ?? 1_000;
    this.staleLeaseThresholdMs = config.staleLeaseThresholdMs ?? 60_000;
    this.maxClaimsPerTick = config.maxClaimsPerTick ?? 10;
    this.maxSuspendedChecksPerTick = config.maxSuspendedChecksPerTick ?? 10;
    this.maxOutboxFlushPerTick = config.maxOutboxFlushPerTick ?? 100;
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
    void this.processJobs();

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
    try {
      this.orchestrationTicks++;

      // 1. Claim pending runs → enqueue first-stage jobs
      await this.kernel.dispatch({
        type: "run.claimPending",
        workerId: this.workerId,
        maxClaims: this.maxClaimsPerTick,
      });

      // 2. Poll suspended stages → resume if ready
      const pollResult = await this.kernel.dispatch({
        type: "stage.pollSuspended",
        maxChecks: this.maxSuspendedChecksPerTick,
      });
      for (const workflowRunId of pollResult.resumedWorkflowRunIds) {
        await this.kernel.dispatch({
          type: "run.transition",
          workflowRunId,
        });
      }

      // 3. Reap stale leases → release crashed worker locks
      await this.kernel.dispatch({
        type: "lease.reapStale",
        staleThresholdMs: this.staleLeaseThresholdMs,
      });

      // 4. Flush outbox → publish pending events through EventSink
      await this.kernel.dispatch({
        type: "outbox.flush",
        maxEvents: this.maxOutboxFlushPerTick,
      });
    } catch (error) {
      // Orchestration errors are non-fatal — the next tick will retry
      console.error("[NodeHost] Orchestration tick error:", error);
    }
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

        const config =
          (job.payload as { config?: Record<string, unknown> }).config || {};

        const result = await this.kernel.dispatch({
          type: "job.execute",
          idempotencyKey: `job:${job.jobId}:attempt:${job.attempt}`,
          workflowRunId: job.workflowRunId,
          workflowId: job.workflowId,
          stageId: job.stageId,
          config,
        });

        this.jobsProcessed++;

        if (result.outcome === "completed") {
          await this.jobTransport.complete(job.jobId);
          await this.kernel.dispatch({
            type: "run.transition",
            workflowRunId: job.workflowRunId,
          });
        } else if (result.outcome === "suspended") {
          const nextPollAt = result.nextPollAt ?? new Date(Date.now() + 60_000);
          await this.jobTransport.suspend(job.jobId, nextPollAt);
        } else if (result.outcome === "failed") {
          const canRetry = job.attempt < (job.maxAttempts ?? 3);
          await this.jobTransport.fail(
            job.jobId,
            result.error ?? "Unknown error",
            canRetry,
          );
        }
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

// ============================================================================
// Factory
// ============================================================================

export function createNodeHost(config: NodeHostConfig): NodeHost {
  return new NodeHostImpl(config);
}
