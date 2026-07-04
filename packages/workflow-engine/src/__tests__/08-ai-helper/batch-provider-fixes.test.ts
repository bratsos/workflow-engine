/**
 * Regression tests for verified bugs in the low-level batch provider
 * implementations (google-batch.ts, openai-batch.ts, anthropic-batch.ts),
 * driving each provider class directly against a mocked SDK client.
 *
 * Covers:
 *  - Google batch requests use native systemInstruction/generationConfig
 *    fields instead of stuffing system/maxTokens/temperature into prompt
 *    text, and use native responseMimeType + responseJsonSchema for
 *    structured output instead of prompt text.
 *  - OpenAI batch requests use max_completion_tokens (reasoning-model safe)
 *    instead of max_tokens.
 *  - Anthropic's errored-result message falls back cleanly through
 *    message -> type -> generic, with no "Error type: undefined".
 */

import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { registerModels } from "../../ai/model-helper.js";

// ============================================================================
// Google
// ============================================================================

const { googleCreateMock } = vi.hoisted(() => ({
  googleCreateMock: vi.fn(async (_args: any) => ({ name: "batch-123" })),
}));

vi.mock("@google/genai", () => ({
  GoogleGenAI: class {
    batches = {
      create: googleCreateMock,
      get: vi.fn(),
      delete: vi.fn(),
    };
  },
  JobState: {
    JOB_STATE_SUCCEEDED: "JOB_STATE_SUCCEEDED",
    JOB_STATE_FAILED: "JOB_STATE_FAILED",
    JOB_STATE_CANCELLED: "JOB_STATE_CANCELLED",
    JOB_STATE_PENDING: "JOB_STATE_PENDING",
    JOB_STATE_RUNNING: "JOB_STATE_RUNNING",
  },
  FunctionCallingConfigMode: { ANY: "ANY", NONE: "NONE", AUTO: "AUTO" },
}));

describe("GoogleBatchProvider.submit", () => {
  it("uses native systemInstruction/generationConfig fields instead of stuffing prompt text", async () => {
    process.env.GOOGLE_GENERATIVE_AI_API_KEY = "test-key";
    const { GoogleBatchProvider } = await import(
      "../../utils/batch/providers/google-batch.js"
    );
    const provider = new GoogleBatchProvider();

    await provider.submit([
      {
        id: "r1",
        prompt: "Summarize this document.",
        model: "gemini-2.5-flash",
        system: "Be terse.",
        maxTokens: 256,
        temperature: 0.2,
      },
    ]);

    expect(googleCreateMock).toHaveBeenCalledTimes(1);
    const args = googleCreateMock.mock.calls[0]![0] as any;
    const inlined = args.src.inlinedRequests[0];

    // Prompt text is untouched - no synthesized instructions appended.
    expect(inlined.contents[0].parts).toEqual([
      { text: "Summarize this document." },
    ]);

    // system/maxTokens/temperature flow through the native config instead.
    expect(inlined.config.systemInstruction).toBe("Be terse.");
    expect(inlined.config.maxOutputTokens).toBe(256);
    expect(inlined.config.temperature).toBe(0.2);
  });

  it("uses native responseMimeType + responseJsonSchema for structured output", async () => {
    process.env.GOOGLE_GENERATIVE_AI_API_KEY = "test-key";
    const { GoogleBatchProvider } = await import(
      "../../utils/batch/providers/google-batch.js"
    );
    const provider = new GoogleBatchProvider();
    const schema = z.object({ name: z.string(), age: z.number() });

    await provider.submit([
      {
        id: "r1",
        prompt: "Extract the person's details.",
        model: "gemini-2.5-flash",
        schema,
      },
    ]);

    const args = googleCreateMock.mock.calls.at(-1)![0] as any;
    const inlined = args.src.inlinedRequests[0];

    // No synthesized "please respond with JSON" text in the prompt.
    expect(inlined.contents[0].parts).toEqual([
      { text: "Extract the person's details." },
    ]);

    expect(inlined.config.responseMimeType).toBe("application/json");
    expect(inlined.config.responseJsonSchema).toBeDefined();
    expect(inlined.config.responseJsonSchema.type).toBe("object");
    expect(inlined.config.responseJsonSchema.properties).toHaveProperty("name");
    expect(inlined.config.responseJsonSchema.properties).toHaveProperty("age");
  });

  it("adds an id field to GoogleBatchRequest without needing an unsafe cast", async () => {
    process.env.GOOGLE_GENERATIVE_AI_API_KEY = "test-key";
    const { GoogleBatchProvider } = await import(
      "../../utils/batch/providers/google-batch.js"
    );
    const provider = new GoogleBatchProvider();

    const handle = await provider.submit([
      { id: "my-custom-id", prompt: "hi", model: "gemini-2.5-flash" },
    ]);

    expect(handle.metadata?.customIds).toEqual(["my-custom-id"]);
    const args = googleCreateMock.mock.calls.at(-1)![0] as any;
    expect(args.src.inlinedRequests[0].metadata.customId).toBe("my-custom-id");
  });
});

// ============================================================================
// OpenAI
// ============================================================================

const { openaiFilesCreateMock, openaiBatchesCreateMock } = vi.hoisted(() => ({
  openaiFilesCreateMock: vi.fn(async (_args: any) => ({
    id: "file-1",
    filename: "batch-requests.jsonl",
  })),
  openaiBatchesCreateMock: vi.fn(async (_args: any) => ({
    id: "batch-1",
    created_at: 0,
    status: "validating",
  })),
}));

vi.mock("openai", () => ({
  default: class {
    files = { create: openaiFilesCreateMock };
    batches = { create: openaiBatchesCreateMock };
  },
}));

describe("OpenAIBatchProvider.submit", () => {
  it("uses max_completion_tokens instead of max_tokens (reasoning-model safe)", async () => {
    registerModels({
      "bugfix-openai-batch-model": {
        id: "openai/gpt-4o-mini",
        name: "GPT-4o mini",
        inputCostPerMillion: 0,
        outputCostPerMillion: 0,
        provider: "openrouter",
        supportsAsyncBatch: true,
      },
    });
    const { OpenAIBatchProvider } = await import(
      "../../utils/batch/providers/openai-batch.js"
    );
    const provider = new OpenAIBatchProvider({ apiKey: "test-key" });

    await provider.submit([
      {
        customId: "r1",
        prompt: "hello",
        model: "bugfix-openai-batch-model" as never,
        maxTokens: 500,
      },
    ]);

    expect(openaiFilesCreateMock).toHaveBeenCalledTimes(1);
    const fileArg = openaiFilesCreateMock.mock.calls[0]?.[0] as {
      file: File;
    };
    const text = await fileArg.file.text();
    const body = JSON.parse(text).body;

    expect(body.max_completion_tokens).toBe(500);
    expect(body).not.toHaveProperty("max_tokens");
  });
});

// ============================================================================
// Anthropic
// ============================================================================

const { anthropicRetrieveMock, anthropicResultsMock } = vi.hoisted(() => ({
  anthropicRetrieveMock: vi.fn(async () => ({
    processing_status: "ended",
    request_counts: {
      succeeded: 0,
      errored: 3,
      canceled: 0,
      expired: 0,
      processing: 0,
    },
  })),
  anthropicResultsMock: vi.fn(),
}));

vi.mock("@anthropic-ai/sdk", () => ({
  Anthropic: class {
    messages = {
      batches: {
        retrieve: anthropicRetrieveMock,
        results: anthropicResultsMock,
      },
    };
  },
}));

describe("AnthropicBatchProvider errored-result message fallback", () => {
  it("prefers the error message, then the error type, then a generic fallback - never 'undefined'", async () => {
    anthropicResultsMock.mockResolvedValue(
      (async function* () {
        yield {
          custom_id: "has-message",
          result: {
            type: "errored",
            error: { type: "invalid_request_error", message: "Bad field" },
          },
        };
        yield {
          custom_id: "type-only",
          result: { type: "errored", error: { type: "overloaded_error" } },
        };
        yield {
          custom_id: "nothing",
          result: { type: "errored", error: undefined },
        };
      })(),
    );

    const { AnthropicBatchProvider } = await import(
      "../../utils/batch/providers/anthropic-batch.js"
    );
    const provider = new AnthropicBatchProvider({ apiKey: "test-key" });

    const results = await provider.getResults({
      id: "batch-1",
      provider: "anthropic",
      requestCount: 3,
      createdAt: new Date(),
    });

    const byId = Object.fromEntries(results.map((r) => [r.customId, r]));
    expect(byId["has-message"]?.error).toBe("Bad field");
    expect(byId["type-only"]?.error).toBe("Error type: overloaded_error");
    expect(byId.nothing?.error).toBe("Request errored");

    for (const r of results) {
      expect(r.error).not.toContain("undefined");
    }
  });
});
