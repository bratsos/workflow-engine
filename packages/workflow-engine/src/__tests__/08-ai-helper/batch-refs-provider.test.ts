/**
 * A batch is polled and collected through the transport named by the refs
 * stored at submit, not through whatever the live registry resolves for
 * the model key now: a `batchProvider` change while a batch is in flight
 * must not strand the run.
 */

import { describe, expect, it, vi } from "vitest";
import {
  AIBatchImpl,
  batchProviderFromRefProvider,
} from "../../ai/batch-helper.js";
import { registerModels } from "../../ai/model-helper.js";
import { InMemoryAICallLogger } from "../../testing/in-memory-ai-logger.js";

registerModels({
  "refs-provider-gemini": {
    id: "google/gemini-2.5-flash-lite",
    name: "Gemini, batchProvider switched to google after submit",
    inputCostPerMillion: 1,
    outputCostPerMillion: 2,
    provider: "openrouter",
    supportsAsyncBatch: true,
    batchModelId: "google/gemini-2.5-flash-lite:batch",
    batchProvider: "google",
  },
});

describe("batch provider follows the stored refs", () => {
  it("maps a ref's provider id onto the engine provider", () => {
    expect(batchProviderFromRefProvider("openrouter")).toBe("openrouter");
    expect(batchProviderFromRefProvider("google.generative-ai")).toBe("google");
    expect(batchProviderFromRefProvider("anthropic.messages")).toBe(
      "anthropic",
    );
    expect(batchProviderFromRefProvider("openai.responses")).toBe("openai");
    expect(batchProviderFromRefProvider("custom")).toBeUndefined();
  });

  it("polls an OpenRouter batch through OpenRouter although the registry now names google", async () => {
    const urls: string[] = [];
    const fetchFn = vi.fn(async (url: string | URL | Request) => {
      urls.push(String(url));
      return new Response(
        JSON.stringify({
          id: "batch-or-9",
          status: "in_progress",
          request_counts: { total: 2, completed: 1, failed: 0 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });
    const batch = new AIBatchImpl(
      { topic: "t", aiCallLogger: new InMemoryAICallLogger() },
      "refs-provider-gemini",
      "google",
      undefined,
      { apiKey: "sk-or-test", fetch: fetchFn as never },
    );

    const status = await batch.getStatus("batch-or-9", {
      batchRefs: [
        {
          version: 1,
          type: "text",
          id: "batch-or-9",
          provider: "openrouter",
          modelId: "google/gemini-2.5-flash-lite",
        },
      ],
    });

    expect(status.provider).toBe("openrouter");
    expect(urls[0]).toContain("openrouter.ai/api/beta/batches/batch-or-9");
  });
});
