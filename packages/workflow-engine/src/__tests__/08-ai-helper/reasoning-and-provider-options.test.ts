/**
 * Reasoning models + providerOptions passthrough
 *
 * These tests drive the REAL AIHelperImpl (via createAIHelper) against a fake
 * LanguageModelV4 injected through the providerResolver hook, so they exercise
 * the actual AI SDK integration rather than the MockAIHelper.
 *
 * They cover two gaps:
 *  1. generateText / generateObject / streamText must forward
 *     options.providerOptions to the AI SDK (embed already did).
 *  2. Reasoning models (which emit on the reasoning channel) must not be
 *     treated as empty output: reasoning is exposed via result.reasoning /
 *     getReasoning(), and the buffered text is reconciled via getText().
 */

import type { LanguageModelV4GenerateResult } from "@ai-sdk/provider";
import { MockLanguageModelV4, simulateReadableStream } from "ai/test";
import { describe, expect, it, vi } from "vitest";
import { createAIHelper, type ProviderResolver } from "../../ai/ai-helper.js";

// A logger that records logCall payloads so we can assert what gets persisted.
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

function generateModel(content: Array<{ type: string; text: string }>) {
  return new MockLanguageModelV4({
    doGenerate: async (): Promise<LanguageModelV4GenerateResult> => ({
      content: content as any,
      finishReason: { unified: "stop", raw: undefined },
      usage: USAGE,
      warnings: [],
    }),
  });
}

function reasoningOnlyStreamModel() {
  return new MockLanguageModelV4({
    doStream: async () => ({
      stream: simulateReadableStream({
        chunks: [
          { type: "stream-start", warnings: [] },
          { type: "reasoning-start", id: "r1" },
          { type: "reasoning-delta", id: "r1", delta: "Let me think. " },
          { type: "reasoning-delta", id: "r1", delta: "The answer is 42." },
          { type: "reasoning-end", id: "r1" },
          { type: "finish", finishReason: "stop", usage: USAGE },
        ] as any,
      }),
    }),
  });
}

// stream-start + finish with no text and no reasoning. In the AI SDK this is
// the "zero steps" path whose promises reject with
// "No output generated. Check the stream for errors." — the exact symptom the
// fix must not re-introduce while iterating .stream.
function emptyStreamModel() {
  return new MockLanguageModelV4({
    doStream: async () => ({
      stream: simulateReadableStream({
        chunks: [
          { type: "stream-start", warnings: [] },
          { type: "finish", finishReason: "stop", usage: USAGE },
        ] as any,
      }),
    }),
  });
}

function reasoningThenTextStreamModel(delayed = false) {
  return new MockLanguageModelV4({
    doStream: async () => ({
      stream: simulateReadableStream({
        ...(delayed ? { initialDelayInMs: 5, chunkDelayInMs: 5 } : {}),
        chunks: [
          { type: "stream-start", warnings: [] },
          { type: "reasoning-start", id: "r1" },
          { type: "reasoning-delta", id: "r1", delta: "thinking..." },
          { type: "reasoning-end", id: "r1" },
          { type: "text-start", id: "t1" },
          { type: "text-delta", id: "t1", delta: "The answer " },
          { type: "text-delta", id: "t1", delta: "is 42." },
          { type: "text-end", id: "t1" },
          { type: "finish", finishReason: "stop", usage: USAGE },
        ] as any,
      }),
    }),
  });
}

describe("providerOptions passthrough", () => {
  it("forwards providerOptions to generateText", async () => {
    const model = generateModel([{ type: "text", text: "hi" }]);
    const resolver: ProviderResolver = () => model as any;
    const { logger } = makeLogger();
    const ai = createAIHelper("t", logger as any, undefined, resolver);

    const providerOptions = {
      openrouter: { reasoning: { enabled: false } },
    };
    await ai.generateText("gemini-2.5-flash", "hello", { providerOptions });

    expect(model.doGenerateCalls).toHaveLength(1);
    expect(model.doGenerateCalls[0]?.providerOptions).toEqual(providerOptions);
  });

  it("forwards providerOptions to generateText (multimodal input)", async () => {
    const model = generateModel([{ type: "text", text: "hi" }]);
    const resolver: ProviderResolver = () => model as any;
    const { logger } = makeLogger();
    const ai = createAIHelper("t", logger as any, undefined, resolver);

    const providerOptions = { anthropic: { thinking: { type: "disabled" } } };
    await ai.generateText(
      "gemini-2.5-flash",
      [
        { type: "text", text: "describe this" },
        { type: "file", data: "aGVsbG8=", mediaType: "image/png" },
      ],
      { providerOptions },
    );

    expect(model.doGenerateCalls).toHaveLength(1);
    expect(model.doGenerateCalls[0]?.providerOptions).toEqual(providerOptions);
  });

  it("forwards providerOptions to generateObject", async () => {
    const model = generateModel([{ type: "text", text: '{"data":"x"}' }]);
    const resolver: ProviderResolver = () => model as any;
    const { logger } = makeLogger();
    const ai = createAIHelper("t", logger as any, undefined, resolver);

    const { z } = await import("zod");
    const providerOptions = { anthropic: { thinking: { type: "disabled" } } };
    await ai
      .generateObject(
        "gemini-2.5-flash",
        "hello",
        z.object({ data: z.string() }),
        { providerOptions },
      )
      .catch(() => {
        // object parsing may fail for the fake content; we only care about
        // what was forwarded to the model.
      });

    expect(model.doGenerateCalls.length).toBeGreaterThanOrEqual(1);
    expect(model.doGenerateCalls[0]?.providerOptions).toEqual(providerOptions);
  });

  it("forwards providerOptions to streamText", async () => {
    const model = reasoningThenTextStreamModel();
    const resolver: ProviderResolver = () => model as any;
    const { logger } = makeLogger();
    const ai = createAIHelper("t", logger as any, undefined, resolver);

    const providerOptions = { openrouter: { reasoning: { effort: "low" } } };
    const result = ai.streamText(
      "gemini-2.5-flash",
      { prompt: "hello" },
      { providerOptions },
    );
    for await (const _ of result.stream) {
      // consume
    }

    expect(model.doStreamCalls).toHaveLength(1);
    expect(model.doStreamCalls[0]?.providerOptions).toEqual(providerOptions);
  });
});

describe("reasoning model output", () => {
  it("exposes reasoning on generateText result", async () => {
    const model = generateModel([
      { type: "reasoning", text: "step by step" },
      { type: "text", text: "final answer" },
    ]);
    const resolver: ProviderResolver = () => model as any;
    const { logger } = makeLogger();
    const ai = createAIHelper("t", logger as any, undefined, resolver);

    const result = await ai.generateText("gemini-2.5-flash", "hello");

    expect(result.text).toBe("final answer");
    expect(result.reasoning).toBe("step by step");
  });

  it("streamText: reasoning-only response exposes reasoning, not blank silence", async () => {
    const model = reasoningOnlyStreamModel();
    const resolver: ProviderResolver = () => model as any;
    const { logger } = makeLogger();
    const ai = createAIHelper("t", logger as any, undefined, resolver);

    const result = ai.streamText("gemini-2.5-flash", { prompt: "hello" });

    const chunks: string[] = [];
    for await (const c of result.stream) {
      chunks.push(c);
    }

    // The answer channel is genuinely empty for a reasoning-only response...
    expect(chunks.join("")).toBe("");
    expect(await result.getText()).toBe("");
    // ...but the reasoning is recoverable instead of being silently dropped.
    expect(await result.getReasoning()).toBe("Let me think. The answer is 42.");
  });

  it("streamText: reasoning-then-text streams the answer and exposes reasoning", async () => {
    const model = reasoningThenTextStreamModel();
    const resolver: ProviderResolver = () => model as any;
    const { logger } = makeLogger();
    const ai = createAIHelper("t", logger as any, undefined, resolver);

    const result = ai.streamText("gemini-2.5-flash", { prompt: "hello" });

    const chunks: string[] = [];
    for await (const c of result.stream) {
      chunks.push(c);
    }

    expect(chunks.join("")).toBe("The answer is 42.");
    expect(await result.getText()).toBe("The answer is 42.");
    expect(await result.getReasoning()).toBe("thinking...");
  });

  it("streamText: a zero-output stream ends gracefully, never throwing mid-iteration", async () => {
    const model = emptyStreamModel();
    const resolver: ProviderResolver = () => model as any;
    const { logger } = makeLogger();
    const ai = createAIHelper("t", logger as any, undefined, resolver);

    const result = ai.streamText("gemini-2.5-flash", { prompt: "hello" });

    // Must not throw "No output generated" while iterating the answer channel.
    const chunks: string[] = [];
    await expect(
      (async () => {
        for await (const c of result.stream) chunks.push(c);
      })(),
    ).resolves.toBeUndefined();

    expect(chunks.join("")).toBe("");
    expect(await result.getText()).toBe("");
    expect(await result.getReasoning()).toBeUndefined();
  });

  it("streamText: getText/getReasoning/getUsage run concurrently with .stream without locking", async () => {
    // Regression: getX must not open a second reader on result.textStream while
    // the consumer is mid-iteration (would throw a ReadableStream lock error).
    const model = reasoningThenTextStreamModel(true);
    const resolver: ProviderResolver = () => model as any;
    const { logger } = makeLogger();
    const ai = createAIHelper("t", logger as any, undefined, resolver);

    const result = ai.streamText("gemini-2.5-flash", { prompt: "hello" });

    const chunks: string[] = [];
    const iterating = (async () => {
      for await (const c of result.stream) chunks.push(c);
    })();
    // Call the buffered accessors WHILE the stream is still being iterated.
    const [text, reasoning, usage] = await Promise.all([
      result.getText(),
      result.getReasoning(),
      result.getUsage(),
    ]);
    await iterating;

    expect(chunks.join("")).toBe("The answer is 42.");
    expect(text).toBe("The answer is 42.");
    expect(reasoning).toBe("thinking...");
    expect(usage.inputTokens).toBe(10);
    expect(usage.outputTokens).toBe(20);
  });

  it("streamText: getText() works without manually consuming the stream", async () => {
    const model = reasoningThenTextStreamModel();
    const resolver: ProviderResolver = () => model as any;
    const { logger } = makeLogger();
    const ai = createAIHelper("t", logger as any, undefined, resolver);

    const result = ai.streamText("gemini-2.5-flash", { prompt: "hello" });

    // Never iterate .stream; getText() must still reconcile the buffered text.
    expect(await result.getText()).toBe("The answer is 42.");
  });
});
