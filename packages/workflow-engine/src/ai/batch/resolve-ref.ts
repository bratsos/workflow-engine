import type { BatchOptions } from "../types";
import { type AiSdkBatchModelOptions, resolveAiSdkBatchModel } from "./ai-sdk";
import {
  batchProviderFromRefProvider,
  type EngineBatchModel,
  type EngineBatchRef,
} from "./model";
import { createOpenRouterBatchModel } from "./openrouter";

/**
 * The built-in transport for a stored batch ref, for a process that did not
 * create the batch (`run.cancel` is the caller). The ref names the provider
 * and the native model id. Pass only options that belong to that provider.
 * Without explicit options, the resolver uses the provider's default URL and
 * environment credentials (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`,
 * `GOOGLE_GENERATIVE_AI_API_KEY` / `GEMINI_API_KEY`, `OPENROUTER_API_KEY`).
 *
 * Throws when no built-in transport serves the ref's provider, when the vendor
 * package is not installed, or when OpenRouter has no key. A key a vendor SDK
 * cannot find surfaces on the first call, as the SDK's `AI_LoadAPIKeyError`.
 */
export async function resolveBatchModelForRef(
  ref: EngineBatchRef,
  options: AiSdkBatchModelOptions & Pick<BatchOptions, "endpoint"> = {},
): Promise<EngineBatchModel> {
  const provider = batchProviderFromRefProvider(ref.provider);
  if (provider === undefined) {
    throw new Error(
      `No built-in batch transport serves provider "${ref.provider}".`,
    );
  }
  if (provider !== "openrouter") {
    return resolveAiSdkBatchModel(provider, ref.modelId, options);
  }
  const apiKey =
    options.apiKey ??
    (typeof process !== "undefined"
      ? process.env?.OPENROUTER_API_KEY
      : undefined);
  if (!apiKey) {
    throw new Error(
      "OpenRouter batch access needs an API key: pass apiKey or set OPENROUTER_API_KEY.",
    );
  }
  return createOpenRouterBatchModel({
    apiKey,
    modelId: ref.modelId,
    ...(options.baseURL !== undefined ? { baseURL: options.baseURL } : {}),
    ...(options.fetch !== undefined
      ? { fetch: options.fetch as typeof globalThis.fetch }
      : {}),
    ...(options.endpoint !== undefined ? { endpoint: options.endpoint } : {}),
  });
}
