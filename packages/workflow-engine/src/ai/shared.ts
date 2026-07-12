/**
 * AI Helper - Shared Internal Helpers
 *
 * Small cross-cutting helpers used by generate.ts, embeddings.ts, stream.ts,
 * and ai-helper.ts. Not part of the public API.
 */

import { google } from "@ai-sdk/google";
import type { LanguageModelV4 } from "@ai-sdk/provider";
import { openrouter } from "@openrouter/ai-sdk-provider";
import { createLogger } from "../utils/logger";
import {
  calculateCost,
  getModel,
  type ModelConfig,
  type ModelKey,
} from "./model-helper";

export const logger = createLogger("AIHelper");

export function getModelProvider(modelConfig: ModelConfig): LanguageModelV4 {
  if (modelConfig.provider === "openrouter") {
    // strict pricing: don't pay more than the model's defined cost
    // this effectively prevents routing to more expensive providers
    // require_parameters ensures routing only to providers that support
    // the requested features (e.g., json_schema for structured output)
    return openrouter(modelConfig.id, {
      extraBody: {
        provider: {
          sort: "throughput",
          require_parameters: true,
          max_price: {
            prompt: modelConfig.inputCostPerMillion,
            completion: modelConfig.outputCostPerMillion,
          },
        },
      },
    });
  }
  if (modelConfig.provider === "google") {
    return google(modelConfig.id);
  }

  throw new Error(
    `Unsupported provider "${modelConfig.provider}" for model "${modelConfig.id}". ` +
      `Use a built-in provider ("openrouter", "google") or supply a providerResolver.`,
  );
}

/** Optional per-call token breakdown used to refine cost beyond the flat input/output rates. */
export interface CostUsageDetail {
  /** Input tokens served from a provider-side cache (subset of `inputTokens`; billed separately when the model has `cachedInputCostPerMillion`). */
  cachedInputTokens?: number;
  /** Output tokens spent reasoning (subset of `outputTokens`; billed separately when the model has `reasoningCostPerMillion`). */
  reasoningTokens?: number;
}

export function calculateCostWithDiscount(
  modelKey: ModelKey,
  inputTokens: number,
  outputTokens: number,
  isBatch: boolean = false,
  usageDetail?: CostUsageDetail,
): number {
  const model = getModel(modelKey);
  const hasCachedRate = model.cachedInputCostPerMillion !== undefined;
  const hasReasoningRate = model.reasoningCostPerMillion !== undefined;

  // No refined rates configured: identical to the pre-refinement code path,
  // so cost is byte-for-byte unchanged for models without the new fields.
  let baseCost: number;
  if (!hasCachedRate && !hasReasoningRate) {
    baseCost = calculateCost(modelKey, inputTokens, outputTokens).totalCost;
  } else {
    // v7 `inputTokens`/`outputTokens` are inclusive of cached/reasoning
    // tokens, so the refined rate applies only to the cached/reasoning slice
    // and the base rate covers the remainder.
    const cacheRead = usageDetail?.cachedInputTokens ?? 0;
    const reasoning = usageDetail?.reasoningTokens ?? 0;

    const inputCost = hasCachedRate
      ? ((inputTokens - cacheRead) / 1_000_000) * model.inputCostPerMillion +
        (cacheRead / 1_000_000) * (model.cachedInputCostPerMillion as number)
      : (inputTokens / 1_000_000) * model.inputCostPerMillion;

    const outputCost = hasReasoningRate
      ? ((outputTokens - reasoning) / 1_000_000) * model.outputCostPerMillion +
        (reasoning / 1_000_000) * (model.reasoningCostPerMillion as number)
      : (outputTokens / 1_000_000) * model.outputCostPerMillion;

    baseCost = inputCost + outputCost;
  }

  if (isBatch && model.batchDiscountPercent) {
    return baseCost * (1 - model.batchDiscountPercent / 100);
  }

  return baseCost;
}

/**
 * Fields shared by `TextOptions`/`ObjectOptions`/`StreamOptions` that pass
 * straight through to the underlying AI SDK call under the same name.
 * Centralized here so generate.ts/stream.ts don't each repeat the same
 * eleven-field conditional spread.
 */
export interface CommonCallOptionsLike {
  topP?: unknown;
  topK?: unknown;
  frequencyPenalty?: unknown;
  presencePenalty?: unknown;
  seed?: unknown;
  stopSequences?: unknown;
  headers?: unknown;
  reasoning?: unknown;
  telemetry?: unknown;
  activeTools?: unknown;
  prepareStep?: unknown;
}

const COMMON_CALL_OPTION_FIELDS = [
  "topP",
  "topK",
  "frequencyPenalty",
  "presencePenalty",
  "seed",
  "stopSequences",
  "headers",
  "reasoning",
  "telemetry",
  "activeTools",
  "prepareStep",
] as const satisfies ReadonlyArray<keyof CommonCallOptionsLike>;

/** Passthrough spread for the {@link CommonCallOptionsLike} fields, omitting any that are undefined. */
export function buildCommonCallOptions(
  options: CommonCallOptionsLike,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const field of COMMON_CALL_OPTION_FIELDS) {
    const value = options[field];
    if (value !== undefined) result[field] = value;
  }
  return result;
}

/**
 * Build the `{ usageDetail: {...} }` metadata fragment for the AICall ledger,
 * omitting keys the provider didn't report. Returns an empty object when
 * every field is undefined, so spreading it into `metadata` is a no-op.
 */
export function buildUsageDetailMetadata(detail: {
  totalTokens?: number;
  cachedInputTokens?: number;
  reasoningTokens?: number;
}): { usageDetail: Record<string, number> } | Record<string, never> {
  const entries = Object.entries(detail).filter(
    ([, value]) => value !== undefined,
  );
  if (entries.length === 0) return {};
  return { usageDetail: Object.fromEntries(entries) };
}
