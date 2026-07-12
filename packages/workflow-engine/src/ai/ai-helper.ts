/**
 * AI Helper - Unified AI interaction tracking with hierarchical topics
 *
 * This is the new unified AI tracking system that replaces workflow-specific tracking.
 * It supports:
 * - Hierarchical topics for flexible categorization (e.g., "workflow.abc.stage.extraction")
 * - All AI call types: generateText, generateObject, embed, streamText, batch
 * - Automatic cost calculation with batch discounts
 * - Persistent DB logging to AICall table
 *
 * Implementation is split across generate.ts, embeddings.ts, stream.ts, and
 * batch-helper.ts; this file wires them together behind the AIHelper
 * interface and owns createChild/recordCall/getStats - the state that
 * doesn't belong to any one AI call type.
 *
 * @example
 * ```typescript
 * const ai = createAIHelper("workflow.abc123").createChild("stage", "extraction");
 * const result = await ai.generateText("gemini-2.5-flash", prompt);
 * ```
 */

import type { ToolSet } from "ai";
import type { z } from "zod";
import type { AICallLogger } from "../persistence";
import { getBestProviderForModel } from "../utils/batch/model-mapping";
import { AIBatchImpl } from "./batch-helper";
import { embed as embedImpl } from "./embeddings";
import {
  generateObject as generateObjectImpl,
  generateText as generateTextImpl,
} from "./generate";
import { getModel, type ModelKey } from "./model-helper";
import { calculateCostWithDiscount, logger } from "./shared";
import { streamText as streamTextImpl } from "./stream";
import type {
  AIBatch,
  AIBatchProvider,
  AICallType,
  AIEmbedResult,
  AIHelper,
  AIHelperContext,
  AIHelperStats,
  AIObjectResult,
  AIStreamResult,
  AITextResult,
  BatchLogFn,
  EmbedOptions,
  LogContext,
  ObjectOptions,
  ProviderResolver,
  RecordCallParams,
  StreamOptions,
  StreamTextInput,
  TextInput,
  TextOptions,
} from "./types";

// ============================================================================
// AIHelper Implementation
// ============================================================================

class AIHelperImpl implements AIHelper {
  readonly topic: string;
  private readonly aiCallLogger: AICallLogger;
  private readonly logContext?: LogContext;
  private readonly batchLogFn?: BatchLogFn;
  private readonly providerResolver?: ProviderResolver;

  constructor(
    topic: string,
    aiCallLogger: AICallLogger,
    logContext?: LogContext,
    providerResolver?: ProviderResolver,
  ) {
    if (!aiCallLogger) {
      throw new Error(
        "AIHelperImpl requires a logger. Create one using createPrismaAICallLogger(prisma).",
      );
    }
    this.topic = topic;
    this.aiCallLogger = aiCallLogger;
    this.logContext = logContext;
    this.providerResolver = providerResolver;

    // Create batch log function if logContext is provided
    if (logContext) {
      this.batchLogFn = (level, message, meta) => {
        // Fire and forget - don't block on persistence logging
        logContext
          .createLog({
            workflowRunId: logContext.workflowRunId,
            workflowStageId: logContext.stageRecordId,
            level,
            message,
            metadata: meta,
          })
          .catch((err) => logger.error("Failed to persist log:", err));
        // Also log to console for immediate visibility
        logger.debug(`[${level}] ${message}`, meta ? JSON.stringify(meta) : "");
      };
    }
  }

  /** Bundle the state generateText/generateObject/embed/streamText/batch need. */
  private context(): AIHelperContext {
    return {
      topic: this.topic,
      aiCallLogger: this.aiCallLogger,
      providerResolver: this.providerResolver,
    };
  }

  generateText<TTools extends ToolSet = ToolSet>(
    modelKey: ModelKey,
    prompt: TextInput,
    options?: TextOptions<TTools>,
  ): Promise<AITextResult> {
    return generateTextImpl(this.context(), modelKey, prompt, options);
  }

  generateObject<TSchema extends z.ZodTypeAny>(
    modelKey: ModelKey,
    prompt: TextInput,
    schema: TSchema,
    options?: ObjectOptions,
  ): Promise<AIObjectResult<z.infer<TSchema>>> {
    return generateObjectImpl(
      this.context(),
      modelKey,
      prompt,
      schema,
      options,
    );
  }

  embed(
    modelKey: ModelKey,
    text: string | string[],
    options?: EmbedOptions,
  ): Promise<AIEmbedResult> {
    return embedImpl(this.context(), modelKey, text, options);
  }

  streamText(
    modelKey: ModelKey,
    input: StreamTextInput,
    options?: StreamOptions,
  ): AIStreamResult {
    return streamTextImpl(this.context(), modelKey, input, options);
  }

  batch<T = string>(
    modelKey: ModelKey,
    provider?: AIBatchProvider,
  ): AIBatch<T> {
    const resolvedProvider =
      provider ?? getBestProviderForModel(modelKey) ?? "google";
    return new AIBatchImpl<T>(
      this.context(),
      modelKey,
      resolvedProvider,
      this.batchLogFn,
    );
  }

  createChild(segment: string, id?: string): AIHelper {
    const newTopic = id
      ? `${this.topic}.${segment}.${id}`
      : `${this.topic}.${segment}`;
    // Preserve logContext and providerResolver for child helpers (same workflow context)
    return new AIHelperImpl(
      newTopic,
      this.aiCallLogger,
      this.logContext,
      this.providerResolver,
    );
  }

  // Overloaded recordCall to support both new object-based API and legacy positional API
  recordCall(
    paramsOrModelKey: RecordCallParams | ModelKey,
    prompt?: string,
    response?: string,
    tokens?: { input: number; output: number },
    options?: {
      callType?: AICallType;
      isBatch?: boolean;
      metadata?: Record<string, unknown>;
    },
  ): void {
    let modelKey: ModelKey;
    let actualPrompt: string;
    let actualResponse: string;
    let inputTokens: number;
    let outputTokens: number;
    let callType: AICallType;
    let isBatch: boolean;
    let metadata: Record<string, unknown> | undefined;

    // Check if first argument is the new object-based params or legacy modelKey string
    if (
      typeof paramsOrModelKey === "object" &&
      "modelKey" in paramsOrModelKey
    ) {
      // New object-based API
      const params = paramsOrModelKey as RecordCallParams;
      modelKey = params.modelKey;
      actualPrompt = params.prompt;
      actualResponse = params.response;
      inputTokens = params.inputTokens;
      outputTokens = params.outputTokens;
      callType = params.callType;
      isBatch = callType === "batch";
      metadata = params.metadata;
    } else {
      // Legacy positional API - see the @deprecated overload on AIHelper.recordCall.
      if (!prompt || !response || !tokens) {
        throw new Error(
          "recordCall: legacy API requires prompt, response, and tokens",
        );
      }
      modelKey = paramsOrModelKey as ModelKey;
      actualPrompt = prompt;
      actualResponse = response;
      inputTokens = tokens.input;
      outputTokens = tokens.output;
      callType = options?.callType ?? "text";
      isBatch = options?.isBatch ?? false;
      metadata = options?.metadata;
    }

    const modelConfig = getModel(modelKey);
    const cost = calculateCostWithDiscount(
      modelKey,
      inputTokens,
      outputTokens,
      isBatch,
    );

    // Persist to DB (fire and forget)
    this.aiCallLogger.logCall({
      topic: this.topic,
      callType,
      modelKey,
      modelId: modelConfig.id,
      prompt: actualPrompt,
      response: actualResponse,
      inputTokens,
      outputTokens,
      cost,
      metadata: isBatch ? { ...metadata, isBatch: true } : metadata,
    });
  }

  async getStats(): Promise<AIHelperStats> {
    return this.aiCallLogger.getStats(this.topic);
  }
}

// ============================================================================
// Factory Function
// ============================================================================

/**
 * Create an AI helper instance with topic-based tracking.
 *
 * @param topic - Initial topic path (e.g., "workflow.abc123" or "reranker")
 * @returns AIHelper instance
 *
 * @example
 * ```typescript
 * // Simple topic
 * const ai = createAIHelper("reranker");
 *
 * // Hierarchical topic
 * const ai = createAIHelper("workflow.abc123", logger)
 *   .createChild("stage", "extraction");
 * // topic: "workflow.abc123.stage.extraction"
 *
 * // Use AI methods
 * const result = await ai.generateText("gemini-2.5-flash", prompt);
 * ```
 */
export function createAIHelper(
  topic: string,
  logger: AICallLogger,
  logContext?: LogContext,
  providerResolver?: ProviderResolver,
): AIHelper {
  return new AIHelperImpl(topic, logger, logContext, providerResolver);
}

// ============================================================================
// Public Re-exports
// ============================================================================
// ai-helper.ts is the module's established import path (src/index.ts,
// src/client.ts, and tests all import from here), so the pieces implemented
// in the split-out modules are re-exported from this file rather than
// requiring call sites to reach into ./types / ./embeddings directly.

export {
  getEmbeddingModelProvider,
  registerEmbeddingProvider,
} from "./embeddings";
export type { ModelKey } from "./model-helper";
export type {
  AIBatch,
  AIBatchHandle,
  AIBatchProvider,
  AIBatchRequest,
  AIBatchResult,
  AICallType,
  AIEmbedResult,
  AIHelper,
  AIHelperStats,
  AIObjectResult,
  AISDKStreamResult,
  AIStreamResult,
  AITextResult,
  BatchLogFn,
  ContentPart,
  EmbedOptions,
  LogContext,
  MediaPart,
  ObjectOptions,
  ProviderResolver,
  RecordCallParams,
  StreamOptions,
  StreamTextInput,
  TextInput,
  TextOptions,
  TextPart,
} from "./types";
