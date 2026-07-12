/**
 * Regression tests for a set of verified AI-layer bugs, driving the REAL
 * AIHelperImpl (via createAIHelper) with a fake LanguageModelV4/
 * EmbeddingModelV4 injected through providerResolver / registerEmbeddingProvider,
 * so these exercise the actual implementation rather than MockAIHelper.
 *
 * Covers:
 *  - Tool-execution log records must be zero-cost observability entries, not
 *    billable events (no (N+1)x cost inflation).
 *  - A streamed call must be persisted exactly once when the stream finishes,
 *    even if the consumer never calls getUsage().
 *  - getModelProvider() must throw for an unknown provider instead of
 *    silently falling back to google().
 *  - embed() must use the AI SDK's embedMany() for multi-text input instead
 *    of looping embed() once per text.
 *  - Batch getResults() must validate structured output against the
 *    request's schema, and must not cast failed results to `{} as T`.
 */

import type { EmbeddingModelV4 } from "@ai-sdk/provider";
import { MockEmbeddingModelV4, MockLanguageModelV4 } from "ai/test";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

// Mock optional peer dependencies that ai-helper.ts transitively imports via
// the batch providers, so they can be constructed without real credentials.
vi.mock("@anthropic-ai/sdk", () => ({ Anthropic: class {} }));
vi.mock("openai", () => ({ default: class {} }));

const { googleGetResultsMock, googleSubmitMock, googleCheckStatusMock } =
  vi.hoisted(() => ({
    googleGetResultsMock: vi.fn(),
    googleSubmitMock: vi.fn(async (requests: Array<{ id: string }>) => ({
      id: "google-batch-1",
      provider: "google",
      requestCount: requests.length,
      createdAt: new Date(),
    })),
    googleCheckStatusMock: vi.fn(async () => ({
      state: "completed",
      processedCount: 1,
      totalCount: 1,
    })),
  }));

vi.mock("../../utils/batch/providers/google-batch.js", () => ({
  GoogleBatchProvider: class {
    submit = googleSubmitMock;
    checkStatus = googleCheckStatusMock;
    getResults = googleGetResultsMock;
  },
}));

import {
  createAIHelper,
  getEmbeddingModelProvider,
  type ProviderResolver,
  registerEmbeddingProvider,
} from "../../ai/ai-helper.js";
import { registerModels } from "../../ai/model-helper.js";

function makeLogger() {
  const calls: Array<Record<string, unknown>> = [];
  return {
    logger: {
      logCall: vi.fn((payload: Record<string, unknown>) => {
        calls.push(payload);
      }),
      getStats: vi.fn().mockResolvedValue({
        totalCalls: 0,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalCost: 0,
        perModel: {},
      }),
      isRecorded: vi.fn().mockResolvedValue(false),
      logBatchResults: vi.fn().mockResolvedValue(undefined),
      getCalls: vi.fn().mockResolvedValue([]),
    },
    calls,
  };
}

const USAGE = {
  inputTokens: { total: 10 },
  outputTokens: { total: 20 },
} as any;

describe("tool-call cost is not double counted", () => {
  it("logs tool-execution records as zero-cost observability entries", async () => {
    let step = 0;
    const model = new MockLanguageModelV4({
      doGenerate: async () => {
        step++;
        if (step === 1) {
          return {
            content: [
              {
                type: "tool-call",
                toolCallId: "call-1",
                toolName: "getWeather",
                input: JSON.stringify({ location: "Tokyo" }),
              },
            ],
            finishReason: "tool-calls",
            usage: USAGE,
            warnings: [],
          } as any;
        }
        return {
          content: [{ type: "text", text: "It is sunny in Tokyo." }],
          finishReason: "stop",
          usage: USAGE,
          warnings: [],
        } as any;
      },
    });
    const resolver: ProviderResolver = () => model as any;
    const { logger, calls } = makeLogger();
    const ai = createAIHelper("t", logger as any, undefined, resolver);

    const { stepCountIs } = await import("ai");

    await ai.generateText("gemini-2.5-flash", "What's the weather in Tokyo?", {
      tools: {
        getWeather: {
          description: "Get the weather for a location",
          inputSchema: z.object({ location: z.string() }),
          execute: async ({ location }: { location: string }) =>
            `Sunny in ${location}`,
        },
      },
      stopWhen: stepCountIs(2),
      onStepEnd: async () => {},
    });

    const toolCallRecords = calls.filter((c) =>
      (c.topic as string).includes(".tool."),
    );
    expect(toolCallRecords.length).toBeGreaterThan(0);
    for (const record of toolCallRecords) {
      expect(record.inputTokens).toBe(0);
      expect(record.outputTokens).toBe(0);
      expect(record.cost).toBe(0);
    }

    // Exactly one billable record for the whole call (the final response) -
    // not one per tool result plus one for the final call.
    const billableRecords = calls.filter(
      (c) => !(c.topic as string).includes(".tool."),
    );
    expect(billableRecords).toHaveLength(1);
    expect(billableRecords[0]?.inputTokens).toBeGreaterThan(0);
  });
});

describe("streamed calls are always logged once", () => {
  function simpleTextStreamModel() {
    return new MockLanguageModelV4({
      doStream: async () => {
        const { simulateReadableStream } = await import("ai/test");
        return {
          stream: simulateReadableStream({
            chunks: [
              { type: "stream-start", warnings: [] },
              { type: "text-start", id: "t1" },
              { type: "text-delta", id: "t1", delta: "Hello " },
              { type: "text-delta", id: "t1", delta: "world." },
              { type: "text-end", id: "t1" },
              { type: "finish", finishReason: "stop", usage: USAGE },
            ] as any,
          }),
        };
      },
    });
  }

  it("persists the call once the stream finishes even if getUsage() is never called", async () => {
    const model = simpleTextStreamModel();
    const resolver: ProviderResolver = () => model as any;
    const { logger, calls } = makeLogger();
    const ai = createAIHelper("t", logger as any, undefined, resolver);

    const result = ai.streamText("gemini-2.5-flash", { prompt: "hi" });
    for await (const _chunk of result.stream) {
      // consume without ever calling getUsage()
    }

    // onEnd runs as part of the AI SDK's internal stream consumption;
    // give any pending microtasks a chance to flush.
    await new Promise((resolve) => setTimeout(resolve, 0));

    const streamCalls = calls.filter((c) => c.callType === "stream");
    expect(streamCalls).toHaveLength(1);
    expect(streamCalls[0]?.response).toBe("Hello world.");
    expect(streamCalls[0]?.inputTokens).toBe(10);
    expect(streamCalls[0]?.outputTokens).toBe(20);
  });

  it("does not double-log when getUsage() is called after the stream finishes", async () => {
    const model = simpleTextStreamModel();
    const resolver: ProviderResolver = () => model as any;
    const { logger, calls } = makeLogger();
    const ai = createAIHelper("t", logger as any, undefined, resolver);

    const result = ai.streamText("gemini-2.5-flash", { prompt: "hi" });
    for await (const _chunk of result.stream) {
      // consume
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
    await result.getUsage();
    await result.getUsage();

    const streamCalls = calls.filter((c) => c.callType === "stream");
    expect(streamCalls).toHaveLength(1);
  });
});

describe("getModelProvider throws for unknown providers", () => {
  it("throws a descriptive error instead of silently falling back to google()", async () => {
    registerModels({
      "bugfix-unknown-provider-model": {
        id: "totally-unknown/some-model",
        name: "Unknown Provider Model",
        inputCostPerMillion: 0,
        outputCostPerMillion: 0,
        provider: "totally-unknown",
      },
    });
    const { logger } = makeLogger();
    const ai = createAIHelper("t", logger as any); // no providerResolver

    await expect(
      ai.generateText("bugfix-unknown-provider-model" as never, "hello"),
    ).rejects.toThrow(/Unsupported provider "totally-unknown"/);
  });
});

describe("embed() uses embedMany() for multi-text input", () => {
  it("makes a single embedMany call instead of one embed() call per text", async () => {
    const doEmbed = vi.fn(async ({ values }: { values: string[] }) => ({
      embeddings: values.map((_v: string, i: number) => [i, i + 1, i + 2]),
      usage: { tokens: values.length * 2 },
      warnings: [],
    }));
    const model = new MockEmbeddingModelV4({
      // A generous per-call limit so embedMany() batches all 3 texts into a
      // single provider call, distinguishing it from the old N-calls loop.
      maxEmbeddingsPerCall: 100,
      doEmbed: doEmbed as unknown as EmbeddingModelV4["doEmbed"],
    });
    registerEmbeddingProvider(
      "bugfix-mock-embed-provider",
      () => model as unknown as EmbeddingModelV4,
    );
    registerModels({
      "bugfix-mock-embed-model": {
        id: "mock-embed-model",
        name: "Mock Embed Model",
        inputCostPerMillion: 0,
        outputCostPerMillion: 0,
        provider: "bugfix-mock-embed-provider",
      },
    });

    const { logger } = makeLogger();
    const ai = createAIHelper("t", logger as any);

    const result = await ai.embed("bugfix-mock-embed-model" as never, [
      "alpha",
      "beta",
      "gamma",
    ]);

    expect(doEmbed).toHaveBeenCalledTimes(1);
    expect(doEmbed.mock.calls[0]?.[0]?.values).toEqual([
      "alpha",
      "beta",
      "gamma",
    ]);
    expect(result.embeddings).toHaveLength(3);
    expect(result.inputTokens).toBe(6);
  });

  it("still uses a single embed() call for single-text input", async () => {
    const doEmbed = vi.fn(async ({ values }: { values: string[] }) => ({
      embeddings: values.map(() => [0.1, 0.2, 0.3]),
      usage: { tokens: 2 },
      warnings: [],
    }));
    const model = new MockEmbeddingModelV4({
      doEmbed: doEmbed as unknown as EmbeddingModelV4["doEmbed"],
    });
    registerEmbeddingProvider(
      "bugfix-mock-embed-provider-single",
      () => model as unknown as EmbeddingModelV4,
    );
    registerModels({
      "bugfix-mock-embed-model-single": {
        id: "mock-embed-model-single",
        name: "Mock Embed Model Single",
        inputCostPerMillion: 0,
        outputCostPerMillion: 0,
        provider: "bugfix-mock-embed-provider-single",
      },
    });

    const { logger } = makeLogger();
    const ai = createAIHelper("t", logger as any);
    const result = await ai.embed(
      "bugfix-mock-embed-model-single" as never,
      "alpha",
    );

    expect(doEmbed).toHaveBeenCalledTimes(1);
    expect(result.embeddings).toHaveLength(1);
  });

  it("getEmbeddingModelProvider export is unaffected (sanity check for existing consumers)", () => {
    expect(typeof getEmbeddingModelProvider).toBe("function");
  });
});

describe("batch getResults() validates structured output against the schema", () => {
  it("validates, rejects malformed JSON, and rejects schema mismatches instead of trusting the model blindly", async () => {
    googleGetResultsMock.mockResolvedValue([
      {
        index: 0,
        customId: "valid",
        text: JSON.stringify({ name: "Alice", age: 30 }),
        inputTokens: 5,
        outputTokens: 5,
      },
      {
        index: 1,
        customId: "wrong-shape",
        text: JSON.stringify({ name: "Bob" }), // missing required `age`
        inputTokens: 5,
        outputTokens: 5,
      },
      {
        index: 2,
        customId: "not-json",
        text: "this is definitely not json",
        inputTokens: 5,
        outputTokens: 5,
      },
    ]);

    const { logger } = makeLogger();
    const ai = createAIHelper("t", logger as any);
    const schema = z.object({ name: z.string(), age: z.number() });

    const batch = ai.batch<{ name: string; age: number }>(
      "gemini-2.5-flash",
      "google",
    );
    const handle = await batch.submit([
      { id: "valid", prompt: "p1", schema },
      { id: "wrong-shape", prompt: "p2", schema },
      { id: "not-json", prompt: "p3", schema },
    ]);

    const results = await batch.getResults(handle.id);

    const valid = results.find((r) => r.id === "valid")!;
    expect(valid.status).toBe("succeeded");
    expect(valid.result).toEqual({ name: "Alice", age: 30 });

    const wrongShape = results.find((r) => r.id === "wrong-shape")!;
    expect(wrongShape.status).toBe("failed");
    expect(wrongShape.result).toBeUndefined();
    expect(wrongShape.error).toBeTruthy();

    const notJson = results.find((r) => r.id === "not-json")!;
    expect(notJson.status).toBe("failed");
    expect(notJson.result).toBeUndefined();
    expect(notJson.error).toBeTruthy();
  });

  it("does not fabricate a {} result for provider-level failures", async () => {
    googleGetResultsMock.mockResolvedValue([
      {
        index: 0,
        customId: "provider-error",
        text: "",
        inputTokens: 0,
        outputTokens: 0,
        error: "Rate limit exceeded",
      },
    ]);

    const { logger } = makeLogger();
    const ai = createAIHelper("t", logger as any);
    const batch = ai.batch("gemini-2.5-flash", "google");
    const handle = await batch.submit([{ id: "provider-error", prompt: "p" }]);

    const results = await batch.getResults(handle.id);

    expect(results[0]?.status).toBe("failed");
    expect(results[0]?.result).toBeUndefined();
    expect(results[0]?.error).toBe("Rate limit exceeded");
  });

  it("falls back to unvalidated parsing when no schema was supplied at submit time", async () => {
    googleGetResultsMock.mockResolvedValue([
      {
        index: 0,
        customId: "no-schema",
        text: JSON.stringify({ anything: "goes" }),
        inputTokens: 1,
        outputTokens: 1,
      },
    ]);

    const { logger } = makeLogger();
    const ai = createAIHelper("t", logger as any);
    const batch = ai.batch("gemini-2.5-flash", "google");
    const handle = await batch.submit([{ id: "no-schema", prompt: "p" }]);

    const results = await batch.getResults(handle.id);
    expect(results[0]?.status).toBe("succeeded");
    expect(results[0]?.result).toEqual({ anything: "goes" });
  });
});
