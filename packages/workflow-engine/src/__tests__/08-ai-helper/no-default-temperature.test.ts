/**
 * `temperature` is sent only when the caller sets it. GPT-5 endpoints
 * reject a temperature under OpenRouter's `requireParameters`, and no
 * provider needs the 0.7 the helper used to default to — on the realtime
 * paths (generateText, generateObject, streamText) and both batch bodies.
 */

import type { LanguageModelV4CallOptions } from "@ai-sdk/provider";
import { MockLanguageModelV4, simulateReadableStream } from "ai/test";
import { describe, expect, it } from "vitest";
import { createAIHelper } from "../../ai/ai-helper.js";
import { fromAiSdk } from "../../ai/batch/ai-sdk.js";
import { createOpenRouterBatchModel } from "../../ai/batch/openrouter.js";
import { registerModels } from "../../ai/model-helper.js";
import { InMemoryAICallLogger } from "../../testing/in-memory-ai-logger.js";

const MODEL = "no-default-temperature-model";
registerModels({
  [MODEL]: {
    id: "openai/gpt-5-nano",
    name: "Nano",
    provider: "openrouter",
    inputCostPerMillion: 1,
    outputCostPerMillion: 1,
  },
});

function capturing(captured: LanguageModelV4CallOptions[]) {
  return new MockLanguageModelV4({
    provider: "openrouter.chat",
    doGenerate: async (options) => {
      captured.push(options);
      return {
        content: [{ type: "text", text: '{"a":"b"}' }],
        finishReason: { unified: "stop", raw: "stop" },
        usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } },
        warnings: [],
      } as never;
    },
    doStream: async (options) => {
      captured.push(options);
      return {
        stream: simulateReadableStream({
          chunks: [
            { type: "stream-start", warnings: [] },
            { type: "text-start", id: "t" },
            { type: "text-delta", id: "t", delta: "hi" },
            { type: "text-end", id: "t" },
            {
              type: "finish",
              finishReason: { unified: "stop", raw: "stop" },
              usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } },
            },
          ] as never[],
        }),
      } as never;
    },
  });
}

describe("realtime request bodies", () => {
  it("carry no temperature unless the caller sets one", async () => {
    const captured: LanguageModelV4CallOptions[] = [];
    const ai = createAIHelper(
      "temp",
      new InMemoryAICallLogger(),
      undefined,
      () => capturing(captured) as never,
    );
    const { z } = await import("zod");
    const schema = z.object({ a: z.string() });

    await ai.generateText(MODEL, "q");
    await ai.generateObject(MODEL, "q", schema);
    for await (const _ of ai.streamText(MODEL, { prompt: "q" }).stream) {
    }
    expect(captured).toHaveLength(3);
    for (const call of captured) {
      expect(call.temperature).toBeUndefined();
    }

    captured.length = 0;
    await ai.generateText(MODEL, "q", { temperature: 0.3 });
    await ai.generateObject(MODEL, "q", schema, { temperature: 0 });
    for await (const _ of ai.streamText(
      MODEL,
      { prompt: "q" },
      { temperature: 1 },
    ).stream) {
    }
    expect(captured.map((c) => c.temperature)).toEqual([0.3, 0, 1]);
  });
});

describe("batch request bodies", () => {
  it("AI SDK batch requests carry temperature only when set", async () => {
    const starts: unknown[] = [];
    const mock = {
      specificationVersion: "v4",
      provider: "openai",
      modelId: "gpt-5-nano",
      async experimental_doStartBatch(options: unknown) {
        starts.push(options);
        return {
          batchId: "b1",
          status: "pending",
          warnings: [],
          requestCounts: { total: 2, pending: 2, completed: 0, failed: 0 },
        };
      },
      async experimental_doGetBatchStatus() {
        return { status: "completed", rawStatus: "done" };
      },
      async experimental_doGetBatchResults() {
        return new ReadableStream({ start: (c) => c.close() });
      },
    };
    const model = fromAiSdk(mock, {
      provider: "openai",
      modelId: "gpt-5-nano",
    });
    await model.start([
      { id: "r1", prompt: "q" },
      { id: "r2", prompt: "q", temperature: 0.5 },
    ]);
    const requests = (starts[0] as { requests: { options: object }[] })
      .requests;
    expect("temperature" in requests[0]!.options).toBe(false);
    expect(requests[1]!.options).toMatchObject({ temperature: 0.5 });
  });

  it("OpenRouter batch bodies carry temperature only when set", async () => {
    const bodies: string[] = [];
    const model = createOpenRouterBatchModel({
      apiKey: "test-key",
      modelId: "openai/gpt-5-nano",
      fetch: (async (_url: unknown, init?: RequestInit) => {
        bodies.push(String(init?.body));
        return new Response(
          JSON.stringify({ id: "batch-1", status: "pending" }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }) as never,
    });
    await model.start([
      { id: "r1", prompt: "q" },
      { id: "r2", prompt: "q", temperature: 0.5 },
    ]);
    const parsed = JSON.parse(bodies[0]!) as {
      requests: { custom_id: string; body: Record<string, unknown> }[];
    };
    expect("temperature" in parsed.requests[0]!.body).toBe(false);
    expect(parsed.requests[1]!.body.temperature).toBe(0.5);
  });
});
