/**
 * @bratsos/workflow-engine/client - Client-safe exports
 *
 * This entry point contains ONLY exports that are safe to use in browser/client code.
 * No Node.js APIs, no Prisma, no server-only modules.
 *
 * Use this for:
 * - Dashboard components
 * - Client-side React components
 * - Any code that runs in the browser
 *
 * For server code (API routes, workers), use the main entry:
 * import { ... } from "@bratsos/workflow-engine"
 */

// Model configuration (client-safe)
export {
  AVAILABLE_MODELS,
  ModelKey,
  type ModelConfig,
  type ModelRegistry,
  type ModelFilter,
  listModels,
  DEFAULT_MODEL_KEY,
  calculateCost,
  modelSupportsBatch,
  registerModels,
} from "./ai/model-helper";

export { type AIHelper } from "./ai/ai-helper";

// Stage definition (client-safe)
export {
  defineStage,
  defineAsyncBatchStage,
  type EnhancedStageContext,
  type SyncStageDefinition,
  type AsyncBatchStageDefinition,
  type InferInput,
  type SimpleStageResult,
} from "./core/stage-factory";

export { NoInputSchema } from "./core/schema-helpers";

export type {
  WorkflowSSEEvent,
  WorkflowEventType,
  WorkflowStartedPayload,
  WorkflowCompletedPayload,
  WorkflowSuspendedPayload,
  WorkflowFailedPayload,
  StageStartedPayload,
  StageCompletedPayload,
  StageFailedPayload,
  LogPayload,
} from "./core/workflow-events";
