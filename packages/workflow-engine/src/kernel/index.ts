/**
 * Kernel API - Public Entry Point
 *
 * Pure command kernel for workflow orchestration.
 * Environment-agnostic: no timers, no process signals, no global singletons.
 */

// Command types
export type {
  CommandResult,
  JobExecuteCommand,
  JobExecuteResult,
  KernelCommand,
  KernelCommandType,
  LeaseReapStaleCommand,
  LeaseReapStaleResult,
  OutboxFlushCommand,
  OutboxFlushResult,
  PluginReplayDLQCommand,
  PluginReplayDLQResult,
  RunCancelCommand,
  RunCancelResult,
  RunClaimPendingCommand,
  RunClaimPendingResult,
  RunCreateCommand,
  RunCreateResult,
  RunRerunFromCommand,
  RunRerunFromResult,
  RunTransitionCommand,
  RunTransitionResult,
  StagePollSuspendedCommand,
  StagePollSuspendedResult,
} from "./commands.js";
// Kernel errors
export { IdempotencyInProgressError } from "./errors.js";

// Event types
export type {
  KernelEvent,
  KernelEventType,
  StageCompletedEvent,
  StageFailedEvent,
  StageProgressEvent,
  StageStartedEvent,
  StageSuspendedEvent,
  WorkflowCancelledEvent,
  WorkflowCompletedEvent,
  WorkflowCreatedEvent,
  WorkflowFailedEvent,
  WorkflowStartedEvent,
  WorkflowSuspendedEvent,
} from "./events.js";
// Kernel helpers
export { loadWorkflowContext, saveStageOutput } from "./helpers/index.js";
// Kernel factory and core interfaces
export {
  createKernel,
  type Kernel,
  type KernelConfig,
  type WorkflowRegistry,
} from "./kernel.js";
// Plugin system
export {
  createPluginRunner,
  definePlugin,
  type PluginDefinition,
  type PluginRunner,
  type PluginRunnerConfig,
} from "./plugins.js";
// Port interfaces
export type {
  BlobStore,
  Clock,
  CreateOutboxEventInput,
  EventSink,
  IdempotencyRecord,
  JobTransport,
  OutboxRecord,
  Persistence,
  Scheduler,
} from "./ports.js";
