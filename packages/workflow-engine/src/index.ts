/**
 * @bratsos/workflow-engine - Main Entry Point
 *
 * Export core workflow components for external use.
 */

// The AI SDK error an adapter should throw so `ctx.step.ai.map` repairs the
// item instead of counting the call against `realtime.retries`.
export { NoObjectGeneratedError } from "ai";
export { NoInputSchema } from "./core/schema-helpers";
export { type Stage } from "./core/stage";
export {
  type AsyncBatchStageDefinition,
  defineStage,
  type EnhancedStageContext,
  type InferInput,
  type InferStageConfig,
  type InferStageInput,
  type InferStageOutput,
  type SimpleStageResult,
  type SyncStageDefinition,
} from "./core/stage-factory";
// Stage ID utilities
export {
  assertValidStageId,
  createStageIds,
  defineStageIds,
  isValidStageId,
  type WorkflowStageId,
} from "./core/stage-ids";

export {
  AiMapBatchFailedError,
  AiMapBudgetExceededError,
  type AiMapResult,
  type AiMapSpec,
  type StepAiApi,
  type StepStreamResult,
} from "./core/step-ai";
export {
  DURABLE_SUSPEND_MARKER,
  isStepControlFlowError,
  type StepApi,
  StepInFlight,
  StepLedgerNotConfiguredError,
  StepLedgerWriteError,
  StepResultNotSerializable,
  type StepRunOptions,
  StepSuspend,
  StepTimeoutError,
  type StepWaitOptions,
} from "./core/steps";
export { type StageResult } from "./core/types";
// Core Workflow
export {
  type BuilderStageDefinition,
  type DefineWorkflowOptions,
  defineWorkflow,
  type InferStageOutputById,
  type InferWorkflowContext,
  type InferWorkflowInput,
  type InferWorkflowOutput,
  type InferWorkflowStageIds,
  ParallelGroupBuilder,
  Workflow,
  WorkflowBuilder,
  type WorkflowOptions,
} from "./core/workflow";

// =============================================================================
// Advanced Exports
// =============================================================================

// AI Helper
export {
  type AdapterEmbedRequest,
  type AdapterEmbedResponse,
  type AdapterObjectRequest,
  type AdapterObjectResponse,
  type AdapterStreamRequest,
  type AdapterStreamResponse,
  type AdapterTextRequest,
  type AdapterTextResponse,
  type AIAdapter,
  // High-level batch types (user-facing API)
  type AIBatch,
  type AIBatchHandle,
  type AIBatchProvider,
  type AIBatchRequest,
  type AIBatchResult,
  AICallTimeoutError,
  type AICallType,
  type AIEmbedResult,
  type AIHelper,
  type AIHelperOptions,
  type AIObjectResult,
  type AIStreamResult,
  type AITextResult,
  type BatchLogFn,
  type BatchOptions,
  type ContentPart,
  createAIHelper,
  type EmbedOptions,
  type LogContext,
  type MediaPart,
  type ObjectOptions,
  type OpenRouterRoutingOptions,
  type ProviderResolver,
  type RecordCallParams,
  registerEmbeddingProvider,
  type StreamOptions,
  type StreamTextInput,
  type TextInput,
  type TextOptions,
  type TextPart,
} from "./ai/ai-helper";
// Batch Engine & OpenRouter Direct Driver
export {
  createOpenRouterBatchModel,
  type EngineBatchItemResult,
  type EngineBatchModel,
  type EngineBatchRef,
  type EngineBatchRequest,
  type EngineBatchStatus,
  fromAiSdk,
  type OpenRouterBatchConfig,
  resolveAiSdkBatchModel,
} from "./ai/batch";
export { BatchSubmitError } from "./ai/batch-helper";
// Model Helper
export {
  AVAILABLE_MODELS,
  calculateCost,
  DEFAULT_MODEL_KEY,
  getModel,
  listModels,
  type ModelConfig,
  type ModelFilter,
  ModelKey,
  type ModelRegistry,
  type ModelStats,
  type ModelSyncConfig,
  registerModels,
} from "./ai/model-helper";
export {
  restorePortableValue,
  type SchemaTarget,
  stripOptionalNulls,
  toPortableJsonSchema,
  UnportableSchemaError,
} from "./ai/schema-portability";
export type {
  AIConfig,
  ConcurrencyConfig,
  DebugConfig,
  FeatureFlagsConfig,
} from "./core/config-presets";
export {
  AIConfigSchema,
  ConcurrencyConfigSchema,
  DebugConfigSchema,
  FeatureFlagsConfigSchema,
  withAIConfig,
  withConcurrency,
  withFeatureFlags,
  withStandardConfig,
} from "./core/config-presets";
// Persistence interfaces and types
export type {
  AICallLogger,
  AICallRecord,
  AIHelperStats,
  ArtifactType,
  CreateAICallInput,
  CreateLogInput,
  CreateRunInput,
  CreateStageInput,
  DequeueResult,
  EnqueueJobInput,
  JobQueue,
  JobRecord,
  LogLevel,
  PersistenceCore,
  SaveArtifactInput,
  // Unified status type (preferred)
  Status,
  UpdateRunInput,
  UpdateStageInput,
  UpsertStageInput,
  WorkflowArtifactRecord,
  WorkflowLogRecord,
  WorkflowPersistence,
  WorkflowRunRecord,
  WorkflowStageRecord,
} from "./persistence";
// Prisma implementations and factories
export {
  createPrismaAICallLogger,
  createPrismaBlobStore,
  createPrismaJobQueue,
  createPrismaStepLedger,
  createPrismaWorkflowPersistence,
  PrismaAICallLogger,
  PrismaBlobStore,
  PrismaJobQueue,
  PrismaStepLedger,
  PrismaWorkflowPersistence,
} from "./persistence";
// Batch Model Mapping
export {
  getBestProviderForModel,
  resolveModelForProvider,
} from "./utils/batch/model-mapping";

// =============================================================================
// Kernel API (Phase 1)
// =============================================================================

// Definition versioning: the structural contract a run is pinned to.
export {
  buildDefinitionSnapshot,
  computeDefinitionVersion,
  DEFINITION_SNAPSHOT_FORMAT,
  DERIVED_VERSION_PREFIX,
  type DefinitionDrift,
  type DefinitionDriftCode,
  type DefinitionSnapshot,
  type DefinitionStageSnapshot,
  diffDefinitionSnapshots,
  hashDefinitionSnapshot,
  isDerivedVersion,
} from "./core/definition-version";
export type {
  CommandResult,
  DefinitionVersionSummary,
  JobExecuteCommand,
  JobExecuteResult,
  KernelCommand,
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
  RunListVersionsCommand,
  RunListVersionsResult,
  RunReapStuckCommand,
  RunReapStuckResult,
  RunRerunFromCommand,
  RunRerunFromResult,
  RunTransitionCommand,
  RunTransitionResult,
  StagePollSuspendedCommand,
  StagePollSuspendedResult,
  StepSignalCommand,
  StepSignalResult,
} from "./kernel/commands";
export {
  AIServicesNotConfiguredError,
  DefinitionVersionConflictError,
  DefinitionVersionMismatchError,
  IdempotencyInProgressError,
} from "./kernel/errors";
export type {
  KernelEvent,
  KernelEventType,
  StepSignalledEvent,
} from "./kernel/events";
export {
  createKernel,
  createWorkflowRegistry,
  type Kernel,
  type KernelConfig,
  type WorkflowRegistry,
} from "./kernel/kernel";
export {
  createPluginRunner,
  definePlugin,
  type PluginDefinition,
  type PluginRunner,
  type PluginRunnerConfig,
} from "./kernel/plugins";
export type {
  AIHelperFactory,
  BlobStore,
  Clock,
  EventSink,
  JobTransport,
  KernelServices,
  Persistence,
  Scheduler,
  StepLedger,
  StepRecord,
} from "./kernel/ports";
export type {
  CreateDefinitionInput,
  CreateOutboxEventInput,
  DefinitionVersionCount,
  DefinitionVersionCountFilter,
  IdempotencyRecord,
  OutboxRecord,
  ServedDefinition,
  WorkflowDefinitionRecord,
} from "./persistence/interface";
export { StaleVersionError } from "./persistence/interface";
