/**
 * OpenRouter's "No endpoints found that can handle the requested parameters"
 * is a routing outcome of `requireParameters: true` (the default), not an
 * outage; the helper says so and names the switch.
 */

import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";
import { createAIHelper } from "../../ai/ai-helper.js";
import { registerModels } from "../../ai/model-helper.js";
import type { ProviderResolver } from "../../ai/types.js";
import { InMemoryAICallLogger } from "../../testing/in-memory-ai-logger.js";

const MODEL = "routing-no-endpoints-model";
registerModels({
  [MODEL]: {
    id: "openai/gpt-5-nano",
    name: "Nano",
    provider: "openrouter",
    inputCostPerMillion: 1,
    outputCostPerMillion: 1,
  },
});

const throwing: ProviderResolver = () =>
  new MockLanguageModelV4({
    doGenerate: async () => {
      throw new Error(
        "No endpoints found that can handle the requested parameters",
      );
    },
  }) as never;

describe("no-endpoints routing error", () => {
  it("is explained with the requireParameters switch under the default routing", async () => {
    const ai = createAIHelper(
      "t",
      new InMemoryAICallLogger(),
      undefined,
      throwing,
    );
    await expect(
      ai.generateText(MODEL, "hi", { maxTokens: 64 }),
    ).rejects.toThrow(/routing: \{ requireParameters: false \}/);
  });

  it("is left alone when the caller already turned requireParameters off", async () => {
    const ai = createAIHelper(
      "t",
      new InMemoryAICallLogger(),
      undefined,
      throwing,
      { routing: { requireParameters: false } },
    );
    await expect(
      ai.generateText(MODEL, "hi", { maxTokens: 64 }),
    ).rejects.toThrow(/^No endpoints found/);
  });
});
