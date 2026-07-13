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
 *  - v0.12 AI SDK v7 consumer-surface expansion: usage detail + cost
 *    refinement, result richness, messages input, and the new passthrough
 *    options (telemetry, sampling params, reasoning, activeTools,
 *    prepareStep, experimental_transform, embeddings retries/headers).
 */

import type { EmbeddingModelV4 } from "@ai-sdk/provider";
import { smoothStream } from "ai";
import {
  MockEmbeddingModelV4,
  MockLanguageModelV4,
  simulateReadableStream,
} from "ai/test";
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
import { calculateCost, registerModels } from "../../ai/model-helper.js";
import { buildCommonCallOptions } from "../../ai/shared.js";

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

// =============================================================================
// AI SDK v7 consumer-surface expansion (v0.12+)
// =============================================================================
// MockLanguageModelV4's `finishReason` must be the unified-shape object
// ({ unified, raw }) - a plain string is silently unrecognized by the AI
// SDK's own finish-reason normalization, which breaks `result.finishReason`
// and (since Output.object() only resolves output when the last step's
// finishReason unifies to "stop") generateObject entirely.
const USAGE_WITH_DETAIL = {
  inputTokens: { total: 100, noCache: 80, cacheRead: 20, cacheWrite: 0 },
  outputTokens: { total: 50, text: 40, reasoning: 10 },
} as any;

function textModel(text: string, usage: any = USAGE) {
  return new MockLanguageModelV4({
    doGenerate: async () => ({
      content: [{ type: "text", text }],
      finishReason: { unified: "stop", raw: undefined },
      usage,
      warnings: [],
    }),
  });
}

function objectModel(object: unknown, usage: any = USAGE) {
  return new MockLanguageModelV4({
    doGenerate: async () => ({
      content: [{ type: "text", text: JSON.stringify(object) }],
      finishReason: { unified: "stop", raw: undefined },
      usage,
      warnings: [],
    }),
  });
}

describe("usage detail (v0.12+)", () => {
  it("surfaces totalTokens/cachedInputTokens/reasoningTokens on generateText and persists them into AICall metadata", async () => {
    const model = textModel("answer", USAGE_WITH_DETAIL);
    const resolver: ProviderResolver = () => model as any;
    const { logger, calls } = makeLogger();
    const ai = createAIHelper("t", logger as any, undefined, resolver);

    const result = await ai.generateText("gemini-2.5-flash", "hi");

    expect(result.totalTokens).toBe(150);
    expect(result.cachedInputTokens).toBe(20);
    expect(result.reasoningTokens).toBe(10);

    expect(calls).toHaveLength(1);
    expect((calls[0]!.metadata as Record<string, unknown>).usageDetail).toEqual(
      {
        totalTokens: 150,
        cachedInputTokens: 20,
        reasoningTokens: 10,
      },
    );
  });

  it("surfaces usage detail on generateObject and persists them into AICall metadata", async () => {
    const model = objectModel({ data: "x" }, USAGE_WITH_DETAIL);
    const resolver: ProviderResolver = () => model as any;
    const { logger, calls } = makeLogger();
    const ai = createAIHelper("t", logger as any, undefined, resolver);

    const result = await ai.generateObject(
      "gemini-2.5-flash",
      "hi",
      z.object({ data: z.string() }),
    );

    expect(result.totalTokens).toBe(150);
    expect(result.cachedInputTokens).toBe(20);
    expect(result.reasoningTokens).toBe(10);
    expect((calls[0]!.metadata as Record<string, unknown>).usageDetail).toEqual(
      {
        totalTokens: 150,
        cachedInputTokens: 20,
        reasoningTokens: 10,
      },
    );
  });

  it("surfaces usage detail via streamText.getUsage() and persists them into AICall metadata", async () => {
    const model = new MockLanguageModelV4({
      doStream: async () => ({
        stream: simulateReadableStream({
          chunks: [
            { type: "stream-start", warnings: [] },
            { type: "text-start", id: "t1" },
            { type: "text-delta", id: "t1", delta: "answer" },
            { type: "text-end", id: "t1" },
            { type: "finish", finishReason: "stop", usage: USAGE_WITH_DETAIL },
          ] as any,
        }),
      }),
    });
    const resolver: ProviderResolver = () => model as any;
    const { logger, calls } = makeLogger();
    const ai = createAIHelper("t", logger as any, undefined, resolver);

    const result = ai.streamText("gemini-2.5-flash", { prompt: "hi" });
    const usage = await result.getUsage();

    expect(usage.totalTokens).toBe(150);
    expect(usage.cachedInputTokens).toBe(20);
    expect(usage.reasoningTokens).toBe(10);

    const streamCalls = calls.filter((c) => c.callType === "stream");
    expect(streamCalls).toHaveLength(1);
    expect(
      (streamCalls[0]!.metadata as Record<string, unknown>).usageDetail,
    ).toEqual({
      totalTokens: 150,
      cachedInputTokens: 20,
      reasoningTokens: 10,
    });
  });
});

describe("cost refinement (v0.12+)", () => {
  it("is byte-identical to the base cost calculation when the model has no refined rate fields", async () => {
    const model = textModel("answer", USAGE_WITH_DETAIL);
    const resolver: ProviderResolver = () => model as any;
    const { logger } = makeLogger();
    const ai = createAIHelper("t", logger as any, undefined, resolver);

    const result = await ai.generateText("gemini-2.5-flash", "hi");

    // gemini-2.5-flash has no cachedInputCostPerMillion/reasoningCostPerMillion,
    // so cost must equal the unrefined calculateCost() output exactly, even
    // though the provider reported cache/reasoning tokens.
    const expected = calculateCost("gemini-2.5-flash", 100, 50).totalCost;
    expect(result.cost).toBe(expected);
  });

  it("refines cost using cachedInputCostPerMillion/reasoningCostPerMillion when the model config sets them", async () => {
    registerModels({
      "cost-refinement-test-model": {
        id: "mock/cost-refinement-model",
        name: "Cost Refinement Test Model",
        inputCostPerMillion: 3,
        outputCostPerMillion: 15,
        cachedInputCostPerMillion: 0.3,
        reasoningCostPerMillion: 60,
        provider: "mock-cost-refinement-provider",
      },
    });

    const model = textModel("answer", {
      inputTokens: {
        total: 1_000_000,
        noCache: 800_000,
        cacheRead: 200_000,
        cacheWrite: 0,
      },
      outputTokens: { total: 500_000, text: 400_000, reasoning: 100_000 },
    });
    const resolver: ProviderResolver = () => model as any;
    const { logger } = makeLogger();
    const ai = createAIHelper("t", logger as any, undefined, resolver);

    const result = await ai.generateText(
      "cost-refinement-test-model" as never,
      "hi",
    );

    // inputCost = (1,000,000 - 200,000)/1e6 * 3 + 200,000/1e6 * 0.3 = 2.4 + 0.06 = 2.46
    // outputCost = (500,000 - 100,000)/1e6 * 15 + 100,000/1e6 * 60 = 6 + 6 = 12
    // total = 14.46
    expect(result.cost).toBeCloseTo(14.46, 6);

    // The naive (unrefined) formula gives a different number - proves refinement changed the result.
    const naive = (1_000_000 / 1_000_000) * 3 + (500_000 / 1_000_000) * 15;
    expect(result.cost).not.toBeCloseTo(naive, 6);
  });
});

describe("result richness (v0.12+)", () => {
  it("populates finishReason/warnings/toolCalls/toolResults/steps on generateText", async () => {
    const model = new MockLanguageModelV4({
      doGenerate: async () => ({
        content: [{ type: "text", text: "answer" }],
        finishReason: { unified: "stop", raw: undefined },
        usage: USAGE,
        warnings: [{ type: "unsupported", feature: "temperature" }],
      }),
    });
    const resolver: ProviderResolver = () => model as any;
    const { logger } = makeLogger();
    const ai = createAIHelper("t", logger as any, undefined, resolver);

    const result = await ai.generateText("gemini-2.5-flash", "hi");

    expect(result.finishReason).toBe("stop");
    expect(result.warnings).toEqual([
      { type: "unsupported", feature: "temperature" },
    ]);
    expect(result.toolCalls).toEqual([]);
    expect(result.toolResults).toEqual([]);
    expect(result.steps).toHaveLength(1);
  });

  it("populates finishReason/warnings/toolCalls/toolResults/steps on generateObject", async () => {
    const model = objectModel({ data: "x" });
    const resolver: ProviderResolver = () => model as any;
    const { logger } = makeLogger();
    const ai = createAIHelper("t", logger as any, undefined, resolver);

    const result = await ai.generateObject(
      "gemini-2.5-flash",
      "hi",
      z.object({ data: z.string() }),
    );

    expect(result.finishReason).toBe("stop");
    expect(result.warnings).toEqual([]);
    expect(result.toolCalls).toEqual([]);
    expect(result.toolResults).toEqual([]);
    expect(result.steps).toHaveLength(1);
  });

  it("streamText exposes getFinishReason/getWarnings/getToolCalls/getToolResults/getSteps without requiring manual stream consumption", async () => {
    const model = new MockLanguageModelV4({
      doStream: async () => ({
        stream: simulateReadableStream({
          chunks: [
            {
              type: "stream-start",
              warnings: [{ type: "unsupported", feature: "topK" }],
            },
            { type: "text-start", id: "t1" },
            { type: "text-delta", id: "t1", delta: "answer" },
            { type: "text-end", id: "t1" },
            {
              type: "finish",
              finishReason: { unified: "stop", raw: undefined },
              usage: USAGE,
            },
          ] as any,
        }),
      }),
    });
    const resolver: ProviderResolver = () => model as any;
    const { logger } = makeLogger();
    const ai = createAIHelper("t", logger as any, undefined, resolver);

    const result = ai.streamText("gemini-2.5-flash", { prompt: "hi" });

    expect(await result.getFinishReason()).toBe("stop");
    expect(await result.getWarnings()).toEqual([
      { type: "unsupported", feature: "topK" },
    ]);
    expect(await result.getToolCalls()).toEqual([]);
    expect(await result.getToolResults()).toEqual([]);
    expect(await result.getSteps()).toHaveLength(1);
  });
});

describe("messages input (v0.12+)", () => {
  it("generateText: the string-prompt path is unchanged - forwards a single user message with that exact text", async () => {
    const model = textModel("answer");
    const resolver: ProviderResolver = () => model as any;
    const { logger } = makeLogger();
    const ai = createAIHelper("t", logger as any, undefined, resolver);

    await ai.generateText("gemini-2.5-flash", "hello there");

    expect(model.doGenerateCalls[0]?.prompt).toEqual([
      { role: "user", content: [{ type: "text", text: "hello there" }] },
    ]);
  });

  it("generateText: messages input forwards the full message array to the model", async () => {
    const model = textModel("answer");
    const resolver: ProviderResolver = () => model as any;
    const { logger } = makeLogger();
    const ai = createAIHelper("t", logger as any, undefined, resolver);

    await ai.generateText("gemini-2.5-flash", {
      messages: [
        { role: "user", content: "Message A" },
        { role: "assistant", content: "Message B" },
        { role: "user", content: "Message C" },
      ],
    });

    expect(model.doGenerateCalls[0]?.prompt).toEqual([
      { role: "user", content: [{ type: "text", text: "Message A" }] },
      { role: "assistant", content: [{ type: "text", text: "Message B" }] },
      { role: "user", content: [{ type: "text", text: "Message C" }] },
    ]);
  });

  it("generateObject: the string-prompt path is unchanged", async () => {
    const model = objectModel({ data: "y" });
    const resolver: ProviderResolver = () => model as any;
    const { logger } = makeLogger();
    const ai = createAIHelper("t", logger as any, undefined, resolver);

    const result = await ai.generateObject(
      "gemini-2.5-flash",
      "Extract this",
      z.object({ data: z.string() }),
    );

    expect(result.object).toEqual({ data: "y" });
    expect(model.doGenerateCalls[0]?.prompt).toEqual([
      { role: "user", content: [{ type: "text", text: "Extract this" }] },
    ]);
  });

  it("generateObject: messages input forwards the full message array to the model", async () => {
    const model = objectModel({ data: "x" });
    const resolver: ProviderResolver = () => model as any;
    const { logger } = makeLogger();
    const ai = createAIHelper("t", logger as any, undefined, resolver);

    const result = await ai.generateObject(
      "gemini-2.5-flash",
      { messages: [{ role: "user", content: "Extract this" }] },
      z.object({ data: z.string() }),
    );

    expect(result.object).toEqual({ data: "x" });
    expect(model.doGenerateCalls[0]?.prompt).toEqual([
      { role: "user", content: [{ type: "text", text: "Extract this" }] },
    ]);
  });
});

describe("passthrough options forwarded to the SDK call (v0.12+)", () => {
  it("forwards sampling params, headers, and reasoning to generateText's underlying model call", async () => {
    const model = textModel("answer");
    const resolver: ProviderResolver = () => model as any;
    const { logger } = makeLogger();
    const ai = createAIHelper("t", logger as any, undefined, resolver);

    await ai.generateText("gemini-2.5-flash", "hi", {
      topP: 0.5,
      topK: 20,
      frequencyPenalty: 0.1,
      presencePenalty: 0.2,
      seed: 42,
      stopSequences: ["END"],
      headers: { "x-test": "1" },
      reasoning: "low",
    });

    const call = model.doGenerateCalls[0]!;
    expect(call.topP).toBe(0.5);
    expect(call.topK).toBe(20);
    expect(call.frequencyPenalty).toBe(0.1);
    expect(call.presencePenalty).toBe(0.2);
    expect(call.seed).toBe(42);
    expect(call.stopSequences).toEqual(["END"]);
    expect(call.headers).toMatchObject({ "x-test": "1" });
    expect((call as { reasoning?: string }).reasoning).toBe("low");
  });

  it("forwards topP and reasoning to generateObject's underlying model call", async () => {
    const model = objectModel({ data: "x" });
    const resolver: ProviderResolver = () => model as any;
    const { logger } = makeLogger();
    const ai = createAIHelper("t", logger as any, undefined, resolver);

    await ai.generateObject(
      "gemini-2.5-flash",
      "hi",
      z.object({ data: z.string() }),
      { topP: 0.3, reasoning: "medium" },
    );

    expect(model.doGenerateCalls[0]?.topP).toBe(0.3);
    expect(
      (model.doGenerateCalls[0] as { reasoning?: string })?.reasoning,
    ).toBe("medium");
  });

  it("forwards topK and reasoning to streamText's underlying model call", async () => {
    const model = new MockLanguageModelV4({
      doStream: async () => ({
        stream: simulateReadableStream({
          chunks: [
            { type: "stream-start", warnings: [] },
            { type: "text-start", id: "t1" },
            { type: "text-delta", id: "t1", delta: "answer" },
            { type: "text-end", id: "t1" },
            { type: "finish", finishReason: "stop", usage: USAGE },
          ] as any,
        }),
      }),
    });
    const resolver: ProviderResolver = () => model as any;
    const { logger } = makeLogger();
    const ai = createAIHelper("t", logger as any, undefined, resolver);

    const result = ai.streamText(
      "gemini-2.5-flash",
      { prompt: "hi" },
      { topK: 15, reasoning: "high" },
    );
    for await (const _ of result.stream) {
      // consume
    }

    expect(model.doStreamCalls[0]?.topK).toBe(15);
    expect((model.doStreamCalls[0] as { reasoning?: string })?.reasoning).toBe(
      "high",
    );
  });

  it("activeTools restricts which tools reach the model", async () => {
    const model = textModel("answer");
    const resolver: ProviderResolver = () => model as any;
    const { logger } = makeLogger();
    const ai = createAIHelper("t", logger as any, undefined, resolver);

    await ai.generateText("gemini-2.5-flash", "hi", {
      tools: {
        toolA: {
          description: "a",
          inputSchema: z.object({}),
          execute: async () => "a",
        },
        toolB: {
          description: "b",
          inputSchema: z.object({}),
          execute: async () => "b",
        },
      },
      activeTools: ["toolA"],
    });

    const toolNames = model.doGenerateCalls[0]?.tools?.map(
      (t: { name: string }) => t.name,
    );
    expect(toolNames).toEqual(["toolA"]);
  });

  it("prepareStep is invoked before the step runs on generateText", async () => {
    const model = textModel("answer");
    const resolver: ProviderResolver = () => model as any;
    const { logger } = makeLogger();
    const ai = createAIHelper("t", logger as any, undefined, resolver);
    const prepareStep = vi.fn(async () => ({}));

    await ai.generateText("gemini-2.5-flash", "hi", { prepareStep });

    expect(prepareStep).toHaveBeenCalledTimes(1);
  });

  it("experimental_transform (e.g. smoothStream) is applied to streamText's output", async () => {
    const model = new MockLanguageModelV4({
      doStream: async () => ({
        stream: simulateReadableStream({
          chunks: [
            { type: "stream-start", warnings: [] },
            { type: "text-start", id: "t1" },
            {
              type: "text-delta",
              id: "t1",
              delta: "Hello there world foo bar",
            },
            { type: "text-end", id: "t1" },
            { type: "finish", finishReason: "stop", usage: USAGE },
          ] as any,
        }),
      }),
    });
    const resolver: ProviderResolver = () => model as any;
    const { logger } = makeLogger();
    const ai = createAIHelper("t", logger as any, undefined, resolver);

    const result = ai.streamText(
      "gemini-2.5-flash",
      { prompt: "hi" },
      { experimental_transform: smoothStream({ chunking: "word" }) },
    );

    const chunks: string[] = [];
    for await (const c of result.stream) chunks.push(c);

    // Without the transform, the mock's single raw text-delta would come
    // through as one chunk. smoothStream({chunking:"word"}) re-chunks by
    // word, proving experimental_transform actually reached streamText.
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join("")).toBe("Hello there world foo bar");
  });

  it("telemetry is forwarded into the constructed SDK call args", () => {
    // telemetry never reaches the provider-level doGenerate/doStream call
    // (it drives the AI SDK's own OTel spans), so it can't be observed via
    // a mock model's received args - assert the pass-through into the
    // params object generate.ts/stream.ts hand to the SDK instead.
    const telemetry = { isEnabled: true, functionId: "my-function" };
    expect(buildCommonCallOptions({ telemetry }).telemetry).toEqual(telemetry);
  });

  it("forwards abortSignal/headers to embed()'s underlying call, and accepts maxRetries/telemetry", async () => {
    const model = new MockEmbeddingModelV4({
      doEmbed: (async ({ values }: { values: string[] }) => ({
        embeddings: values.map(() => [0.1, 0.2, 0.3]),
        usage: { tokens: values.length },
        warnings: [],
      })) as unknown as EmbeddingModelV4["doEmbed"],
    });
    registerEmbeddingProvider(
      "surface-expansion-embed-provider",
      () => model as unknown as EmbeddingModelV4,
    );
    registerModels({
      "surface-expansion-embed-model": {
        id: "surface-expansion-embed-model",
        name: "Surface Expansion Embed Model",
        inputCostPerMillion: 0,
        outputCostPerMillion: 0,
        provider: "surface-expansion-embed-provider",
      },
    });

    const { logger } = makeLogger();
    const ai = createAIHelper("t", logger as any);
    const controller = new AbortController();

    const result = await ai.embed(
      "surface-expansion-embed-model" as never,
      "alpha",
      {
        abortSignal: controller.signal,
        headers: { "x-test": "1" },
        maxRetries: 5,
        telemetry: { isEnabled: true },
      },
    );

    expect(result.embedding).toEqual([0.1, 0.2, 0.3]);
    expect(model.doEmbedCalls).toHaveLength(1);
    expect(model.doEmbedCalls[0]?.abortSignal).toBe(controller.signal);
    expect(model.doEmbedCalls[0]?.headers).toMatchObject({ "x-test": "1" });
  });
});
