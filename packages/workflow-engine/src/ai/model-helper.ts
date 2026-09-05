/**
 * Model Helper - Centralized model selection and cost tracking for AI scripts
 */

import z from "zod";

export interface ModelConfig {
  id: string;
  name: string;
  inputCostPerMillion: number; // Cost in USD per 1M input tokens
  outputCostPerMillion: number; // Cost in USD per 1M output tokens
  provider: string;
  description?: string;
  supportsAsyncBatch?: boolean;
  /**
   * Vendor-documented batch discount for the NATIVE transports (OpenAI Batch,
   * Anthropic Message Batches, Gemini Batch are all 50% off). Applied only
   * when batching through one of those vendors, or when no absolute
   * `batch*CostPerMillion` price is known. The OpenRouter transport always
   * uses the absolute prices below instead - its multipliers are not uniform.
   * Populated by `workflow-engine-sync` only for vendors with a documented
   * discount; never guessed.
   */
  batchDiscountPercent?: number;
  /** The ":batch" sibling slug in OpenRouter's catalog, when one exists. */
  batchModelId?: string;
  /**
   * Batch transport to prefer for this model when a call names none:
   * `"openrouter"` routes `ctx.step.ai.map` / `ai.batch(key)` through the
   * OpenRouter Batch API (the key you already use for realtime calls)
   * instead of the vendor SDK the slug names. Resolution order is the
   * call's `batch.provider`, then this, then the slug's native vendor
   * (google/anthropic/openai), then OpenRouter.
   */
  batchProvider?: "google" | "anthropic" | "openai" | "openrouter";
  /** Absolute price of the ":batch" variant, per 1M input tokens. Authoritative; prefer over batchDiscountPercent. */
  batchInputCostPerMillion?: number;
  /** Absolute price of the ":batch" variant, per 1M output tokens. */
  batchOutputCostPerMillion?: number;
  /** Long-context pricing tier from OpenRouter `pricing.overrides`, when the override is keyed on prompt length. */
  longContextTier?: {
    minPromptTokens: number;
    inputCostPerMillion: number;
    outputCostPerMillion: number;
  };
  isEmbeddingModel?: boolean; // true for embedding models
  supportsTools?: boolean; // true if model supports function calling
  supportsStructuredOutputs?: boolean; // true if model supports JSON schema outputs
  contextLength?: number; // Max context window from OpenRouter
  maxCompletionTokens?: number | null; // Max output tokens from OpenRouter
}

/**
 * Filter options for listModels()
 */
export interface ModelFilter {
  /** Only include embedding models */
  isEmbeddingModel?: boolean;
  /** Only include models that support function calling */
  supportsTools?: boolean;
  /** Only include models that support structured outputs */
  supportsStructuredOutputs?: boolean;
  /** Only include models that support async batch */
  supportsAsyncBatch?: boolean;
}

/**
 * Configuration for workflow-engine.models.ts sync config
 */
export interface ModelSyncConfig {
  /** Only include models matching these patterns (applied before exclude) */
  include?: (string | RegExp)[];
  /** Output path relative to consumer's project root (default: src/generated/models.ts) */
  outputPath?: string;
  /** Patterns to exclude models (string for exact match, RegExp for pattern) */
  exclude?: (string | RegExp)[];
  /** Custom models to add (embeddings, rerankers, etc.) */
  customModels?: Record<string, ModelConfig>;
}

/**
 * Model Registry - augmented by consumer's generated file for autocomplete
 * Import the generated file to populate this interface
 */
export interface ModelRegistry {}

/**
 * Runtime model registry populated by registerModels()
 */
const MODEL_REGISTRY: Record<string, ModelConfig> = {};

/**
 * Register models at runtime (called by generated file)
 */
export function registerModels(models: Record<string, ModelConfig>): void {
  Object.assign(MODEL_REGISTRY, models);
}

export interface ModelStats {
  modelId: string;
  modelName: string;
  apiCalls: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  inputCost: number;
  outputCost: number;
  totalCost: number;
}

/**
 * Static enum for built-in models - provides .enum accessor for AVAILABLE_MODELS keys
 */
export const ModelKeyEnum = z.enum(["gemini-2.5-flash"]);

/**
 * Type representing all available model keys
 * Supports both built-in enum keys AND dynamically registered keys via ModelRegistry
 */
export type ModelKey =
  | z.infer<typeof ModelKeyEnum>
  | keyof ModelRegistry
  | (string & {});

/**
 * Zod schema for model keys. Deliberately open: it accepts any non-empty
 * string, exactly like the `ModelKey` *type*. Registry membership is checked
 * where a model is actually resolved (`getModel()`), not at config-parse
 * time, so a `schemas.config` field typed with `ModelKey` does not reject a
 * key the consumer registers later (or resolves through a custom provider).
 */
export const ModelKey = z.string().min(1);

/**
 * Available AI models with their configurations
 * Prices should be updated regularly from provider pricing pages
 */
export const AVAILABLE_MODELS: Record<string, ModelConfig> = {
  [ModelKeyEnum.enum["gemini-2.5-flash"]]: {
    id: "google/gemini-2.5-flash-preview-09-2025",
    name: "Gemini 2.5 Flash Preview",
    inputCostPerMillion: 0.3,
    outputCostPerMillion: 2.5,
    provider: "openrouter",
    description: "Fast, efficient model for general tasks",
    supportsAsyncBatch: true,
    batchDiscountPercent: 50,
  },
};

/**
 * Default model selection
 * Change this to switch the default model across all scripts
 */
export const DEFAULT_MODEL_KEY: ModelKey = "gemini-2.5-flash";

/**
 * Get a model configuration by key
 * Checks both built-in AVAILABLE_MODELS and runtime MODEL_REGISTRY
 */
export function getModel(key: ModelKey): ModelConfig {
  // First check built-in models (for backward compatibility)
  const builtInModel = AVAILABLE_MODELS[key];
  if (builtInModel) {
    return builtInModel;
  }

  // Then check runtime registry (for dynamically registered models)
  const registeredModel = MODEL_REGISTRY[key];
  if (registeredModel) {
    return registeredModel;
  }

  const allKeys = [
    ...Object.keys(AVAILABLE_MODELS),
    ...Object.keys(MODEL_REGISTRY),
  ];
  throw new Error(
    `Model "${key}" not found. Available models: ${allKeys.join(", ")}`,
  );
}

/**
 * List all available models (built-in + registered)
 * @param filter Optional filter to narrow down models by capability
 */
export function listModels(
  filter?: ModelFilter,
): Array<{ key: string; config: ModelConfig }> {
  // Combine built-in models and registered models
  const builtIn = Object.entries(AVAILABLE_MODELS).map(([key, config]) => ({
    key,
    config,
  }));

  const registered = Object.entries(MODEL_REGISTRY).map(([key, config]) => ({
    key,
    config,
  }));

  // Merge, with registered models taking precedence if there's a duplicate
  const merged = new Map<string, { key: string; config: ModelConfig }>();
  for (const item of builtIn) {
    merged.set(item.key, item);
  }
  for (const item of registered) {
    merged.set(item.key, item);
  }

  let models = Array.from(merged.values());

  // Apply filters if provided
  if (filter) {
    models = models.filter((item) => {
      const { config } = item;

      // Filter by embedding model
      if (filter.isEmbeddingModel !== undefined) {
        if (filter.isEmbeddingModel && !config.isEmbeddingModel) return false;
        if (!filter.isEmbeddingModel && config.isEmbeddingModel) return false;
      }

      // Filter by tool support
      if (filter.supportsTools !== undefined) {
        if (filter.supportsTools && !config.supportsTools) return false;
        if (!filter.supportsTools && config.supportsTools) return false;
      }

      // Filter by structured outputs support
      if (filter.supportsStructuredOutputs !== undefined) {
        if (
          filter.supportsStructuredOutputs &&
          !config.supportsStructuredOutputs
        )
          return false;
        if (
          !filter.supportsStructuredOutputs &&
          config.supportsStructuredOutputs
        )
          return false;
      }

      // Filter by batch support
      if (filter.supportsAsyncBatch !== undefined) {
        if (filter.supportsAsyncBatch && !config.supportsAsyncBatch)
          return false;
        if (!filter.supportsAsyncBatch && config.supportsAsyncBatch)
          return false;
      }

      return true;
    });
  }

  return models.sort((a, b) => a.key.localeCompare(b.key));
}

/**
 * Calculate costs based on token usage
 */
export function calculateCost(
  modelKey: ModelKey,
  inputTokens: number,
  outputTokens: number,
): {
  inputCost: number;
  outputCost: number;
  totalCost: number;
} {
  const model = getModel(modelKey);

  const tier = model.longContextTier;
  const useLongContextTier =
    tier !== undefined && inputTokens >= tier.minPromptTokens;

  const inputRate = useLongContextTier
    ? tier.inputCostPerMillion
    : model.inputCostPerMillion;
  const outputRate = useLongContextTier
    ? tier.outputCostPerMillion
    : model.outputCostPerMillion;

  const inputCost = (inputTokens / 1_000_000) * inputRate;
  const outputCost = (outputTokens / 1_000_000) * outputRate;
  const totalCost = inputCost + outputCost;

  return {
    inputCost,
    outputCost,
    totalCost,
  };
}
