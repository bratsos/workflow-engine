/**
 * AI Helper - Shared Internal Helpers
 *
 * Small cross-cutting helpers used by generate.ts, embeddings.ts, stream.ts,
 * and ai-helper.ts. Not part of the public API.
 */

import { google } from "@ai-sdk/google";
import type {
  JSONObject,
  JSONValue,
  LanguageModelV4,
  SharedV4ProviderOptions,
} from "@ai-sdk/provider";
import { openrouter } from "@openrouter/ai-sdk-provider";
import { wrapLanguageModel } from "ai";
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
  /** Upstream provider policy for calls made by this helper and its children. */
  provider?: {
    only?: string[];
    order?: string[];
    allowFallbacks?: boolean;
    dataCollection?: "allow" | "deny";
  };
}

export function assertDirectProviderPolicy(
  provider: string,
  policy: OpenRouterRoutingOptions["provider"],
): void {
  if (policy?.only !== undefined && !policy.only.includes(provider)) {
    throw new Error(
      `Provider "${provider}" is excluded by routing.provider.only.`,
    );
  }
  if (
    policy?.allowFallbacks === false &&
    policy.order?.length &&
    !policy.order.includes(provider)
  ) {
    throw new Error(
      `Provider "${provider}" is outside routing.provider.order and provider fallbacks are disabled.`,
    );
  }
  if (policy?.dataCollection === "deny") {
    throw new Error(
      `Direct provider "${provider}" cannot enforce routing.provider.dataCollection: "deny".`,
    );
  }
}

export function assertAdapterProviderPolicy(
  policy: OpenRouterRoutingOptions["provider"],
): void {
  if (policy !== undefined) {
    throw new Error(
      "The configured AI adapter cannot enforce the helper's provider policy.",
    );
  }
}

export function buildOpenRouterRoutingProvider(
  modelConfig: ModelConfig,
  routing?: OpenRouterRoutingOptions,
  requestProvider?: unknown,
): JSONObject {
  const policy = routing?.provider;
  if (policy?.only?.length === 0) {
    throw new Error(
      "routing.provider.only is empty, so no provider is permitted.",
    );
  }
  if (requestProvider != null && !isRoutingObject(requestProvider)) {
    throw new Error("OpenRouter provider options must be an object.");
  }

  const requested = requestProvider ?? {};
  const priceHeadroom = routing?.priceHeadroom ?? 1.25;
  const configured = {
    sort: routing?.sort ?? ("throughput" as const),
    require_parameters: routing?.requireParameters ?? true,
    ...(priceHeadroom > 0 && {
      max_price: {
        prompt: modelConfig.inputCostPerMillion * priceHeadroom,
        completion: modelConfig.outputCostPerMillion * priceHeadroom,
      },
    }),
  };
  const merged: JSONObject = { ...configured, ...requested };
  const ignore = providerSlugs(requested.ignore, "ignore");
  const requestOnly = providerSlugs(requested.only, "only");
  const configuredOnly = policy?.only ?? requestOnly;
  let only =
    configuredOnly &&
    eligibleProviderSlugs(configuredOnly, requestOnly, ignore);
  if (only?.length === 0) {
    throw new Error(
      "The merged OpenRouter provider allowlist permits no provider.",
    );
  }

  const helperFallbacks = policy?.allowFallbacks;
  const requestFallbacks = requested.allow_fallbacks;
  const allowFallbacks =
    helperFallbacks === false || requestFallbacks === false
      ? false
      : (helperFallbacks ?? requestFallbacks);
  const helperOrder = policy?.order;
  const requestOrder = providerSlugs(requested.order, "order");
  const fromHelper = eligibleProviderSlugs(helperOrder ?? [], only, ignore);
  const fromRequest = eligibleProviderSlugs(requestOrder ?? [], only, ignore);
  let order = fromHelper.length ? fromHelper : fromRequest;
  if (helperOrder?.length && requestOrder?.length) {
    const overlap = intersectProviderSlugs(fromHelper, fromRequest);
    const reverse = intersectProviderSlugs(fromRequest, fromHelper);
    if (overlap.length === 0 || !sameProviderOrder(overlap, reverse)) {
      throw new Error(
        "The helper and per-call OpenRouter provider orders conflict.",
      );
    }
    order = overlap;
  }

  if (
    allowFallbacks === false &&
    (helperOrder?.length || requestOrder?.length)
  ) {
    if (!order.length) {
      throw new Error(
        "The merged OpenRouter provider allowlist and order permit no provider.",
      );
    }
    const singleEndpoint =
      (helperFallbacks === false && !helperOrder?.length) ||
      (requestFallbacks === false && !requestOrder?.length);
    if (singleEndpoint && order.length !== 1) {
      throw new Error(
        "The OpenRouter provider order conflicts with a single-endpoint fallback restriction.",
      );
    }
    // A hard allowlist also excludes private endpoints outside the order.
    only = eligibleProviderSlugs(only ?? order, order, ignore);
    // Adding even a singleton order to an unordered no-fallback request
    // enables backups. Pin its provider through only instead.
    if (singleEndpoint) order = [];
  }

  if (only !== undefined) merged.only = only;
  if (order.length) {
    merged.order = order;
    delete merged.sort;
  } else {
    delete merged.order;
  }
  if (allowFallbacks !== undefined) merged.allow_fallbacks = allowFallbacks;
  if (
    policy?.dataCollection === "deny" ||
    requested.data_collection === "deny"
  ) {
    merged.data_collection = "deny";
  } else if (policy?.dataCollection === "allow") {
    merged.data_collection = "allow";
  }
  if (configured.require_parameters || requested.require_parameters === true) {
    merged.require_parameters = true;
  }
  if (configured.max_price) {
    const requestPrice = requested.max_price;
    if (requestPrice != null && !isRoutingObject(requestPrice)) {
      throw new Error("OpenRouter provider max_price must be an object.");
    }
    const prices: JSONObject = { ...configured.max_price, ...requestPrice };
    for (const [unit, cap] of Object.entries(configured.max_price)) {
      const requested = requestPrice?.[unit];
      if (requested == null || priceLimit(requested) >= cap) prices[unit] = cap;
    }
    merged.max_price = prices;
  }
  return merged;
}

function isRoutingObject(value: unknown): value is JSONObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function providerSlugs(
  value: JSONValue | undefined,
  field: string,
): string[] | undefined {
  if (value == null) return undefined;
  if (
    !Array.isArray(value) ||
    !value.every((slug) => typeof slug === "string" && slug.length > 0)
  ) {
    throw new Error(
      `OpenRouter provider ${field} must be an array of provider slugs.`,
    );
  }
  return value;
}

function sameProviderOrder(first: string[], second: string[]): boolean {
  return (
    first.length === second.length &&
    first.every((slug, index) => slug === second[index])
  );
}

/** Base slugs include variants. A specific slug covers only itself. */
function coversProviderSlug(filter: string, slug: string): boolean {
  return (
    filter === slug || (!filter.includes("/") && slug.startsWith(`${filter}/`))
  );
}

function intersectProviderSlugs(first: string[], second: string[]): string[] {
  const intersection = new Set<string>();
  for (const a of first) {
    for (const b of second) {
      if (coversProviderSlug(b, a)) intersection.add(a);
      else if (coversProviderSlug(a, b)) intersection.add(b);
    }
  }
  return [...intersection];
}

export function eligibleProviderSlugs(
  candidates: string[],
  only?: string[],
  ignore?: string[],
): string[] {
  const included = only
    ? intersectProviderSlugs(candidates, only)
    : [...new Set(candidates)];
  // Keep broad slugs when only some of their variants are excluded. The
  // outgoing ignore list lets OpenRouter apply those finer exclusions.
  return included.filter(
    (slug) => !ignore?.some((filter) => coversProviderSlug(filter, slug)),
  );
}

function priceLimit(value: JSONValue): number {
  const limit =
    typeof value === "number" || (typeof value === "string" && value.trim())
      ? Number(value)
      : Number.NaN;
  if (!Number.isFinite(limit) || limit < 0) {
    throw new Error(
      "OpenRouter provider max_price must use non-negative price limits.",
    );
  }
  return limit;
}

/** The SDK sends the whole per-call provider object in place of the model's provider settings. */
export function mergeOpenRouterProviderOptions(
  options: SharedV4ProviderOptions | undefined,
  modelConfig: ModelConfig,
  routing: OpenRouterRoutingOptions,
): SharedV4ProviderOptions | undefined {
  const openrouterOptions = options?.openrouter;
  if (!openrouterOptions || !("provider" in openrouterOptions)) return options;
  return {
    ...options,
    openrouter: {
      ...openrouterOptions,
      provider: buildOpenRouterRoutingProvider(
        modelConfig,
        routing,
        openrouterOptions.provider,
      ),
    },
  };
}

export function getModelProvider(
  modelConfig: ModelConfig,
  routing?: OpenRouterRoutingOptions,
): LanguageModelV4 {
  if (modelConfig.provider === "openrouter") {
    const provider = buildOpenRouterRoutingProvider(modelConfig, routing);

    const model = openrouter(modelConfig.id, {
      usage: { include: true },
      extraBody: {
        provider,
      },
    });
    if (routing?.provider === undefined) return model;
    return wrapLanguageModel({
      model,
      middleware: {
        specificationVersion: "v4",
        async transformParams({ params }) {
          return {
            ...params,
            providerOptions: mergeOpenRouterProviderOptions(
              params.providerOptions,
              modelConfig,
              routing,
            ),
          };
        },
      },
    });
  }
  if (modelConfig.provider === "google") {
    assertDirectProviderPolicy("google", routing?.provider);
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
  const policy = ctx.routing?.provider;
  const resolved =
    policy === undefined
      ? ctx.providerResolver?.(modelConfig)
      : ctx.providerResolver?.(modelConfig, policy);
  const model = resolved ?? getModelProvider(modelConfig, ctx.routing);
  return withPortableSchema(model, schemaTargetForModel(modelConfig, model));
}

export interface ProviderResultLike {
  /** SDK transport name for a completed model step. */
  model?: { provider?: string };
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
  /**
   * Per-step results of a multi-step call. When two or more carry token
   * counts, the estimate prices each step at its own long-context tier.
   */
  steps?: readonly unknown[];
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

export function extractStepProvider(value: unknown): string | null {
  const step = value as ProviderResultLike | undefined;
  const reported = extractServedBy(step);
  if (reported !== undefined) return reported;
  const transport = step?.model?.provider?.split(".")[0];
  return transport === "google" ||
    transport === "openai" ||
    transport === "anthropic"
    ? transport
    : null;
}

export function summarizeStepProviders(steps: (string | null)[]): {
  servedBy?: string;
  servedBySteps?: (string | null)[];
} {
  const servedBy = [...new Set(steps.filter((name) => name !== null))].join(
    ",",
  );
  return {
    ...(servedBy ? { servedBy } : {}),
    ...(steps.length ? { servedBySteps: [...steps] } : {}),
  };
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
  /** The serving provider for each step, in order. */
  servedBySteps?: (string | null)[];
  /** Input tokens served from the prompt cache (part of `inputTokens`), when reported. */
  cachedInputTokens?: number;
  /** Reasoning tokens (part of `outputTokens`), when reported. */
  reasoningTokens?: number;
}

/**
 * The realtime estimate of a multi-step call, priced step by step. The
 * long-context tier applies per request, so a call whose steps each stay
 * under `minPromptTokens` is billed at the base rate even when their summed
 * input crosses it. Undefined unless the result carries two or more steps
 * that all report finite input and output token counts whose sums (and
 * summed cached-input counts) match the aggregate being estimated; the
 * caller then estimates the aggregate.
 */
function estimateAcrossSteps(
  modelKey: ModelKey,
  result: ProviderResultLike | undefined,
  inputTokens: number,
  outputTokens: number,
  cachedInputTokens: number,
): number | undefined {
  const steps = result && typeof result === "object" ? result.steps : undefined;
  if (!Array.isArray(steps) || steps.length < 2) return undefined;

  let total = 0;
  let inputSum = 0;
  let outputSum = 0;
  let cachedSum = 0;
  for (const step of steps) {
    if (!step || typeof step !== "object") return undefined;
    const usage = (step as ProviderResultLike).usage;
    const input = usage?.inputTokens;
    const output = usage?.outputTokens;
    if (
      typeof input !== "number" ||
      !Number.isFinite(input) ||
      typeof output !== "number" ||
      !Number.isFinite(output)
    ) {
      return undefined;
    }
    const cached =
      extractUsageDetails(step as ProviderResultLike).cachedInputTokens ?? 0;
    inputSum += input;
    outputSum += output;
    cachedSum += cached;
    total += calculateCost(modelKey, input, output, cached).totalCost;
  }
  if (
    inputSum !== inputTokens ||
    outputSum !== outputTokens ||
    cachedSum !== cachedInputTokens
  ) {
    return undefined;
  }
  return total;
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
  const estimatedCost =
    (isBatch
      ? undefined
      : estimateAcrossSteps(
          modelKey,
          providerResult,
          inputTokens,
          outputTokens,
          usageDetails.cachedInputTokens ?? 0,
        )) ??
    calculateCostWithDiscount(
      modelKey,
      inputTokens,
      outputTokens,
      isBatch,
      undefined,
      usageDetails.cachedInputTokens,
    );
  const reportedCostUsd = extractReportedCost(providerResult);
  const steps = providerResult?.steps;
  const providers =
    Array.isArray(steps) && steps.length > 1
      ? summarizeStepProviders(steps.map(extractStepProvider))
      : { servedBy: extractServedBy(providerResult) };
  const extras = {
    ...providers,
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
