/**
 * When the vendor batch SDK is not installed but OpenRouter can batch the
 * model, the batch helper falls back to the OpenRouter transport with a
 * WARN instead of failing the submit with an install instruction.
 */

import { describe, expect, it, vi } from "vitest";
import { AIBatchImpl } from "../../ai/batch-helper.js";
import { registerModels } from "../../ai/model-helper.js";
import { InMemoryAICallLogger } from "../../testing/in-memory-ai-logger.js";

vi.mock("../../ai/batch/ai-sdk.js", () => ({
  resolveAiSdkBatchModel: async () => {
    throw new Error(
      'Package "@ai-sdk/anthropic" is required to use vendor "anthropic". Please install @ai-sdk/anthropic.',
    );
  },
}));

registerModels({
  "fallback-haiku": {
    id: "anthropic/claude-haiku-4.5",
    name: "Haiku",
    inputCostPerMillion: 1,
    outputCostPerMillion: 5,
    provider: "openrouter",
    supportsAsyncBatch: true,
    batchModelId: "anthropic/claude-haiku-4.5:batch",
  },
});

describe("vendor batch SDK missing", () => {
  it("submits through OpenRouter and warns", async () => {
    const urls: string[] = [];
    const fetchFn = vi.fn(async (url: string | URL | Request) => {
      urls.push(String(url));
      return new Response(
        JSON.stringify({
          id: "batch-or-1",
          status: "validating",
          request_counts: { total: 1, completed: 0, failed: 0 },
        }),
        { status: 202, headers: { "Content-Type": "application/json" } },
      );
    });
    const logs: string[] = [];
    const batch = new AIBatchImpl(
      { topic: "t", aiCallLogger: new InMemoryAICallLogger() },
      "fallback-haiku",
      "anthropic",
      (level, message) => logs.push(`${level}: ${message}`),
      { apiKey: "sk-or-test", fetch: fetchFn as never },
    );

    const handle = await batch.submit([{ id: "r1", prompt: "hello" }]);

    expect(handle.id).toBe("batch-or-1");
    expect(handle.provider).toBe("openrouter");
    expect(urls[0]).toContain("openrouter.ai/api/beta/batches");
    expect(
      logs.some(
        (l) => l.startsWith("WARN") && /Falling back to the OpenRouter/.test(l),
      ),
    ).toBe(true);
  });
});
