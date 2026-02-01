/**
 * @bratsos/workflow-engine/ai - AI Helper Module
 */

export {
  createAIHelper,
  type AIHelper,
  type AITextResult,
  type AIObjectResult,
  type AIEmbedResult,
  type AIStreamResult,
  type TextOptions,
  type ObjectOptions,
  type StreamOptions,
  type EmbedOptions,
  type BatchProvider,
  type BatchRequest,
  type BatchResult,
  type BatchHandle,
  type RecordCallParams,
  type AIHelperStats,
  type AICallType,
  type ModelKey,
} from "./ai-helper";

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
  ModelKey as ModelKeyEnum,
  type ModelConfig,
  type ModelStats,
} from "./model-helper";
