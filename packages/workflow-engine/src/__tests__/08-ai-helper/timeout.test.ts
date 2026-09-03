import { MockLanguageModelV4 } from "ai/test";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AICallTimeoutError,
  createAIHelper,
  type ProviderResolver,
} from "../../ai/ai-helper.js";
import { registerModels } from "../../ai/model-helper.js";
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
});
