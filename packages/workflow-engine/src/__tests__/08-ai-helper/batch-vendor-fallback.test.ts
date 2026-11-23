/**
 * When the vendor batch SDK is not installed, or its release exposes no
 * batch seam the engine can drive, but OpenRouter can batch the model, the
 * batch helper falls back to the OpenRouter transport with a WARN instead of
 * failing the submit.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createAIHelper,
  type OpenRouterRoutingOptions,
} from "../../ai/ai-helper.js";
import { AIBatchImpl } from "../../ai/batch-helper.js";
import { registerModels } from "../../ai/model-helper.js";
import { InMemoryAICallLogger } from "../../testing/in-memory-ai-logger.js";

const resolveError = vi.hoisted(() => ({
  next: (vendor: string): Error =>
    new Error(
      `Package "@ai-sdk/${vendor}" is required to use vendor "${vendor}". Please install @ai-sdk/${vendor}.`,
    ),
}));

vi.mock("../../ai/batch/ai-sdk.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../ai/batch/ai-sdk.js")>()),
  resolveAiSdkBatchModel: async (vendor: string) => {
    throw resolveError.next(vendor);
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
  const openRouterKey = "test-openrouter-environment";
  const nativeKey = "test-native-option";
  const openRouterBatches = "https://openrouter.ai/api/v1/batches";
  const nativeClients = [
    ["openai", "fallback-nano-no-batch-id", "https://api.openai.com/v1"],
    ["anthropic", "fallback-haiku", "https://api.anthropic.com/v1"],
  ] as const;

  beforeEach(() => {
    vi.stubEnv("OPENROUTER_API_KEY", openRouterKey);
    vi.stubEnv("OPENAI_API_KEY", "test-openai-environment");
    vi.stubEnv("ANTHROPIC_API_KEY", "test-anthropic-environment");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    resolveError.next = (vendor) =>
      new Error(
        `Package "@ai-sdk/${vendor}" is required to use vendor "${vendor}". Please install @ai-sdk/${vendor}.`,
      );
  });

  function helperWithPolicy(provider?: OpenRouterRoutingOptions["provider"]) {
    return createAIHelper(
      "batch-options",
      new InMemoryAICallLogger(),
      undefined,
      undefined,
      {
        routing: { provider },
      },
    );
  }

  describe.each(
    nativeClients,
  )("%s transport options", (vendor, modelKey, nativeUrl) => {
    const requests = [{ id: "order-1", prompt: "Classify the order." }];
    const policy = { only: ["azure"], allowFallbacks: false };
    const explicitOptions = [
      ["baseURL", { baseURL: nativeUrl }],
      ["apiKey", { apiKey: nativeKey }],
      ["baseURL and apiKey", { baseURL: nativeUrl, apiKey: nativeKey }],
    ] as const;

    it.each(
      explicitOptions,
    )("refuses fallback with explicit %s, with or without a policy", async (_setting, options) => {
      const fetchFn = vi
        .fn<typeof fetch>()
        .mockImplementation(async () =>
          Response.json(
            { id: "batch-1", status: "validating" },
            { status: 202 },
          ),
        );
      for (const constraint of [policy, undefined]) {
        await expect(
          helperWithPolicy(constraint)
            .batch(modelKey, vendor, {
              ...options,
              fetch: fetchFn,
            })
            .submit(requests),
        ).rejects.toThrow(/configure.*OpenRouter.*explicitly/i);
      }
      expect(fetchFn).not.toHaveBeenCalled();
    });

    it("uses the OpenRouter destination and environment credential for fallback", async () => {
      const fetchFn = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(
          Response.json(
            { id: "batch-1", status: "validating" },
            { status: 202 },
          ),
        );
      const batch = helperWithPolicy(policy).batch(modelKey, vendor, {
        fetch: fetchFn,
      });
      await expect(batch.submit(requests)).resolves.toMatchObject({
        provider: "openrouter",
      });
      expect(fetchFn).toHaveBeenCalledTimes(1);
      const [url, init] = fetchFn.mock.calls[0]!;
      expect(String(url)).toBe(openRouterBatches);
      expect(new Headers(init?.headers).get("authorization")).toBe(
        `Bearer ${openRouterKey}`,
      );
      expect(JSON.parse(String(init?.body))).toMatchObject({
        provider: { only: ["azure"], allow_fallbacks: false },
        requests: [
          {
            custom_id: "order-1",
            body: { messages: [{ content: requests[0]!.prompt }] },
          },
        ],
      });
    });

    it.each(
      explicitOptions,
    )("uses saved OpenRouter credentials and destination across %s overrides", async (_setting, options) => {
      const fetchFn = vi
        .fn<typeof fetch>()
        .mockImplementation(async (_url, init) =>
          init?.method === "POST"
            ? Response.json(
                { id: "batch-saved", status: "validating" },
                { status: 202 },
              )
            : Response.json({
                id: "batch-saved",
                status: "completed",
                request_counts: { total: 1, completed: 1 },
                results: [
                  {
                    custom_id: "order-1",
                    response: {
                      status_code: 200,
                      body: { choices: [{ message: { content: "Approved" } }] },
                    },
                  },
                ],
              }),
        );
      const ai = helperWithPolicy(policy);
      const saved = await ai
        .batch(modelKey, "openrouter", { fetch: fetchFn })
        .submit(requests);
      const metadata = JSON.parse(JSON.stringify({ batchRefs: saved.refs }));
      fetchFn.mockClear();
      const batch = ai.batch(modelKey, vendor, { ...options, fetch: fetchFn });

      const [status, items, cancellation] = await Promise.all([
        batch.getStatus(saved.id, metadata),
        batch.getResults(saved.id, metadata),
        batch.cancel!(saved.id, metadata),
      ]);
      expect(status).toMatchObject({
        status: "completed",
        provider: "openrouter",
      });
      expect(items).toMatchObject([{ id: "order-1", result: "Approved" }]);
      expect(cancellation).toMatchObject([{ outcome: "unsupported" }]);
      expect(
        fetchFn.mock.calls.map(([url, init]) => ({
          url: String(url),
          method: init?.method,
          credential: new Headers(init?.headers).get("authorization"),
          body: init?.body,
        })),
      ).toEqual(
        Array.from({ length: 2 }, () => ({
          url: `${openRouterBatches}/${saved.id}`,
          method: "GET",
          credential: `Bearer ${openRouterKey}`,
          body: undefined,
        })),
      );
    });
  });

  it("honours explicit OpenRouter options for its submissions and saved refs", async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({ id: "batch-1", status: "validating" }, { status: 202 }),
      )
      .mockResolvedValueOnce(
        Response.json({ id: "batch-1", status: "in_progress" }),
      );
    const batch = helperWithPolicy({ only: ["azure"] }).batch(
      "fallback-haiku",
      "openrouter",
      {
        apiKey: "test-openrouter-option",
        baseURL: "https://router.example.test/api/v1",
        fetch: fetchFn,
      },
    );
    const saved = await batch.submit([
      { id: "order-1", prompt: "Classify the order." },
    ]);
    await expect(
      batch.getStatus(saved.id, { batchRefs: saved.refs }),
    ).resolves.toMatchObject({
      status: "processing",
      provider: "openrouter",
    });
    expect(
      fetchFn.mock.calls.map(([url, init]) => [
        String(url),
        init?.method,
        new Headers(init?.headers).get("authorization"),
      ]),
    ).toEqual([
      [
        "https://router.example.test/api/v1/batches",
        "POST",
        "Bearer test-openrouter-option",
      ],
      [
        "https://router.example.test/api/v1/batches/batch-1",
        "GET",
        "Bearer test-openrouter-option",
      ],
    ]);
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
      { fetch: fetchFn },
    );

    const handle = await batch.submit([{ id: "r1", prompt: "hello" }]);

    expect(handle.id).toBe("batch-or-1");
    expect(handle.provider).toBe("openrouter");
    expect(urls[0]).toContain("openrouter.ai/api/v1/batches");
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
      { fetch: fetchFn },
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
      { fetch: fetchFn },
    );

    const handle = await batch.submit([{ id: "r1", prompt: "hello" }]);

    expect(handle.provider).toBe("openrouter");
    expect(logs).toEqual([
      expect.stringMatching(
        /^WARN: .*not batch-capable.*Falling back to the OpenRouter batch transport/,
      ),
    ]);
  });

  it("refuses the OpenRouter fallback when the native batch cannot serve a policy-bound call", async () => {
    const fetchFn = vi.fn<typeof fetch>();
    const ai = createAIHelper(
      "batch-policy",
      new InMemoryAICallLogger(),
      undefined,
      undefined,
      {
        routing: {
          provider: {
            only: ["anthropic", "openai"],
            order: ["anthropic", "openai"],
          },
        },
      },
    );
    const batch = ai.batch("fallback-haiku", "anthropic", { fetch: fetchFn });

    await expect(
      batch.submit([{ id: "r1", prompt: "Summarize the invoice." }]),
    ).rejects.toThrow(/OpenRouter batch.*provider policy/i);
    expect(fetchFn).not.toHaveBeenCalled();
  });
  it("sends the supported policy when a native batch falls back to OpenRouter", async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({ id: "batch-1", status: "validating" }, { status: 202 }),
      );
    const ai = createAIHelper(
      "batch-policy",
      new InMemoryAICallLogger(),
      undefined,
      undefined,
      {
        routing: { provider: { only: ["anthropic"], allowFallbacks: true } },
      },
    );
    await expect(
      ai
        .batch("fallback-haiku", "anthropic", {
          fetch: fetchFn,
        })
        .submit([{ id: "job-1", prompt: "Summarize the invoice." }]),
    ).resolves.toMatchObject({ provider: "openrouter" });
    expect(
      JSON.parse(String(fetchFn.mock.calls[0]![1]?.body)).provider,
    ).toEqual({
      only: ["anthropic"],
      allow_fallbacks: true,
    });
  });

  it("pins the regional endpoint when a native batch falls back", async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json(
          { id: "regional-batch", status: "validating" },
          { status: 202 },
        ),
      );
    const ai = createAIHelper(
      "batch-policy",
      new InMemoryAICallLogger(),
      undefined,
      undefined,
      {
        routing: {
          provider: {
            only: ["baseten/fp4"],
            order: ["baseten/fp4/us"],
            allowFallbacks: false,
          },
        },
      },
    );
    await expect(
      ai
        .batch("fallback-haiku", "anthropic", {
          fetch: fetchFn,
        })
        .submit([{ id: "job-1", prompt: "Summarize the invoice." }]),
    ).resolves.toMatchObject({ id: "regional-batch", provider: "openrouter" });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0]!;
    expect(String(url)).toMatch(/openrouter\.ai\/api\/v1\/batches$/);
    const body = String(init?.body);
    expect(body.indexOf('"provider"')).toBeLessThan(body.indexOf('"requests"'));
    const parsed = JSON.parse(body);
    expect(parsed.provider).toEqual({
      only: ["baseten/fp4/us"],
      allow_fallbacks: false,
    });
    expect(parsed.requests[0].body).not.toHaveProperty("provider");
  });

  it.each([
    { order: ["baseten/fp4/us", "anthropic"], allowFallbacks: false },
    { order: ["baseten/fp4/us"], allowFallbacks: true },
  ])("refuses an unrepresentable regional ranking on native fallback (%j)", async (policy) => {
    const fetchFn = vi.fn<typeof fetch>();
    const ai = createAIHelper(
      "batch-policy",
      new InMemoryAICallLogger(),
      undefined,
      undefined,
      {
        routing: {
          provider: { ...policy, only: ["anthropic", "baseten/fp4"] },
        },
      },
    );
    await expect(
      ai
        .batch("fallback-haiku", "anthropic", {
          fetch: fetchFn,
        })
        .submit([{ id: "job-1", prompt: "Summarize the invoice." }]),
    ).rejects.toThrow(/OpenRouter batch.*provider policy/i);
    expect(fetchFn).not.toHaveBeenCalled();
  });
});
