/**
 * AI Helper - Shared Internal Helpers
 *
 * Small cross-cutting helpers used by generate.ts, embeddings.ts, stream.ts,
 * and ai-helper.ts. Not part of the public API.
 */

import { google } from "@ai-sdk/google";
import type { LanguageModelV3 } from "@ai-sdk/provider";
import { openrouter } from "@openrouter/ai-sdk-provider";
import { createLogger } from "../utils/logger";
import {
  calculateCost,
  getModel,
  type ModelConfig,
  type ModelKey,
} from "./model-helper";

export const logger = createLogger("AIHelper");

export function getModelProvider(modelConfig: ModelConfig): LanguageModelV3 {
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

export function calculateCostWithDiscount(
  modelKey: ModelKey,
  inputTokens: number,
  outputTokens: number,
  isBatch: boolean = false,
): number {
  const model = getModel(modelKey);
  const baseCost = calculateCost(modelKey, inputTokens, outputTokens);

  if (isBatch && model.batchDiscountPercent) {
    return baseCost.totalCost * (1 - model.batchDiscountPercent / 100);
  }

  return baseCost.totalCost;
}
