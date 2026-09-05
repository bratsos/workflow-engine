/**
 * Kernel API - Public Entry Point
 *
 * Pure command kernel for workflow orchestration.
 * Environment-agnostic: no timers, no process signals, no global singletons.
 */

// Command types
export type {
  CommandResult,
  DefinitionVersionSummary,
  EventSinkStatus,
  JobExecuteCommand,
  JobExecuteResult,
  JobHeartbeatCommand,
  JobHeartbeatResult,
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
  RunListVersionsCommand,
  RunListVersionsResult,
  RunPurgeCommand,
  RunPurgeResult,
  RunReapStuckCommand,
  RunReapStuckResult,
  RunRedriveCommand,
  RunRedriveFrom,
  RunRedriveResult,
  RunRerunFromCommand,
  RunRerunFromResult,
  RunTransitionCommand,
  RunTransitionResult,
  StagePollSuspendedCommand,
  StagePollSuspendedResult,
  StepSignalCommand,
  StepSignalResult,
} from "./commands.js";
// Kernel errors
export {
  AIServicesNotConfiguredError,
  DefinitionVersionConflictError,
  DefinitionVersionMismatchError,
  IdempotencyInProgressError,
  SpilledPayloadUnavailableError,
} from "./errors.js";

// Event types
export type {
  AnnotationCreatedEvent,
  KernelEvent,
  KernelEventType,
  StageCompletedEvent,
  StageFailedEvent,
  StageProgressEvent,
  StageStartedEvent,
  StageSuspendedEvent,
  StepSignalledEvent,
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
// Definition pinning helpers, for hosts that resolve definitions themselves.
export { SUPERSEDED_ATTEMPT_KEY } from "./handlers/run-redrive.js";
export {
  assertServesRun,
  recordDefinitionVersion,
  resolvePinnedWorkflow,
  servedDefinitions,
  servesRun,
} from "./helpers/definition-pinning.js";
// Kernel helpers
export {
  type CreateEventSinkMonitorOptions,
  createEventSinkMonitor,
  type EventSinkHealth,
  type EventSinkMonitor,
  type EventSinkObservation,
  type ExecuteJobOutcome,
  type ExecuteJobWithHeartbeatOptions,
  executeJobWithHeartbeat,
  HOST_DEFAULTS,
  type HostJobMessage,
  loadWorkflowContext,
  type MaintenanceTickCounts,
  normalizeAnnotateArgs,
  type RetentionOptions,
  type RunMaintenanceTickOptions,
  runMaintenanceTick,
  saveStageOutput,
  toErrorMessage,
  toEventSinkObservation,
} from "./helpers/index.js";
// Durable-step API constructor for hosts that build a stage context themselves
// (e.g. remote activity workers). Without a ledger every ctx.step.* call throws
// StepLedgerNotConfiguredError, which is the documented behaviour.
export {
  type CreateStepApiOptions,
  createStepApi,
} from "./helpers/step-api";
// Kernel factory and core interfaces
export {
  type AnnotateAttachInput,
  createKernel,
  createWorkflowRegistry,
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
  AIHelperFactory,
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
  KernelServices,
  OutboxRecord,
  Persistence,
  Scheduler,
  ServedDefinition,
  StepLedger,
  StepRecord,
  WorkflowAnnotationRecord,
} from "./ports.js";
// Claim-check spilling for unbounded payloads
export {
  createPayloadSpill,
  createSpillingJobTransport,
  DEFAULT_SPILL_THRESHOLD_BYTES,
  isSpillRef,
  type PayloadSpill,
  type PayloadSpillOptions,
  SPILL_REF_MARKER,
  type SpillingJobTransportOptions,
  type SpillRef,
  stepSpillPrefix,
  withStepResultSpill,
} from "./spill.js";
