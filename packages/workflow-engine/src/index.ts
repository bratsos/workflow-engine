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
// Internal/Advanced Exports
// =============================================================================
// These are considered internal implementation details. Most users should use
// WorkflowRuntime as the primary API instead of these lower-level components.

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
  type StageExecutionRequest,
  type StageExecutionResult,
  StageExecutor,
  type WorkflowRegistry,
} from "./core/stage-executor";
export {
  createStorage,
  getDefaultStorageProvider,
} from "./core/storage-factory";
export {
  type PgNotifyLike,
  workflowEventBus,
} from "./core/workflow-event-bus.server";
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
// Workflow Runtime (unified scheduling + orchestration)
export {
  type CreateRunOptions,
  type CreateRunResult,
  createWorkflowRuntime,
  WorkflowRuntime,
  type WorkflowRuntimeConfig,
} from "./runtime";
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
