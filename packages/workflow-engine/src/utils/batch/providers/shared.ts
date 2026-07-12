/**
 * Batch Provider Shared Helpers
 *
 * Boilerplate genuinely repeated across the Google/Anthropic/OpenAI batch
 * providers: the empty-batch guard, model resolution, custom-ID fallback,
 * API key resolution, and the results-retrieved summary log. The
 * SDK-specific request/response handling stays in each provider file.
 */

import type { ModelKey } from "../../../ai/model-helper";
import type { BatchProviderName } from "../model-mapping";
import { resolveModelForProvider } from "../model-mapping";
import type { BatchLogger, RawBatchResult } from "../types";

/** All three providers reject an empty batch the same way. */
export function assertNonEmptyBatch(requests: unknown[]): void {
  if (requests.length === 0) {
    throw new Error("Cannot submit empty batch");
  }
}

/** Resolve the provider-specific model ID for a batch from its first request's model (or the provider default). */
export function resolveBatchModel(
  requests: Array<{ model?: ModelKey }>,
  provider: BatchProviderName,
): { modelKey: ModelKey | undefined; model: string } {
  const modelKey = requests[0]?.model;
  return { modelKey, model: resolveModelForProvider(modelKey, provider) };
}

/** `customId`, falling back to a positional placeholder - shared by all three providers' request mapping. */
export function resolveCustomId(
  customId: string | undefined,
  index: number,
): string {
  return customId || `request-${index}`;
}

/** Resolve the API key from explicit config or an env var, throwing a consistent error if neither is set. */
export function resolveApiKey(
  configApiKey: string | undefined,
  envVar: string,
  providerLabel: string,
): string {
  const apiKey = configApiKey || process.env[envVar];
  if (!apiKey) {
    throw new Error(
      `${providerLabel} API key is required. Set ${envVar} or pass apiKey in config.`,
    );
  }
  return apiKey;
}

/** Log the `"<Provider> batch results retrieved"` summary shared by providers whose getResults() logs a final tally. */
export function logBatchResultsSummary(
  logger: BatchLogger | undefined,
  providerLabel: string,
  batchId: string,
  results: RawBatchResult[],
): void {
  logger?.log("INFO", `${providerLabel} batch results retrieved`, {
    batchId,
    resultCount: results.length,
    successCount: results.filter((r) => !r.error).length,
    errorCount: results.filter((r) => r.error).length,
  });
}
