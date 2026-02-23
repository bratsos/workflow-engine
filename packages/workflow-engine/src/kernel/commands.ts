/**
 * Kernel Command Types
 *
 * Discriminated union of commands accepted by the kernel's dispatch
 * interface, together with a conditional `CommandResult` type that maps
 * each command to its corresponding result.
 *
 * This file contains ONLY types -- no runtime code.
 */

// ---------------------------------------------------------------------------
// run.create
// ---------------------------------------------------------------------------

/** Creates a new workflow run. */
export interface RunCreateCommand {
  readonly type: "run.create";
  readonly idempotencyKey: string;
  readonly workflowId: string;
  readonly input: Record<string, unknown>;
  readonly config?: Record<string, unknown>;
  readonly priority?: number;
  readonly metadata?: Record<string, unknown>;
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
}

/** Result of a `job.execute` command. */
export interface JobExecuteResult {
  readonly outcome: "completed" | "suspended" | "failed";
  readonly output?: unknown;
  readonly error?: string;
  readonly nextPollAt?: Date;
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
// lease.reapStale
// ---------------------------------------------------------------------------

/** Releases stale job leases that have exceeded the threshold. */
export interface LeaseReapStaleCommand {
  readonly type: "lease.reapStale";
  readonly staleThresholdMs: number;
}

/** Result of a `lease.reapStale` command. */
export interface LeaseReapStaleResult {
  readonly released: number;
}

// ---------------------------------------------------------------------------
// outbox.flush
// ---------------------------------------------------------------------------

/** Publishes pending outbox events through EventSink. */
export interface OutboxFlushCommand {
  readonly type: "outbox.flush";
  readonly maxEvents?: number;
}

/** Result of an `outbox.flush` command. */
export interface OutboxFlushResult {
  readonly published: number;
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
  | LeaseReapStaleCommand
  | OutboxFlushCommand
  | PluginReplayDLQCommand;

/** String literal union of all kernel command type discriminants. */
export type KernelCommandType = KernelCommand["type"];

/** Maps a `KernelCommand` to its corresponding result type. */
export type CommandResult<T extends KernelCommand> =
  T extends RunCreateCommand ? RunCreateResult :
  T extends RunClaimPendingCommand ? RunClaimPendingResult :
  T extends RunTransitionCommand ? RunTransitionResult :
  T extends RunCancelCommand ? RunCancelResult :
  T extends RunRerunFromCommand ? RunRerunFromResult :
  T extends JobExecuteCommand ? JobExecuteResult :
  T extends StagePollSuspendedCommand ? StagePollSuspendedResult :
  T extends LeaseReapStaleCommand ? LeaseReapStaleResult :
  T extends OutboxFlushCommand ? OutboxFlushResult :
  T extends PluginReplayDLQCommand ? PluginReplayDLQResult :
  never;
