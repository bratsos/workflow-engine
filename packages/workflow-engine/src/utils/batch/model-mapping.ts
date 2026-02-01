/**
 * Model Mapping for Batch Providers
 *
 * Dynamically maps models from the registry to provider-specific batch API identifiers.
 * Uses the `supportsAsyncBatch` flag and OpenRouter ID prefix to determine compatibility.
 */

import z from "zod";
import {
  getModel,
  listModels,
  ModelKey,
  ModelConfig,
} from "../../ai/model-helper";

// =============================================================================
// Provider Types
// =============================================================================

export const BatchProviderName = z.enum(["google", "anthropic", "openai"]);
export type BatchProviderName = z.infer<typeof BatchProviderName>;

// =============================================================================
// Dynamic Model Resolution
// =============================================================================

/**
 * Extract the native batch API model ID from an OpenRouter model ID
 *
 * OpenRouter IDs are typically: "provider/model-name"
 * Native batch APIs just need: "model-name"
 */
function extractNativeModelId(
  openRouterId: string,
  provider: BatchProviderName,
): string {
  const prefix = `${provider}/`;
  if (openRouterId.startsWith(prefix)) {
    return openRouterId.slice(prefix.length);
  }
  // Handle Google's special case (google/ prefix but also gemini in ID)
  if (provider === "google" && openRouterId.startsWith("google/")) {
    return openRouterId.slice("google/".length);
  }
  return openRouterId;
}

/**
 * Get the provider from an OpenRouter model ID
 */
function getProviderFromOpenRouterId(
  openRouterId: string,
): BatchProviderName | undefined {
  if (openRouterId.startsWith("google/") || openRouterId.includes("gemini")) {
    return "google";
  }
  if (
    openRouterId.startsWith("anthropic/") ||
    openRouterId.includes("claude")
  ) {
    return "anthropic";
  }
  if (openRouterId.startsWith("openai/") || openRouterId.includes("gpt")) {
    return "openai";
  }
  return undefined;
}

// =============================================================================
// Mapping Functions
// =============================================================================

/**
 * Get the provider-specific model ID for a given ModelKey
 * Dynamically checks if the model supports async batch and extracts the native ID
 *
 * @param modelKey - The ModelKey from model-helper.ts
 * @param provider - The batch provider to get the model ID for
 * @returns Provider-specific model ID or undefined if not supported
 */
export function getProviderModelId(
  modelKey: ModelKey,
  provider: BatchProviderName,
): string | undefined {
  const modelConfig = getModel(modelKey);

  // Check if model supports batching
  if (!modelConfig.supportsAsyncBatch) {
    return undefined;
  }

  // Check if model belongs to this provider
  const modelProvider = getProviderFromOpenRouterId(modelConfig.id);
  if (modelProvider !== provider) {
    return undefined;
  }

  // Extract native model ID
  return extractNativeModelId(modelConfig.id, provider);
}

/**
 * Get default model for a provider by finding the first batch-compatible model
 */
function getDefaultModelForProvider(provider: BatchProviderName): string {
  const models = listModels({
    supportsAsyncBatch: true,
    isEmbeddingModel: false,
  });

  for (const { config } of models) {
    const modelProvider = getProviderFromOpenRouterId(config.id);
    if (modelProvider === provider) {
      return extractNativeModelId(config.id, provider);
    }
  }

  // Fallbacks if no models found in registry
  throw new Error(
    `No batch-compatible models found for ${provider}. ` +
      `Ensure you have models with supportsAsyncBatch: true in your generated models file.`,
  );
}

/**
 * Get the provider-specific model ID, with fallback to default
 *
 * @param modelKey - The ModelKey from model-helper.ts (optional)
 * @param provider - The batch provider
 * @returns Provider-specific model ID
 * @throws Error if model is not supported by the provider
 */
export function resolveModelForProvider(
  modelKey: ModelKey | undefined,
  provider: BatchProviderName,
): string {
  // No model specified - use default
  if (!modelKey) {
    return getDefaultModelForProvider(provider);
  }

  // Get model config and check batch support
  const modelConfig = getModel(modelKey);

  // Check if model supports batching
  if (!modelConfig.supportsAsyncBatch) {
    throw new Error(
      `Model "${modelKey}" does not support async batch processing.`,
    );
  }

  // Check if model is compatible with requested provider
  const modelProvider = getProviderFromOpenRouterId(modelConfig.id);
  if (modelProvider !== provider) {
    throw new Error(
      `Model "${modelKey}" belongs to ${modelProvider || "unknown"} provider, ` +
        `not ${provider}. Use a ${provider} model or change the batch provider.`,
    );
  }

  return extractNativeModelId(modelConfig.id, provider);
}

/**
 * Get list of OpenRouter model IDs supported by a provider for batching
 * Dynamically reads from the registry
 */
export function getSupportedModels(provider: BatchProviderName): string[] {
  const models = listModels({
    supportsAsyncBatch: true,
    isEmbeddingModel: false,
  });

  return models
    .filter(({ config }) => getProviderFromOpenRouterId(config.id) === provider)
    .map(({ config }) => config.id);
}

/**
 * Check if a ModelKey is supported by a provider for batching
 */
export function isModelSupported(
  modelKey: ModelKey,
  provider: BatchProviderName,
): boolean {
  return getProviderModelId(modelKey, provider) !== undefined;
}

/**
 * Get the best provider for a given ModelKey
 * Returns the provider that natively supports the model
 */
export function getBestProviderForModel(
  modelKey: ModelKey,
): BatchProviderName | undefined {
  const modelConfig = getModel(modelKey);

  if (!modelConfig.supportsAsyncBatch) {
    return undefined;
  }

  return getProviderFromOpenRouterId(modelConfig.id);
}

/**
 * Get all models that support async batching from the registry
 */
export function getBatchCompatibleModels(): Array<{
  key: string;
  config: ModelConfig;
}> {
  return listModels({ supportsAsyncBatch: true, isEmbeddingModel: false });
}
