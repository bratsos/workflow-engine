import { stepCountIs } from "ai";
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
import { InMemoryAICallLogger } from "../../testing/in-memory-ai-logger.js";

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
      only: ["google"],
      allow_fallbacks: true,
      data_collection: "allow",
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

describe("helper provider policy", () => {
  it.each([
    [
      "text",
      "/chat/completions",
      (ai) => ai.generateText("policy-text", "Invoice", { providerOptions }),
    ],
    [
      "object",
      "/chat/completions",
      (ai) =>
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
      (ai) =>
        ai
          .streamText("policy-text", { prompt: "Invoice" }, { providerOptions })
          .getUsage(),
    ],
    [
      "embed",
      "/embeddings",
      (ai) => ai.embed("policy-embed", "Invoice", { providerOptions }),
    ],
    [
      "embedMany",
      "/embeddings",
      (ai) =>
        ai.embed("policy-embed", ["Invoice", "Order"], { providerOptions }),
    ],
    [
      "evaluate",
      "/decisions",
      (ai) => ai.evaluate("policy-evaluate", spec, { providerOptions }),
    ],
  ] satisfies [
    string,
    string,
    (ai: ReturnType<typeof makeHelper>) => Promise<unknown>,
  ][])("enforces the helper policy in the OpenRouter %s request", async (_call, endpoint, run) => {
    await run(makeHelper().createChild("tenant-a")).catch(() => {});
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toMatch(new RegExp(`${endpoint}$`));
    expect(JSON.parse(String(init?.body)).provider).toMatchObject(wirePolicy);
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

  it("refuses an OpenRouter batch with a policy before sending requests", async () => {
    const ai = makeHelper();
    await expect(
      ai
        .batch("policy-text", "openrouter", { fetch: fetchMock })
        .submit(requests),
    ).rejects.toThrow(/OpenRouter batch.*provider policy/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("records the distinct serving providers and the provider for every tool-calling step", async () => {
    const logger = new InMemoryAICallLogger();
    const ai = createAIHelper("policy", logger, undefined, undefined, {
      routing: { provider },
    });
    for (const [index, name] of ["Azure", "OpenAI", "Azure"].entries()) {
      const final = index === 2;
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
                ? { role: "assistant", content: "Paid" }
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
          usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
        }),
      );
    }

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
});
