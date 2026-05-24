/**
 * Kernel Event Types
 *
 * Discriminated union of all events emitted by the workflow kernel.
 * Each event carries a string literal `type` discriminant, a `timestamp`,
 * and a `workflowRunId` that scopes the event to a specific run.
 *
 * This file contains ONLY types -- no runtime code.
 */

// ---------------------------------------------------------------------------
// Workflow-level events
// ---------------------------------------------------------------------------

/** Emitted when a new workflow run record is created. */
export interface WorkflowCreatedEvent {
  readonly type: "workflow:created";
  readonly timestamp: Date;
  readonly workflowRunId: string;
  readonly workflowId: string;
}

/** Emitted when a workflow run begins execution. */
export interface WorkflowStartedEvent {
  readonly type: "workflow:started";
  readonly timestamp: Date;
  readonly workflowRunId: string;
}

/** Emitted when a workflow run finishes successfully. */
export interface WorkflowCompletedEvent {
  readonly type: "workflow:completed";
  readonly timestamp: Date;
  readonly workflowRunId: string;
  readonly duration?: number;
  readonly totalCost?: number;
  readonly totalTokens?: number;
  readonly output?: unknown;
}

/** Emitted when a workflow run terminates due to an unrecoverable error. */
export interface WorkflowFailedEvent {
  readonly type: "workflow:failed";
  readonly timestamp: Date;
  readonly workflowRunId: string;
  readonly error: string;
}

/** Emitted when a workflow run is cancelled by an external request. */
export interface WorkflowCancelledEvent {
  readonly type: "workflow:cancelled";
  readonly timestamp: Date;
  readonly workflowRunId: string;
  readonly reason?: string;
}

/** Emitted when a workflow run suspends, waiting on an external signal. */
export interface WorkflowSuspendedEvent {
  readonly type: "workflow:suspended";
  readonly timestamp: Date;
  readonly workflowRunId: string;
  readonly stageId: string;
}

// ---------------------------------------------------------------------------
// Stage-level events
// ---------------------------------------------------------------------------

/** Emitted when a stage begins execution. */
export interface StageStartedEvent {
  readonly type: "stage:started";
  readonly timestamp: Date;
  readonly workflowRunId: string;
  readonly stageId: string;
  readonly stageName: string;
  readonly stageNumber: number;
}

/** Emitted when a stage completes successfully. */
export interface StageCompletedEvent {
  readonly type: "stage:completed";
  readonly timestamp: Date;
  readonly workflowRunId: string;
  readonly stageId: string;
  readonly stageName: string;
  readonly duration: number;
}

/** Emitted when a stage suspends, awaiting a future poll. */
export interface StageSuspendedEvent {
  readonly type: "stage:suspended";
  readonly timestamp: Date;
  readonly workflowRunId: string;
  readonly stageId: string;
  readonly stageName: string;
  readonly nextPollAt: Date;
}

/** Emitted when a stage fails with an error. */
export interface StageFailedEvent {
  readonly type: "stage:failed";
  readonly timestamp: Date;
  readonly workflowRunId: string;
  readonly stageId: string;
  readonly stageName: string;
  readonly error: string;
}

/** Emitted to report incremental progress within a stage. */
export interface StageProgressEvent {
  readonly type: "stage:progress";
  readonly timestamp: Date;
  readonly workflowRunId: string;
  readonly stageId: string;
  readonly progress: number;
  readonly message: string;
  readonly details?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Annotation events (opt-in)
// ---------------------------------------------------------------------------

/**
 * Emitted when an annotation is written with `emitEvent: true`. Lets
 * plugins and external systems react to provenance writes in real time
 * (audit pipelines, SIEM, live dashboards) without polling
 * `kernel.annotations.list`.
 *
 * Off by default — annotations are primarily a queryable provenance
 * surface, not an event stream. Most consumers won't need this.
 */
export interface AnnotationCreatedEvent {
  readonly type: "annotation:created";
  readonly timestamp: Date;
  readonly workflowRunId: string;
  readonly key: string;
  readonly value: unknown;
  readonly scope: string;
  readonly scopeId?: string;
  readonly attempt?: number;
  readonly actorKind?: string;
  readonly actorId?: string;
  readonly actorVersion?: string;
}

// ---------------------------------------------------------------------------
// Union & helpers
// ---------------------------------------------------------------------------

/** Discriminated union of every kernel event. */
export type KernelEvent =
  | WorkflowCreatedEvent
  | WorkflowStartedEvent
  | WorkflowCompletedEvent
  | WorkflowFailedEvent
  | WorkflowCancelledEvent
  | WorkflowSuspendedEvent
  | StageStartedEvent
  | StageCompletedEvent
  | StageSuspendedEvent
  | StageFailedEvent
  | StageProgressEvent
  | AnnotationCreatedEvent;

/** String literal union of all kernel event type discriminants. */
export type KernelEventType = KernelEvent["type"];
