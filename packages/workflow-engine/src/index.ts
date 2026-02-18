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

export { type StageResult } from "./core/types";
// Core Workflow
export {
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
  type RecordCallParams,
  type StreamOptions,
  type TextOptions,
} from "./ai/ai-helper";
// Model Helper
export {
  AVAILABLE_MODELS,
  calculateCost,
  DEFAULT_MODEL_KEY,
  getDefaultModel,
  getModel,
  getModelById,
  getRegisteredModel,
  listModels,
  listRegisteredModels,
  type ModelConfig,
  ModelKey,
  type ModelRegistry,
  type ModelStats,
  ModelStatsTracker,
  type ModelSyncConfig,
  modelSupportsBatch,
  printAvailableModels,
  registerModels,
} from "./ai/model-helper";
export {
  createStorage,
  getDefaultStorageProvider,
} from "./core/storage-factory";
export type {
  WorkflowEventType,
  WorkflowSSEEvent,
} from "./core/workflow-events";
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
  JobStatus,
  LogLevel,
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
  WorkflowStageStatus,
  // Deprecated aliases (use Status instead)
  WorkflowStatus,
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
export type {
  AnthropicBatchRequest,
  // Request types
  BaseBatchRequest,
  BatchHandle,
  BatchLogger,
  BatchMetrics,
  BatchProvider,
  BatchRequest,
  BatchRequestText,
  BatchRequestWithSchema,
  BatchResult,
  BatchState,
  BatchStatus,
  BatchSubmitOptions,
  GoogleBatchRequest,
  OpenAIBatchRequest,
  RawBatchResult,
  SerializedBatch,
} from "./utils/batch/types";

// =============================================================================
// Kernel API (Phase 1)
// =============================================================================

export {
  createKernel,
  type Kernel,
  type KernelConfig,
  type WorkflowRegistry as KernelWorkflowRegistry,
} from "./kernel/kernel";
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
  PluginReplayDLQCommand,
  PluginReplayDLQResult,
} from "./kernel/commands";
export type {
  KernelEvent,
  KernelEventType,
} from "./kernel/events";
export type {
  Clock,
  Persistence,
  BlobStore,
  JobTransport,
  EventSink,
  Scheduler,
} from "./kernel/ports";
export {
  definePlugin,
  createPluginRunner,
  type PluginDefinition,
  type PluginRunnerConfig,
  type PluginRunner,
} from "./kernel/plugins";
export { StaleVersionError } from "./persistence/interface";
export type {
  OutboxRecord,
  CreateOutboxEventInput,
  IdempotencyRecord,
} from "./persistence/interface";
