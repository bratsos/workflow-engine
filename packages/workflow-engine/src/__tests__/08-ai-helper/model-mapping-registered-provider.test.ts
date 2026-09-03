/**
 * Batch provider resolution: explicit `batch.provider` first, then the
 * model's `batchProvider`, then the slug's native vendor, then OpenRouter.
 * Own file: the registry is module-level and these entries must not leak
 * into the mapping suite.
 */

import { describe, expect, it } from "vitest";
import { getModel, registerModels } from "../../ai/model-helper.js";
import { getModelProvider } from "../../ai/shared.js";
import {
  getBestProviderForModel,
  resolveModelForProvider,
} from "../../utils/batch/model-mapping.js";

registerModels({
  "mapping-openrouter-haiku": {
    id: "anthropic/claude-haiku-4.5",
    name: "Haiku via OpenRouter",
    inputCostPerMillion: 1,
    outputCostPerMillion: 5,
    provider: "openrouter",
    supportsAsyncBatch: true,
    batchProvider: "openrouter",
  },
  "mapping-synced-haiku": {
    id: "anthropic/claude-haiku-4.5",
    name: "Haiku synced from the catalog",
    inputCostPerMillion: 1,
    outputCostPerMillion: 5,
    provider: "openrouter",
    supportsAsyncBatch: true,
    batchModelId: "anthropic/claude-haiku-4.5:batch",
  },
});

describe("batch provider resolution honours the model's batchProvider", () => {
  it("routes a model that names OpenRouter through OpenRouter, without a catalog batch row", () => {
    expect(getBestProviderForModel("mapping-openrouter-haiku")).toBe(
      "openrouter",
    );
    expect(
      resolveModelForProvider("mapping-openrouter-haiku", "openrouter"),
    ).toBe("anthropic/claude-haiku-4.5");
  });

  it("keeps the slug's vendor for a synced entry that names no batch provider", () => {
    expect(getBestProviderForModel("mapping-synced-haiku")).toBe("anthropic");
    expect(resolveModelForProvider("mapping-synced-haiku", "openrouter")).toBe(
      "anthropic/claude-haiku-4.5",
    );
  });
});

registerModels({
  "mapping-native-google-bare": {
    id: "gemini-2.5-flash-lite",
    name: "Gemini registered natively with the bare id",
    inputCostPerMillion: 1,
    outputCostPerMillion: 2,
    provider: "google",
    supportsAsyncBatch: true,
  },
  "mapping-native-google-slug": {
    id: "google/gemini-2.5-flash-lite",
    name: "Gemini registered natively with the catalog slug",
    inputCostPerMillion: 1,
    outputCostPerMillion: 2,
    provider: "google",
    supportsAsyncBatch: true,
  },
});

describe("a native provider entry is the vendor, whichever id form it carries", () => {
  it("batches a provider: google entry with the bare id through Google, not OpenRouter", () => {
    expect(getBestProviderForModel("mapping-native-google-bare")).toBe(
      "google",
    );
    expect(
      resolveModelForProvider("mapping-native-google-bare", "google"),
    ).toBe("gemini-2.5-flash-lite");
  });

  it("strips the vendor prefix for the batch and the realtime path alike", () => {
    expect(getBestProviderForModel("mapping-native-google-slug")).toBe(
      "google",
    );
    expect(
      resolveModelForProvider("mapping-native-google-slug", "google"),
    ).toBe("gemini-2.5-flash-lite");
    expect(
      getModelProvider(getModel("mapping-native-google-slug")).modelId,
    ).toBe("gemini-2.5-flash-lite");
    expect(
      getModelProvider(getModel("mapping-native-google-bare")).modelId,
    ).toBe("gemini-2.5-flash-lite");
  });
});
