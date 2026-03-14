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

export { type AIHelper } from "./ai/ai-helper";
// Model configuration (client-safe)
export {
  AVAILABLE_MODELS,
  calculateCost,
  DEFAULT_MODEL_KEY,
  listModels,
  type ModelConfig,
  type ModelFilter,
  ModelKey,
  type ModelRegistry,
  modelSupportsBatch,
  registerModels,
} from "./ai/model-helper";
export { NoInputSchema } from "./core/schema-helpers";
// Stage definition (client-safe)
export {
  type AsyncBatchStageDefinition,
  defineAsyncBatchStage,
  defineStage,
  type EnhancedStageContext,
  type InferInput,
  type SimpleStageResult,
  type SyncStageDefinition,
} from "./core/stage-factory";
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
} from "./kernel/events";
