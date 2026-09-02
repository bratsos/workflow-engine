/**
 * Catalog → ModelConfig transform used by the `workflow-engine-sync` CLI.
 *
 * Deliberately free of side effects (no fetch, no fs, no process) so the
 * derivation rules can be unit-tested. The CLI in sync-models.ts owns I/O.
 */

import type { ModelConfig } from "../ai/model-helper";

export interface OpenRouterPricingOverride {
  min_prompt_tokens?: number;
  prompt?: string;
  completion?: string;
  [key: string]: unknown;
}

export interface OpenRouterModel {
  id: string;
  name: string;
  description?: string;
  context_length?: number;
  architecture?: {
    input_modalities?: string[];
    output_modalities?: string[];
  };
  pricing?: {
    prompt?: string;
    completion?: string;
    overrides?: OpenRouterPricingOverride[];
  };
  supported_parameters?: string[];
  top_provider?: {
    context_length?: number;
    max_completion_tokens?: number;
  };
}

export interface OpenRouterResponse {
  data: OpenRouterModel[];
  total_count?: number;
  links?: {
    next?: string | null;
    [key: string]: unknown;
  };
}

/**
 * Vendors whose AI SDK provider (`@ai-sdk/google`, `@ai-sdk/anthropic`,
 * `@ai-sdk/openai`) implements the batch seam natively. Any text model from
 * these vendors can be batched through that transport regardless of whether
 * OpenRouter publishes a `:batch` variant for it.
 */
export const NATIVE_BATCH_VENDORS: ReadonlySet<string> = new Set([
  "google",
  "anthropic",
  "openai",
]);

/**
 * The batch discount every native vendor transport documents: OpenAI Batch,
 * Anthropic Message Batches, and Gemini Batch are all 50% off standard
 * per-token pricing. Used ONLY for the native transports; the OpenRouter
 * transport always uses the absolute price from the `:batch` catalog row,
 * because OpenRouter's multipliers range from 0.25x to 4x and a flat rule is
 * wrong for a fifth of them.
 */
export const NATIVE_BATCH_DISCOUNT_PERCENT = 50;

/** Convert an OpenRouter per-token price string to USD per million tokens. */
export function perMillion(perToken: string | undefined): number {
  return (
    Math.round(Number.parseFloat(perToken || "0") * 1_000_000 * 10000) / 10000
  );
}

/** The part of an OpenRouter slug before the first "/", or "" if none. */
export function vendorOf(id: string): string {
  const i = id.indexOf("/");
  return i === -1 ? "" : id.slice(0, i);
}

export function isEmbeddingModel(model: OpenRouterModel): boolean {
  const outputs = model.architecture?.output_modalities;
  return Boolean(
    outputs?.includes("embeddings") || outputs?.includes("embedding"),
  );
}

/** True when the model produces text. Missing architecture is treated as text. */
export function producesText(model: OpenRouterModel): boolean {
  const outputs = model.architecture?.output_modalities;
  return outputs === undefined || outputs.includes("text");
}

export type BatchCapability = Pick<
  ModelConfig,
  | "supportsAsyncBatch"
  | "batchModelId"
  | "batchInputCostPerMillion"
  | "batchOutputCostPerMillion"
  | "batchDiscountPercent"
>;

/**
 * Decide whether — and through which transports — a model can be batched.
 *
 * Two independent signals, either of which makes the model batch-capable:
 *
 * 1. **OpenRouter transport**: the catalog publishes an `<id>:batch` sibling.
 *    Its prices are recorded verbatim as absolute per-million figures, and
 *    `batchModelId` names the sibling. This is the only source of truth for
 *    OpenRouter batch pricing — never a multiplier.
 *
 * 2. **Native transport**: the vendor is one of {@link NATIVE_BATCH_VENDORS}
 *    and the model is a text (non-embedding) model. The vendor's documented
 *    discount is recorded as `batchDiscountPercent`.
 *
 * Deriving capability from the catalog sibling alone (what 0.13.0 first
 * shipped) under-reports the native transports: zertai's default batch model
 * `google/gemini-3.1-flash-lite-preview` has no `:batch` row in the catalog,
 * so that rule would have made `ai.batch()` throw for it on upgrade.
 */
export function deriveBatchCapability(
  model: OpenRouterModel,
  catalog: ReadonlyMap<string, OpenRouterModel>,
): BatchCapability {
  const sibling = catalog.get(`${model.id}:batch`);
  const nativeCapable =
    NATIVE_BATCH_VENDORS.has(vendorOf(model.id)) &&
    producesText(model) &&
    !isEmbeddingModel(model);

  if (!sibling && !nativeCapable) {
    return {};
  }

  const capability: BatchCapability = { supportsAsyncBatch: true };

  if (sibling) {
    capability.batchModelId = `${model.id}:batch`;
    capability.batchInputCostPerMillion = perMillion(sibling.pricing?.prompt);
    capability.batchOutputCostPerMillion = perMillion(
      sibling.pricing?.completion,
    );
  }

  if (nativeCapable) {
    capability.batchDiscountPercent = NATIVE_BATCH_DISCOUNT_PERCENT;
  }

  return capability;
}

export function deriveLongContextTier(
  model: OpenRouterModel,
): ModelConfig["longContextTier"] | undefined {
  const override = model.pricing?.overrides?.find(
    (o) => typeof o.min_prompt_tokens === "number",
  );
  if (!override || typeof override.min_prompt_tokens !== "number") {
    return undefined;
  }
  return {
    minPromptTokens: override.min_prompt_tokens,
    inputCostPerMillion: perMillion(override.prompt),
    outputCostPerMillion: perMillion(override.completion),
  };
}

/** Build the registry entry for one catalog row. Pure. */
export function toModelConfig(
  model: OpenRouterModel,
  catalog: ReadonlyMap<string, OpenRouterModel>,
): ModelConfig {
  const embedding = isEmbeddingModel(model);
  const supportsTools = model.supported_parameters?.includes("tools") ?? false;
  const supportsStructuredOutputs =
    model.supported_parameters?.includes("structured_outputs") ?? false;
  const longContextTier = deriveLongContextTier(model);

  return {
    id: model.id,
    name: model.name,
    inputCostPerMillion: perMillion(model.pricing?.prompt),
    outputCostPerMillion: perMillion(model.pricing?.completion),
    provider: "openrouter",
    description: model.description,
    contextLength: model.top_provider?.context_length ?? model.context_length,
    maxCompletionTokens: model.top_provider?.max_completion_tokens,
    ...(embedding && { isEmbeddingModel: true }),
    ...(supportsTools && { supportsTools: true }),
    ...(supportsStructuredOutputs && { supportsStructuredOutputs: true }),
    ...deriveBatchCapability(model, catalog),
    ...(longContextTier && { longContextTier }),
  };
}
