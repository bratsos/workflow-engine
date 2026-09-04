/**
 * Kernel Command Types
 *
 * Discriminated union of commands accepted by the kernel's dispatch
 * interface, together with a conditional `CommandResult` type that maps
 * each command to its corresponding result.
 *
 * This file contains ONLY types -- no runtime code.
 */

import type { AnnotationActor } from "../persistence/interface";

// ---------------------------------------------------------------------------
// run.create
// ---------------------------------------------------------------------------

/** Annotation to attach at run-creation time. */
export interface RunCreateAnnotation {
  readonly attributes: Record<string, unknown>;
  readonly actor?: AnnotationActor;
  readonly payload?: Record<string, unknown>;
  readonly idempotencyKey?: string;
  /**
   * If true, the engine writes an `annotation:created` outbox event for
   * each attribute in this batch, in the same transaction as the run
   * creation. Off by default.
   */
  readonly emitEvent?: boolean;
}

/** Creates a new workflow run. */
export interface RunCreateCommand {
  readonly type: "run.create";
  readonly idempotencyKey: string;
  readonly workflowId: string;
  readonly input: Record<string, unknown>;
  readonly config?: Record<string, unknown>;
  readonly priority?: number;
  /**
   * Annotations to attach at run creation time. Each entry becomes one
   * row per attribute, sharing the supplied envelope (actor / payload /
   * idempotencyKey). Written inside the same transaction as the run.
   */
  readonly annotations?: ReadonlyArray<RunCreateAnnotation>;
}

/** Result of a `run.create` command. */
export interface RunCreateResult {
  readonly workflowRunId: string;
  readonly status: "PENDING";
}

// ---------------------------------------------------------------------------
// run.claimPending
// ---------------------------------------------------------------------------

/** Claims pending runs and enqueues first-stage jobs. */
export interface RunClaimPendingCommand {
  readonly type: "run.claimPending";
  readonly workerId: string;
  readonly maxClaims?: number;
}

/** Result of a `run.claimPending` command. */
export interface RunClaimPendingResult {
  readonly claimed: ReadonlyArray<{
    readonly workflowRunId: string;
    readonly workflowId: string;
    readonly jobIds: string[];
  }>;
}

// ---------------------------------------------------------------------------
// run.transition
// ---------------------------------------------------------------------------

/** Advances a workflow to the next stage group or completes it. */
export interface RunTransitionCommand {
  readonly type: "run.transition";
  readonly workflowRunId: string;
}

/** Result of a `run.transition` command. */
export interface RunTransitionResult {
  readonly action: "advanced" | "completed" | "failed" | "noop";
  readonly nextGroup?: number;
}

// ---------------------------------------------------------------------------
// run.cancel
// ---------------------------------------------------------------------------

/** Cancels a running workflow. */
export interface RunCancelCommand {
  readonly type: "run.cancel";
  readonly workflowRunId: string;
  readonly reason?: string;
}

/** Result of a `run.cancel` command. */
export interface RunCancelResult {
  readonly cancelled: boolean;
}

// ---------------------------------------------------------------------------
// run.rerunFrom
// ---------------------------------------------------------------------------

/** Reruns a workflow from a specific stage, deleting stages at/after that point. */
export interface RunRerunFromCommand {
  readonly type: "run.rerunFrom";
  readonly workflowRunId: string;
  readonly fromStageId: string;
  /** Optional idempotency key — a replayed call returns the cached result. */
  readonly idempotencyKey?: string;
}

/** Result of a `run.rerunFrom` command. */
export interface RunRerunFromResult {
  readonly workflowRunId: string;
  readonly fromStageId: string;
  readonly deletedStages: string[];
}

// ---------------------------------------------------------------------------
// job.execute
// ---------------------------------------------------------------------------

/** Executes a single stage within a workflow run. */
export interface JobExecuteCommand {
  readonly type: "job.execute";
  readonly idempotencyKey?: string;
  readonly workflowRunId: string;
  readonly workflowId: string;
  readonly stageId: string;
  readonly config: Record<string, unknown>;
  /**
   * The job's attempt number (1 on the first execution, as the transport
   * counts it) and its attempt budget. When both are known the kernel
   * records a retryable stage failure as PENDING — the retry the host is
   * about to enqueue — instead of FAILED, and reports `willRetry`.
   */
  readonly attempt?: number;
  readonly maxAttempts?: number;
}

/** Result of a `job.execute` command. */
export interface JobExecuteResult {
  readonly outcome: "completed" | "suspended" | "failed";
  readonly output?: unknown;
  readonly error?: string;
  readonly nextPollAt?: Date;
  /** True when the job was not executed because the run is not RUNNING. */
  readonly ghost?: boolean;
  /**
   * Only set alongside `ghost`. Distinguishes the two reasons a job can
   * find its run not RUNNING:
   *  - `"orphan"` — the run is CANCELLED/COMPLETED/FAILED, or was made so
   *    mid-execution. The job is meaningless and must be thrown away.
   *  - `"race"` — the run is still PENDING, i.e. its claim had not
   *    committed when this job was dequeued. The job is valid and simply
   *    arrived early: it must be re-delivered, not discarded, or the run
   *    wedges RUNNING with no job until `run.reapStuck` sweeps it up.
   */
  readonly ghostReason?: "orphan" | "race";
  /**
   * False marks a deterministic failure (e.g. Zod input/config validation)
   * that will not succeed on retry — hosts should fail the job terminally.
   * `undefined`/`true` preserves default retry behavior.
   */
  readonly retryable?: boolean;
  /**
   * True when the failure was recorded as a pending retry (stage left
   * PENDING with the error on `errorMessage`) because the command carried
   * `attempt`/`maxAttempts` with attempts remaining and the error was not
   * deterministic. The host must re-enqueue the job
   * (`jobTransport.fail(jobId, error, true)`).
   */
  readonly willRetry?: boolean;
  /** The job attempt that ran, echoed from the command when it carried one. */
  readonly attempt?: number;
  /** The attempt budget the retry decision used, when the command carried one. */
  readonly maxAttempts?: number;
}

// ---------------------------------------------------------------------------
// stage.pollSuspended
// ---------------------------------------------------------------------------

/** Polls suspended stages to check if they can be resumed. */
export interface StagePollSuspendedCommand {
  readonly type: "stage.pollSuspended";
  readonly maxChecks?: number;
}

/** Result of a `stage.pollSuspended` command. */
export interface StagePollSuspendedResult {
  readonly checked: number;
  readonly resumed: number;
  readonly failed: number;
  readonly resumedWorkflowRunIds: string[];
}

// ---------------------------------------------------------------------------
// step.signal
// ---------------------------------------------------------------------------

/** Completes a durable signal step and nudges its stage for replay. */
export interface StepSignalCommand {
  readonly type: "step.signal";
  readonly workflowRunId: string;
  readonly stageId: string;
  readonly stepId: string;
  readonly payload: unknown;
}

export interface StepSignalResult {
  readonly signalled: boolean;
  readonly ok: true;
  readonly alreadyCompleted: boolean;
}

// ---------------------------------------------------------------------------
// lease.reapStale
// ---------------------------------------------------------------------------

/** Releases stale job leases that have exceeded the threshold. */
export interface LeaseReapStaleCommand {
  readonly type: "lease.reapStale";
  readonly staleThresholdMs: number;
  /**
   * Absolute cap (ms) on how long one claim may hold its lease, measured
   * from `startedAt` and therefore unaffected by heartbeating. Jobs past it
   * are failed terminally with the `LEASE_ABSOLUTE_CAP` reason. Omit, or
   * pass 0, to run the heartbeat tier alone (the pre-1.0.0-alpha.9
   * behaviour). Ignored by a transport with no `expireRunawayJobs`.
   */
  readonly absoluteTimeoutMs?: number;
}

/** Result of a `lease.reapStale` command. */
export interface LeaseReapStaleResult {
  /** Jobs the heartbeat tier requeued for another worker. */
  readonly released: number;
  /** Jobs the absolute tier failed as runaways. */
  readonly expired: number;
}

// ---------------------------------------------------------------------------
// outbox.flush
// ---------------------------------------------------------------------------

/** Publishes pending outbox events through EventSink. */
export interface OutboxFlushCommand {
  readonly type: "outbox.flush";
  readonly maxEvents?: number;
}

/**
 * Health of the event sink as of the last flush.
 *
 * `"degraded"` is the named state for "the sink is refusing events": the
 * run keeps progressing (the poller, not the sink, is what advances a
 * run), events stay committed in the outbox, and delivery is retried on
 * the next flush. It is not an error — it is a state a host reports so it
 * is visible *before* the dead-letter queue fills.
 */
export type EventSinkStatus = "healthy" | "degraded";

/** Result of an `outbox.flush` command. */
export interface OutboxFlushResult {
  readonly published: number;
  /**
   * Events this flush claimed but could not publish. They were released
   * (their `publishedAt` cleared) and the next flush retries them, so this
   * is a delivery-lag signal, not data loss.
   */
  readonly failed: number;
  /**
   * Events this flush moved to the dead-letter queue because their retry
   * budget ran out. These no longer retry on their own: replay them with
   * `plugin.replayDLQ`.
   */
  readonly deadLettered: number;
  /** `"degraded"` when at least one event could not be published. */
  readonly eventSinkStatus: EventSinkStatus;
  /** Message of the first publish failure of this flush, when degraded. */
  readonly eventSinkError?: string;
}

// ---------------------------------------------------------------------------
// plugin.replayDLQ
// ---------------------------------------------------------------------------

/** Replays DLQ outbox events for reprocessing. */
export interface PluginReplayDLQCommand {
  readonly type: "plugin.replayDLQ";
  readonly maxEvents?: number;
}

/** Result of a `plugin.replayDLQ` command. */
export interface PluginReplayDLQResult {
  readonly replayed: number;
}

// ---------------------------------------------------------------------------
// run.reapStuck
// ---------------------------------------------------------------------------

/** Detects and handles RUNNING runs with no recent activity. */
export interface RunReapStuckCommand {
  readonly type: "run.reapStuck";
  readonly stuckThresholdMs: number;
}

/** Result of a `run.reapStuck` command. */
export interface RunReapStuckResult {
  readonly transitioned: number;
  readonly failed: number;
  /**
   * Wedged runs resolved by the dropped-transition heal: every stage was
   * terminal while the run still said RUNNING, and firing the missing
   * run.transition resolved the run instead of reaping finished work.
   */
  readonly healed: number;
}

// ---------------------------------------------------------------------------
// Union & conditional result mapping
// ---------------------------------------------------------------------------

/** Discriminated union of every kernel command. */
export type KernelCommand =
  | RunCreateCommand
  | RunClaimPendingCommand
  | RunTransitionCommand
  | RunCancelCommand
  | RunRerunFromCommand
  | JobExecuteCommand
  | StagePollSuspendedCommand
  | StepSignalCommand
  | LeaseReapStaleCommand
  | OutboxFlushCommand
  | PluginReplayDLQCommand
  | RunReapStuckCommand;

/** String literal union of all kernel command type discriminants. */
export type KernelCommandType = KernelCommand["type"];

/** Maps a `KernelCommand` to its corresponding result type. */
export type CommandResult<T extends KernelCommand> = T extends RunCreateCommand
  ? RunCreateResult
  : T extends RunClaimPendingCommand
    ? RunClaimPendingResult
    : T extends RunTransitionCommand
      ? RunTransitionResult
      : T extends RunCancelCommand
        ? RunCancelResult
        : T extends RunRerunFromCommand
          ? RunRerunFromResult
          : T extends JobExecuteCommand
            ? JobExecuteResult
            : T extends StagePollSuspendedCommand
              ? StagePollSuspendedResult
              : T extends StepSignalCommand
                ? StepSignalResult
                : T extends LeaseReapStaleCommand
                  ? LeaseReapStaleResult
                  : T extends OutboxFlushCommand
                    ? OutboxFlushResult
                    : T extends PluginReplayDLQCommand
                      ? PluginReplayDLQResult
                      : T extends RunReapStuckCommand
                        ? RunReapStuckResult
                        : never;
