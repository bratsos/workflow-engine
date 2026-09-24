/**
 * When the vendor batch SDK is not installed, or its release exposes no
 * batch seam the engine can drive, but OpenRouter can batch the model, the
 * batch helper falls back to the OpenRouter transport with a WARN instead of
 * failing the submit.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { AIBatchImpl } from "../../ai/batch-helper.js";
import { registerModels } from "../../ai/model-helper.js";
import { InMemoryAICallLogger } from "../../testing/in-memory-ai-logger.js";

const resolveError = vi.hoisted(() => ({
  next: (): Error =>
    new Error(
      'Package "@ai-sdk/anthropic" is required to use vendor "anthropic". Please install @ai-sdk/anthropic.',
    ),
}));

vi.mock("../../ai/batch/ai-sdk.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../ai/batch/ai-sdk.js")>()),
  resolveAiSdkBatchModel: async () => {
    throw resolveError.next();
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
  // A catalog generated before `batchModelId` existed (2026-05 sync output).
  "fallback-nano-no-batch-id": {
    id: "openai/gpt-5-nano",
    name: "Nano",
    inputCostPerMillion: 1,
    outputCostPerMillion: 5,
    provider: "openrouter",
    supportsAsyncBatch: true,
  },
});

describe("vendor batch SDK missing", () => {
  afterEach(() => {
    resolveError.next = () =>
      new Error(
        'Package "@ai-sdk/anthropic" is required to use vendor "anthropic". Please install @ai-sdk/anthropic.',
      );
  });

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

  it("derives the OpenRouter batch id when the catalog entry has no batchModelId", async () => {
    const bodies: string[] = [];
    const fetchFn = vi.fn(async (_url: string | URL | Request, init?: any) => {
      bodies.push(String(init?.body ?? ""));
      return new Response(
        JSON.stringify({
          id: "batch-or-2",
          status: "validating",
          request_counts: { total: 1, completed: 0, failed: 0 },
        }),
        { status: 202, headers: { "Content-Type": "application/json" } },
      );
    });
    const logs: string[] = [];
    const batch = new AIBatchImpl(
      { topic: "t", aiCallLogger: new InMemoryAICallLogger() },
      "fallback-nano-no-batch-id",
      "openai",
      (level, message) => logs.push(`${level}: ${message}`),
      { apiKey: "sk-or-test", fetch: fetchFn as never },
    );

    const handle = await batch.submit([{ id: "r1", prompt: "hello" }]);

    expect(handle.provider).toBe("openrouter");
    expect(bodies[0]).toContain('"model":"openai/gpt-5-nano"');
    expect(logs).toEqual([
      expect.stringMatching(
        /^WARN: .*Falling back to the OpenRouter batch transport.*assuming OpenRouter serves "openai\/gpt-5-nano:batch".*regenerate it with workflow-engine-sync/,
      ),
    ]);
  });

  it("falls back when the vendor release exposes no batch seam", async () => {
    const { NotBatchCapableError } = await import("../../ai/batch/ai-sdk.js");
    resolveError.next = () =>
      new NotBatchCapableError("anthropic.messages", "claude-haiku-4-5");
    const fetchFn = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            id: "batch-or-3",
            status: "validating",
            request_counts: { total: 1, completed: 0, failed: 0 },
          }),
          { status: 202, headers: { "Content-Type": "application/json" } },
        ),
    );
    const logs: string[] = [];
    const batch = new AIBatchImpl(
      { topic: "t", aiCallLogger: new InMemoryAICallLogger() },
      "fallback-haiku",
      "anthropic",
      (level, message) => logs.push(`${level}: ${message}`),
      { apiKey: "sk-or-test", fetch: fetchFn as never },
    );

    const handle = await batch.submit([{ id: "r1", prompt: "hello" }]);

    expect(handle.provider).toBe("openrouter");
    expect(logs).toEqual([
      expect.stringMatching(
        /^WARN: .*not batch-capable.*Falling back to the OpenRouter batch transport/,
      ),
    ]);
  });
});
