/**
 * Model Mapping for Batch Providers
 *
 * Dynamically maps models from the registry to provider-specific batch API identifiers.
 * Uses the `supportsAsyncBatch` flag and catalog slug parsing.
 */

import z from "zod";
import {
  getModel,
  listModels,
  type ModelConfig,
  type ModelKey,
} from "../../ai/model-helper";

// =============================================================================
// Provider Types
// =============================================================================

const NATIVE_VENDORS: ReadonlySet<string> = new Set([
  "google",
  "anthropic",
  "openai",
]);

export const BatchProviderName = z.enum([
  "google",
  "anthropic",
  "openai",
  "openrouter",
]);
export type BatchProviderName = z.infer<typeof BatchProviderName>;

// =============================================================================
// Slug Parsing Helpers
// =============================================================================

/**
 * Parses an OpenRouter slug into a vendor and native model id.
 * Splits on the first "/" and strips any trailing ":variant" suffix.
 */
function parseModelSlug(slug: string): { vendor: string; nativeId: string } {
  const slashIndex = slug.indexOf("/");
  const vendor = slashIndex !== -1 ? slug.slice(0, slashIndex) : "";
  let nativeId = slashIndex !== -1 ? slug.slice(slashIndex + 1) : slug;
  const colonIndex = nativeId.indexOf(":");
  if (colonIndex !== -1) {
    nativeId = nativeId.slice(0, colonIndex);
  }
  return { vendor, nativeId };
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

  const { vendor, nativeId } = parseModelSlug(modelConfig.id);
  if (provider === "openrouter") {
    // OpenRouter can only batch models it publishes batch pricing for. A
    // native-vendor model that is batch-capable through @ai-sdk/* but has no
    // ":batch" catalog row is NOT reachable through this transport.
    return modelConfig.batchModelId ? modelConfig.id : undefined;
  }
  if (vendor !== provider) {
    return undefined;
  }

  return nativeId;
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
    const { vendor, nativeId } = parseModelSlug(config.id);
    if (provider === "openrouter") {
      if (config.batchModelId) return config.id;
      continue;
    }
    if (vendor === provider) {
      return nativeId;
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

  const { vendor, nativeId } = parseModelSlug(modelConfig.id);

  if (provider === "openrouter") {
    // A model that names OpenRouter as its batch transport is batched there
    // even without a catalog ":batch" row (the cost then falls back to the
    // base price or `batchDiscountPercent`); the pricing check guards the
    // models that were merely synced from the catalog.
    if (
      !modelConfig.batchModelId &&
      modelConfig.batchProvider !== "openrouter"
    ) {
      const hint = NATIVE_VENDORS.has(vendor)
        ? `Use the native "${vendor}" provider instead: ai.batch(modelKey, "${vendor}").`
        : `Pick a model that has a ":batch" variant in OpenRouter's catalog.`;
      throw new Error(
        `OpenRouter has no batch pricing for "${modelKey}" (${modelConfig.id}) - ` +
          `the catalog has no "${modelConfig.id}:batch" row. ${hint}`,
      );
    }
    return modelConfig.id;
  }

  if (vendor !== provider) {
    throw new Error(
      `Model "${modelKey}" belongs to ${vendor || "unknown"} provider, ` +
        `not ${provider}. Use a ${provider} model or change the batch provider.`,
    );
  }

  return nativeId;
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
    .filter(({ config }) => {
      const { vendor } = parseModelSlug(config.id);
      if (provider === "openrouter") {
        return true;
      }
      return vendor === provider;
    })
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

  // A registry-level preference wins over the slug heuristic (explicit
  // `batch.provider` on the call wins over both).
  if (modelConfig.batchProvider) {
    return modelConfig.batchProvider;
  }

  const { vendor } = parseModelSlug(modelConfig.id);
  if (vendor === "google" || vendor === "anthropic" || vendor === "openai") {
    return vendor;
  }

  return "openrouter";
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
