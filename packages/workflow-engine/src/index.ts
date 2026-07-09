/**
 * @bratsos/workflow-engine - Main Entry Point
 *
 * Export core workflow components for external use.
 */

export {
  NoInputSchema,
  requireStageOutput,
} from "./core/schema-helpers";
export { type Stage } from "./core/stage";
export {
  type AsyncBatchStageDefinition,
  defineAsyncBatchStage,
  defineStage,
  type EnhancedStageContext,
  type InferInput,
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
export { type StageResult } from "./core/types";
// Core Workflow
export {
  type DefineWorkflowOptions,
  defineWorkflow,
  type InferWorkflowStageIds,
  Workflow,
  WorkflowBuilder,
} from "./core/workflow";

// =============================================================================
// Advanced Exports
// =============================================================================

// AI Helper
export {
  // High-level batch types (user-facing API)
  type AIBatch,
  type AIBatchHandle,
  type AIBatchProvider,
  type AIBatchRequest,
  type AIBatchResult,
  type AICallType,
  type AIEmbedResult,
  type AIHelper,
  type AIObjectResult,
  type AIStreamResult,
  type AITextResult,
  type BatchLogFn,
  createAIHelper,
  type EmbedOptions,
  type LogContext,
  type ObjectOptions,
  type ProviderResolver,
  type RecordCallParams,
  registerEmbeddingProvider,
  type StreamOptions,
  type TextOptions,
} from "./ai/ai-helper";
// Model Helper
export {
  AVAILABLE_MODELS,
  calculateCost,
  DEFAULT_MODEL_KEY,
  /** @deprecated Tests-only. Prefer configuring models via `registerModels()`. Removal at 1.0. */
  getDefaultModel,
  getModel,
  getModelById,
  /** @deprecated Tests-only. Prefer configuring models via `registerModels()`. Removal at 1.0. */
  getRegisteredModel,
  listModels,
  /** @deprecated Tests-only. Prefer configuring models via `registerModels()`. Removal at 1.0. */
  listRegisteredModels,
  type ModelConfig,
  type ModelFilter,
  ModelKey,
  type ModelRegistry,
  type ModelStats,
  /** @deprecated Tests-only. Removal at 1.0. */
  ModelStatsTracker,
  type ModelSyncConfig,
  /** @deprecated Tests-only. Prefer checking `getModel(key)`'s config directly. Removal at 1.0. */
  modelSupportsBatch,
  registerModels,
} from "./ai/model-helper";
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
  // `WorkflowPersistence`'s two focused subsets: `PersistenceCore` (what the
  // kernel actually calls) and `ArtifactPersistence` (deprecated artifact
  // methods -- use BlobStore instead). Re-exported for export-surface
  // consistency with `WorkflowPersistence` below.
  ArtifactPersistence,
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
  createPrismaJobQueue,
  createPrismaWorkflowPersistence,
  PrismaAICallLogger,
  PrismaJobQueue,
  PrismaWorkflowPersistence,
} from "./persistence";
// Batch Model Mapping
export {
  getBestProviderForModel,
  resolveModelForProvider,
} from "./utils/batch/model-mapping";
// Batch Providers
export {
  AnthropicBatchProvider,
  type AnthropicBatchProviderConfig,
  GoogleBatchProvider,
  type GoogleBatchProviderConfig,
  OpenAIBatchProvider,
  type OpenAIBatchProviderConfig,
} from "./utils/batch/providers";

// Batch Types
//
// `BaseBatchRequest`, `BatchLogger`, `BatchState`, `BatchSubmitOptions`, and
// `RawBatchResult` are intentionally NOT re-exported here — they're
// provider-internal plumbing (used by the batch provider implementations
// below and by ./utils/batch/types internally) with no documented public
// surface. `BatchStatus` stays exported because it's the public return type
// of `BatchProvider.checkStatus()`, implemented by the root-exported
// provider classes.
export type {
  AnthropicBatchRequest,
  BatchRequestText,
  BatchRequestWithSchema,
  BatchStatus,
  GoogleBatchRequest,
  OpenAIBatchRequest,
} from "./utils/batch/types";

// =============================================================================
// Kernel API (Phase 1)
// =============================================================================

export type {
  CommandResult,
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
  RunReapStuckCommand,
  RunReapStuckResult,
  RunRerunFromCommand,
  RunRerunFromResult,
  RunTransitionCommand,
  RunTransitionResult,
  StagePollSuspendedCommand,
  StagePollSuspendedResult,
} from "./kernel/commands";
export { IdempotencyInProgressError } from "./kernel/errors";
export type {
  KernelEvent,
  KernelEventType,
} from "./kernel/events";
export { createKernel, type Kernel, type KernelConfig } from "./kernel/kernel";
export {
  createPluginRunner,
  definePlugin,
  type PluginDefinition,
  type PluginRunner,
  type PluginRunnerConfig,
} from "./kernel/plugins";
export type {
  BlobStore,
  Clock,
  EventSink,
  JobTransport,
  Persistence,
  Scheduler,
} from "./kernel/ports";
export type {
  CreateOutboxEventInput,
  IdempotencyRecord,
  OutboxRecord,
} from "./persistence/interface";
export { StaleVersionError } from "./persistence/interface";
