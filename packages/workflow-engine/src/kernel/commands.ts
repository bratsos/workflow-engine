/**
 * Kernel Command Types
 *
 * Discriminated union of commands accepted by the kernel's dispatch
 * interface, together with a conditional `CommandResult` type that maps
 * each command to its corresponding result.
 *
 * This file contains ONLY types -- no runtime code.
 */

import type {
  AnnotationActor,
  ServedDefinition,
} from "../persistence/interface";

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
  /**
   * The definition version the run is pinned to, or `null` on a database
   * whose schema predates definition versioning.
   */
  readonly definitionVersion: string | null;
}

// ---------------------------------------------------------------------------
// run.claimPending
// ---------------------------------------------------------------------------

/** Claims pending runs and enqueues first-stage jobs. */
export interface RunClaimPendingCommand {
  readonly type: "run.claimPending";
  readonly workerId: string;
  readonly maxClaims?: number;
  /**
   * Which definition versions this claim may adopt.
   *
   * Left unset, the kernel derives it from the registry's optional
   * `listWorkflows()` — so a registry built with `createWorkflowRegistry`
   * claims only runs this build can correctly execute, and a registry
   * without enumeration claims anything, as before versioning existed.
   *
   * Pass `"all"` to claim regardless of version (the pre-1.0 behaviour),
   * or an explicit list to claim on behalf of another build.
   *
   * Runs created before the consumer migrated carry no version and are
   * always claimable.
   */
  readonly serves?: readonly ServedDefinition[] | "all";
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
   *  - `"version"` — the run is pinned to a definition version this build
   *    does not serve. The job is valid but belongs to another build: it
   *    must be re-delivered so a process running that definition executes
   *    it. `run.listVersions` reports these runs; `run.redrive` with
   *    `definitionVersion: "latest"` moves them onto the current build.
   */
  readonly ghostReason?: "orphan" | "race" | "version";
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
// run.listVersions
// ---------------------------------------------------------------------------

/**
 * Answers "has this definition version drained?" — the query DBOS's
 * workflow listing gives operators, so an old build can be retired
 * knowingly rather than hopefully.
 */
export interface RunListVersionsCommand {
  readonly type: "run.listVersions";
  /** Restrict to one workflow. */
  readonly workflowId?: string;
  /** Restrict to one definition version. */
  readonly definitionVersion?: string;
}

/** Per-version run accounting. */
export interface DefinitionVersionSummary {
  readonly workflowId: string;
  /** `null` for runs created before the consumer migrated. */
  readonly definitionVersion: string | null;
  /** Run count per status. */
  readonly counts: Readonly<Record<string, number>>;
  /** Runs at this version in any status. */
  readonly total: number;
  /** PENDING + RUNNING + SUSPENDED — the runs still needing a host. */
  readonly active: number;
  /** True when nothing at this version still needs a host. */
  readonly drained: boolean;
  /**
   * Whether this process's registry currently serves this version.
   * `false` with `active > 0` is the state to act on: those runs have no
   * host here, and either a peer on the old build must finish them or
   * `run.redrive` must move them forward.
   */
  readonly servedHere: boolean;
  /** Creation time of the oldest run at this version, in any status. */
  readonly oldestCreatedAt: Date | null;
}

/** Result of a `run.listVersions` command. */
export interface RunListVersionsResult {
  /**
   * False on a database whose schema predates definition versioning; the
   * `versions` array is then empty rather than misleading.
   */
  readonly supported: boolean;
  /** Newest-first by `oldestCreatedAt`, unpinned runs last. */
  readonly versions: readonly DefinitionVersionSummary[];
  /**
   * Versions with active runs that this process does not serve — the
   * runs that would otherwise sit pending with nobody to execute them.
   */
  readonly unservedHere: readonly DefinitionVersionSummary[];
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
  | RunListVersionsCommand
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
          : T extends RunListVersionsCommand
            ? RunListVersionsResult
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
