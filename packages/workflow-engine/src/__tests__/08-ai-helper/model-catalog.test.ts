/**
 * Batch-capability derivation for the model registry.
 *
 * Two transports can batch a model, and they have different truth sources:
 * OpenRouter's catalog publishes a `<id>:batch` sibling with its own absolute
 * prices; the native AI SDK providers (google / anthropic / openai) can batch
 * any of their text models at a documented 50% discount, whether or not
 * OpenRouter publishes a sibling for it.
 *
 * 0.13.0 originally derived capability from the catalog sibling alone, which
 * would have made `ai.batch()` throw for zertai's default batch model on
 * upgrade. These tests pin the transport-aware rule.
 */

import { beforeAll, describe, expect, it } from "vitest";
import { registerModels } from "../../ai/model-helper.js";
import {
  deriveBatchCapability,
  NATIVE_BATCH_DISCOUNT_PERCENT,
  type OpenRouterModel,
  perMillion,
  toModelConfig,
} from "../../cli/model-catalog.js";
import {
  getBestProviderForModel,
  getProviderModelId,
  resolveModelForProvider,
} from "../../utils/batch/model-mapping.js";

function row(
  id: string,
  extra: Partial<OpenRouterModel> & {
    prompt?: string;
    completion?: string;
  } = {},
): OpenRouterModel {
  const { prompt = "0.000001", completion = "0.000002", ...rest } = extra;
  return {
    id,
    name: id,
    architecture: { input_modalities: ["text"], output_modalities: ["text"] },
    pricing: { prompt, completion },
    ...rest,
  };
}

function catalogOf(...rows: OpenRouterModel[]) {
  return new Map(rows.map((r) => [r.id, r]));
}

describe("deriveBatchCapability", () => {
  it("native vendor text model with NO catalog sibling is batch-capable via the vendor discount", () => {
    // zertai's default batch model. No ":batch" row exists for it.
    const m = row("google/gemini-3.1-flash-lite-preview", {
      prompt: "0.000001",
      completion: "0.000004",
    });
    const cap = deriveBatchCapability(m, catalogOf(m));
    expect(cap.supportsAsyncBatch).toBe(true);
    expect(cap.batchModelId).toBeUndefined();
    // The vendor discount is applied to the model's own prices and recorded
    // as absolute batch prices; the generated file carries no
    // `batchDiscountPercent` (the 0.13 field the codemod flags).
    const factor = 1 - NATIVE_BATCH_DISCOUNT_PERCENT / 100;
    expect(cap.batchInputCostPerMillion).toBe(1 * factor);
    expect(cap.batchOutputCostPerMillion).toBe(4 * factor);
    expect(cap).not.toHaveProperty("batchDiscountPercent");
    expect(cap.batchProvider).toBeUndefined();
  });

  it("catalog sibling supplies absolute prices, rounded exactly like base prices", () => {
    const m = row("deepseek/deepseek-v4", {
      prompt: "0.000003",
      completion: "0.000015",
    });
    const sib = row("deepseek/deepseek-v4:batch", {
      prompt: "0.0000015",
      completion: "0.0000075",
    });
    const cap = deriveBatchCapability(m, catalogOf(m, sib));
    expect(cap.supportsAsyncBatch).toBe(true);
    expect(cap.batchModelId).toBe("deepseek/deepseek-v4:batch");
    expect(cap.batchInputCostPerMillion).toBe(perMillion("0.0000015"));
    expect(cap.batchOutputCostPerMillion).toBe(perMillion("0.0000075"));
    // Only OpenRouter can batch it: the entry names its transport.
    expect(cap.batchProvider).toBe("openrouter");
  });

  it("native vendor WITH a sibling records the sibling's absolute prices and leaves the transport to the default", () => {
    const m = row("anthropic/claude-sonnet-4.5", {
      prompt: "0.000003",
      completion: "0.000015",
    });
    const sib = row("anthropic/claude-sonnet-4.5:batch", {
      prompt: "0.0000015",
      completion: "0.0000075",
    });
    const cap = deriveBatchCapability(m, catalogOf(m, sib));
    expect(cap.batchModelId).toBe("anthropic/claude-sonnet-4.5:batch");
    expect(cap.batchInputCostPerMillion).toBe(1.5);
    expect(cap).not.toHaveProperty("batchDiscountPercent");
    expect(cap.batchProvider).toBeUndefined();
  });

  it("non-native vendor with no sibling is not batch-capable", () => {
    const m = row("inception/mercury-2.5-preview");
    expect(deriveBatchCapability(m, catalogOf(m))).toEqual({});
  });

  it("native image-output model is not batch-capable through the native rule", () => {
    const m = row("openai/gpt-5-image", {
      architecture: {
        input_modalities: ["text"],
        output_modalities: ["image"],
      },
    });
    expect(deriveBatchCapability(m, catalogOf(m))).toEqual({});
  });

  it("native embedding model needs a sibling; four of them really have one", () => {
    const emb = row("openai/text-embedding-3-small", {
      architecture: {
        input_modalities: ["text"],
        output_modalities: ["embeddings"],
      },
    });
    expect(deriveBatchCapability(emb, catalogOf(emb))).toEqual({});
    const sib = row("openai/text-embedding-3-small:batch", {
      architecture: {
        input_modalities: ["text"],
        output_modalities: ["embeddings"],
      },
    });
    const cap = deriveBatchCapability(emb, catalogOf(emb, sib));
    expect(cap.supportsAsyncBatch).toBe(true);
    expect(cap.batchModelId).toBe("openai/text-embedding-3-small:batch");
    expect(cap).not.toHaveProperty("batchDiscountPercent");
  });

  it("treats a row with no architecture block as a text model (inclusion over exclusion)", () => {
    const m: OpenRouterModel = {
      id: "google/gemini-old",
      name: "x",
      pricing: { prompt: "0.000001", completion: "0.000002" },
    };
    expect(deriveBatchCapability(m, catalogOf(m)).supportsAsyncBatch).toBe(
      true,
    );
  });
});

describe("toModelConfig", () => {
  it("assembles a full registry entry from a catalog row", () => {
    const m = row("google/gemini-2.5-flash", {
      description: "d",
      context_length: 1_000_000,
      supported_parameters: ["tools", "structured_outputs"],
      top_provider: {
        context_length: 1_048_576,
        max_completion_tokens: 65_536,
      },
      pricing: {
        prompt: "0.0000003",
        completion: "0.0000025",
        overrides: [
          {
            min_prompt_tokens: 200_000,
            prompt: "0.0000006",
            completion: "0.000005",
          },
        ],
      },
    });
    const sib = row("google/gemini-2.5-flash:batch", {
      prompt: "0.00000015",
      completion: "0.00000125",
    });
    const cfg = toModelConfig(m, catalogOf(m, sib));
    expect(cfg).toMatchObject({
      id: "google/gemini-2.5-flash",
      provider: "openrouter",
      inputCostPerMillion: 0.3,
      outputCostPerMillion: 2.5,
      contextLength: 1_048_576,
      maxCompletionTokens: 65_536,
      supportsTools: true,
      supportsStructuredOutputs: true,
      supportsAsyncBatch: true,
      batchModelId: "google/gemini-2.5-flash:batch",
      batchInputCostPerMillion: 0.15,
      batchOutputCostPerMillion: 1.25,
      longContextTier: {
        minPromptTokens: 200_000,
        inputCostPerMillion: 0.6,
        outputCostPerMillion: 5,
      },
    });
    expect(cfg.isEmbeddingModel).toBeUndefined();
  });
});

describe("transport resolution honours the two signals", () => {
  const NATIVE_ONLY = "cat-test-native-only";
  const WITH_SIBLING = "cat-test-with-sibling";
  const OR_ONLY = "cat-test-openrouter-only";

  beforeAll(() => {
    registerModels({
      [NATIVE_ONLY]: {
        id: "google/gemini-3.1-flash-lite-preview",
        name: "n",
        inputCostPerMillion: 1,
        outputCostPerMillion: 2,
        provider: "openrouter",
        supportsAsyncBatch: true,
        batchDiscountPercent: 50,
      },
      [WITH_SIBLING]: {
        id: "anthropic/claude-sonnet-4.5",
        name: "s",
        inputCostPerMillion: 3,
        outputCostPerMillion: 15,
        provider: "openrouter",
        supportsAsyncBatch: true,
        batchModelId: "anthropic/claude-sonnet-4.5:batch",
        batchInputCostPerMillion: 1.5,
        batchOutputCostPerMillion: 7.5,
        batchDiscountPercent: 50,
      },
      [OR_ONLY]: {
        id: "deepseek/deepseek-v4",
        name: "d",
        inputCostPerMillion: 1,
        outputCostPerMillion: 2,
        provider: "openrouter",
        supportsAsyncBatch: true,
        batchModelId: "deepseek/deepseek-v4:batch",
        batchInputCostPerMillion: 0.5,
        batchOutputCostPerMillion: 1,
      },
    });
  });

  it("a native-only model resolves to its vendor and is NOT reachable via OpenRouter", () => {
    const key = NATIVE_ONLY;
    expect(getBestProviderForModel(key)).toBe("google");
    expect(getProviderModelId(key, "google")).toBe(
      "gemini-3.1-flash-lite-preview",
    );
    expect(getProviderModelId(key, "openrouter")).toBeUndefined();
    expect(() => resolveModelForProvider(key, "openrouter")).toThrow(
      /no batch pricing/,
    );
    expect(() => resolveModelForProvider(key, "openrouter")).toThrow(
      /ai\.batch\(modelKey, "google"\)/,
    );
  });

  it("a native model with a sibling is reachable through both transports", () => {
    const key = WITH_SIBLING;
    expect(getBestProviderForModel(key)).toBe("anthropic");
    expect(getProviderModelId(key, "anthropic")).toBe("claude-sonnet-4.5");
    expect(getProviderModelId(key, "openrouter")).toBe(
      "anthropic/claude-sonnet-4.5",
    );
    expect(resolveModelForProvider(key, "openrouter")).toBe(
      "anthropic/claude-sonnet-4.5",
    );
  });

  it("a non-native model with a sibling resolves to OpenRouter", () => {
    const key = OR_ONLY;
    expect(getBestProviderForModel(key)).toBe("openrouter");
    expect(resolveModelForProvider(key, "openrouter")).toBe(
      "deepseek/deepseek-v4",
    );
    expect(getProviderModelId(key, "google")).toBeUndefined();
  });
});
