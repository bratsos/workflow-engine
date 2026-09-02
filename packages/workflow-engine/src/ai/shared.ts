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

export interface OpenRouterRoutingOptions {
  /** Multiplier applied to the registry price for provider.max_price. Default 1.25. Pass 0 to omit max_price entirely. */
  priceHeadroom?: number;
  /** provider.sort. Default "throughput". */
  sort?: "throughput" | "price" | "latency";
  /** provider.require_parameters. Default true. */
  requireParameters?: boolean;
}

export function getModelProvider(
  modelConfig: ModelConfig,
  routing?: OpenRouterRoutingOptions,
): LanguageModelV4 {
  if (modelConfig.provider === "openrouter") {
    const priceHeadroom = routing?.priceHeadroom ?? 1.25;
    const sort = routing?.sort ?? "throughput";
    const requireParameters = routing?.requireParameters ?? true;

    const provider: {
      sort: "throughput" | "price" | "latency";
      require_parameters: boolean;
      max_price?: {
        prompt: number;
        completion: number;
      };
    } = {
      sort,
      require_parameters: requireParameters,
    };

    if (priceHeadroom > 0) {
      provider.max_price = {
        prompt: modelConfig.inputCostPerMillion * priceHeadroom,
        completion: modelConfig.outputCostPerMillion * priceHeadroom,
      };
    }

    return openrouter(modelConfig.id, {
      usage: { include: true },
      extraBody: {
        provider,
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

export interface ProviderResultLike {
  providerMetadata?: Record<string, any>;
  usage?: {
    raw?: Record<string, any>;
    [key: string]: any;
  };
  finalStep?: {
    providerMetadata?: Record<string, any>;
    usage?: {
      raw?: Record<string, any>;
      [key: string]: any;
    };
  };
}

/**
 * Extract actual USD cost as reported by OpenRouter (or other compatible providers),
 * accounting for BYOK upstream inference cost.
 *
 * Never throws, never produces NaN. Returns undefined when provider cost is not available.
 */
export function extractReportedCost(
  result: ProviderResultLike | undefined | null,
): number | undefined {
  if (!result || typeof result !== "object") {
    return undefined;
  }

  const openrouterMeta =
    result.providerMetadata?.openrouter ??
    result.finalStep?.providerMetadata?.openrouter;

  const rawUsage = result.usage?.raw ?? result.finalStep?.usage?.raw;

  const reported = openrouterMeta?.usage?.cost ?? openrouterMeta?.cost;

  if (typeof reported !== "number" || Number.isNaN(reported)) {
    return undefined;
  }

  const isByok =
    rawUsage?.is_byok === true ||
    rawUsage?.isByok === true ||
    openrouterMeta?.usage?.is_byok === true;

  const upstreamRaw =
    rawUsage?.cost_details?.upstream_inference_cost ??
    rawUsage?.costDetails?.upstreamInferenceCost ??
    openrouterMeta?.usage?.costDetails?.upstreamInferenceCost ??
    openrouterMeta?.usage?.cost_details?.upstream_inference_cost;

  const upstream =
    typeof upstreamRaw === "number" && !Number.isNaN(upstreamRaw)
      ? upstreamRaw
      : 0;

  const total = isByok ? reported + upstream : reported;

  if (typeof total !== "number" || Number.isNaN(total)) {
    return undefined;
  }

  return total;
}

export interface CostResolution {
  cost: number;
  reportedCostUsd?: number;
  costSource: "reported" | "estimated";
}

/**
 * Reconcile provider-reported cost with the local static pricing estimate.
 * Prefer reported cost when present, fallback to estimated cost.
 */
export function resolveCost(
  modelKey: ModelKey,
  inputTokens: number,
  outputTokens: number,
  resultLike?: ProviderResultLike | unknown,
  isBatch: boolean = false,
): CostResolution {
  const estimatedCost = calculateCostWithDiscount(
    modelKey,
    inputTokens,
    outputTokens,
    isBatch,
  );
  const reportedCostUsd = extractReportedCost(
    resultLike as ProviderResultLike | undefined,
  );

  if (reportedCostUsd !== undefined) {
    return {
      cost: reportedCostUsd,
      reportedCostUsd,
      costSource: "reported",
    };
  }

  return {
    cost: estimatedCost,
    reportedCostUsd: undefined,
    costSource: "estimated",
  };
}

/**
 * Calculate batch cost for a model config, preferring absolute batch prices if available.
 */
/** Batch transports whose vendor bills its own documented batch discount. */
const NATIVE_BATCH_TRANSPORTS: ReadonlySet<string> = new Set([
  "google",
  "anthropic",
  "openai",
]);

/**
 * Calculate batch cost for a model config.
 *
 * Which price applies depends on the TRANSPORT the batch actually ran on:
 * - a native vendor transport (google/anthropic/openai via @ai-sdk/*) bills the
 *   vendor's documented discount (`batchDiscountPercent`), which is what the
 *   sync CLI records for those vendors;
 * - the OpenRouter transport bills the absolute price of the `:batch` catalog
 *   row (`batch*CostPerMillion`), which is NOT a uniform multiplier.
 * When the transport is unknown, absolute prices win over the percentage.
 */
export function calculateBatchCost(
  modelConfig: ModelConfig,
  inputTokens: number,
  outputTokens: number,
  transport?: string,
): number {
  const baseCost =
    (inputTokens / 1_000_000) * modelConfig.inputCostPerMillion +
    (outputTokens / 1_000_000) * modelConfig.outputCostPerMillion;
  const hasAbsolute =
    modelConfig.batchInputCostPerMillion !== undefined ||
    modelConfig.batchOutputCostPerMillion !== undefined;
  const discount = modelConfig.batchDiscountPercent;

  if (transport && NATIVE_BATCH_TRANSPORTS.has(transport) && discount) {
    return baseCost * (1 - discount / 100);
  }

  if (hasAbsolute) {
    const inputRate =
      modelConfig.batchInputCostPerMillion ?? modelConfig.inputCostPerMillion;
    const outputRate =
      modelConfig.batchOutputCostPerMillion ?? modelConfig.outputCostPerMillion;
    return (
      (inputTokens / 1_000_000) * inputRate +
      (outputTokens / 1_000_000) * outputRate
    );
  }

  if (discount) {
    return baseCost * (1 - discount / 100);
  }

  return baseCost;
}

export function calculateCostWithDiscount(
  modelKey: ModelKey,
  inputTokens: number,
  outputTokens: number,
  isBatch: boolean = false,
  batchTransport?: string,
): number {
  const model = getModel(modelKey);

  if (isBatch) {
    return calculateBatchCost(model, inputTokens, outputTokens, batchTransport);
  }

  const baseCost = calculateCost(modelKey, inputTokens, outputTokens);
  return baseCost.totalCost;
}
