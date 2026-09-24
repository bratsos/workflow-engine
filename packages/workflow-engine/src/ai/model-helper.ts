/**
 * Model Helper - Centralized model selection and cost tracking for AI scripts
 */

import z from "zod";

export interface ModelConfig {
  id: string;
  name: string;
  inputCostPerMillion: number; // Cost in USD per 1M input tokens
  outputCostPerMillion: number; // Cost in USD per 1M output tokens
  /**
   * Price of a cached (prompt-cache read) input token, per 1M. From
   * OpenRouter's `pricing.input_cache_read`; populated by
   * `workflow-engine-sync` when the catalogue publishes it. The estimate
   * bills a call's cached input tokens at this rate and the rest at
   * `inputCostPerMillion`; when absent every input token is billed at the
   * full rate.
   */
  cachedInputCostPerMillion?: number;
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
    /** Cached-input rate inside the tier, when the override publishes one. */
    cachedInputCostPerMillion?: number;
  };
  isEmbeddingModel?: boolean; // true for embedding models
  /**
   * True for decision models (OpenRouter output modality `decisions`, e.g.
   * TypeSafe's Jev). These answer typed questions through `ai.evaluate` and
   * cannot generate text; `workflow-engine-sync` sets this from the catalogue.
   */
  isEvaluationModel?: boolean;
  /**
   * True for speech-to-text models answered through `ai.transcribe` (OpenAI's
   * `whisper-1` / `gpt-4o-transcribe`, Google's transcription models). Not in
   * OpenRouter's catalogue, so registered by hand with `registerModels`.
   */
  isTranscriptionModel?: boolean;
  /**
   * USD per minute of transcribed audio, for providers that bill by the
   * minute and report the audio's duration (OpenAI). Providers that bill by
   * tokens (Google) are priced from `inputCostPerMillion` /
   * `outputCostPerMillion` instead, from the usage they report.
   */
  transcriptionCostPerMinute?: number;
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
  /** Only include decision models (or, when false, exclude them) */
  isEvaluationModel?: boolean;
  /** Only include transcription models (or, when false, exclude them) */
  isTranscriptionModel?: boolean;
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

      // Filter by decision model
      if (filter.isEvaluationModel !== undefined) {
        if (filter.isEvaluationModel && !config.isEvaluationModel) return false;
        if (!filter.isEvaluationModel && config.isEvaluationModel) return false;
      }

      // Filter by transcription model
      if (filter.isTranscriptionModel !== undefined) {
        if (filter.isTranscriptionModel && !config.isTranscriptionModel)
          return false;
        if (!filter.isTranscriptionModel && config.isTranscriptionModel)
          return false;
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
 * Calculate costs based on token usage.
 *
 * `inputTokens` is the total prompt size (the AI SDK's `usage.inputTokens`
 * and OpenRouter's `prompt_tokens` both include cached tokens);
 * `cachedInputTokens` is the part of it served from the prompt cache, billed
 * at the model's `cachedInputCostPerMillion` when the catalogue has one and
 * at the full input rate otherwise. `outputTokens` already includes
 * reasoning tokens (both sources report them as part of the completion
 * count), so reasoning is priced as output without any adjustment here.
 */
export function calculateCost(
  modelKey: ModelKey,
  inputTokens: number,
  outputTokens: number,
  cachedInputTokens: number = 0,
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
  const cachedRate =
    (useLongContextTier
      ? tier.cachedInputCostPerMillion
      : model.cachedInputCostPerMillion) ?? inputRate;

  const cached = Math.min(Math.max(cachedInputTokens, 0), inputTokens);
  const inputCost =
    ((inputTokens - cached) / 1_000_000) * inputRate +
    (cached / 1_000_000) * cachedRate;
  const outputCost = (outputTokens / 1_000_000) * outputRate;
  const totalCost = inputCost + outputCost;

  return {
    inputCost,
    outputCost,
    totalCost,
  };
}
