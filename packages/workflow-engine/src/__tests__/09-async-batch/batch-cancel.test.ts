/**
 * Cancelling a provider batch, per transport.
 *
 * Each vendor transport is driven through the real AI SDK over a fake
 * `fetch`, so the request each provider documents (method, path, auth header)
 * is what is asserted. Documentation relied on:
 * - OpenAI    POST /v1/batches/{batch_id}/cancel
 *   https://developers.openai.com/api/reference/resources/batches/methods/cancel
 * - Anthropic POST /v1/messages/batches/{message_batch_id}/cancel
 *   https://platform.claude.com/docs/en/api/messages/batches/cancel
 * - Gemini    POST /v1beta/batches/{name}:cancel
 *   https://aistudio.google.com/api-reference/batch-api/cancel-batch
 * - OpenRouter documents no cancel ("There is no cancel endpoint yet"):
 *   https://openrouter.ai/docs/projects/docs/batch-quickstart
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { createAIHelper } from "../../ai/ai-helper.js";
import {
  createOpenRouterBatchModel,
  type EngineBatchModel,
  type EngineBatchRef,
  resolveAiSdkBatchModel,
  resolveBatchModelForRef,
} from "../../ai/batch";
import { AIBatchImpl } from "../../ai/batch-helper.js";
import { registerModels } from "../../ai/model-helper.js";
import { InMemoryAICallLogger } from "../../testing/in-memory-ai-logger.js";

interface Seen {
  method: string;
  host: string;
  path: string;
  headers: Headers;
}

/** A fake provider: answers GETs with `current`, and POSTs to `/cancel` with `onCancel`. */
function fakeProvider(opts: {
  current: () => unknown;
  /** What the cancel call answers on success (OpenAI and Anthropic return the batch). */
  cancelBody?: unknown;
  onCancel?: () => Response;
}) {
  const seen: Seen[] = [];
  const fetchFn = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = (init?.method ?? "GET").toUpperCase();
    seen.push({
      method,
      host: url.host,
      path: decodeURIComponent(url.pathname),
      headers: new Headers(init?.headers),
    });
    if (method === "POST") {
      return (
        opts.onCancel?.() ??
        Response.json(opts.cancelBody ?? {}, {
          headers: { "content-type": "application/json" },
        })
      );
    }
    return Response.json(opts.current(), {
      headers: { "content-type": "application/json" },
    });
  });
  return {
    fetchFn,
    seen,
    calls: () => seen.map((s) => `${s.method} ${s.path}`),
  };
}

const counts = {
  processing: 1,
  succeeded: 0,
  errored: 0,
  canceled: 0,
  expired: 0,
};

interface Vendor {
  vendor: "openai" | "anthropic" | "google";
  modelId: string;
  ref: EngineBatchRef;
  cancelCall: string;
  authHeader: [string, string];
  /** The provider's batch object in the given state. */
  body: (state: string, extra?: object) => unknown;
  /** What the provider answers to a successful cancel. */
  cancelBody: unknown;
  active: string;
  cancelling: string[];
  ended: string[];
}

const vendors: Vendor[] = [
  {
    vendor: "openai",
    modelId: "gpt-4o",
    ref: {
      version: 1,
      type: "text",
      id: "batch_1",
      provider: "openai.responses",
      modelId: "gpt-4o",
    },
    cancelCall: "POST /v1/batches/batch_1/cancel",
    authHeader: ["authorization", "Bearer sk-test"],
    body: (state) => ({ id: "batch_1", status: state }),
    cancelBody: { id: "batch_1", status: "cancelling" },
    active: "in_progress",
    cancelling: ["cancelling", "cancelled"],
    ended: ["completed", "failed", "expired"],
  },
  {
    vendor: "anthropic",
    modelId: "claude-sonnet-4-5",
    ref: {
      version: 1,
      type: "text",
      id: "msgbatch_1",
      provider: "anthropic.messages",
      modelId: "claude-sonnet-4-5",
    },
    cancelCall: "POST /v1/messages/batches/msgbatch_1/cancel",
    authHeader: ["x-api-key", "sk-test"],
    body: (state, extra) => ({
      id: "msgbatch_1",
      type: "message_batch",
      processing_status: state,
      request_counts: counts,
      created_at: "2026-01-01T00:00:00Z",
      expires_at: "2026-01-02T00:00:00Z",
      ...extra,
    }),
    cancelBody: {
      id: "msgbatch_1",
      type: "message_batch",
      processing_status: "canceling",
      request_counts: counts,
      created_at: "2026-01-01T00:00:00Z",
      expires_at: "2026-01-02T00:00:00Z",
      cancel_initiated_at: "2026-01-01T00:05:00Z",
    },
    active: "in_progress",
    cancelling: ["canceling"],
    ended: ["ended"],
  },
  {
    vendor: "google",
    modelId: "gemini-2.5-flash",
    ref: {
      version: 1,
      type: "text",
      id: "batches/abc",
      provider: "google.generative-ai",
      modelId: "gemini-2.5-flash",
    },
    cancelCall: "POST /v1beta/batches/abc:cancel",
    authHeader: ["x-goog-api-key", "sk-test"],
    body: (state) => ({
      name: "batches/abc",
      metadata: { state },
      done: state === "JOB_STATE_SUCCEEDED",
    }),
    cancelBody: {},
    active: "JOB_STATE_RUNNING",
    cancelling: ["JOB_STATE_CANCELLED"],
    ended: ["JOB_STATE_SUCCEEDED", "JOB_STATE_FAILED", "JOB_STATE_EXPIRED"],
  },
];

describe.each(vendors)("$vendor batch cancel", (v) => {
  afterEach(() => vi.unstubAllEnvs());

  async function modelFor(provider: ReturnType<typeof fakeProvider>) {
    return resolveAiSdkBatchModel(v.vendor, v.modelId, {
      apiKey: "sk-test",
      fetch: provider.fetchFn as never,
    });
  }

  it.each([
    false,
    true,
  ])("selects cross-provider cancellation options with a policy set to %s", async (withPolicy) => {
    const [key, host, credential] = (
      {
        openai: [
          "OPENAI_API_KEY",
          "api.openai.com",
          "Bearer test-native-environment",
        ],
        anthropic: [
          "ANTHROPIC_API_KEY",
          "api.anthropic.com",
          "test-native-environment",
        ],
        google: [
          "GOOGLE_GENERATIVE_AI_API_KEY",
          "generativelanguage.googleapis.com",
          "test-native-environment",
        ],
      } as const
    )[v.vendor];
    vi.stubEnv(key, "test-native-environment");
    const provider = fakeProvider({
      current: () => v.body(v.active),
      cancelBody: v.cancelBody,
    });
    const modelKey = `saved-${v.vendor}-batch`;
    registerModels({
      [modelKey]: {
        id: `${v.vendor}/${v.modelId}`,
        name: "Saved batch",
        inputCostPerMillion: 1,
        outputCostPerMillion: 2,
        provider: "openrouter",
        supportsAsyncBatch: true,
      },
    });
    const batch = createAIHelper(
      "batch-cancel",
      new InMemoryAICallLogger(),
      undefined,
      undefined,
      { routing: { provider: withPolicy ? { only: ["azure"] } : undefined } },
    ).batch(modelKey, "openrouter", {
      baseURL: "https://router.example.test/api/v1",
      apiKey: "test-router-option",
      fetch: provider.fetchFn,
    });
    await expect(
      batch.cancel!(v.ref.id, { batchRefs: [v.ref] }),
    ).resolves.toEqual([{ ref: v.ref, outcome: "cancelled" }]);
    const expectedHost = withPolicy ? host : "router.example.test";
    const expectedCredential = withPolicy
      ? credential
      : v.vendor === "openai"
        ? "Bearer test-router-option"
        : "test-router-option";
    expect(provider.seen.map((call) => call.host)).toEqual([
      expectedHost,
      expectedHost,
    ]);
    expect(
      provider.seen.map((call) => call.headers.get(v.authHeader[0])),
    ).toEqual([expectedCredential, expectedCredential]);
    expect(provider.calls()[1]).toMatch(/(?:\/cancel|:cancel)$/);
  });

  it("reads the batch, then sends the documented cancel call", async () => {
    const provider = fakeProvider({
      current: () => v.body(v.active),
      cancelBody: v.cancelBody,
    });
    const model = await modelFor(provider);

    const result = await model.cancel!(v.ref);

    expect(result).toEqual({ outcome: "cancelled", rawStatus: v.active });
    expect(provider.calls()).toHaveLength(2);
    expect(provider.calls()[0]).toMatch(/^GET /);
    expect(provider.calls()[1]).toBe(v.cancelCall);
    const [header, value] = v.authHeader;
    expect(provider.seen[1]!.headers.get(header)).toBe(value);
  });

  it("does not send a second cancel to a batch that is already cancelling or cancelled", async () => {
    for (const state of v.cancelling) {
      const provider = fakeProvider({ current: () => v.body(state) });
      const model = await modelFor(provider);

      await expect(model.cancel!(v.ref)).resolves.toEqual({
        outcome: "cancelled",
        rawStatus: state,
      });
      expect(provider.calls()).toHaveLength(1);
    }
  });

  it("does not cancel a batch that ended on its own", async () => {
    for (const state of v.ended) {
      const provider = fakeProvider({ current: () => v.body(state) });
      const model = await modelFor(provider);

      await expect(model.cancel!(v.ref)).resolves.toEqual({
        outcome: "already-terminal",
        rawStatus: state,
      });
      expect(provider.calls()).toHaveLength(1);
    }
  });

  it("tells a cancelling or cancelled batch from the others in status(), which a sweep that died is resolved with", async () => {
    for (const state of v.cancelling) {
      const provider = fakeProvider({ current: () => v.body(state) });
      const model = await modelFor(provider);
      await expect(model.status(v.ref)).resolves.toMatchObject({
        cancelled: true,
      });
    }
    for (const state of [v.active, ...v.ended]) {
      const provider = fakeProvider({ current: () => v.body(state) });
      const model = await modelFor(provider);
      await expect(model.status(v.ref)).resolves.not.toHaveProperty(
        "cancelled",
      );
    }
  });

  it("throws what the provider answered when the cancel is rejected", async () => {
    const provider = fakeProvider({
      current: () => v.body(v.active),
      onCancel: () =>
        Response.json(
          {
            error: {
              message: "overloaded",
              type: "api_error",
              status: "UNAVAILABLE",
            },
          },
          { status: 503 },
        ),
    });
    const model = await modelFor(provider);

    await expect(model.cancel!(v.ref)).rejects.toMatchObject({
      statusCode: 503,
    });
  });
});

describe("anthropic batch cancel", () => {
  it("tells a batch that ended because it was cancelled from one that finished", async () => {
    const v = vendors[1]!;
    const cancelled = fakeProvider({
      current: () =>
        v.body("ended", { cancel_initiated_at: "2026-01-01T00:05:00Z" }),
    });
    const model = await resolveAiSdkBatchModel("anthropic", v.modelId, {
      apiKey: "sk-test",
      fetch: cancelled.fetchFn as never,
    });

    await expect(model.cancel!(v.ref)).resolves.toMatchObject({
      outcome: "cancelled",
    });
    expect(cancelled.calls()).toHaveLength(1);
    // Reported as `ended`, so only the flag says it was cancelled.
    await expect(model.status(v.ref)).resolves.toMatchObject({
      rawStatus: "ended",
      cancelled: true,
    });
  });
});

describe("OpenRouter batch cancel", () => {
  it("has no cancel call, because the provider documents none", () => {
    const model = createOpenRouterBatchModel({
      apiKey: "sk-or-test",
      modelId: "openai/gpt-4o",
    });

    expect(model.cancel).toBeUndefined();
  });

  it("reports a cancelling or cancelled batch (the provider cancelled it) in status()", async () => {
    const statusOf = async (state: string) => {
      const model = createOpenRouterBatchModel({
        apiKey: "sk-or-test",
        modelId: "openai/gpt-4o",
        fetch: (async () =>
          Response.json({ id: "b", status: state })) as typeof fetch,
      });
      return model.status({
        version: 1,
        type: "text",
        id: "b",
        provider: "openrouter",
        modelId: "openai/gpt-4o",
      });
    };

    await expect(statusOf("cancelled")).resolves.toMatchObject({
      cancelled: true,
    });
    await expect(statusOf("cancelling")).resolves.toMatchObject({
      cancelled: true,
    });
    await expect(statusOf("in_progress")).resolves.not.toHaveProperty(
      "cancelled",
    );
  });
});

describe("resolveBatchModelForRef", () => {
  const ref = (provider: string): EngineBatchRef => ({
    version: 1,
    type: "text",
    id: "b",
    provider,
    modelId: "m",
  });

  it("builds the transport the ref names, with a cancel call where one exists", async () => {
    for (const [provider, cancels] of [
      ["openai.responses", true],
      ["anthropic.messages", true],
      ["google.generative-ai", true],
    ] as const) {
      const model = await resolveBatchModelForRef(ref(provider), {
        apiKey: "k",
      });
      expect(model.provider).toBe(provider);
      expect(typeof model.cancel === "function").toBe(cancels);
    }
    const openrouter = await resolveBatchModelForRef(ref("openrouter"), {
      apiKey: "k",
    });
    expect(openrouter.provider).toBe("openrouter");
    expect(openrouter.cancel).toBeUndefined();
  });

  it("refuses a provider with no transport and OpenRouter without a key", async () => {
    await expect(resolveBatchModelForRef(ref("acme.cloud"))).rejects.toThrow(
      /No built-in batch transport serves provider "acme.cloud"/,
    );
    const saved = process.env.OPENROUTER_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    try {
      await expect(resolveBatchModelForRef(ref("openrouter"))).rejects.toThrow(
        /needs an API key/,
      );
    } finally {
      if (saved !== undefined) process.env.OPENROUTER_API_KEY = saved;
    }
  });

  it("hits the SDK's missing-key error when a vendor key is in neither options nor environment", async () => {
    const saved = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      const model = await resolveBatchModelForRef(ref("openai.responses"));
      await expect(
        model.cancel!(ref("openai.responses")),
      ).rejects.toMatchObject({ name: "AI_LoadAPIKeyError" });
    } finally {
      if (saved !== undefined) process.env.OPENAI_API_KEY = saved;
    }
  });
});

describe("AIBatch.cancel and a replayed submit", () => {
  registerModels({
    "cancel-test-model": {
      id: "openai/gpt-4o",
      name: "Cancel test",
      inputCostPerMillion: 1,
      outputCostPerMillion: 2,
      provider: "openrouter",
      supportsAsyncBatch: true,
    },
  });
  const ctx = { topic: "t", aiCallLogger: new InMemoryAICallLogger() };
  const REF: EngineBatchRef = {
    version: 1,
    type: "text",
    id: "b1",
    provider: "openrouter",
    modelId: "openai/gpt-4o",
  };
  const model = (over: Partial<EngineBatchModel>): EngineBatchModel => ({
    provider: "openrouter",
    modelId: "openai/gpt-4o",
    recovery: "metadata",
    start: vi.fn(async () => ({
      ...REF,
      id: "b2",
      status: "pending" as const,
    })),
    status: vi.fn(),
    results: vi.fn(),
    ...over,
  });

  it("cancels every batch of a handle and reports transports with no cancel", async () => {
    const cancel = vi.fn(async () => ({ outcome: "cancelled" as const }));
    const refs = [REF, { ...REF, id: "b2" }];
    const batch = new AIBatchImpl(
      ctx,
      "cancel-test-model",
      "openrouter",
      undefined,
      undefined,
      model({ cancel }),
    );

    await expect(batch.cancel("b1", { batchRefs: refs })).resolves.toEqual([
      { ref: refs[0], outcome: "cancelled" },
      { ref: refs[1], outcome: "cancelled" },
    ]);
    expect(cancel).toHaveBeenCalledTimes(2);

    const plain = new AIBatchImpl(
      ctx,
      "cancel-test-model",
      "openrouter",
      undefined,
      undefined,
      model({}),
    );
    await expect(plain.cancel("b1", { batchRefs: [REF] })).resolves.toEqual([
      { ref: REF, outcome: "unsupported" },
    ]);
  });

  it("tries every batch, then throws when one cancel failed", async () => {
    const cancel = vi
      .fn()
      .mockRejectedValueOnce(
        Object.assign(new Error("private diagnostic marker"), {
          statusCode: 503,
        }),
      )
      .mockResolvedValueOnce({ outcome: "cancelled" });
    const batch = new AIBatchImpl(
      ctx,
      "cancel-test-model",
      "openrouter",
      undefined,
      undefined,
      model({ cancel }),
    );

    await expect(
      batch.cancel("b1", { batchRefs: [REF, { ...REF, id: "b2" }] }),
    ).rejects.toThrow("HTTP 503");
    expect(cancel).toHaveBeenCalledTimes(2);
  });

  it("passes the batches the engine cancelled to the search, and ignores one an adopter returns anyway", async () => {
    const start = vi.fn(async () => ({
      ...REF,
      id: "b-new",
      status: "pending" as const,
    }));
    const adopt = vi.fn(async () => ({
      ...REF,
      id: "b-dead",
      status: "pending" as const,
    }));
    const batch = new AIBatchImpl(
      ctx,
      "cancel-test-model",
      "openrouter",
      undefined,
      undefined,
      model({ start, adopt }),
    );

    const handle = await batch.submit([{ id: "r1", prompt: "p" }], {
      externalKey: "wfe-0123456789abcdef0123456789abcdef",
      recovering: true,
      excludeBatchIds: ["b-dead"],
    });

    expect(adopt).toHaveBeenCalledWith(
      "wfe-0123456789abcdef0123456789abcdef-p0",
      expect.objectContaining({ excludeBatchIds: ["b-dead"] }),
    );
    expect(handle.batchIds).toEqual(["b-new"]);
  });

  describe("resuming after a partial submit", () => {
    const requests = [
      { id: "r1", prompt: "p" },
      { id: "r2", prompt: "p" },
      { id: "r3", prompt: "p" },
    ];
    const submit = (
      batchModel: EngineBatchModel,
      options: Parameters<AIBatchImpl["submit"]>[1],
    ) =>
      new AIBatchImpl(
        ctx,
        "cancel-test-model",
        "openrouter",
        undefined,
        { maxRequestsPerBatch: 1 },
        batchModel,
      ).submit(requests, {
        externalKey: "wfe-0123456789abcdef0123456789abcdef",
        ...options,
      });
    const made = (n: number) => ({ ...REF, id: `made-${n}` });

    it("creates only the partitions that are missing, on a transport that cannot adopt too", async () => {
      const start = vi.fn(async () => ({
        ...REF,
        id: "b-new",
        status: "pending" as const,
      }));

      const handle = await submit(model({ start, recovery: "none" }), {
        recovering: true,
        onReclaim: "resubmit",
        existingRefs: [made(1), made(2)],
      });

      expect(start).toHaveBeenCalledTimes(1);
      expect(handle.batchIds).toEqual(["made-1", "made-2", "b-new"]);
    });

    it("still refuses where it cannot tell whether a missing partition exists", async () => {
      const start = vi.fn();

      await expect(
        submit(model({ start, recovery: "none" }), {
          recovering: true,
          existingRefs: [made(1)],
        }),
      ).rejects.toThrow(/cannot be recovered after a worker crash/);
      expect(start).not.toHaveBeenCalled();
    });

    it("creates nothing when every partition was already created", async () => {
      const start = vi.fn();

      const handle = await submit(model({ start, recovery: "none" }), {
        recovering: true,
        existingRefs: [made(1), made(2), made(3)],
      });

      expect(start).not.toHaveBeenCalled();
      expect(handle.batchIds).toEqual(["made-1", "made-2", "made-3"]);
    });
  });

  it("does not adopt a batch its transport reports as cancelled", async () => {
    const start = vi.fn(async () => ({
      ...REF,
      id: "b-new",
      status: "pending" as const,
    }));
    const adopt = vi.fn(async () => ({
      ...REF,
      id: "b-old",
      status: "failed" as const,
      rawStatus: "cancelled",
    }));
    const batch = new AIBatchImpl(
      ctx,
      "cancel-test-model",
      "openrouter",
      undefined,
      undefined,
      model({ start, adopt }),
    );

    const handle = await batch.submit([{ id: "r1", prompt: "p" }], {
      externalKey: "wfe-0123456789abcdef0123456789abcdef",
      recovering: true,
    });

    expect(adopt).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledTimes(1);
    expect(handle.batchIds).toEqual(["b-new"]);
  });
});
