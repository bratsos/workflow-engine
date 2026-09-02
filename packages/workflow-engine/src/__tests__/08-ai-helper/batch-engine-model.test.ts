import type {
  Experimental_BatchLanguageModelV4,
  Experimental_BatchV4ItemResult,
  Experimental_BatchV4OperationOptions,
  Experimental_BatchV4StartOptions,
  Experimental_BatchV4StartResult,
  Experimental_BatchV4Status,
  Experimental_LanguageModelV4BatchRequest,
  LanguageModelV4GenerateResult,
} from "@ai-sdk/provider";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  createOpenRouterBatchModel,
  type EngineBatchItemResult,
  type EngineBatchRef,
  EngineBatchRefSchema,
  type EngineBatchRequest,
  fromAiSdk,
  isEngineBatchRef,
  resolveAiSdkBatchModel,
  toJsonSchema,
} from "../../ai/batch";

// Hand-rolled fake Experimental_BatchLanguageModelV4 for testing
class MockBatchLanguageModel
  implements Partial<Experimental_BatchLanguageModelV4>
{
  readonly specificationVersion = "v4" as const;
  readonly provider = "mock-provider";
  readonly modelId = "mock-model";

  startBatchCalls: Array<
    Experimental_BatchV4StartOptions<Experimental_LanguageModelV4BatchRequest>
  > = [];
  getStatusCalls: Array<Experimental_BatchV4OperationOptions> = [];
  getResultsCalls: Array<Experimental_BatchV4OperationOptions> = [];

  mockStartResult: Experimental_BatchV4StartResult = {
    batchId: "batch-ai-sdk-1",
    status: "pending",
    warnings: [],
    requestCounts: { total: 1, pending: 1, completed: 0, failed: 0 },
  };

  mockStatusResult: Experimental_BatchV4Status = {
    status: "completed",
    rawStatus: "COMPLETED",
    requestCounts: { total: 1, pending: 0, completed: 1, failed: 0 },
  };

  mockResults: Array<
    Experimental_BatchV4ItemResult<LanguageModelV4GenerateResult>
  > = [];

  async experimental_doStartBatch(
    options: Experimental_BatchV4StartOptions<Experimental_LanguageModelV4BatchRequest>,
  ): Promise<Experimental_BatchV4StartResult> {
    this.startBatchCalls.push(options);
    return this.mockStartResult;
  }

  async experimental_doGetBatchStatus(
    options: Experimental_BatchV4OperationOptions,
  ): Promise<Experimental_BatchV4Status> {
    this.getStatusCalls.push(options);
    return this.mockStatusResult;
  }

  async experimental_doGetBatchResults(
    options: Experimental_BatchV4OperationOptions,
  ): Promise<
    ReadableStream<
      Experimental_BatchV4ItemResult<LanguageModelV4GenerateResult>
    >
  > {
    this.getResultsCalls.push(options);
    const items = this.mockResults;
    return new ReadableStream({
      start(controller) {
        for (const item of items) {
          controller.enqueue(item);
        }
        controller.close();
      },
    });
  }
}

describe("Batch Subsystem - Frozen Model Contract & Schema", () => {
  it("validates EngineBatchRef with EngineBatchRefSchema and round-trips via JSON", () => {
    const validRef: EngineBatchRef = {
      version: 1,
      type: "text",
      id: "batch-999",
      provider: "openrouter",
      modelId: "openai/gpt-4o",
    };

    const serialized = JSON.stringify(validRef);
    const parsed = JSON.parse(serialized);
    const validated = EngineBatchRefSchema.parse(parsed);

    expect(validated).toEqual(validRef);
    expect(isEngineBatchRef(validRef)).toBe(true);
    expect(isEngineBatchRef(parsed)).toBe(true);
  });

  it("isEngineBatchRef rejects invalid shapes", () => {
    expect(isEngineBatchRef(null)).toBe(false);
    expect(isEngineBatchRef({})).toBe(false);
    expect(
      isEngineBatchRef({
        version: 2,
        type: "text",
        id: "b-1",
        provider: "google",
        modelId: "m1",
      }),
    ).toBe(false);
    expect(
      isEngineBatchRef({
        version: 1,
        type: "audio",
        id: "b-1",
        provider: "google",
        modelId: "m1",
      }),
    ).toBe(false);
    expect(
      isEngineBatchRef({
        version: 1,
        type: "text",
        id: "b-1",
      }),
    ).toBe(false);
  });

  it("toJsonSchema converts a Zod schema to a valid JSON Schema object", () => {
    const schema = z.object({
      title: z.string(),
      score: z.number(),
    });

    const jsonSchema = toJsonSchema(schema);
    expect(jsonSchema).toBeDefined();
    expect(typeof jsonSchema).toBe("object");
    expect((jsonSchema as any).type).toBe("object");
    expect((jsonSchema as any).properties?.title).toBeDefined();
    expect((jsonSchema as any).properties?.score).toBeDefined();
  });
});

describe("Batch Subsystem - AI SDK Adapter (fromAiSdk)", () => {
  it("rejects non-batch-capable models at construction with a clear error", () => {
    expect(() =>
      fromAiSdk({}, { provider: "openai", modelId: "gpt-4o" }),
    ).toThrowError(/not batch-capable/i);

    expect(() =>
      fromAiSdk(
        {
          experimental_doStartBatch: () => {},
        },
        { provider: "openai", modelId: "gpt-4o" },
      ),
    ).toThrowError(/openai\.chat\(\) is not batch-capable/i);
  });

  it("maps start() requests including system prompt, user prompt, maxOutputTokens, temperature, and responseFormat", async () => {
    const mockModel = new MockBatchLanguageModel();
    const batchModel = fromAiSdk(mockModel, {
      provider: "google.generative-ai",
      modelId: "gemini-2.5-flash",
    });

    const schema = z.object({
      summary: z.string(),
    });

    const requests: EngineBatchRequest[] = [
      {
        id: "req-1",
        prompt: "Analyze this text",
        system: "You are a concise analyst.",
        maxOutputTokens: 256,
        temperature: 0.2,
        schema,
      },
      {
        id: "req-2",
        prompt: "Simple prompt without system or schema",
      },
    ];

    const result = await batchModel.start(requests);

    expect(result.id).toBe("batch-ai-sdk-1");
    expect(result.version).toBe(1);
    expect(result.type).toBe("text");
    expect(result.provider).toBe("google.generative-ai");
    expect(result.modelId).toBe("gemini-2.5-flash");
    expect(result.status).toBe("pending");

    expect(mockModel.startBatchCalls.length).toBe(1);
    const call = mockModel.startBatchCalls[0];
    expect(call.requests.length).toBe(2);

    // Request 1 mapping
    const r1 = call.requests[0];
    expect(r1.id).toBe("req-1");
    expect(r1.options.maxOutputTokens).toBe(256);
    expect(r1.options.temperature).toBe(0.2);
    expect(r1.options.prompt).toEqual([
      { role: "system", content: "You are a concise analyst." },
      { role: "user", content: [{ type: "text", text: "Analyze this text" }] },
    ]);
    expect(r1.options.responseFormat?.type).toBe("json");
    expect((r1.options.responseFormat as any)?.schema).toBeDefined();

    // Request 2 mapping
    const r2 = call.requests[1];
    expect(r2.id).toBe("req-2");
    expect(r2.options.maxOutputTokens).toBeUndefined();
    expect(r2.options.temperature).toBeUndefined();
    expect(r2.options.prompt).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "Simple prompt without system or schema" },
        ],
      },
    ]);
    expect(r2.options.responseFormat).toBeUndefined();
  });

  it("maps status() correctly", async () => {
    const mockModel = new MockBatchLanguageModel();
    mockModel.mockStatusResult = {
      status: "completed",
      rawStatus: "COMPLETED",
      requestCounts: { total: 10, pending: 0, completed: 9, failed: 1 },
      error: { message: "Partial failure" },
    };

    const batchModel = fromAiSdk(mockModel, {
      provider: "anthropic.messages",
      modelId: "claude-3-5-sonnet",
    });

    const status = await batchModel.status({
      version: 1,
      type: "text",
      id: "batch-ai-sdk-1",
      provider: "anthropic.messages",
      modelId: "claude-3-5-sonnet",
    });

    expect(status.status).toBe("completed");
    expect(status.rawStatus).toBe("COMPLETED");
    expect(status.requestCounts).toEqual({
      total: 10,
      pending: 0,
      completed: 9,
      failed: 1,
    });
    expect(status.error).toBe("Partial failure");
  });

  it("streams and maps results for all four item statuses (succeeded, failed, cancelled, expired)", async () => {
    const mockModel = new MockBatchLanguageModel();
    mockModel.mockResults = [
      {
        id: "req-1",
        status: "succeeded",
        result: {
          content: [
            { type: "text", text: "Hello " },
            { type: "text", text: "world!" },
          ],
          finishReason: { unified: "stop", raw: "stop" },
          warnings: [],
          usage: {
            inputTokens: {
              total: 12,
              noCache: 12,
              cacheRead: 0,
              cacheWrite: 0,
            },
            outputTokens: {
              total: 24,
              text: 24,
              reasoning: 0,
            },
          },
        },
      },
      {
        id: "req-2",
        status: "failed",
        error: { message: "Content policy violation" },
      },
      {
        id: "req-3",
        status: "cancelled",
        error: { message: "Batch was cancelled" },
      },
      {
        id: "req-4",
        status: "expired",
        error: { message: "Batch expired before processing" },
      },
    ];

    const batchModel = fromAiSdk(mockModel, {
      provider: "google.generative-ai",
      modelId: "gemini-2.5-flash",
    });

    const ref: EngineBatchRef = {
      version: 1,
      type: "text",
      id: "batch-ai-sdk-1",
      provider: "google.generative-ai",
      modelId: "gemini-2.5-flash",
    };

    const items: EngineBatchItemResult[] = [];
    for await (const item of batchModel.results(ref)) {
      items.push(item);
    }

    expect(items.length).toBe(4);

    expect(items[0]).toEqual({
      id: "req-1",
      status: "succeeded",
      text: "Hello world!",
      inputTokens: 12,
      outputTokens: 24,
    });

    expect(items[1]).toEqual({
      id: "req-2",
      status: "failed",
      error: "Content policy violation",
    });

    expect(items[2]).toEqual({
      id: "req-3",
      status: "cancelled",
      error: "Batch was cancelled",
    });

    expect(items[3]).toEqual({
      id: "req-4",
      status: "expired",
      error: "Batch expired before processing",
    });
  });

  it("resolves dynamic AI SDK batch models for supported vendors", async () => {
    const googleModel = await resolveAiSdkBatchModel(
      "google",
      "gemini-2.5-flash",
    );
    expect(googleModel.provider).toBe("google.generative-ai");
    expect(googleModel.modelId).toBe("gemini-2.5-flash");

    const anthropicModel = await resolveAiSdkBatchModel(
      "anthropic",
      "claude-3-5-sonnet",
    );
    expect(anthropicModel.provider).toBe("anthropic.messages");
    expect(anthropicModel.modelId).toBe("claude-3-5-sonnet");

    const openaiModel = await resolveAiSdkBatchModel("openai", "gpt-4o");
    expect(openaiModel.provider).toBe("openai.responses");
    expect(openaiModel.modelId).toBe("gpt-4o");
  });
});

describe("Batch Subsystem - OpenRouter Fetch Client (createOpenRouterBatchModel)", () => {
  it("enforces payload key ORDER (requests appears after endpoint and model)", async () => {
    let capturedBody = "";
    const mockFetch = vi.fn(
      async (url: string | URL | Request, init?: RequestInit) => {
        capturedBody = init?.body as string;
        return new Response(
          JSON.stringify({
            id: "batch-or-1",
            status: "validating",
            request_counts: { total: 1, completed: 0, failed: 0 },
          }),
          { status: 202, headers: { "Content-Type": "application/json" } },
        );
      },
    );

    const model = createOpenRouterBatchModel({
      apiKey: "sk-or-test-key",
      modelId: "openai/gpt-4o",
      fetch: mockFetch as any,
    });

    await model.start([{ id: "req-1", prompt: "Hello OpenRouter" }]);

    expect(capturedBody).toBeDefined();
    const endpointIdx = capturedBody.indexOf('"endpoint"');
    const modelIdx = capturedBody.indexOf('"model"');
    const requestsIdx = capturedBody.indexOf('"requests"');

    expect(endpointIdx).toBeGreaterThan(-1);
    expect(modelIdx).toBeGreaterThan(endpointIdx);
    expect(requestsIdx).toBeGreaterThan(modelIdx);
  });

  it("passes auth header, baseURL, and custom headers properly", async () => {
    let capturedUrl = "";
    let capturedHeaders: Record<string, string> = {};

    const mockFetch = vi.fn(
      async (url: string | URL | Request, init?: RequestInit) => {
        capturedUrl = url.toString();
        capturedHeaders = init?.headers as Record<string, string>;
        return new Response(
          JSON.stringify({
            id: "batch-or-2",
            status: "validating",
            request_counts: { total: 1, completed: 0, failed: 0 },
          }),
          { status: 202, headers: { "Content-Type": "application/json" } },
        );
      },
    );

    const model = createOpenRouterBatchModel({
      apiKey: "sk-or-custom-secret",
      modelId: "anthropic/claude-3.5-sonnet",
      baseURL: "https://custom.openrouter.ai/api/beta/",
      headers: { "X-Custom-Header": "custom-val" },
      fetch: mockFetch as any,
    });

    await model.start([{ id: "req-1", prompt: "Test" }], {
      headers: { "X-Call-Header": "call-val" },
    });

    expect(capturedUrl).toBe("https://custom.openrouter.ai/api/beta/batches");
    expect(capturedHeaders["Authorization"]).toBe("Bearer sk-or-custom-secret");
    expect(capturedHeaders["Content-Type"]).toBe("application/json");
    expect(capturedHeaders["X-Custom-Header"]).toBe("custom-val");
    expect(capturedHeaders["X-Call-Header"]).toBe("call-val");
    expect(model.modelId).toBe("anthropic/claude-3.5-sonnet");
  });

  it("emits structured-output response_format on item body when schema is provided", async () => {
    let capturedBody = "";
    const mockFetch = vi.fn(
      async (url: string | URL | Request, init?: RequestInit) => {
        capturedBody = init?.body as string;
        return new Response(
          JSON.stringify({
            id: "batch-or-schema",
            status: "validating",
          }),
          { status: 202, headers: { "Content-Type": "application/json" } },
        );
      },
    );

    const model = createOpenRouterBatchModel({
      apiKey: "test-key",
      modelId: "openai/gpt-4o",
      fetch: mockFetch as any,
    });

    const schema = z.object({
      category: z.string(),
      confidence: z.number(),
    });

    await model.start([
      {
        id: "req-structured",
        prompt: "Categorize this",
        system: "Be structured",
        schema,
        maxOutputTokens: 100,
        temperature: 0.1,
      },
    ]);

    const parsed = JSON.parse(capturedBody);
    expect(parsed.requests.length).toBe(1);
    const reqBody = parsed.requests[0].body;

    expect(reqBody.max_tokens).toBe(100);
    expect(reqBody.temperature).toBe(0.1);
    expect(reqBody.messages).toEqual([
      { role: "system", content: "Be structured" },
      { role: "user", content: "Categorize this" },
    ]);
    expect(reqBody.response_format?.type).toBe("json_schema");
    expect(reqBody.response_format?.json_schema?.name).toBe("response");
    expect(reqBody.response_format?.json_schema?.strict).toBe(true);
    expect(
      reqBody.response_format?.json_schema?.schema?.properties?.category,
    ).toBeDefined();
  });

  it("maps an unrecognized upstream status to failed with a naming error, not to processing", async () => {
    // A renamed or newly added OpenRouter status must not silently poll for
    // 24h; it must fail loudly with the raw status preserved.
    const mockFetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ id: "batch-test", status: "quota_exceeded" }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    );
    const model = createOpenRouterBatchModel({
      apiKey: "test-key",
      modelId: "openai/gpt-4o",
      fetch: mockFetch as any,
    });
    const status = await model.status({
      version: 1,
      type: "text",
      id: "batch-test",
      provider: "openrouter",
      modelId: "openai/gpt-4o",
    });
    expect(status.status).toBe("failed");
    expect(status.rawStatus).toBe("quota_exceeded");
    expect(status.error).toMatch(
      /Unrecognized OpenRouter batch status "quota_exceeded"/,
    );
  });

  it("accepts null for optional fields and never synthesizes a zero total", async () => {
    // OpenRouter sends `null`, not absence, for fields it has no value for.
    const mockFetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            id: "batch-test",
            status: "in_progress",
            request_counts: { completed: 2 },
            usage: null,
            created_at: null,
            results: null,
            error: null,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    );
    const model = createOpenRouterBatchModel({
      apiKey: "test-key",
      modelId: "openai/gpt-4o",
      fetch: mockFetch as any,
    });
    const status = await model.status({
      version: 1,
      type: "text",
      id: "batch-test",
      provider: "openrouter",
      modelId: "openai/gpt-4o",
    });
    expect(status.status).toBe("processing");
    // No `total` upstream -> no counts at all, rather than total: 0.
    expect(status.requestCounts).toBeUndefined();
  });

  it("maps all 8 upstream OpenRouter statuses correctly", async () => {
    const statuses = [
      { upstream: "validating", expected: "pending" },
      { upstream: "in_progress", expected: "processing" },
      { upstream: "finalizing", expected: "processing" },
      { upstream: "completed", expected: "completed" },
      { upstream: "failed", expected: "failed" },
      { upstream: "expired", expected: "failed" },
      { upstream: "cancelling", expected: "failed" },
      { upstream: "cancelled", expected: "failed" },
    ] as const;

    for (const { upstream, expected } of statuses) {
      const mockFetch = vi.fn(async () => {
        return new Response(
          JSON.stringify({
            id: "batch-test",
            status: upstream,
            request_counts: { total: 5, completed: 3, failed: 1 },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      });

      const model = createOpenRouterBatchModel({
        apiKey: "test-key",
        modelId: "openai/gpt-4o",
        fetch: mockFetch as any,
      });

      const status = await model.status({
        version: 1,
        type: "text",
        id: "batch-test",
        provider: "openrouter",
        modelId: "openai/gpt-4o",
      });

      expect(status.status).toBe(expected);
      expect(status.rawStatus).toBe(upstream);
      expect(status.requestCounts).toEqual({
        total: 5,
        pending: 1,
        completed: 3,
        failed: 1,
      });
    }
  });

  it("maps results for a success item, an error item, and an HTTP error item in a mixed batch", async () => {
    const mockFetch = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          id: "batch-results-test",
          status: "completed",
          results: [
            {
              custom_id: "req-success",
              response: {
                status_code: 200,
                body: {
                  choices: [
                    {
                      message: {
                        content: '{"result":"structured output"}',
                      },
                    },
                  ],
                  usage: {
                    prompt_tokens: 40,
                    completion_tokens: 80,
                  },
                },
              },
            },
            {
              custom_id: "req-err-field",
              error: {
                message: "Provider rate limit exceeded on item",
              },
            },
            {
              custom_id: "req-http-err",
              response: {
                status_code: 400,
                body: {
                  error: {
                    message: "Invalid response schema requested",
                  },
                },
              },
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });

    const model = createOpenRouterBatchModel({
      apiKey: "test-key",
      modelId: "openai/gpt-4o",
      fetch: mockFetch as any,
    });

    const ref: EngineBatchRef = {
      version: 1,
      type: "text",
      id: "batch-results-test",
      provider: "openrouter",
      modelId: "openai/gpt-4o",
    };

    const items: EngineBatchItemResult[] = [];
    for await (const item of model.results(ref)) {
      items.push(item);
    }

    expect(items.length).toBe(3);

    expect(items[0]).toEqual({
      id: "req-success",
      status: "succeeded",
      text: '{"result":"structured output"}',
      inputTokens: 40,
      outputTokens: 80,
    });

    expect(items[1]).toEqual({
      id: "req-err-field",
      status: "failed",
      error: "Provider rate limit exceeded on item",
      inputTokens: 0,
      outputTokens: 0,
    });

    expect(items[2]).toEqual({
      id: "req-http-err",
      status: "failed",
      error: "Invalid response schema requested",
      inputTokens: 0,
      outputTokens: 0,
    });
  });

  it("throws when calling results() on a non-completed batch", async () => {
    const mockFetch = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          id: "batch-in-progress",
          status: "in_progress",
          results: null,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });

    const model = createOpenRouterBatchModel({
      apiKey: "test-key",
      modelId: "openai/gpt-4o",
      fetch: mockFetch as any,
    });

    const ref: EngineBatchRef = {
      version: 1,
      type: "text",
      id: "batch-in-progress",
      provider: "openrouter",
      modelId: "openai/gpt-4o",
    };

    await expect(async () => {
      for await (const _ of model.results(ref)) {
        // iterate
      }
    }).rejects.toThrowError(/not completed.*results: null/i);
  });

  it("never retries POST on failure, but retries 429 GET honoring Retry-After", async () => {
    // 1. Test POST failure is not retried
    let postCallCount = 0;
    const mockPostFetch = vi.fn(async () => {
      postCallCount++;
      return new Response(JSON.stringify({ error: "Rate limit exceeded" }), {
        status: 429,
        headers: { "Content-Type": "application/json" },
      });
    });

    const postModel = createOpenRouterBatchModel({
      apiKey: "test-key",
      modelId: "openai/gpt-4o",
      fetch: mockPostFetch as any,
    });

    await expect(
      postModel.start([{ id: "r1", prompt: "Hello" }]),
    ).rejects.toThrowError(/OpenRouter batch creation failed/i);
    expect(postCallCount).toBe(1);

    // 2. Test GET 429 is retried and honors Retry-After
    let getCallCount = 0;
    const mockGetFetch = vi.fn(async () => {
      getCallCount++;
      if (getCallCount === 1) {
        return new Response(JSON.stringify({ error: "Too Many Requests" }), {
          status: 429,
          headers: {
            "Content-Type": "application/json",
            "Retry-After": "0.01",
          },
        });
      }
      return new Response(
        JSON.stringify({
          id: "batch-retry-ok",
          status: "completed",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });

    const getModel = createOpenRouterBatchModel({
      apiKey: "test-key",
      modelId: "openai/gpt-4o",
      fetch: mockGetFetch as any,
    });

    const status = await getModel.status({
      version: 1,
      type: "text",
      id: "batch-retry-ok",
      provider: "openrouter",
      modelId: "openai/gpt-4o",
    });

    expect(status.status).toBe("completed");
    expect(getCallCount).toBe(2);
  });
});
