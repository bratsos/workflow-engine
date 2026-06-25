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
  RunCreateAnnotation,
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
// Executor implementations
export { createLocalExecutor } from "./executor/local-executor.js";
export {
  createRoutingExecutor,
  type RoutingExecutorOptions,
} from "./executor/routing-executor.js";
// Kernel helpers
export { loadWorkflowContext, saveStageOutput } from "./helpers/index.js";
// Kernel factory and core interfaces
export {
  type AnnotateAttachInput,
  createKernel,
  type Kernel,
  type KernelAnnotations,
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
// Port interfaces and annotation types
export type {
  ActivityExecutor,
  ActivityRunInput,
  ActivityRunResult,
  AnnotationActor,
  AnnotationFilters,
  AnnotationScope,
  BlobStore,
  BufferedLog,
  Clock,
  CreateAnnotationInput,
  CreateOutboxEventInput,
  EventSink,
  ExecutorDeps,
  IdempotencyRecord,
  JobTransport,
  OutboxRecord,
  Persistence,
  Scheduler,
  WorkflowAnnotationRecord,
} from "./ports.js";
