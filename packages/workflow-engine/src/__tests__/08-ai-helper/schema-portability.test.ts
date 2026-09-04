/**
 * Structured-output schemas are rewritten per target at the model boundary:
 * OpenAI (native and through OpenRouter) rejects `oneOf` — what
 * `z.discriminatedUnion` emits — and Gemini drops it, so both receive
 * `anyOf`; OpenAI additionally gets `additionalProperties: false` on every
 * object. Validation still runs against the original Zod schema.
 */

import type { LanguageModelV4CallOptions } from "@ai-sdk/provider";
import { streamText as aiStreamText, Output } from "ai";
import { MockLanguageModelV4, simulateReadableStream } from "ai/test";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createAIHelper } from "../../ai/ai-helper.js";
import { AIBatchImpl } from "../../ai/batch-helper.js";
import { registerModels } from "../../ai/model-helper.js";
import {
  schemaTargetForModel,
  stripOptionalNulls,
  toPortableJsonSchema,
  withPortableSchema,
} from "../../ai/schema-portability.js";
import type { ProviderResolver } from "../../ai/types.js";
import { InMemoryAICallLogger } from "../../testing/in-memory-ai-logger.js";
import { makeFakeBackend } from "../durable/ai-map-harness.js";

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

// ---- OpenAI strict: every property required, optional ones nullable --------

const Address = z.object({
  street: z.string(),
  unit: z.string().optional(),
});
const Contact = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("email"),
    address: z.string(),
    label: z.string().optional(),
  }),
  z.object({
    kind: z.literal("phone"),
    number: z.string(),
    extension: z.string().nullable().optional(),
  }),
]);
const Person = z.object({
  name: z.string(),
  nickname: z.string().optional(),
  middle: z.string().nullable().optional(),
  suffix: z.string().nullable(),
  home: Address.optional(),
  addresses: z.array(Address),
  contacts: z.array(Contact),
  primary: Contact.optional(),
});

describe("toPortableJsonSchema for OpenAI: required lists every property", () => {
  const json = z.toJSONSchema(Person, { io: "input" });
  const out = toPortableJsonSchema(json, "openai") as any;

  it("lists every property of every object in required, recursively", () => {
    expect(out.required).toEqual(Object.keys(out.properties));
    expect(out.properties.home.anyOf[0].required).toEqual(["street", "unit"]);
    expect(out.properties.addresses.items.required).toEqual(["street", "unit"]);
    for (const branch of out.properties.contacts.items.anyOf) {
      expect(branch.required).toEqual(Object.keys(branch.properties));
    }
  });

  it("makes an optional non-nullable property nullable and leaves the rest", () => {
    expect(out.properties.nickname).toEqual({
      anyOf: [{ type: "string" }, { type: "null" }],
    });
    expect(out.properties.home.anyOf[1]).toEqual({ type: "null" });
    // Optional nullable: already admits null, not wrapped twice.
    expect(out.properties.middle).toEqual({
      anyOf: [{ type: "string" }, { type: "null" }],
    });
    // Required nullable and required non-nullable: untouched.
    expect(out.properties.suffix).toEqual({
      anyOf: [{ type: "string" }, { type: "null" }],
    });
    expect(out.properties.name).toEqual({ type: "string" });
    // Discriminated-union members get the same treatment.
    const [email, phone] = out.properties.contacts.items.anyOf;
    expect(email.properties.label).toEqual({
      anyOf: [{ type: "string" }, { type: "null" }],
    });
    expect(phone.properties.extension).toEqual({
      anyOf: [{ type: "string" }, { type: "null" }],
    });
    // An optional union flattens into one anyOf with a null branch.
    expect(out.properties.primary.anyOf).toHaveLength(3);
    expect(out.properties.primary.anyOf[2]).toEqual({ type: "null" });
  });

  it("handles $defs/$ref (a reused sub-schema) and keeps refs intact", () => {
    const Node = z.object({ id: z.string(), tag: z.string().optional() });
    const Tree = z.object({ a: Node, b: Node.optional() });
    const ref = toPortableJsonSchema(
      z.toJSONSchema(Tree, { io: "input", reused: "ref" }),
      "openai",
    ) as any;
    const defs = ref.$defs ?? ref.definitions;
    expect(defs).toBeDefined();
    const def = Object.values(defs)[0] as any;
    expect(def.required).toEqual(["id", "tag"]);
    expect(def.properties.tag).toEqual({
      anyOf: [{ type: "string" }, { type: "null" }],
    });
    expect(ref.required).toEqual(["a", "b"]);
    expect(ref.properties.a.$ref).toBeDefined();
    expect(ref.properties.b.anyOf[0].$ref).toBeDefined();
    expect(ref.properties.b.anyOf[1]).toEqual({ type: "null" });
  });

  it("keeps required as zod emitted it for Google", () => {
    const google = toPortableJsonSchema(json, "google") as any;
    expect(google.required).toEqual(json.required);
    expect(google.properties.nickname).toEqual({ type: "string" });
  });
});

describe("stripOptionalNulls", () => {
  const json = z.toJSONSchema(Person, { io: "input" });

  it("removes the nulls the original schema does not admit so zod parses the reply", () => {
    const reply = {
      name: "Ada",
      nickname: null,
      middle: null,
      suffix: null,
      home: null,
      addresses: [{ street: "1 Main", unit: null }],
      contacts: [
        { kind: "email", address: "a@b.c", label: null },
        { kind: "phone", number: "555", extension: null },
      ],
      primary: { kind: "email", address: "a@b.c", label: null },
    };
    expect(Person.safeParse(reply).success).toBe(false);
    const stripped = stripOptionalNulls(reply, json);
    expect(stripped).toEqual({
      name: "Ada",
      middle: null,
      suffix: null,
      addresses: [{ street: "1 Main" }],
      contacts: [
        { kind: "email", address: "a@b.c" },
        { kind: "phone", number: "555", extension: null },
      ],
      primary: { kind: "email", address: "a@b.c" },
    });
    expect(Person.safeParse(stripped).success).toBe(true);
    // Never mutates its input.
    expect(reply.nickname).toBeNull();
    expect(reply.addresses[0]!.unit).toBeNull();
  });

  it("keeps a null a required or nullable property admits, and real values", () => {
    const reply = {
      name: "Ada",
      nickname: "A",
      middle: null,
      suffix: null,
      home: { street: "x", unit: "2" },
      addresses: [],
      contacts: [{ kind: "phone", number: "1", extension: null }],
    };
    expect(stripOptionalNulls(reply, json)).toEqual(reply);
  });

  it("follows $ref into $defs", () => {
    const Node = z.object({ id: z.string(), tag: z.string().optional() });
    const Tree = z.object({ a: Node, b: Node.optional() });
    const ref = z.toJSONSchema(Tree, { io: "input", reused: "ref" });
    const stripped = stripOptionalNulls(
      { a: { id: "1", tag: null }, b: null },
      ref,
    );
    expect(stripped).toEqual({ a: { id: "1" } });
    expect(Tree.safeParse(stripped).success).toBe(true);
  });
});

// ---- Middleware round trip ---------------------------------------------------

const PERSON_REPLY = {
  name: "Ada",
  nickname: null,
  middle: null,
  suffix: null,
  home: null,
  addresses: [{ street: "1 Main", unit: null }],
  contacts: [{ kind: "email", address: "a@b.c", label: null }],
  primary: null,
};
const PERSON_PARSED = {
  name: "Ada",
  middle: null,
  suffix: null,
  addresses: [{ street: "1 Main" }],
  contacts: [{ kind: "email", address: "a@b.c" }],
};

function personModel(provider: string, captured: LanguageModelV4CallOptions[]) {
  return new MockLanguageModelV4({
    provider,
    doGenerate: async (options) => {
      captured.push(options);
      return {
        content: [{ type: "text", text: JSON.stringify(PERSON_REPLY) }],
        finishReason: { unified: "stop", raw: "stop" },
        usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } },
        warnings: [],
      } as never;
    },
    doStream: async (options) => {
      captured.push(options);
      return {
        stream: simulateReadableStream({
          chunks: [
            { type: "stream-start", warnings: [] },
            { type: "text-start", id: "t" },
            {
              type: "text-delta",
              id: "t",
              delta: JSON.stringify(PERSON_REPLY),
            },
            { type: "text-end", id: "t" },
            {
              type: "finish",
              finishReason: { unified: "stop", raw: "stop" },
              usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } },
            },
          ] as never[],
        }),
      } as never;
    },
  });
}

function requiredEverywhere(node: unknown): boolean {
  if (Array.isArray(node)) return node.every(requiredEverywhere);
  if (typeof node !== "object" || node === null) return true;
  const n = node as Record<string, unknown>;
  if (n.properties && typeof n.properties === "object") {
    const keys = Object.keys(n.properties as object);
    if (JSON.stringify(n.required) !== JSON.stringify(keys)) return false;
  }
  return Object.values(n).every(requiredEverywhere);
}

describe("OpenAI middleware: required-everywhere request, nulls stripped before validation", () => {
  it("generateObject and generateText + Output.object return the zod-parsed object", async () => {
    const captured: LanguageModelV4CallOptions[] = [];
    const ai = createAIHelper(
      "portability",
      new InMemoryAICallLogger(),
      undefined,
      () => personModel("openrouter.chat", captured) as never,
    );
    const viaObject = await ai.generateObject(OPENROUTER_MODEL, "q", Person);
    const viaText = await ai.generateText(OPENROUTER_MODEL, "q", {
      output: Output.object({ schema: Person }),
    });
    expect(viaObject.object).toEqual(PERSON_PARSED);
    expect(viaText.output).toEqual(PERSON_PARSED);
    expect(captured).toHaveLength(2);
    for (const call of captured) {
      const schema =
        call.responseFormat?.type === "json"
          ? call.responseFormat.schema
          : undefined;
      expect(requiredEverywhere(schema)).toBe(true);
      expect(keywords(schema).has("oneOf")).toBe(false);
    }
  });

  it("streamText sends the same portable schema", async () => {
    const captured: LanguageModelV4CallOptions[] = [];
    const model = withPortableSchema(
      personModel("openrouter.chat", captured) as never,
      "openai",
    );
    const result = aiStreamText({
      model,
      prompt: "q",
      output: Output.object({ schema: Person }),
    });
    let text = "";
    for await (const chunk of result.textStream) text += chunk;
    expect(JSON.parse(text)).toEqual(PERSON_REPLY);
    expect(captured).toHaveLength(1);
    const schema =
      captured[0]!.responseFormat?.type === "json"
        ? captured[0]!.responseFormat.schema
        : undefined;
    expect(requiredEverywhere(schema)).toBe(true);
  });

  it("does not touch Google or unknown providers", async () => {
    const captured: LanguageModelV4CallOptions[] = [];
    const ai = createAIHelper(
      "portability",
      new InMemoryAICallLogger(),
      undefined,
      () => personModel("google.generative-ai", captured) as never,
    );
    // Google receives zod's required list and an unmodified reply, which
    // the original schema rejects (null for an optional string).
    await expect(
      ai.generateObject(GOOGLE_MODEL, "q", Person),
    ).rejects.toThrow();
    const schema =
      captured[0]!.responseFormat?.type === "json"
        ? (captured[0]!.responseFormat.schema as any)
        : undefined;
    expect(schema.required).toEqual(
      z.toJSONSchema(Person, { io: "input" }).required,
    );
  });
});

describe("OpenAI/OpenRouter batch: nulls stripped before schema validation", () => {
  it("validates an item whose reply has null for an optional property", async () => {
    const backend = makeFakeBackend({
      respond: () => JSON.stringify(PERSON_REPLY),
    });
    const batch = new AIBatchImpl(
      { topic: "portability", aiCallLogger: new InMemoryAICallLogger() },
      OPENROUTER_MODEL,
      "openrouter",
      undefined,
      undefined,
      backend.model,
    );
    const handle = await batch.submit([
      { id: "r1", prompt: "q", schema: Person },
    ]);
    const sent = (backend.model.start as any).mock.calls[0][0][0];
    expect(
      requiredEverywhere(sent.schema ? z.toJSONSchema(sent.schema) : {}),
    ).toBe(false);
    const results = await batch.getResults(handle.id);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      id: "r1",
      status: "succeeded",
      validated: true,
      result: PERSON_PARSED,
    });
  });
});
