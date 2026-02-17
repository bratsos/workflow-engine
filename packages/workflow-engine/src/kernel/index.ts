/**
 * Kernel API - Public Entry Point
 *
 * Pure command kernel for workflow orchestration.
 * Environment-agnostic: no timers, no process signals, no global singletons.
 */

// Kernel factory and core interfaces
export {
  createKernel,
  type Kernel,
  type KernelConfig,
  type WorkflowRegistry,
} from "./kernel.js";

// Command types
export type {
  KernelCommand,
  KernelCommandType,
  CommandResult,
  RunCreateCommand,
  RunCreateResult,
  RunClaimPendingCommand,
  RunClaimPendingResult,
  RunTransitionCommand,
  RunTransitionResult,
  RunCancelCommand,
  RunCancelResult,
  JobExecuteCommand,
  JobExecuteResult,
  StagePollSuspendedCommand,
  StagePollSuspendedResult,
  LeaseReapStaleCommand,
  LeaseReapStaleResult,
  OutboxFlushCommand,
  OutboxFlushResult,
  PluginReplayDLQCommand,
  PluginReplayDLQResult,
} from "./commands.js";

// Event types
export type {
  KernelEvent,
  KernelEventType,
  WorkflowCreatedEvent,
  WorkflowStartedEvent,
  WorkflowCompletedEvent,
  WorkflowFailedEvent,
  WorkflowCancelledEvent,
  WorkflowSuspendedEvent,
  StageStartedEvent,
  StageCompletedEvent,
  StageSuspendedEvent,
  StageFailedEvent,
  StageProgressEvent,
} from "./events.js";

// Port interfaces
export type {
  Clock,
  Persistence,
  BlobStore,
  JobTransport,
  EventSink,
  Scheduler,
  OutboxRecord,
  CreateOutboxEventInput,
  IdempotencyRecord,
} from "./ports.js";

// Plugin system
export {
  definePlugin,
  createPluginRunner,
  type PluginDefinition,
  type PluginRunnerConfig,
  type PluginRunner,
} from "./plugins.js";

// Kernel helpers
export { saveStageOutput, loadWorkflowContext } from "./helpers/index.js";
