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
import type { BatchOptions } from "../../ai/types.js";
import { InMemoryAICallLogger } from "../../testing/in-memory-ai-logger.js";

type DestinationOptions = Pick<BatchOptions, "apiKey" | "baseURL">;

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
    const requests = [
      { id: "order-1", prompt: "Classify the first order." },
      { id: "order-2", prompt: "Classify the second order." },
    ];
    const answers = ["Approved", "Returned"];
    const policy = { only: ["azure"], allowFallbacks: false };
    const canonical = "https://openrouter.ai/api/v1";
    const canonicalVariant = "https://OPENROUTER.AI/api/v1///";
    const gateway = "https://router.example.test/api/v1";
    const inlineKey = "test-openrouter-option";

    function batchFetch() {
      return vi.fn<typeof fetch>().mockImplementation(async (_url, init) =>
        init?.method === "POST"
          ? Response.json(
              { id: "batch-saved", status: "validating" },
              { status: 202 },
            )
          : Response.json({
              id: "batch-saved",
              status: "completed",
              request_counts: { total: 2, completed: 2 },
              results: requests.map(({ id }, index) => ({
                custom_id: id,
                response: {
                  status_code: 200,
                  body: { choices: [{ message: { content: answers[index] } }] },
                },
              })),
            }),
      );
    }

    const unpolicedOptions: [string, DestinationOptions][] = [
      ["canonical URL and environment key", { baseURL: canonical }],
      ["inline key alone", { apiKey: inlineKey }],
      [
        "canonical URL and inline key",
        { baseURL: canonical, apiKey: inlineKey },
      ],
      ["gateway URL and inline key", { baseURL: gateway, apiKey: inlineKey }],
    ];
    it.each(
      unpolicedOptions,
    )("completes a no-policy fallback with %s", async (_description, options) => {
      if (options.apiKey) vi.stubEnv("OPENROUTER_API_KEY", undefined);
      const fetchFn = batchFetch();
      const ai = helperWithPolicy();
      const batchOptions = { ...options, fetch: fetchFn };
      const handle = await ai
        .batch(modelKey, undefined, batchOptions)
        .submit(requests);
      expect(handle).toMatchObject({
        id: "batch-saved",
        provider: "openrouter",
      });
      const metadata = JSON.parse(
        JSON.stringify({ batchRefs: handle.refs, totalRequests: 2 }),
      );
      const resumed = ai.batch(modelKey, undefined, batchOptions);
      await expect(
        resumed.getStatus(handle.id, metadata),
      ).resolves.toMatchObject({
        status: "completed",
        requestCounts: { total: 2, completed: 2 },
      });
      await expect(
        resumed.getResults(handle.id, metadata),
      ).resolves.toMatchObject([
        { id: "order-1", result: "Approved", status: "succeeded" },
        { id: "order-2", result: "Returned", status: "succeeded" },
      ]);
      const batchesUrl = `${options.baseURL ?? canonical}/batches`;
      expect(
        fetchFn.mock.calls.map(([url, init]) => [
          String(url),
          init?.method,
          new Headers(init?.headers).get("authorization"),
        ]),
      ).toEqual([
        [batchesUrl, "POST", `Bearer ${options.apiKey ?? openRouterKey}`],
        [
          `${batchesUrl}/batch-saved`,
          "GET",
          `Bearer ${options.apiKey ?? openRouterKey}`,
        ],
        [
          `${batchesUrl}/batch-saved`,
          "GET",
          `Bearer ${options.apiKey ?? openRouterKey}`,
        ],
      ]);
      expect(String(fetchFn.mock.calls[0]![1]?.body)).toBe(
        JSON.stringify({
          endpoint: "/v1/chat/completions",
          model:
            vendor === "openai"
              ? "openai/gpt-5-nano"
              : "anthropic/claude-haiku-4.5",
          requests: requests.map(({ id, prompt }) => ({
            custom_id: id,
            body: {
              messages: [{ role: "user", content: prompt }],
              usage: { include: true },
            },
          })),
        }),
      );
    });

    it.each([
      ["native URL", nativeUrl],
      ["noncanonical path on the OpenRouter host", `${canonical}/proxy`],
      [
        "OpenRouter userinfo on a native host",
        "https://openrouter.ai@api.openai.com/api/v1",
      ],
    ])("refuses a policy-bound fallback to a %s before fetch", async (_description, baseURL) => {
      const fetchFn = batchFetch();
      await expect(
        helperWithPolicy(policy)
          .batch(modelKey, vendor, {
            baseURL,
            apiKey: nativeKey,
            fetch: fetchFn,
          })
          .submit(requests),
      ).rejects.toThrow(/configure.*OpenRouter.*explicitly/i);
      expect(fetchFn).not.toHaveBeenCalled();
    });

    it.each([
      ["provider defaults", {}, openRouterBatches, openRouterKey],
      ["inline key alone", { apiKey: inlineKey }, openRouterBatches, inlineKey],
      [
        "canonical URL and inline key",
        { baseURL: canonical, apiKey: inlineKey },
        openRouterBatches,
        inlineKey,
      ],
      [
        "uppercase host and trailing slashes",
        { baseURL: canonicalVariant, apiKey: inlineKey },
        "https://OPENROUTER.AI/api/v1/batches",
        inlineKey,
      ],
    ])("carries %s into an allowed policy-bound fallback", async (_description, options, expectedUrl, expectedKey) => {
      const fetchFn = batchFetch();
      const batch = helperWithPolicy(policy).batch(modelKey, vendor, {
        ...options,
        fetch: fetchFn,
      });
      await expect(batch.submit(requests)).resolves.toMatchObject({
        provider: "openrouter",
      });
      expect(fetchFn).toHaveBeenCalledTimes(1);
      const [url, init] = fetchFn.mock.calls[0]!;
      expect(String(url)).toBe(expectedUrl);
      expect(new Headers(init?.headers).get("authorization")).toBe(
        `Bearer ${expectedKey}`,
      );
      expect(JSON.parse(String(init?.body))).toMatchObject({
        provider: { only: ["azure"], allow_fallbacks: false },
        requests: [{ custom_id: "order-1" }, { custom_id: "order-2" }],
      });
    });

    it.each([
      [
        "no policy with canonical URL and inline key",
        undefined,
        { baseURL: canonical, apiKey: inlineKey },
        openRouterBatches,
        inlineKey,
      ],
      [
        "no policy with gateway URL and inline key",
        undefined,
        { baseURL: gateway, apiKey: inlineKey },
        `${gateway}/batches`,
        inlineKey,
      ],
      [
        "policy with canonical URL and inline key",
        policy,
        { baseURL: canonicalVariant, apiKey: inlineKey },
        "https://OPENROUTER.AI/api/v1/batches",
        inlineKey,
      ],
      [
        "policy with inline key alone",
        policy,
        { apiKey: inlineKey },
        openRouterBatches,
        inlineKey,
      ],
      [
        "policy with native URL and native key",
        policy,
        { baseURL: nativeUrl, apiKey: nativeKey },
        openRouterBatches,
        openRouterKey,
      ],
      [
        "policy with native URL alone",
        policy,
        { baseURL: nativeUrl },
        openRouterBatches,
        openRouterKey,
      ],
    ])("resumes an existing job under %s", async (_description, constraint, options, expectedUrl, expectedKey) => {
      const fetchFn = batchFetch();
      const saved = await helperWithPolicy()
        .batch(modelKey, "openrouter", {
          apiKey: inlineKey,
          fetch: fetchFn,
        })
        .submit(requests);
      if (expectedKey === inlineKey)
        vi.stubEnv("OPENROUTER_API_KEY", undefined);
      const metadata = JSON.parse(JSON.stringify({ batchRefs: saved.refs }));
      fetchFn.mockClear();
      const batch = helperWithPolicy(constraint).batch(modelKey, undefined, {
        ...options,
        fetch: fetchFn,
      });
      const [status, items, cancellation] = await Promise.all([
        batch.getStatus(saved.id, metadata),
        batch.getResults(saved.id, metadata),
        batch.cancel!(saved.id, metadata),
      ]);
      expect(status).toMatchObject({
        status: "completed",
        provider: "openrouter",
      });
      expect(items).toMatchObject([
        { id: "order-1", result: "Approved" },
        { id: "order-2", result: "Returned" },
      ]);
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
          url: `${expectedUrl}/${saved.id}`,
          method: "GET",
          credential: `Bearer ${expectedKey}`,
          body: undefined,
        })),
      );
    });
  });

  it.each([
    false,
    true,
  ])("uses explicit OpenRouter options for submission and resolves saved refs with policy set to %s", async (withPolicy) => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({ id: "batch-1", status: "validating" }, { status: 202 }),
      )
      .mockResolvedValueOnce(
        Response.json({ id: "batch-1", status: "in_progress" }),
      );
    const batch = helperWithPolicy(
      withPolicy ? { only: ["azure"] } : undefined,
    ).batch("fallback-haiku", "openrouter", {
      apiKey: "test-openrouter-option",
      baseURL: "https://router.example.test/api/v1",
      fetch: fetchFn,
    });
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
