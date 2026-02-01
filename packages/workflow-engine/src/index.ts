/**
 * @bratsos/workflow-engine - Main Entry Point
 *
 * Export core workflow components for external use.
 */

// Core Workflow
export {
  Workflow,
  WorkflowBuilder,
  type InferWorkflowStageIds,
} from "./core/workflow";

export {
  defineStage,
  defineAsyncBatchStage,
  type EnhancedStageContext,
  type SyncStageDefinition,
  type AsyncBatchStageDefinition,
  type InferInput,
  type SimpleStageResult,
} from "./core/stage-factory";

export { type Stage } from "./core/stage";

export { type StageResult } from "./core/types";

export {
  NoInputSchema,
  requireStageOutput,
} from "./core/schema-helpers";

// =============================================================================
// Internal/Advanced Exports
// =============================================================================
// These are considered internal implementation details. Most users should use
// WorkflowRuntime as the primary API instead of these lower-level components.

/**
 * @internal
 * WorkflowExecutor - Low-level executor for running workflows directly.
 * For most use cases, use WorkflowRuntime instead.
 */
export { WorkflowExecutor } from "./core/executor";

/**
 * @internal
 * StageExecutor - Low-level executor for running individual stages.
 * Used internally by WorkflowRuntime for distributed execution.
 */
export {
  StageExecutor,
  type StageExecutionRequest,
  type StageExecutionResult,
  type WorkflowRegistry,
} from "./core/stage-executor";

export {
  createStorage,
  getDefaultStorageProvider,
} from "./core/storage-factory";

export {
  workflowEventBus,
  type PgNotifyLike,
} from "./core/workflow-event-bus.server";

export type {
  WorkflowSSEEvent,
  WorkflowEventType,
} from "./core/workflow-events";

// Workflow Runtime (unified scheduling + orchestration)
export {
  WorkflowRuntime,
  createWorkflowRuntime,
  type WorkflowRuntimeConfig,
  type CreateRunOptions,
  type CreateRunResult,
} from "./runtime";

// Persistence interfaces and types
export type {
  WorkflowPersistence,
  AICallLogger,
  JobQueue,
  WorkflowRunRecord,
  WorkflowStageRecord,
  WorkflowLogRecord,
  WorkflowArtifactRecord,
  AICallRecord,
  JobRecord,
  // Unified status type (preferred)
  Status,
  // Deprecated aliases (use Status instead)
  WorkflowStatus,
  WorkflowStageStatus,
  JobStatus,
  LogLevel,
  ArtifactType,
  CreateRunInput,
  UpdateRunInput,
  CreateStageInput,
  UpdateStageInput,
  UpsertStageInput,
  CreateLogInput,
  SaveArtifactInput,
  CreateAICallInput,
  EnqueueJobInput,
  DequeueResult,
  AIHelperStats,
} from "./persistence";

// Prisma implementations and factories
export {
  PrismaWorkflowPersistence,
  PrismaAICallLogger,
  PrismaJobQueue,
  createPrismaWorkflowPersistence,
  createPrismaAICallLogger,
  createPrismaJobQueue,
} from "./persistence";

// AI Helper
export {
  createAIHelper,
  type AIHelper,
  type AITextResult,
  type AIObjectResult,
  type AIEmbedResult,
  type AIStreamResult,
  type TextOptions,
  type ObjectOptions,
  type EmbedOptions,
  type StreamOptions,
  type RecordCallParams,
  type AICallType,
  type LogContext,
  type BatchLogFn,
  // High-level batch types (user-facing API)
  type AIBatch,
  type AIBatchProvider,
  type AIBatchRequest,
  type AIBatchResult,
  type AIBatchHandle,
} from "./ai/ai-helper";

// Model Helper
export {
  getModel,
  getDefaultModel,
  listModels,
  modelSupportsBatch,
  getModelById,
  calculateCost,
  printAvailableModels,
  ModelStatsTracker,
  AVAILABLE_MODELS,
  DEFAULT_MODEL_KEY,
  ModelKey,
  registerModels,
  listRegisteredModels,
  getRegisteredModel,
  type ModelConfig,
  type ModelStats,
  type ModelRegistry,
  type ModelSyncConfig,
} from "./ai/model-helper";

// Batch Providers
export {
  AnthropicBatchProvider,
  GoogleBatchProvider,
  OpenAIBatchProvider,
  type AnthropicBatchProviderConfig,
  type GoogleBatchProviderConfig,
  type OpenAIBatchProviderConfig,
} from "./utils/batch/providers";

// Batch Model Mapping
export {
  getBestProviderForModel,
  resolveModelForProvider,
} from "./utils/batch/model-mapping";

// Batch Types
export type {
  BatchProvider,
  BatchState,
  BatchStatus,
  BatchHandle,
  BatchSubmitOptions,
  RawBatchResult,
  BatchResult,
  SerializedBatch,
  BatchLogger,
  BatchMetrics,
  // Request types
  BaseBatchRequest,
  BatchRequest,
  BatchRequestWithSchema,
  BatchRequestText,
  GoogleBatchRequest,
  AnthropicBatchRequest,
  OpenAIBatchRequest,
} from "./utils/batch/types";
