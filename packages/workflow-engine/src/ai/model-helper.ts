/**
 * Model Helper - Centralized model selection and cost tracking for AI scripts
 */

import z from "zod";

// Lazy-loaded tiktoken to avoid bundling 2MB of tokenizer data for browser clients
let tiktokenPromise: Promise<{
  Tiktoken: typeof import("js-tiktoken/lite").Tiktoken;
  cl100k_base: typeof import("js-tiktoken/ranks/cl100k_base").default;
}> | null = null;

async function getTiktoken() {
  if (!tiktokenPromise) {
    tiktokenPromise = Promise.all([
      import("js-tiktoken/lite"),
      import("js-tiktoken/ranks/cl100k_base"),
    ]).then(([{ Tiktoken }, cl100kModule]) => ({
      Tiktoken,
      cl100k_base: cl100kModule.default,
    }));
  }
  return tiktokenPromise;
}

export interface ModelConfig {
  id: string;
  name: string;
  inputCostPerMillion: number; // Cost in USD per 1M input tokens
  outputCostPerMillion: number; // Cost in USD per 1M output tokens
  provider: "openrouter" | "google" | "other";
  description?: string;
  supportsAsyncBatch?: boolean;
  batchDiscountPercent?: number; // e.g., 50 for Google Batch (50% off)
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

/**
 * Get a model from the runtime registry
 */
export function getRegisteredModel(key: string): ModelConfig | undefined {
  return MODEL_REGISTRY[key];
}

/**
 * List all registered models
 */
export function listRegisteredModels(): Array<{
  key: string;
  config: ModelConfig;
}> {
  return Object.entries(MODEL_REGISTRY).map(([key, config]) => ({
    key,
    config,
  }));
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
export type ModelKey = z.infer<typeof ModelKeyEnum> | keyof ModelRegistry;

/**
 * Zod schema that validates model keys against both the static enum AND the runtime registry
 * Use ModelKey.parse() to validate and type model key strings
 */
export const ModelKey = z
  .string()
  .refine(
    (key) => {
      // Check built-in enum first
      if (ModelKeyEnum.safeParse(key).success) {
        return true;
      }
      // Then check runtime registry
      return MODEL_REGISTRY[key] !== undefined;
    },
    {
      message:
        "Model not found. Make sure to import the generated models file or register the model.",
    },
  )
  .transform((key) => key as ModelKey);

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
  const builtInModel = AVAILABLE_MODELS[key as keyof typeof AVAILABLE_MODELS];
  if (builtInModel) {
    return builtInModel;
  }

  // Then check runtime registry (for dynamically registered models)
  const registeredModel = MODEL_REGISTRY[key as string];
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
 * Get the default model configuration
 */
export function getDefaultModel(): ModelConfig {
  return getModel(DEFAULT_MODEL_KEY);
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
 * Check if a model supports async batch processing
 */
export function modelSupportsBatch(modelKey: ModelKey): boolean {
  const model = getModel(modelKey);
  return model.supportsAsyncBatch === true;
}

/**
 * Interface for model with bound recording function
 * Useful for parallel execution where you want to pass model + recordCall together
 */
export interface ModelWithRecorder {
  id: string;
  name: string;
  recordCall: (inputTokens: number, outputTokens: number) => void;
}

/**
 * Get model by key with bound recordCall function
 * Perfect for parallel execution - no need to write model name twice
 *
 * Usage:
 * const model = getModelById("gemini-2.5-flash", modelTracker);
 * const result = await generateText({
 *   model: openRouter(model.id),
 *   prompt: "...",
 * });
 * model.recordCall(result.usage.inputTokens, result.usage.outputTokens);
 */
export function getModelById(
  modelKey: ModelKey,
  tracker?: ModelStatsTracker,
): ModelWithRecorder {
  const modelConfig = getModel(modelKey);
  return {
    id: modelConfig.id,
    name: modelConfig.name,
    recordCall: (inputTokens: number, outputTokens: number) => {
      if (!tracker) {
        throw new Error("ModelStatsTracker required to use recordCall()");
      }
      tracker.recordCall(inputTokens, outputTokens, modelKey);
    },
  };
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

  const inputCost = (inputTokens / 1_000_000) * model.inputCostPerMillion;
  const outputCost = (outputTokens / 1_000_000) * model.outputCostPerMillion;
  const totalCost = inputCost + outputCost;

  return {
    inputCost,
    outputCost,
    totalCost,
  };
}

/**
 * Model stats tracker class - tracks single model OR aggregates multiple models
 */
export class ModelStatsTracker {
  private modelKey?: ModelKey;
  private modelConfig?: ModelConfig;
  private stats: {
    apiCalls: number;
    inputTokens: number;
    outputTokens: number;
  };
  private perModelStats: Map<string, ModelStats> = new Map();
  private isAggregating: boolean = false;

  constructor(modelKey: ModelKey = DEFAULT_MODEL_KEY) {
    this.modelKey = modelKey;
    this.modelConfig = getModel(modelKey);
    this.stats = {
      apiCalls: 0,
      inputTokens: 0,
      outputTokens: 0,
    };
  }

  /**
   * Create an aggregating tracker that combines stats from multiple models
   * Perfect for parallel execution where different calls use different models
   */
  static createAggregating(): ModelStatsTracker {
    const tracker = new ModelStatsTracker();
    tracker.isAggregating = true;
    tracker.modelKey = undefined;
    tracker.modelConfig = undefined;
    return tracker;
  }

  /**
   * Get the model ID for use with AI SDK
   * @deprecated Use getModelById(modelKey).id instead for parallel execution
   */
  getModelId(): string {
    if (!this.modelConfig) {
      throw new Error("Model not set for this tracker");
    }
    return this.modelConfig.id;
  }

  /**
   * Get the model configuration
   * @deprecated Use getModelById(modelKey) instead for parallel execution
   */
  getModelConfig(): ModelConfig {
    if (!this.modelConfig) {
      throw new Error("Model not set for this tracker");
    }
    return this.modelConfig;
  }

  /**
   * Switch model (useful for sequential model switching)
   * @deprecated For parallel execution, pass model key to recordCall() instead
   */
  switchModel(modelKey: ModelKey): void {
    this.modelKey = modelKey;
    this.modelConfig = getModel(modelKey);
  }

  /**
   * Get a model helper with bound recordCall for parallel execution
   * Perfect for running multiple AI calls in parallel with different models
   *
   * Usage:
   *   const flashModel = tracker.getModelById("gemini-2.5-flash");
   *   const liteModel = tracker.getModelById("gemini-2.5-flash-lite");
   *
   *   const [result1, result2] = await Promise.all([
   *     generateText({
   *       model: openRouter(flashModel.id),
   *       prompt: prompt1,
   *     }).then(r => { flashModel.recordCall(r.usage.inputTokens, r.usage.outputTokens); return r; }),
   *     generateText({
   *       model: openRouter(liteModel.id),
   *       prompt: prompt2,
   *     }).then(r => { liteModel.recordCall(r.usage.inputTokens, r.usage.outputTokens); return r; }),
   *   ]);
   */
  getModelById(modelKey: ModelKey): {
    id: string;
    name: string;
    recordCall: (inputTokens: number, outputTokens: number) => void;
  } {
    const modelConfig = getModel(modelKey);
    return {
      id: modelConfig.id,
      name: modelConfig.name,
      recordCall: (inputTokens: number, outputTokens: number) => {
        this.recordCall(inputTokens, outputTokens, modelKey);
      },
    };
  }

  /**
   * Record an API call with token usage
   *
   * For sequential execution:
   *   tracker.switchModel("gemini-2.5-flash")
   *   tracker.recordCall(inputTokens, outputTokens)
   *
   * For parallel execution:
   *   tracker.recordCall(inputTokens, outputTokens, "gemini-2.5-flash")
   *   tracker.recordCall(inputTokens, outputTokens, "gemini-2.5-pro")
   */
  recordCall(
    inputTokens: number = 0,
    outputTokens: number = 0,
    modelKeyOverride?: ModelKey,
  ): void {
    // Determine which model to use
    const modelKeyToUse = modelKeyOverride || this.modelKey;
    if (!modelKeyToUse) {
      throw new Error(
        "Model not set and no modelKeyOverride provided to recordCall()",
      );
    }

    const modelConfig = getModel(modelKeyToUse);

    this.stats.apiCalls += 1;
    this.stats.inputTokens += inputTokens;
    this.stats.outputTokens += outputTokens;

    // Always track per-model stats for aggregating trackers
    if (this.isAggregating) {
      const modelId = modelConfig.id;
      const existing = this.perModelStats.get(modelId) || {
        modelId,
        modelName: modelConfig.name,
        apiCalls: 0,
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        inputCost: 0,
        outputCost: 0,
        totalCost: 0,
      };

      const costs = calculateCost(modelKeyToUse, inputTokens, outputTokens);

      this.perModelStats.set(modelId, {
        modelId,
        modelName: modelConfig.name,
        apiCalls: existing.apiCalls + 1,
        inputTokens: existing.inputTokens + inputTokens,
        outputTokens: existing.outputTokens + outputTokens,
        totalTokens: existing.totalTokens + inputTokens + outputTokens,
        inputCost: existing.inputCost + costs.inputCost,
        outputCost: existing.outputCost + costs.outputCost,
        totalCost: existing.totalCost + costs.totalCost,
      });
    }
  }

  /**
   * Estimate cost for a prompt without making an API call
   * Useful for dry-run mode to preview costs
   *
   * Note: This method is async because it lazy-loads the tiktoken library
   * to avoid bundling 2MB of tokenizer data for browser clients.
   *
   * @param prompt - The prompt text to estimate
   * @param estimatedOutputTokens - Estimated number of output tokens (default: 500)
   * @returns Object with token counts and cost estimates
   */
  async estimateCost(
    prompt: string,
    estimatedOutputTokens: number = 500,
  ): Promise<{
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    inputCost: number;
    outputCost: number;
    totalCost: number;
  }> {
    if (!this.modelKey) {
      throw new Error("Model not set for estimation");
    }

    // Lazy-load tiktoken to avoid bundling for browser clients
    const { Tiktoken, cl100k_base } = await getTiktoken();

    // Count tokens in the prompt using tiktoken
    const encoding = new Tiktoken(cl100k_base);
    const inputTokens = encoding.encode(prompt).length;

    const costs = calculateCost(
      this.modelKey,
      inputTokens,
      estimatedOutputTokens,
    );

    return {
      inputTokens,
      outputTokens: estimatedOutputTokens,
      totalTokens: inputTokens + estimatedOutputTokens,
      inputCost: costs.inputCost,
      outputCost: costs.outputCost,
      totalCost: costs.totalCost,
    };
  }

  /**
   * Get current statistics (single model or aggregated)
   * Returns null only if tracker is in aggregating mode - use getAggregatedStats() instead
   */
  getStats(): ModelStats | null {
    if (this.isAggregating) {
      return null; // Use getAggregatedStats() instead
    }

    if (!this.modelKey || !this.modelConfig) {
      throw new Error("Model not set for this tracker");
    }

    const totalTokens = this.stats.inputTokens + this.stats.outputTokens;
    const costs = calculateCost(
      this.modelKey,
      this.stats.inputTokens,
      this.stats.outputTokens,
    );

    return {
      modelId: this.modelConfig.id,
      modelName: this.modelConfig.name,
      apiCalls: this.stats.apiCalls,
      inputTokens: this.stats.inputTokens,
      outputTokens: this.stats.outputTokens,
      totalTokens,
      inputCost: costs.inputCost,
      outputCost: costs.outputCost,
      totalCost: costs.totalCost,
    };
  }

  /**
   * Get aggregated statistics from all models
   */
  getAggregatedStats(): {
    perModel: ModelStats[];
    totals: {
      totalApiCalls: number;
      totalInputTokens: number;
      totalOutputTokens: number;
      totalTokens: number;
      totalInputCost: number;
      totalOutputCost: number;
      totalCost: number;
    };
  } {
    const perModel = Array.from(this.perModelStats.values());

    const totals = {
      totalApiCalls: perModel.reduce((sum, m) => sum + m.apiCalls, 0),
      totalInputTokens: perModel.reduce((sum, m) => sum + m.inputTokens, 0),
      totalOutputTokens: perModel.reduce((sum, m) => sum + m.outputTokens, 0),
      totalTokens: perModel.reduce((sum, m) => sum + m.totalTokens, 0),
      totalInputCost: perModel.reduce((sum, m) => sum + m.inputCost, 0),
      totalOutputCost: perModel.reduce((sum, m) => sum + m.outputCost, 0),
      totalCost: perModel.reduce((sum, m) => sum + m.totalCost, 0),
    };

    return { perModel, totals };
  }

  /**
   * Print statistics to console
   */
  printStats(): void {
    if (this.isAggregating) {
      this.printAggregatedStats();
    } else {
      const stats = this.getStats();
      if (!stats) {
        console.log("No statistics available");
        return;
      }

      console.log("\n📊 API Usage Statistics:");
      console.log(`  Model: ${stats.modelName} (${stats.modelId})`);
      console.log(`  API Calls: ${stats.apiCalls}`);
      console.log(`  Input Tokens: ${stats.inputTokens.toLocaleString()}`);
      console.log(`  Output Tokens: ${stats.outputTokens.toLocaleString()}`);
      console.log(`  Total Tokens: ${stats.totalTokens.toLocaleString()}`);

      if (stats.totalCost > 0) {
        console.log(`  Input Cost: $${stats.inputCost.toFixed(4)}`);
        console.log(`  Output Cost: $${stats.outputCost.toFixed(4)}`);
        console.log(`  Total Cost: $${stats.totalCost.toFixed(4)}`);
      } else {
        console.log("  Cost: Free / Not calculated");
      }
    }
  }

  /**
   * Print aggregated statistics from all models
   */
  printAggregatedStats(): void {
    const { perModel, totals } = this.getAggregatedStats();

    console.log("\n📊 Aggregated API Usage Statistics:");
    console.log("═════════════════════════════════════════\n");

    console.log("Per-Model Breakdown:");
    for (const stats of perModel) {
      console.log(`\n  ${stats.modelName}`);
      console.log(`    API Calls: ${stats.apiCalls}`);
      console.log(`    Input Tokens: ${stats.inputTokens.toLocaleString()}`);
      console.log(`    Output Tokens: ${stats.outputTokens.toLocaleString()}`);
      console.log(`    Total Tokens: ${stats.totalTokens.toLocaleString()}`);
      if (stats.totalCost > 0) {
        console.log(`    Input Cost: $${stats.inputCost.toFixed(4)}`);
        console.log(`    Output Cost: $${stats.outputCost.toFixed(4)}`);
        console.log(`    Total Cost: $${stats.totalCost.toFixed(4)}`);
      } else {
        console.log(`    Cost: Free`);
      }
    }

    console.log("\n─────────────────────────────────────────");
    console.log("Totals Across All Models:");
    console.log(`  Total API Calls: ${totals.totalApiCalls}`);
    console.log(
      `  Total Input Tokens: ${totals.totalInputTokens.toLocaleString()}`,
    );
    console.log(
      `  Total Output Tokens: ${totals.totalOutputTokens.toLocaleString()}`,
    );
    console.log(`  Total Tokens: ${totals.totalTokens.toLocaleString()}`);
    console.log(`  Total Input Cost: $${totals.totalInputCost.toFixed(4)}`);
    console.log(`  Total Output Cost: $${totals.totalOutputCost.toFixed(4)}`);
    console.log(`  TOTAL COST: $${totals.totalCost.toFixed(4)}`);
    console.log("═════════════════════════════════════════\n");
  }

  /**
   * Reset statistics
   */
  reset(): void {
    this.stats = {
      apiCalls: 0,
      inputTokens: 0,
      outputTokens: 0,
    };
    this.perModelStats.clear();
  }
}

/**
 * Print available models to console
 */
export function printAvailableModels(): void {
  console.log("\n📋 Available Models:");
  const models = listModels();

  for (const { key, config } of models) {
    const isDefault = key === DEFAULT_MODEL_KEY;
    const defaultMarker = isDefault ? " (DEFAULT)" : "";
    const costInfo =
      config.inputCostPerMillion === 0 && config.outputCostPerMillion === 0
        ? "Free"
        : `$${config.inputCostPerMillion}/1M in, $${config.outputCostPerMillion}/1M out`;

    console.log(`  ${key}${defaultMarker}`);
    console.log(`    Name: ${config.name}`);
    console.log(`    ID: ${config.id}`);
    console.log(`    Cost: ${costInfo}`);
    if (config.description) {
      console.log(`    Description: ${config.description}`);
    }
    console.log("");
  }
}
