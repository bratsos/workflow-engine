import { MockLanguageModelV4 } from "ai/test";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AICallTimeoutError,
  createAIHelper,
  type ProviderResolver,
} from "../../ai/ai-helper.js";
import { registerModels } from "../../ai/model-helper.js";
import type { AIAdapter } from "../../ai/types.js";
import { MAX_TIMER_MS } from "../../kernel/helpers/host-support.js";
import { InMemoryAICallLogger } from "../../testing/in-memory-ai-logger.js";

const MODEL = "timeout-test-model";
registerModels({
  [MODEL]: {
    id: "timeout/test",
    name: "Timeout Test",
    provider: "fake",
    inputCostPerMillion: 1,
    outputCostPerMillion: 1,
  },
});

afterEach(() => {
  vi.useRealTimers();
});

function neverGeneratingModel() {
  return new MockLanguageModelV4({
    doGenerate: async () => new Promise<never>(() => {}),
    doStream: async () => new Promise<never>(() => {}),
  });
}

describe("AI call timeouts", () => {
  it("throws AICallTimeoutError and logs the failed call", async () => {
    vi.useFakeTimers();
    const aiLogger = new InMemoryAICallLogger();
    const model = neverGeneratingModel();
    const resolver: ProviderResolver = () => model;
    const ai = createAIHelper("timeout.topic", aiLogger, undefined, resolver, {
      timeout: { perCallMs: 1_000 },
    });

    const pending = ai.generateText(MODEL, "never", { timeoutMs: 100 });
    const assertion =
      expect(pending).rejects.toBeInstanceOf(AICallTimeoutError);
    await vi.advanceTimersByTimeAsync(100);
    await assertion;

    const failure = aiLogger.getCallsByTopic("timeout.topic")[0];
    expect(failure?.metadata).toMatchObject({ status: "error" });
    expect(failure?.metadata).toMatchObject({
      error: expect.stringContaining("100ms"),
    });
  });

  it("applies the deadline to the whole stream", async () => {
    vi.useFakeTimers();
    const aiLogger = new InMemoryAICallLogger();
    const model = neverGeneratingModel();
    const resolver: ProviderResolver = () => model;
    const ai = createAIHelper("timeout.stream", aiLogger, undefined, resolver);

    const result = ai.streamText(
      MODEL,
      { prompt: "never" },
      { timeoutMs: 100 },
    );
    const pending = result.getUsage();
    const assertion =
      expect(pending).rejects.toBeInstanceOf(AICallTimeoutError);
    await vi.advanceTimersByTimeAsync(100);
    await assertion;

    expect(aiLogger.getCallsByTopic("timeout.stream")).toHaveLength(1);
  });

  const BAD = [0, -1, NaN, Infinity, 0.5, MAX_TIMER_MS + 1, "100"];
  const message = (name: string) =>
    new RegExp(
      `${name} must be a number of milliseconds from 1 to ${MAX_TIMER_MS}`,
    );
  const echo = () => {
    const calls: unknown[] = [];
    const adapter: AIAdapter = {
      generateText: async (request) => {
        calls.push(request);
        return { text: "ok", inputTokens: 1, outputTokens: 1 };
      },
    };
    return { adapter, calls };
  };

  it("refuses a per-call timeoutMs a timer cannot honour before the call is made", async () => {
    const { adapter, calls } = echo();
    const aiLogger = new InMemoryAICallLogger();
    const ai = createAIHelper("timeout.call", aiLogger, undefined, undefined, {
      adapter,
    });

    for (const bad of BAD) {
      await expect(
        ai.generateText(MODEL, "x", { timeoutMs: bad as number }),
        String(bad),
      ).rejects.toThrow(message("timeoutMs"));
    }
    expect(calls).toHaveLength(0);
    expect(aiLogger.getCallsByTopic("timeout.call")).toHaveLength(0);

    for (const ok of [1, MAX_TIMER_MS]) {
      await expect(
        ai.generateText(MODEL, "x", { timeoutMs: ok }),
      ).resolves.toMatchObject({ text: "ok" });
    }
    expect(calls).toHaveLength(2);
  });

  it("refuses a timeout.perCallMs a timer cannot honour when the helper is created", async () => {
    const { adapter, calls } = echo();
    const aiLogger = new InMemoryAICallLogger();

    for (const bad of BAD) {
      expect(
        () =>
          createAIHelper("timeout.config", aiLogger, undefined, undefined, {
            adapter,
            timeout: { perCallMs: bad as number },
          }),
        String(bad),
      ).toThrow(message("timeout.perCallMs"));
    }

    for (const ok of [1, MAX_TIMER_MS]) {
      const ai = createAIHelper(
        "timeout.config",
        aiLogger,
        undefined,
        undefined,
        {
          adapter,
          timeout: { perCallMs: ok },
        },
      );
      await expect(ai.generateText(MODEL, "x")).resolves.toMatchObject({
        text: "ok",
      });
    }
    expect(calls).toHaveLength(2);
  });
});
