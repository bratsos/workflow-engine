/**
 * Batch provider resolution: explicit `batch.provider` first, then the
 * model's `batchProvider`, then the slug's native vendor, then OpenRouter.
 * Own file: the registry is module-level and these entries must not leak
 * into the mapping suite.
 */

import { describe, expect, it } from "vitest";
import { registerModels } from "../../ai/model-helper.js";
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
