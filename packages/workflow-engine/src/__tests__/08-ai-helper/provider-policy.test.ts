import { openrouter } from "@openrouter/ai-sdk-provider";
import { Output, generateText as sdkGenerateText, stepCountIs } from "ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  createAIHelper,
  type OpenRouterRoutingOptions,
  type ProviderResolver,
  registerEmbeddingProvider,
  registerEvaluationProvider,
  registerTranscriptionProvider,
} from "../../ai/ai-helper.js";
import { registerModels } from "../../ai/model-helper.js";
import type { AIAdapter } from "../../ai/types.js";
import type { AICallLogger } from "../../persistence/interface.js";
import { InMemoryAICallLogger } from "../../testing/in-memory-ai-logger.js";
import { kernelDatabase, realDatabase } from "../sqlite8-kernel-utils.js";

const prices = { inputCostPerMillion: 1, outputCostPerMillion: 2 };
const textModel = {
  ...prices,
  provider: "openrouter",
  id: "openai/gpt-4o-mini",
  name: "Text",
  supportsAsyncBatch: true,
};
const embeddingModel = {
  ...prices,
  provider: "openrouter",
  id: "openai/text-embedding-3-small",
  name: "Embedding",
  isEmbeddingModel: true,
};
const evaluationModel = {
  ...prices,
  provider: "openrouter",
  id: "typesafe/jev-1.13",
  name: "Decider",
  isEvaluationModel: true,
};
const transcriptionModel = {
  ...prices,
  provider: "openai",
  id: "whisper-1",
  name: "Transcription",
  isTranscriptionModel: true,
};

registerModels({
  "policy-text": textModel,
  "policy-embed": embeddingModel,
  "policy-evaluate": evaluationModel,
  "policy-transcribe": transcriptionModel,
  "policy-google": {
    ...textModel,
    id: "google/gemini-2.5-flash",
    provider: "google",
  },
  "policy-anthropic": { ...textModel, id: "anthropic/claude-haiku-4.5" },
  "policy-custom-embed": { ...embeddingModel, provider: "custom-policy" },
  "policy-custom-evaluate": { ...evaluationModel, provider: "custom-policy" },
  "policy-custom-transcribe": {
    ...transcriptionModel,
    provider: "custom-policy",
  },
});

const provider: NonNullable<OpenRouterRoutingOptions["provider"]> = {
  only: ["openai", "azure", "typesafe"],
  order: ["azure", "openai", "typesafe"],
  allowFallbacks: false,
  dataCollection: "deny",
};
const wirePolicy = {
  only: provider.only,
  order: provider.order,
  allow_fallbacks: false,
  data_collection: "deny",
};
const providerOptions = {
  openrouter: {
    user: "user-a",
    provider: {
      only: ["google", "openai"],
      allow_fallbacks: true,
      data_collection: "deny",
      zdr: true,
      require_parameters: true,
      max_price: { prompt: 0.5, request: 0.01 },
      ignore: ["anthropic"],
    },
  },
};
const spec = {
  state: "Invoice paid.",
  questions: {
    paid: { type: "boolean", instructions: "Is the invoice paid?" },
  },
} as const;
const audio = new Uint8Array([82, 73, 70, 70, 0, 0, 0, 0, 87, 65, 86, 69]);
const requests = [{ id: "job-1", prompt: "Summarize the invoice." }];
const fetchMock = vi.fn<typeof fetch>();

function makeHelper(
  policy: OpenRouterRoutingOptions["provider"] = provider,
  resolver?: ProviderResolver,
) {
  return createAIHelper(
    "policy",
    new InMemoryAICallLogger(),
    undefined,
    resolver,
    { routing: { provider: policy } },
  );
}

beforeEach(() => {
  vi.stubEnv("OPENROUTER_API_KEY", "test");
  vi.stubEnv("GOOGLE_GENERATIVE_AI_API_KEY", "test");
  vi.stubEnv("OPENAI_API_KEY", "test");
  fetchMock.mockReset();
  fetchMock.mockImplementation(async () =>
    Response.json(
      { error: { message: "Mock transport reached", code: 400 } },
      { status: 400 },
    ),
  );
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const realtimeCalls = [
  [
    "text",
    "/chat/completions",
    (ai, providerOptions) =>
      ai.generateText("policy-text", "Invoice", { providerOptions }),
  ],
  [
    "object",
    "/chat/completions",
    (ai, providerOptions) =>
      ai.generateObject(
        "policy-text",
        "Invoice",
        z.object({ paid: z.boolean() }),
        { providerOptions },
      ),
  ],
  [
    "stream",
    "/chat/completions",
    (ai, providerOptions) =>
      ai
        .streamText("policy-text", { prompt: "Invoice" }, { providerOptions })
        .getUsage(),
  ],
  [
    "embed",
    "/embeddings",
    (ai, providerOptions) =>
      ai.embed("policy-embed", "Invoice", { providerOptions }),
  ],
  [
    "embedMany",
    "/embeddings",
    (ai, providerOptions) =>
      ai.embed("policy-embed", ["Invoice", "Order"], { providerOptions }),
  ],
  [
    "evaluate",
    "/decisions",
    (ai, providerOptions) =>
      ai.evaluate("policy-evaluate", spec, { providerOptions }),
  ],
] satisfies [
  string,
  string,
  (
    ai: ReturnType<typeof makeHelper>,
    providerOptions?: Record<string, Record<string, unknown>>,
  ) => Promise<unknown>,
][];

describe("helper provider policy", () => {
  it.each(
    realtimeCalls,
  )("enforces the helper policy in the OpenRouter %s request", async (_call, endpoint, run) => {
    const ai = createAIHelper(
      "policy",
      new InMemoryAICallLogger(),
      undefined,
      undefined,
      {
        routing: {
          provider: { ...provider, dataCollection: "allow" },
          requireParameters: false,
        },
      },
    );
    await run(ai.createChild("tenant-a"), providerOptions).catch(() => {});
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toMatch(new RegExp(`${endpoint}$`));
    expect(JSON.parse(String(init?.body)).provider).toMatchObject({
      ...wirePolicy,
      only: ["openai"],
      order: ["openai"],
      zdr: true,
      require_parameters: true,
      max_price: { prompt: 0.5, completion: 2.5, request: 0.01 },
      ignore: ["anthropic"],
    });
  });

  describe.each(
    realtimeCalls,
  )("%s routing restrictions", (_call, _endpoint, run) => {
    const invoke = (
      policy: OpenRouterRoutingOptions["provider"],
      request?: Record<string, unknown>,
    ) =>
      Promise.resolve()
        .then<unknown>(() =>
          run(
            makeHelper(policy),
            request && { openrouter: { provider: request } },
          ),
        )
        .catch(() => {});

    it("refuses a helper ranking that would add backups to the caller's no-fallback request", async () => {
      await invoke({ order: ["azure", "openai"] }, { allow_fallbacks: false });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("pins a caller's singleton order without adding backups to the helper's no-fallback request", async () => {
      await invoke({ allowFallbacks: false }, { order: ["azure"] });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const body = JSON.parse(String(fetchMock.mock.calls[0]![1]?.body));
      expect(body.provider).toEqual({
        only: ["azure"],
        allow_fallbacks: false,
        sort: "throughput",
        require_parameters: true,
        max_price: { prompt: 1.25, completion: 2.5 },
      });
    });

    it("refuses an allowlist whose only eligible provider was ignored", async () => {
      await invoke({ only: ["openai"] }, { ignore: ["openai"] });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("refuses an incompatible helper policy without per-call options", async () => {
      await invoke({
        only: ["openai"],
        order: ["azure"],
        allowFallbacks: false,
      });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("compares provider orders after excluding ineligible providers", async () => {
      await invoke(
        { only: ["openai"], order: ["openai", "azure"], allowFallbacks: false },
        { order: ["azure", "openai"] },
      );
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(
        JSON.parse(String(fetchMock.mock.calls[0]![1]?.body)).provider,
      ).toMatchObject({
        only: ["openai"],
        order: ["openai"],
        allow_fallbacks: false,
      });
    });

    it("keeps only shared preferences even with fallbacks enabled", async () => {
      await invoke(
        { order: ["azure", "openai"], allowFallbacks: true },
        { order: ["openai"] },
      );
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(
        JSON.parse(String(fetchMock.mock.calls[0]![1]?.body)).provider,
      ).toMatchObject({ order: ["openai"], allow_fallbacks: true });
    });

    it("refuses conflicting preferences when an allowlist removes one order", async () => {
      await invoke(
        { only: ["openai"], order: ["openai"], allowFallbacks: true },
        { order: ["azure"] },
      );
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it.each([
      false,
      true,
    ])("keeps the first regional preference within a variant (fallbacks %s)", async (allowFallbacks) => {
      await invoke(
        { dataCollection: "deny" },
        {
          only: ["baseten/fp4", "deepinfra"],
          order: ["baseten/fp4/us", "deepinfra"],
          allow_fallbacks: allowFallbacks,
        },
      );
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(
        JSON.parse(String(fetchMock.mock.calls[0]![1]?.body)).provider,
      ).toMatchObject({
        only: [allowFallbacks ? "baseten/fp4" : "baseten/fp4/us", "deepinfra"],
        order: ["baseten/fp4/us", "deepinfra"],
        allow_fallbacks: allowFallbacks,
        data_collection: "deny",
      });
    });

    it.each([
      ["baseten/fp4", "baseten/fp4/us"],
      ["baseten/fp4/us", "baseten/fp4"],
    ])("intersects regional allowlists (%s and %s)", async (helper, caller) => {
      await invoke({ only: [helper] }, { only: [caller] });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(
        JSON.parse(String(fetchMock.mock.calls[0]![1]?.body)).provider.only,
      ).toEqual(["baseten/fp4/us"]);
    });

    it("refuses a regional allowlist when its parent variant is ignored", async () => {
      await invoke({ only: ["baseten/fp4/us"] }, { ignore: ["baseten/fp4"] });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("preserves the caller's order within a variant ranked by the helper", async () => {
      await invoke(
        { only: ["baseten/fp4/kr", "baseten/fp4/us"], order: ["baseten/fp4"] },
        { order: ["baseten/fp4/us", "baseten/fp4/kr"], allow_fallbacks: false },
      );
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(
        JSON.parse(String(fetchMock.mock.calls[0]![1]?.body)).provider.order,
      ).toEqual(["baseten/fp4/us", "baseten/fp4/kr"]);
    });

    it("keeps an explicit service tier separate from the standard region", async () => {
      await invoke(
        { only: ["google-vertex/global/flex"] },
        { ignore: ["google-vertex/global"] },
      );
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(
        JSON.parse(String(fetchMock.mock.calls[0]![1]?.body)).provider,
      ).toMatchObject({
        only: ["google-vertex/global/flex"],
        ignore: ["google-vertex/global"],
      });
    });

    it("intersects the two documented labels for the same priority endpoint", async () => {
      await invoke({ only: ["openai/priority"] }, { only: ["openai/fast"] });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(
        JSON.parse(String(fetchMock.mock.calls[0]![1]?.body)).provider.only,
      ).toEqual(["openai/priority"]);
    });
  });

  it("preserves helper denial and the stricter helper price cap when call options loosen them", async () => {
    const ai = makeHelper();
    await expect(
      ai.generateText("policy-text", "Invoice", {
        providerOptions: {
          openrouter: {
            provider: {
              data_collection: "allow",
              max_price: { prompt: 10, completion: 10 },
            },
          },
        },
      }),
    ).rejects.toThrow("Mock transport reached");
    expect(
      JSON.parse(String(fetchMock.mock.calls[0]![1]?.body)).provider,
    ).toMatchObject({
      ...wirePolicy,
      max_price: { prompt: 1.25, completion: 2.5 },
    });
  });

  it("refuses disjoint allowlists before sending a request", async () => {
    await expect(
      makeHelper({ only: ["openai"] }).generateText("policy-text", "Invoice", {
        providerOptions: { openrouter: { provider: { only: ["google"] } } },
      }),
    ).rejects.toThrow(/allowlist/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("narrows a provider family to the intersection of explicitly allowed endpoints", async () => {
    await expect(
      makeHelper({ only: ["google-vertex"] }).generateText(
        "policy-text",
        "Invoice",
        {
          providerOptions: {
            openrouter: { provider: { only: ["google-vertex/us-east5"] } },
          },
        },
      ),
    ).rejects.toThrow("Mock transport reached");
    expect(
      JSON.parse(String(fetchMock.mock.calls[0]![1]?.body)).provider.only,
    ).toEqual(["google-vertex/us-east5"]);
  });

  it("refuses a Google model and an OpenAI transcription outside the allowlist", async () => {
    const ai = makeHelper({ only: ["anthropic"] });
    await expect(ai.generateText("policy-google", "Invoice")).rejects.toThrow(
      /google.*routing\.provider\.only/i,
    );
    await expect(ai.transcribe("policy-transcribe", audio)).rejects.toThrow(
      /openai.*routing\.provider\.only/i,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("allows a native transcription when its provider is listed", async () => {
    const ai = makeHelper({ only: ["openai"], allowFallbacks: false });
    await expect(ai.transcribe("policy-transcribe", audio)).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toMatch(/\/audio\/transcriptions$/);
    expect((init?.body as FormData).get("model")).toBe("whisper-1");
  });

  it("refuses a direct call that cannot enforce data-collection denial", async () => {
    const ai = makeHelper({ only: ["openai"], dataCollection: "deny" });
    await expect(ai.transcribe("policy-transcribe", audio)).rejects.toThrow(
      /dataCollection/,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses an empty allowlist before sending an OpenRouter request", async () => {
    const ai = makeHelper({ only: [] });
    await expect(ai.generateText("policy-text", "Invoice")).rejects.toThrow(
      /routing\.provider\.only/,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("gives the resolver the policy and checks the built-in route when it declines", async () => {
    const resolver = vi.fn<ProviderResolver>().mockReturnValue(null);
    const policy = { only: ["openai"] };
    const ai = makeHelper(policy, resolver);
    await expect(ai.generateText("policy-google", "Invoice")).rejects.toThrow(
      /google.*routing\.provider\.only/i,
    );
    expect(resolver).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "google" }),
      policy,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("gives custom model factories the policy", async () => {
    const factory = vi.fn(() => {
      throw new Error("Factory invoked");
    });
    registerEmbeddingProvider("custom-policy", factory);
    registerEvaluationProvider("custom-policy", factory);
    registerTranscriptionProvider("custom-policy", factory);
    const ai = makeHelper();
    await expect(ai.embed("policy-custom-embed", "Invoice")).rejects.toThrow(
      "Factory invoked",
    );
    await expect(ai.evaluate("policy-custom-evaluate", spec)).rejects.toThrow(
      "Factory invoked",
    );
    await expect(
      ai.transcribe("policy-custom-transcribe", audio),
    ).rejects.toThrow("Factory invoked");
    expect(factory.mock.calls).toEqual([
      [embeddingModel.id, provider],
      [evaluationModel.id, provider],
      [transcriptionModel.id, provider],
    ]);
  });

  it("refuses policy-bound calls through adapters with no policy contract", async () => {
    const generateText = vi
      .fn()
      .mockResolvedValue({ text: "Done", inputTokens: 1, outputTokens: 1 });
    const ai = createAIHelper(
      "policy",
      new InMemoryAICallLogger(),
      undefined,
      undefined,
      {
        routing: { provider },
        adapter: { generateText },
      },
    );
    await expect(ai.generateText("policy-text", "Invoice")).rejects.toThrow(
      /adapter.*provider policy/i,
    );
    expect(generateText).not.toHaveBeenCalled();
  });

  it.each([
    "google",
    "anthropic",
    "openai",
  ] as const)("refuses a native %s batch outside the allowlist before sending requests", async (vendor) => {
    const ai = makeHelper({ only: ["azure"] });
    const key = {
      google: "policy-google",
      anthropic: "policy-anthropic",
      openai: "policy-text",
    }[vendor];
    await expect(
      ai.batch(key, vendor, { fetch: fetchMock }).submit(requests),
    ).rejects.toThrow(new RegExp(`${vendor}.*routing\\.provider\\.only`, "i"));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ["google", "policy-google", /:batchGenerateContent$/],
    ["anthropic", "policy-anthropic", /\/messages\/batches$/],
    ["openai", "policy-text", /\/files$/],
  ] as const)("submits through the allowed native %s transport", async (vendor, key, endpoint) => {
    const ai = makeHelper({ only: [vendor] });
    await expect(
      ai
        .batch(key, vendor, { apiKey: "test", fetch: fetchMock })
        .submit(requests),
    ).rejects.toThrow(/Batch submission failed/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toMatch(endpoint);
    const body =
      init?.body instanceof FormData
        ? await (init.body.get("file") as Blob).text()
        : String(init?.body);
    expect(body).toContain(requests[0]!.prompt);
  });

  it.each([
    { only: ["openai"], allowFallbacks: false },
    { order: ["openai"], allowFallbacks: false },
    { only: ["openai"], order: ["azure", "openai"], allowFallbacks: false },
  ])("sends the expressible policy at the top level of an OpenRouter batch (%j)", async (policy) => {
    fetchMock.mockResolvedValueOnce(
      Response.json({ id: "batch-1", status: "validating" }, { status: 202 }),
    );
    await expect(
      makeHelper(policy)
        .batch("policy-text", "openrouter", { fetch: fetchMock })
        .submit(requests),
    ).resolves.toMatchObject({ id: "batch-1" });
    const [, init] = fetchMock.mock.calls[0]!;
    const body = String(init?.body);
    expect(body.indexOf('"provider"')).toBeLessThan(body.indexOf('"requests"'));
    const parsed = JSON.parse(body);
    expect(parsed.provider).toEqual({
      only: ["openai"],
      allow_fallbacks: false,
    });
    expect(parsed.requests[0].body).not.toHaveProperty("provider");
  });

  it.each([
    provider,
    { only: ["openai"], order: ["azure"], allowFallbacks: false },
    {
      only: ["anthropic", "baseten/fp4"],
      order: ["baseten/fp4/us", "anthropic"],
      allowFallbacks: false,
    },
    {
      only: ["anthropic", "baseten/fp4"],
      order: ["baseten/fp4/us"],
      allowFallbacks: true,
    },
  ])("refuses an unrepresentable OpenRouter batch policy (%j)", async (policy) => {
    const ai = makeHelper(policy);
    await expect(
      ai
        .batch("policy-text", "openrouter", { fetch: fetchMock })
        .submit(requests),
    ).rejects.toThrow(/OpenRouter batch.*provider policy/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("pins a regional endpoint in an explicit OpenRouter batch", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({ id: "batch-1", status: "validating" }, { status: 202 }),
    );
    const ai = makeHelper({
      only: ["baseten/fp4"],
      order: ["baseten/fp4/us"],
      allowFallbacks: false,
    });
    await expect(
      ai
        .batch("policy-text", "openrouter", { fetch: fetchMock })
        .submit(requests),
    ).resolves.toMatchObject({ id: "batch-1" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = String(fetchMock.mock.calls[0]![1]?.body);
    expect(body.indexOf('"provider"')).toBeLessThan(body.indexOf('"requests"'));
    const parsed = JSON.parse(body);
    expect(parsed.provider).toEqual({
      only: ["baseten/fp4/us"],
      allow_fallbacks: false,
    });
    expect(parsed.requests[0].body).not.toHaveProperty("provider");
  });

  it("refuses an allowlist on OpenRouter batch embeddings before fetch", async () => {
    const ai = makeHelper({ only: ["openai"] });
    await expect(
      ai
        .batch("policy-text", "openrouter", {
          fetch: fetchMock,
          endpoint: "/v1/embeddings",
        })
        .submit(requests),
    ).rejects.toThrow(/batch.*embeddings/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  function mockToolSteps(finalText?: string, cost?: number) {
    for (const [index, name] of ["Azure", "OpenAI", "Azure"].entries()) {
      const final = index === 2 && finalText !== undefined;
      fetchMock.mockResolvedValueOnce(
        Response.json({
          id: `gen-${index}`,
          model: textModel.id,
          provider: name,
          choices: [
            {
              index: 0,
              finish_reason: final ? "stop" : "tool_calls",
              message: final
                ? { role: "assistant", content: finalText }
                : {
                    role: "assistant",
                    content: null,
                    tool_calls: [
                      {
                        id: `call-${index}`,
                        type: "function",
                        function: { name: "check", arguments: "{}" },
                      },
                    ],
                  },
            },
          ],
          usage: {
            prompt_tokens: 10,
            completion_tokens: 2,
            total_tokens: 12,
            cost,
          },
        }),
      );
    }
  }

  it("records the distinct serving providers and the provider for every tool-calling step", async () => {
    const logger = new InMemoryAICallLogger();
    const ai = createAIHelper("policy", logger, undefined, undefined, {
      routing: { provider },
    });
    mockToolSteps("Paid");

    await ai.generateText("policy-text", "Check the invoice.", {
      stopWhen: stepCountIs(3),
      tools: { check: { inputSchema: z.object({}), execute: () => "Paid" } },
    });

    const rows = await logger.listCalls("policy");
    expect(rows.find((row) => row.topic === "policy")).toMatchObject({
      servedBy: "Azure,OpenAI",
      metadata: { servedBySteps: ["Azure", "OpenAI", "Azure"] },
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    for (const [, init] of fetchMock.mock.calls) {
      expect(JSON.parse(String(init?.body)).provider).toMatchObject(wirePolicy);
    }
  });
  async function failStructuredCall(
    logger: AICallLogger,
    call: "text" | "object",
  ) {
    const topic = `provider-history-${crypto.randomUUID()}`;
    const ai = createAIHelper(topic, logger, undefined, undefined, {
      routing: { provider },
    });
    const schema = z.object({ paid: z.boolean() });
    mockToolSteps(JSON.stringify({ paid: "yes" }));
    const options = {
      stopWhen: stepCountIs(3),
      tools: { check: { inputSchema: z.object({}), execute: () => true } },
    };
    const result =
      call === "object"
        ? ai.generateObject(
            "policy-text",
            "Check the invoice.",
            schema,
            options,
          )
        : ai.generateText("policy-text", "Check the invoice.", {
            ...options,
            output: Output.object({ schema }),
          });
    await expect(result).rejects.toMatchObject({
      name: "AI_NoObjectGeneratedError",
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    return topic;
  }

  const failedHistory = {
    servedBy: "Azure,OpenAI",
    metadata: { status: "error", servedBySteps: ["Azure", "OpenAI", "Azure"] },
  };

  it.each([
    "text",
    "object",
  ] as const)("records completed provider steps when %s output validation fails", async (call) => {
    const logger = new InMemoryAICallLogger();
    const topic = await failStructuredCall(logger, call);
    const rows = await logger.listCalls(topic);
    expect(rows.find((row) => row.topic === topic)).toMatchObject(
      failedHistory,
    );
  });

  const alpha21ToolLimitTotals = {
    inputTokens: 30,
    outputTokens: 6,
    cost: 0.375,
  };
  const alpha21StreamTotals = {
    inputTokens: 20,
    outputTokens: 4,
    cost: 0.000028,
  };
  const alpha21ChunkCallbackTotals = {
    inputTokens: 10,
    outputTokens: 2,
    cost: 0.125,
  };

  async function failAdapterOutput(
    logger: AICallLogger,
    call: "text" | "object",
  ) {
    const topic = `adapter-output-${crypto.randomUUID()}`;
    const schema = z.object({ paid: z.boolean() });
    mockToolSteps(undefined, 0.125);
    const adapterCall = async () => {
      const result = await sdkGenerateText({
        model: openrouter(textModel.id),
        prompt: "Check the invoice.",
        tools: { check: { inputSchema: z.object({}), execute: () => true } },
        stopWhen: stepCountIs(3),
        output: Output.object({ schema }),
        maxRetries: 0,
      });
      return {
        text: result.text,
        inputTokens: result.usage.inputTokens ?? 0,
        outputTokens: result.usage.outputTokens ?? 0,
        costUsd: result.steps.reduce((cost, step) => {
          const usage = step.providerMetadata?.openrouter?.usage as {
            cost: number;
          };
          return cost + usage.cost;
        }, 0),
        get object() {
          return result.output;
        },
      };
    };
    const adapter: AIAdapter = {
      generateText: adapterCall,
      generateObject: adapterCall,
    };
    const ai = createAIHelper(topic, logger, undefined, undefined, { adapter });
    const result =
      call === "text"
        ? ai.generateText("policy-text", "Check the invoice.", {
            output: Output.object({ schema }),
          })
        : ai.generateObject("policy-text", "Check the invoice.", schema);
    await expect(result).rejects.toMatchObject({
      name: "AI_NoOutputGeneratedError",
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    return topic;
  }

  async function failChunkCallback(logger: AICallLogger) {
    const topic = `stream-callback-${crypto.randomUUID()}`;
    const baseChunk = {
      id: "gen-callback",
      model: textModel.id,
      provider: "Azure",
    };
    const first = {
      ...baseChunk,
      choices: [
        {
          index: 0,
          delta: { role: "assistant", content: "Partial" },
          finish_reason: null,
        },
      ],
    };
    const final = {
      ...baseChunk,
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: {
        prompt_tokens: 10,
        completion_tokens: 2,
        total_tokens: 12,
        cost: 0.125,
      },
    };
    const encoder = new TextEncoder();
    let finish!: () => void;
    const readable = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify(first)}\n\n`),
        );
        finish = () => {
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify(final)}\n\ndata: [DONE]\n\n`,
            ),
          );
          controller.close();
        };
      },
    });
    fetchMock.mockResolvedValueOnce(
      new Response(readable, {
        headers: { "Content-Type": "text/event-stream" },
      }),
    );
    const error = new Error("Consumer could not process chunk");
    const stream = createAIHelper(topic, logger).streamText(
      "policy-text",
      { prompt: "Check the invoice." },
      {
        maxRetries: 0,
        onChunk() {
          throw error;
        },
      },
    );
    try {
      await expect(stream.stream[Symbol.asyncIterator]().next()).rejects.toBe(
        error,
      );
    } finally {
      finish();
    }
    expect(await stream.getUsage()).toMatchObject({
      ...alpha21ChunkCallbackTotals,
      reportedCostUsd: 0.125,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    return topic;
  }

  const failedChunkCallback = {
    ...alpha21ChunkCallbackTotals,
    reportedCost: 0.125,
    costSource: "reported",
    servedBy: "Azure",
    metadata: { status: "error", servedBySteps: ["Azure"] },
  };

  const failedAdapterOutput = {
    ...alpha21ToolLimitTotals,
    reportedCost: 0.375,
    costSource: "reported",
    metadata: { status: "error" },
  };

  it.each([
    "text",
    "object",
  ] as const)("keeps the billable totals when an adapter's %s output getter throws", async (call) => {
    const logger = new InMemoryAICallLogger();
    const topic = await failAdapterOutput(logger, call);
    expect(await logger.listCalls(topic)).toMatchObject([failedAdapterOutput]);
  });

  it("keeps the alpha.21 bill when onChunk throws before the stream reports usage", async () => {
    const logger = new InMemoryAICallLogger();
    const topic = await failChunkCallback(logger);
    expect(await logger.listCalls(topic)).toMatchObject([failedChunkCallback]);
  });

  it.skipIf(!realDatabase)(
    "stores the final bill when a consumer fails before reading output",
    async () => {
      const db = await kernelDatabase();
      try {
        const adapterTopic = await failAdapterOutput(db.aiLogger, "text");
        fetchMock.mockClear();
        const streamTopic = await failChunkCallback(db.aiLogger);
        await vi.waitFor(async () => {
          expect(await db.aiLogger.listCalls(adapterTopic)).toMatchObject([
            failedAdapterOutput,
          ]);
          expect(await db.aiLogger.listCalls(streamTopic)).toMatchObject([
            failedChunkCallback,
          ]);
        });
      } finally {
        await db.close();
      }
    },
    20_000,
  );

  async function failAtToolLimit(
    logger: AICallLogger,
    call: "text" | "object",
  ) {
    const topic = `tool-limit-${crypto.randomUUID()}`;
    const ai = createAIHelper(topic, logger);
    mockToolSteps(undefined, 0.125);
    const schema = z.object({ paid: z.boolean() });
    const options = {
      stopWhen: stepCountIs(3),
      tools: { check: { inputSchema: z.object({}), execute: () => true } },
    };
    const result =
      call === "text"
        ? ai.generateText("policy-text", "Check the invoice.", {
            ...options,
            output: Output.object({ schema }),
          })
        : ai.generateObject(
            "policy-text",
            "Check the invoice.",
            schema,
            options,
          );
    await expect(result).rejects.toMatchObject({
      name: "AI_NoOutputGeneratedError",
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    return topic;
  }

  it.each([
    "text",
    "object",
  ] as const)("keeps the alpha.21 billable totals when %s reaches the tool-step limit", async (call) => {
    const logger = new InMemoryAICallLogger();
    const topic = await failAtToolLimit(logger, call);
    const rows = (await logger.listCalls(topic)).filter(
      (row) => row.topic === topic,
    );
    expect(rows).toMatchObject([
      {
        ...alpha21ToolLimitTotals,
        reportedCost: alpha21ToolLimitTotals.cost,
        costSource: "reported",
        ...failedHistory,
      },
    ]);
  });

  it.skipIf(!realDatabase)(
    "persists failed object provider history through the Prisma logger",
    async () => {
      const db = await kernelDatabase();
      try {
        const topic = await failStructuredCall(db.aiLogger, "object");
        await vi.waitFor(async () => {
          const rows = await db.aiLogger.listCalls(topic);
          expect(rows.find((row) => row.topic === topic)).toMatchObject(
            failedHistory,
          );
        });
      } finally {
        await db.close();
      }
    },
    20_000,
  );

  async function failStream(
    logger: AICallLogger,
    streamedError: boolean,
    cost?: number,
  ) {
    const topic = `stream-history-${crypto.randomUUID()}`;
    for (const [index, name] of ["Azure", "OpenAI"].entries()) {
      const chunk = {
        id: `gen-${index}`,
        model: textModel.id,
        provider: name,
        choices: [
          {
            index: 0,
            finish_reason: "tool_calls",
            delta: {
              role: "assistant",
              tool_calls: [
                {
                  index: 0,
                  id: `call-${index}`,
                  type: "function",
                  function: { name: "check", arguments: "{}" },
                },
              ],
            },
          },
        ],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 2,
          total_tokens: 12,
          cost,
        },
      };
      fetchMock.mockResolvedValueOnce(
        new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
          headers: { "Content-Type": "text/event-stream" },
        }),
      );
    }
    if (streamedError) {
      const chunk = {
        id: "gen-2",
        model: textModel.id,
        provider: "Azure",
        choices: [
          {
            index: 0,
            delta: { role: "assistant", content: "Partial" },
            finish_reason: null,
          },
        ],
      };
      const error = { error: { message: "Mock transport error", code: 400 } };
      fetchMock.mockResolvedValueOnce(
        new Response(
          `data: ${JSON.stringify(chunk)}\n\ndata: ${JSON.stringify(error)}\n\ndata: [DONE]\n\n`,
          { headers: { "Content-Type": "text/event-stream" } },
        ),
      );
    }
    const ai = createAIHelper(topic, logger);
    const stream = ai.streamText(
      "policy-text",
      { prompt: "Check the invoice." },
      {
        stopWhen: stepCountIs(3),
        tools: { check: { inputSchema: z.object({}), execute: () => true } },
      },
    );
    const usage = await stream.getUsage().catch(() => undefined);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    if (streamedError)
      expect(usage).toMatchObject({
        ...alpha21StreamTotals,
        cost: expect.closeTo(alpha21StreamTotals.cost, 12),
      });
    return topic;
  }

  const failedStream = (streamedError: boolean) => ({
    ...alpha21StreamTotals,
    cost: expect.closeTo(alpha21StreamTotals.cost, 12),
    estimatedCost: expect.closeTo(alpha21StreamTotals.cost, 12),
    costSource: "estimated",
    servedBy: "Azure,OpenAI",
    metadata: {
      status: "error",
      servedBySteps: streamedError
        ? ["Azure", "OpenAI", "Azure"]
        : ["Azure", "OpenAI"],
    },
  });

  it.each([
    false,
    true,
  ])("keeps the alpha.21 stream ledger totals after failure (streamed error: %s)", async (streamedError) => {
    const logger = new InMemoryAICallLogger();
    const topic = await failStream(logger, streamedError);
    expect(await logger.listCalls(topic)).toMatchObject([
      failedStream(streamedError),
    ]);
  });

  it("preserves all reported stream charges before a later request fails", async () => {
    const logger = new InMemoryAICallLogger();
    const topic = await failStream(logger, false, 0.125);
    expect(await logger.listCalls(topic)).toMatchObject([
      {
        ...failedStream(false),
        cost: 0.25,
        reportedCost: 0.25,
        costSource: "reported",
      },
    ]);
  });

  it.skipIf(!realDatabase)(
    "persists billable accounting for failed calls through the Prisma logger",
    async () => {
      const db = await kernelDatabase();
      try {
        const textTopic = await failAtToolLimit(db.aiLogger, "text");
        fetchMock.mockClear();
        const streamTopic = await failStream(db.aiLogger, true);
        await vi.waitFor(async () => {
          const rows = (await db.aiLogger.listCalls(textTopic)).filter(
            (row) => row.topic === textTopic,
          );
          expect(rows).toMatchObject([
            { ...alpha21ToolLimitTotals, ...failedHistory },
          ]);
          expect(await db.aiLogger.listCalls(streamTopic)).toMatchObject([
            failedStream(true),
          ]);
        });
      } finally {
        await db.close();
      }
    },
    20_000,
  );
});
