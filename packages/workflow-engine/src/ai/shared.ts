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
import { schemaTargetForModel, withPortableSchema } from "./schema-portability";
import type { AIHelperContext } from "./types";

export const logger = createLogger("AIHelper");

export interface OpenRouterRoutingOptions {
  /** Multiplier applied to the registry price for provider.max_price. Default 1.25. Pass 0 to omit max_price entirely. */
  priceHeadroom?: number;
  /** provider.sort. Default "throughput". */
  sort?: "throughput" | "price" | "latency";
  /** provider.require_parameters. Default true. */
  requireParameters?: boolean;
}

export function buildOpenRouterRoutingProvider(
  modelConfig: ModelConfig,
  routing?: OpenRouterRoutingOptions,
): {
  sort: "throughput" | "price" | "latency";
  require_parameters: boolean;
  max_price?: {
    prompt: number;
    completion: number;
  };
} {
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

  return provider;
}

export function getModelProvider(
  modelConfig: ModelConfig,
  routing?: OpenRouterRoutingOptions,
): LanguageModelV4 {
  if (modelConfig.provider === "openrouter") {
    const provider = buildOpenRouterRoutingProvider(modelConfig, routing);

    return openrouter(modelConfig.id, {
      usage: { include: true },
      extraBody: {
        provider,
      },
    });
  }
  if (modelConfig.provider === "google") {
    // A registry entry may carry the catalog slug (`google/gemini-...`) so
    // the same key serves the Google batch path; the Google API itself
    // wants the bare model id (the slug 404s).
    return google(modelConfig.id.replace(/^google\//, ""));
  }

  throw new Error(
    `Unsupported provider "${modelConfig.provider}" for model "${modelConfig.id}". ` +
      `Use a built-in provider ("openrouter", "google") or supply a providerResolver.`,
  );
}

/**
 * The language model for a registry entry — the helper's `providerResolver`
 * first, then the built-in providers — wrapped so structured-output
 * requests carry a schema the target accepts (see schema-portability.ts).
 */
export function resolveLanguageModel(
  ctx: Pick<AIHelperContext, "providerResolver" | "routing">,
  modelConfig: ModelConfig,
): LanguageModelV4 {
  const model =
    ctx.providerResolver?.(modelConfig) ??
    getModelProvider(modelConfig, ctx.routing);
  return withPortableSchema(model, schemaTargetForModel(modelConfig, model));
}

export interface ProviderResultLike {
  /** A cost the transport itself reported, in USD (adapters). */
  costUsd?: number;
  providerMetadata?: Record<string, any>;
  usage?: {
    raw?: Record<string, any>;
    [key: string]: any;
  };
  /** Multi-step aggregate usage (streamText's onEnd event). */
  totalUsage?: {
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

export interface UsageDetails {
  /** Input tokens served from the prompt cache; part of `inputTokens`. */
  cachedInputTokens?: number;
  /** Reasoning tokens the model emitted; part of `outputTokens`. */
  reasoningTokens?: number;
}

function tokenCountOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

/**
 * Cached-input and reasoning token counts, from the AI SDK 7 usage shape
 * (`usage.inputTokenDetails.cacheReadTokens`,
 * `usage.outputTokenDetails.reasoningTokens`) first, then OpenRouter's own
 * accounting (`providerMetadata.openrouter.usage.promptTokensDetails.cachedTokens`,
 * `...completionTokensDetails.reasoningTokens`) and the raw
 * `prompt_tokens_details` / `completion_tokens_details` fields. Both sources
 * report these as breakdowns of the prompt and completion totals, not in
 * addition to them, so nothing here changes `inputTokens` or `outputTokens`.
 * Never throws; a count that is absent everywhere stays undefined.
 */
export function extractUsageDetails(
  result: ProviderResultLike | undefined | null,
): UsageDetails {
  if (!result || typeof result !== "object") {
    return {};
  }
  const usage = result.usage ?? result.totalUsage ?? result.finalStep?.usage;
  const openrouterUsage = (
    result.providerMetadata?.openrouter ??
    result.finalStep?.providerMetadata?.openrouter
  )?.usage;
  const raw = usage?.raw ?? result.finalStep?.usage?.raw;

  const cachedInputTokens =
    tokenCountOrUndefined(usage?.inputTokenDetails?.cacheReadTokens) ??
    tokenCountOrUndefined(usage?.cachedInputTokens) ??
    tokenCountOrUndefined(openrouterUsage?.promptTokensDetails?.cachedTokens) ??
    tokenCountOrUndefined(raw?.prompt_tokens_details?.cached_tokens);
  const reasoningTokens =
    tokenCountOrUndefined(usage?.outputTokenDetails?.reasoningTokens) ??
    tokenCountOrUndefined(usage?.reasoningTokens) ??
    tokenCountOrUndefined(
      openrouterUsage?.completionTokensDetails?.reasoningTokens,
    ) ??
    tokenCountOrUndefined(raw?.completion_tokens_details?.reasoning_tokens);

  return {
    ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
    ...(reasoningTokens !== undefined ? { reasoningTokens } : {}),
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

  if (typeof result.costUsd === "number" && !Number.isNaN(result.costUsd)) {
    return result.costUsd;
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

/**
 * The endpoint that served the request: OpenRouter's `provider` metadata
 * (the upstream it routed to, e.g. "Google", "DeepInfra"). Undefined for
 * providers that do not say.
 */
export function extractServedBy(
  result: ProviderResultLike | undefined | null,
): string | undefined {
  if (!result || typeof result !== "object") {
    return undefined;
  }
  const openrouterMeta =
    result.providerMetadata?.openrouter ??
    result.finalStep?.providerMetadata?.openrouter;
  const served = openrouterMeta?.provider;
  return typeof served === "string" && served.length > 0 ? served : undefined;
}

export interface CostResolution {
  /** Authoritative figure: reported when available, else estimated. */
  cost: number;
  /** The catalogue estimate, always computed. */
  estimatedCostUsd: number;
  reportedCostUsd?: number;
  costSource: "reported" | "estimated";
  /** The endpoint that served the request, when the provider names it. */
  servedBy?: string;
  /** Input tokens served from the prompt cache (part of `inputTokens`), when reported. */
  cachedInputTokens?: number;
  /** Reasoning tokens (part of `outputTokens`), when reported. */
  reasoningTokens?: number;
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
  const providerResult = resultLike as ProviderResultLike | undefined;
  const usageDetails = extractUsageDetails(providerResult);
  const estimatedCost = calculateCostWithDiscount(
    modelKey,
    inputTokens,
    outputTokens,
    isBatch,
    undefined,
    usageDetails.cachedInputTokens,
  );
  const reportedCostUsd = extractReportedCost(providerResult);
  const servedBy = extractServedBy(providerResult);
  const extras = {
    ...(servedBy !== undefined ? { servedBy } : {}),
    ...usageDetails,
  };

  if (reportedCostUsd !== undefined) {
    return {
      cost: reportedCostUsd,
      estimatedCostUsd: estimatedCost,
      reportedCostUsd,
      costSource: "reported",
      ...extras,
    };
  }

  return {
    cost: estimatedCost,
    estimatedCostUsd: estimatedCost,
    reportedCostUsd: undefined,
    costSource: "estimated",
    ...extras,
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

/**
 * The catalogue estimate for a call. `cachedInputTokens` (part of
 * `inputTokens`) is billed at the model's cached-input rate on the realtime
 * path; batch prices are absolute per-row figures with no published cache
 * tier, so a batch estimate bills every input token at the batch rate.
 */
export function calculateCostWithDiscount(
  modelKey: ModelKey,
  inputTokens: number,
  outputTokens: number,
  isBatch: boolean = false,
  batchTransport?: string,
  cachedInputTokens?: number,
): number {
  const model = getModel(modelKey);

  if (isBatch) {
    return calculateBatchCost(model, inputTokens, outputTokens, batchTransport);
  }

  const baseCost = calculateCost(
    modelKey,
    inputTokens,
    outputTokens,
    cachedInputTokens,
  );
  return baseCost.totalCost;
}

const NO_ENDPOINTS =
  /No endpoints found that can handle the requested parameters/;

/**
 * OpenRouter answers "No endpoints found that can handle the requested
 * parameters" when `provider.require_parameters` (on by default) excludes
 * every endpoint that does not honour one of the request's parameters —
 * most often `maxTokens` on a model whose endpoints do not all accept it.
 * The raw message reads like an outage; say what to change.
 */
export function explainRoutingError(
  error: unknown,
  routing: OpenRouterRoutingOptions | undefined,
  modelKey: string,
): unknown {
  if (!(error instanceof Error) || !NO_ENDPOINTS.test(error.message)) {
    return error;
  }
  if (routing?.requireParameters === false) return error;
  const explained = new Error(
    `OpenRouter found no endpoint honouring every requested parameter for "${modelKey}" (routing.requireParameters is true by default, so an endpoint that ignores e.g. maxTokens or temperature is excluded). ` +
      `Set routing: { requireParameters: false } on createAIHelper / AIHelperOptions to accept such endpoints, or drop the parameter. Original: ${error.message}`,
    { cause: error },
  );
  explained.name = error.name;
  return explained;
}
