import type { EmbeddingModelV4 } from "@ai-sdk/provider";
import { MockEmbeddingModelV4 } from "ai/test";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
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
  it("returns the adapter's object from generateObject and logs it", async () => {
    const adapter: AIAdapter = {
      generateObject: async () => ({
        object: { answer: 42 },
        inputTokens: 10,
        outputTokens: 5,
        costUsd: 0.001,
      }),
    };
    const aiLogger = logger();
    const ai = createAIHelper(
      "adapter.object",
      aiLogger,
      undefined,
      undefined,
      {
        adapter,
      },
    );

    const result = await ai.generateObject(
      MODEL,
      "question",
      z.object({ answer: z.number() }),
    );

    expect(result.object).toEqual({ answer: 42 });
    expect(result).toMatchObject({
      inputTokens: 10,
      outputTokens: 5,
      cost: 0.001,
      reportedCostUsd: 0.001,
      costSource: "reported",
    });
    const [call] = aiLogger.getCallsByTopic("adapter.object");
    expect(call).toMatchObject({
      callType: "object",
      response: JSON.stringify({ answer: 42 }, null, 2),
      inputTokens: 10,
      outputTokens: 5,
      cost: 0.001,
    });
  });

  it("returns the adapter's structured `object` as generateText output", async () => {
    const adapter: AIAdapter = {
      generateText: async () => ({
        text: '{"answer":1}',
        object: { answer: 1 },
        inputTokens: 2,
        outputTokens: 1,
      }),
    };
    const aiLogger = logger();
    const ai = createAIHelper("adapter.text", aiLogger, undefined, undefined, {
      adapter,
    });

    const result = await ai.generateText(MODEL, "q", {
      output: { schema: z.object({ answer: z.number() }) } as never,
    });

    expect(result.text).toBe('{"answer":1}');
    expect(result.output).toEqual({ answer: 1 });
    expect(aiLogger.getCallsByTopic("adapter.text")[0]).toMatchObject({
      callType: "text",
      response: '{"answer":1}',
      inputTokens: 2,
      outputTokens: 1,
    });
  });

  it("returns the adapter's embeddings and logs its tokens", async () => {
    const adapter: AIAdapter = {
      embed: async ({ values }) => ({
        embeddings: values.map(() => [0.5, 0.5]),
        inputTokens: 7,
        costUsd: 0.002,
      }),
    };
    const aiLogger = logger();
    const ai = createAIHelper(
      "adapter.embed2",
      aiLogger,
      undefined,
      undefined,
      {
        adapter,
      },
    );

    const result = await ai.embed(EMBED_MODEL, ["a", "b"]);

    expect(result.embeddings).toEqual([
      [0.5, 0.5],
      [0.5, 0.5],
    ]);
    expect(result).toMatchObject({
      inputTokens: 7,
      cost: 0.002,
      costSource: "reported",
    });
    expect(aiLogger.getCallsByTopic("adapter.embed2")[0]).toMatchObject({
      callType: "embed",
      inputTokens: 7,
      cost: 0.002,
    });
  });

  it("streams the adapter's chunks and reports its tokens", async () => {
    const adapter: AIAdapter = {
      streamText: () => ({
        stream: (async function* () {
          yield "hel";
          yield "lo";
        })(),
        inputTokens: 3,
        outputTokens: 2,
        costUsd: 0.003,
      }),
    };
    const aiLogger = logger();
    const ai = createAIHelper(
      "adapter.stream",
      aiLogger,
      undefined,
      undefined,
      {
        adapter,
      },
    );

    const result = await ai.streamText(MODEL, { prompt: "hi" });
    const chunks: string[] = [];
    for await (const chunk of result.stream) chunks.push(chunk);

    expect(chunks).toEqual(["hel", "lo"]);
    await expect(result.getText()).resolves.toBe("hello");
    await expect(result.getUsage()).resolves.toMatchObject({
      inputTokens: 3,
      outputTokens: 2,
      cost: 0.003,
      costSource: "reported",
    });
    expect(aiLogger.getCallsByTopic("adapter.stream")[0]).toMatchObject({
      callType: "stream",
      response: "hello",
      inputTokens: 3,
      outputTokens: 2,
    });
  });
});
