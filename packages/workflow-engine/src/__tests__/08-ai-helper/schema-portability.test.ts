/**
 * Structured-output schemas are rewritten per target at the model boundary:
 * OpenAI (native and through OpenRouter) rejects `oneOf` — what
 * `z.discriminatedUnion` emits — and Gemini drops it, so both receive
 * `anyOf`; OpenAI additionally gets `additionalProperties: false` on every
 * object. Validation still runs against the original Zod schema.
 */

import type { LanguageModelV4CallOptions } from "@ai-sdk/provider";
import { Output } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createAIHelper } from "../../ai/ai-helper.js";
import { registerModels } from "../../ai/model-helper.js";
import {
  schemaTargetForModel,
  toPortableJsonSchema,
} from "../../ai/schema-portability.js";
import type { ProviderResolver } from "../../ai/types.js";
import { InMemoryAICallLogger } from "../../testing/in-memory-ai-logger.js";

const Section = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("heading"), text: z.string() }),
  z.object({
    kind: z.literal("paragraph"),
    text: z.string(),
    tags: z.array(z.string()).max(3),
  }),
]);
const Doc = z.object({
  title: z.string(),
  sections: z.array(Section).min(1),
  note: z.string().nullable(),
});

function keywords(node: unknown, acc = new Set<string>()): Set<string> {
  if (Array.isArray(node)) {
    for (const item of node) keywords(item, acc);
  } else if (typeof node === "object" && node !== null) {
    for (const [key, value] of Object.entries(node)) {
      acc.add(key);
      keywords(value, acc);
    }
  }
  return acc;
}

describe("toPortableJsonSchema", () => {
  const json = z.toJSONSchema(Doc);

  it("emits oneOf for a discriminated union on zod v4 (the premise)", () => {
    expect(keywords(json).has("oneOf")).toBe(true);
  });

  it("rewrites oneOf to anyOf for OpenAI, keeps const/enum/bounds and closes every object", () => {
    const out = toPortableJsonSchema(json, "openai");
    const seen = keywords(out);
    expect(seen.has("oneOf")).toBe(false);
    expect(seen.has("$schema")).toBe(false);
    expect(seen.has("anyOf")).toBe(true);
    expect(seen.has("const")).toBe(true);
    expect(seen.has("minItems")).toBe(true);
    expect(seen.has("maxItems")).toBe(true);
    const items = (out.properties as any).sections.items;
    expect(items.anyOf).toHaveLength(2);
    expect(items.anyOf[0].properties.kind.const).toBe("heading");
    expect(items.anyOf[0].additionalProperties).toBe(false);
    expect(out.additionalProperties).toBe(false);
    // The nullable field is an anyOf with a null branch, untouched.
    expect((out.properties as any).note.anyOf).toEqual([
      { type: "string" },
      { type: "null" },
    ]);
    // Never mutates its input.
    expect(keywords(json).has("oneOf")).toBe(true);
  });

  it("adds additionalProperties: false where zod left an object open", () => {
    const out = toPortableJsonSchema(
      { type: "object", properties: { a: { type: "string" } } },
      "openai",
    );
    expect(out.additionalProperties).toBe(false);
    const google = toPortableJsonSchema(
      { type: "object", properties: { a: { type: "string" } } },
      "google",
    );
    expect(google.additionalProperties).toBeUndefined();
  });

  it("rewrites only the union keyword for Google", () => {
    const out = toPortableJsonSchema(json, "google");
    expect(keywords(out).has("oneOf")).toBe(false);
    expect((out.properties as any).sections.items.anyOf).toHaveLength(2);
  });

  it("merges an existing anyOf with the rewritten oneOf", () => {
    const out = toPortableJsonSchema(
      { anyOf: [{ type: "null" }], oneOf: [{ type: "string" }] },
      "openai",
    );
    expect(out.anyOf).toEqual([{ type: "null" }, { type: "string" }]);
  });
});

describe("schemaTargetForModel", () => {
  it("reads the registry provider first, then the model's provider id", () => {
    const m = (provider: string) => ({ provider });
    expect(schemaTargetForModel({ provider: "openrouter" }, m("x"))).toBe(
      "openai",
    );
    expect(schemaTargetForModel({ provider: "google" }, m("x"))).toBe("google");
    expect(schemaTargetForModel({ provider: "openai" }, m("x"))).toBe("openai");
    expect(
      schemaTargetForModel({ provider: "custom" }, m("openai.responses")),
    ).toBe("openai");
    expect(
      schemaTargetForModel({ provider: "custom" }, m("google.generative-ai")),
    ).toBe("google");
    expect(
      schemaTargetForModel({ provider: "custom" }, m("openrouter.chat")),
    ).toBe("openai");
    expect(
      schemaTargetForModel({ provider: "custom" }, m("anthropic.messages")),
    ).toBeUndefined();
  });
});

const OPENROUTER_MODEL = "portability-openrouter-model";
const GOOGLE_MODEL = "portability-google-model";
const ANTHROPIC_MODEL = "portability-anthropic-model";
registerModels({
  [OPENROUTER_MODEL]: {
    id: "openai/gpt-5-nano",
    name: "Nano via OpenRouter",
    provider: "openrouter",
    inputCostPerMillion: 1,
    outputCostPerMillion: 1,
  },
  [GOOGLE_MODEL]: {
    id: "gemini-2.5-flash-lite",
    name: "Flash Lite",
    provider: "google",
    inputCostPerMillion: 1,
    outputCostPerMillion: 1,
  },
  [ANTHROPIC_MODEL]: {
    id: "claude-haiku-4-5",
    name: "Haiku",
    provider: "custom",
    inputCostPerMillion: 1,
    outputCostPerMillion: 1,
  },
});

const reply = {
  title: "t",
  sections: [{ kind: "heading", text: "h" }],
  note: null,
};

function capturingModel(
  provider: string,
  captured: LanguageModelV4CallOptions[],
) {
  return new MockLanguageModelV4({
    provider,
    doGenerate: async (options) => {
      captured.push(options);
      return {
        content: [{ type: "text", text: JSON.stringify(reply) }],
        finishReason: { unified: "stop", raw: "stop" },
        usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } },
        warnings: [],
      } as never;
    },
  });
}

describe("realtime structured output request bodies", () => {
  it.each([
    [OPENROUTER_MODEL, "openrouter.chat"],
    [GOOGLE_MODEL, "google.generative-ai"],
  ])("sends anyOf instead of oneOf for %s on generateObject and generateText+Output.object", async (modelKey, providerId) => {
    const captured: LanguageModelV4CallOptions[] = [];
    const resolver: ProviderResolver = () =>
      capturingModel(providerId, captured) as never;
    const ai = createAIHelper(
      "portability",
      new InMemoryAICallLogger(),
      undefined,
      resolver,
    );

    const viaObject = await ai.generateObject(modelKey, "q", Doc);
    const viaText = await ai.generateText(modelKey, "q", {
      output: Output.object({ schema: Doc }),
    });

    expect(viaObject.object).toEqual(reply);
    expect(viaText.output).toEqual(reply);
    expect(captured).toHaveLength(2);
    for (const call of captured) {
      const schema =
        call.responseFormat?.type === "json"
          ? call.responseFormat.schema
          : undefined;
      expect(schema).toBeDefined();
      const seen = keywords(schema);
      expect(seen.has("oneOf")).toBe(false);
      expect(seen.has("anyOf")).toBe(true);
      expect(seen.has("$schema")).toBe(false);
    }
  });

  it("still validates the reply against the original Zod schema", async () => {
    const captured: LanguageModelV4CallOptions[] = [];
    const model = new MockLanguageModelV4({
      provider: "openrouter.chat",
      doGenerate: async (options) => {
        captured.push(options);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ ...reply, sections: [{ kind: "nope" }] }),
            },
          ],
          finishReason: { unified: "stop", raw: "stop" },
          usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } },
          warnings: [],
        } as never;
      },
    });
    const ai = createAIHelper(
      "portability",
      new InMemoryAICallLogger(),
      undefined,
      () => model as never,
    );

    await expect(ai.generateObject(OPENROUTER_MODEL, "q", Doc)).rejects.toThrow(
      /No object generated|invalid|Invalid/,
    );
    expect(captured).toHaveLength(1);
  });

  it("leaves a model of an unknown provider untouched", async () => {
    const captured: LanguageModelV4CallOptions[] = [];
    const ai = createAIHelper(
      "portability",
      new InMemoryAICallLogger(),
      undefined,
      () => capturingModel("anthropic.messages", captured) as never,
    );
    await ai.generateObject(ANTHROPIC_MODEL, "q", Doc);
    const schema =
      captured[0]!.responseFormat?.type === "json"
        ? captured[0]!.responseFormat.schema
        : undefined;
    expect(keywords(schema).has("oneOf")).toBe(true);
  });
});
