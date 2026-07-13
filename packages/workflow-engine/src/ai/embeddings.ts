/**
 * AI Helper - Embeddings
 *
 * embed()/embedMany() on top of the AI SDK, plus the custom embedding
 * provider registry that lets consumers plug in community providers
 * (Voyage, Cohere, Jina, etc.) without modifying the workflow engine.
 */

import { google } from "@ai-sdk/google";
import type { EmbeddingModelV4 } from "@ai-sdk/provider";
import { openrouter } from "@openrouter/ai-sdk-provider";
import { embed as aiEmbed, embedMany } from "ai";
import { logFailure } from "./generate";
import { getModel, type ModelConfig, type ModelKey } from "./model-helper";
import { calculateCostWithDiscount, logger } from "./shared";
import type { AIEmbedResult, AIHelperContext, EmbedOptions } from "./types";

// Default embedding dimensions (can be overridden via options)
const DEFAULT_EMBEDDING_DIMENSIONS = 768;

// ============================================================================
// Custom Embedding Provider Registry
// ============================================================================

const embeddingProviderRegistry = new Map<
  string,
  (modelId: string) => EmbeddingModelV4
>();

/**
 * Register a custom embedding provider factory.
 *
 * Consumers can register any AI SDK community provider (Voyage, Cohere, Jina, etc.)
 * without modifying the workflow engine. The factory receives the model ID and must
 * return an EmbeddingModelV4 instance.
 *
 * @example
 * ```typescript
 * import { registerEmbeddingProvider } from "@bratsos/workflow-engine";
 * import { voyage } from "voyage-ai-provider";
 *
 * registerEmbeddingProvider("voyage", (modelId) => voyage.embeddingModel(modelId));
 * ```
 */
export function registerEmbeddingProvider(
  providerName: string,
  factory: (modelId: string) => EmbeddingModelV4,
): void {
  embeddingProviderRegistry.set(providerName, factory);
}

/** @internal Exported for testing only */
export function getEmbeddingModelProvider(modelConfig: ModelConfig) {
  // Custom providers registered by consumer
  const customFactory = embeddingProviderRegistry.get(modelConfig.provider);
  if (customFactory) {
    return customFactory(modelConfig.id);
  }

  // Built-in providers
  if (modelConfig.provider === "openrouter") {
    return openrouter.textEmbeddingModel(modelConfig.id);
  }
  if (modelConfig.provider === "google") {
    const googleModelId = modelConfig.id.replace(/^google\//, "");
    return google.embeddingModel(googleModelId);
  }

  throw new Error(
    `Unsupported embedding provider "${modelConfig.provider}" for model "${modelConfig.id}". ` +
      `Register it with registerEmbeddingProvider() or use a built-in provider ("openrouter", "google").`,
  );
}

export async function embed(
  ctx: AIHelperContext,
  modelKey: ModelKey,
  text: string | string[],
  options: EmbedOptions = {},
): Promise<AIEmbedResult> {
  const modelConfig = getModel(modelKey);
  const texts = Array.isArray(text) ? text : [text];
  const startTime = Date.now();

  // Use dimensions from options, or fall back to active config
  const dimensions = options.dimensions ?? DEFAULT_EMBEDDING_DIMENSIONS;

  // Trace log before embed call
  const textPreview =
    texts.length === 1
      ? texts[0].substring(0, 200) + (texts[0].length > 200 ? "..." : "")
      : `[${texts.length} texts]`;
  logger.debug(`embed request`, {
    model: modelKey,
    modelId: modelConfig.id,
    provider: modelConfig.provider,
    textCount: texts.length,
    textPreview,
    dimensions,
    taskType: options.taskType ?? "RETRIEVAL_DOCUMENT",
  });

  try {
    const embeddingModel = getEmbeddingModelProvider(modelConfig);
    const providerOptions = {
      ...(modelConfig.provider === "google" && {
        google: {
          outputDimensionality: dimensions,
          taskType: options.taskType ?? "RETRIEVAL_DOCUMENT",
        },
      }),
      ...options.providerOptions,
    };

    let embeddings: number[][];
    let totalInputTokens: number;

    if (texts.length === 1) {
      const result = await aiEmbed({
        model: embeddingModel,
        value: texts[0],
        providerOptions,
      });
      embeddings = [result.embedding];
      totalInputTokens = result.usage?.tokens || 0;
    } else {
      const result = await embedMany({
        model: embeddingModel,
        values: texts,
        providerOptions,
      });
      embeddings = result.embeddings;
      totalInputTokens = result.usage?.tokens || 0;
    }

    const outputTokens = 0; // Embeddings have no output tokens
    const cost = calculateCostWithDiscount(
      modelKey,
      totalInputTokens,
      outputTokens,
    );
    const durationMs = Date.now() - startTime;

    ctx.aiCallLogger.logCall({
      topic: ctx.topic,
      callType: "embed",
      modelKey,
      modelId: modelConfig.id,
      prompt: texts.length === 1 ? texts[0] : `[${texts.length} texts]`,
      response: `[${embeddings.length} embeddings, ${dimensions} dims]`,
      inputTokens: totalInputTokens,
      outputTokens,
      cost,
      metadata: {
        taskType: options.taskType,
        textCount: texts.length,
        dimensions,
        durationMs,
      },
    });

    // Trace log after successful embed call
    logger.debug(`embed response`, {
      model: modelKey,
      provider: modelConfig.provider,
      embeddingsCount: embeddings.length,
      dimensions,
      inputTokens: totalInputTokens,
      cost: cost.toFixed(6),
      durationMs,
    });

    return {
      embedding: embeddings[0], // Convenience: first embedding
      embeddings, // All embeddings
      dimensions, // Dimensionality used
      inputTokens: totalInputTokens,
      cost,
    };
  } catch (error) {
    const { errorMessage, durationMs } = logFailure(ctx.aiCallLogger, {
      topic: ctx.topic,
      callType: "embed",
      modelKey,
      modelId: modelConfig.id,
      prompt: texts.length === 1 ? texts[0] : `[${texts.length} texts]`,
      startTime,
      error,
      metadata: {
        taskType: options.taskType,
        textCount: texts.length,
        dimensions,
      },
    });
    logger.error(`embed error`, {
      model: modelKey,
      error: errorMessage,
      durationMs,
    });
    throw error;
  }
}
