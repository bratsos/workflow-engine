import type { EmbeddingModelV4 } from "@ai-sdk/provider";
import { MockEmbeddingModelV4 } from "ai/test";
import { describe, expect, it, vi } from "vitest";
import { createAIHelper } from "../../ai/ai-helper.js";
import { registerEmbeddingProvider } from "../../ai/embeddings.js";
import { registerModels } from "../../ai/model-helper.js";
import type { AdapterTextRequest, AIAdapter } from "../../ai/types.js";
import { InMemoryAICallLogger } from "../../testing/in-memory-ai-logger.js";

const MODEL = "local-cli-adapter-model";
const EMBED_MODEL = "local-cli-adapter-embed-model";
registerModels({
  [MODEL]: {
    id: "local-cli/model",
    name: "Local CLI",
    provider: "local-cli",
    inputCostPerMillion: 1,
    outputCostPerMillion: 2,
  },
  [EMBED_MODEL]: {
    id: "fallback-embed/model",
    name: "Fallback Embed",
    provider: "adapter-fallback-embed",
    inputCostPerMillion: 1,
    outputCostPerMillion: 0,
    isEmbeddingModel: true,
  },
});

class LocalCliLikeAdapter implements AIAdapter {
  readonly generateText = vi.fn(async ({ prompt }: AdapterTextRequest) => ({
    text: `cli:${prompt}`,
    inputTokens: 4,
    outputTokens: 3,
  }));
}

function logger() {
  return new InMemoryAICallLogger();
}

describe("AI adapter seam", () => {
  it("records an adapter-reported cost as the reported cost", async () => {
    const adapter: AIAdapter = {
      generateText: async () => ({
        text: "cli",
        inputTokens: 4,
        outputTokens: 3,
        costUsd: 0.5,
      }),
    };
    const aiLogger = logger();
    const ai = createAIHelper("adapter.cost", aiLogger, undefined, undefined, {
      adapter,
    });

    await expect(ai.generateText(MODEL, "hello")).resolves.toMatchObject({
      cost: 0.5,
      reportedCostUsd: 0.5,
      costSource: "reported",
    });
    expect(aiLogger.getCallsByTopic("adapter.cost")[0]?.cost).toBe(0.5);
  });

  it("uses the adapter below helper logging and preserves it in children", async () => {
    const adapter = new LocalCliLikeAdapter();
    const aiLogger = logger();
    const ai = createAIHelper("adapter.topic", aiLogger, undefined, undefined, {
      adapter,
    });

    await expect(ai.generateText(MODEL, "hello")).resolves.toMatchObject({
      text: "cli:hello",
      inputTokens: 4,
    });
    await ai.createChild("stage", "one").generateText(MODEL, "child");

    expect(adapter.generateText).toHaveBeenCalledTimes(2);
    expect(aiLogger.getCallsByTopic("adapter.topic")[0]?.cost).toBe(
      (4 / 1_000_000) * 1 + (3 / 1_000_000) * 2,
    );
    expect(aiLogger.getCallsByTopic("adapter.topic.stage.one")).toHaveLength(1);
  });

  it("falls through to the SDK path for operations the adapter omits", async () => {
    const doEmbed = vi.fn(async ({ values }: { values: string[] }) => ({
      embeddings: values.map(() => [0.1, 0.2]),
      usage: { tokens: 6 },
      warnings: [],
    }));
    const model = new MockEmbeddingModelV4({
      doEmbed: doEmbed as unknown as EmbeddingModelV4["doEmbed"],
    });
    registerEmbeddingProvider(
      "adapter-fallback-embed",
      () => model as unknown as EmbeddingModelV4,
    );
    const aiLogger = logger();
    const ai = createAIHelper("adapter.embed", aiLogger, undefined, undefined, {
      adapter: new LocalCliLikeAdapter(),
    });

    await ai.embed(EMBED_MODEL, "text");

    expect(doEmbed).toHaveBeenCalledTimes(1);
    expect(aiLogger.getCallsByTopic("adapter.embed")).toHaveLength(1);
  });
});
