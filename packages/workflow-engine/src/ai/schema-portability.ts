/**
 * Schema portability: the JSON Schema a Zod schema emits is not what every
 * provider's structured-output mode accepts.
 *
 * - OpenAI's strict structured outputs (native, and through OpenRouter's
 *   chat completions and `:batch` endpoint) reject `oneOf` — which is what
 *   `z.discriminatedUnion` emits — with `'oneOf' is not permitted`; they
 *   accept `anyOf`, `const`, `enum`, `$defs`/`$ref`, array bounds and
 *   numeric bounds, and require `additionalProperties: false` on every
 *   object (zod v4 emits it for `z.object`; it is added where missing).
 * - Gemini's `responseSchema` has no `oneOf` either; `@ai-sdk/google`
 *   forwards it verbatim and the API drops the union, so a discriminated
 *   union comes back flat. It handles `anyOf` (including `null` branches),
 *   `const`, `enum` and `$ref` itself, so only the union keyword needs
 *   rewriting on the realtime path. (The Google *batch* path substitutes
 *   the engine's full OpenAPI conversion at the fetch boundary instead —
 *   see batch/google-json-schema.ts.)
 *
 * The rewrite is applied at the model boundary as an AI SDK middleware, so
 * `generateObject`, `generateText` + `Output.object` and `streamText` all
 * send a portable schema while validation still runs against the original
 * Zod schema. `oneOf` → `anyOf` accepts the same values for a discriminated
 * union (its branches are mutually exclusive by the discriminator).
 */

import type { LanguageModelV4 } from "@ai-sdk/provider";
import { wrapLanguageModel } from "ai";
import type { ModelConfig } from "./model-helper";

export type SchemaTarget = "openai" | "google";

type JsonNode = Record<string, unknown>;

function isObject(value: unknown): value is JsonNode {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function convert(node: unknown, target: SchemaTarget): unknown {
  if (Array.isArray(node)) return node.map((item) => convert(item, target));
  if (!isObject(node)) return node;
  const out: JsonNode = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === "oneOf") continue;
    out[key] = convert(value, target);
  }
  if (Array.isArray(node.oneOf)) {
    const branches = (node.oneOf as unknown[]).map((b) => convert(b, target));
    out.anyOf = Array.isArray(out.anyOf)
      ? [...(out.anyOf as unknown[]), ...branches]
      : branches;
  }
  if (
    target === "openai" &&
    isObject(out.properties) &&
    out.additionalProperties === undefined
  ) {
    out.additionalProperties = false;
  }
  return out;
}

/**
 * A JSON Schema (as `z.toJSONSchema` emits it) rewritten for `target`.
 * Never mutates its input.
 */
export function toPortableJsonSchema(
  jsonSchema: unknown,
  target: SchemaTarget,
): Record<string, unknown> {
  if (!isObject(jsonSchema)) return {};
  const { $schema: _dialect, ...rest } = jsonSchema;
  return convert(rest, target) as Record<string, unknown>;
}

/**
 * Which rewrite a model needs, from its registry entry first (the engine's
 * own providers) and the resolved model's provider id otherwise (a
 * `providerResolver`-supplied model). `undefined` means no rewrite.
 */
export function schemaTargetForModel(
  modelConfig: Pick<ModelConfig, "provider">,
  model: Pick<LanguageModelV4, "provider">,
): SchemaTarget | undefined {
  const registered = modelConfig.provider;
  if (registered === "openrouter" || registered === "openai") return "openai";
  if (registered === "google") return "google";
  const providerId = model.provider ?? "";
  if (providerId.startsWith("openai") || providerId.startsWith("openrouter")) {
    return "openai";
  }
  if (providerId.startsWith("google")) return "google";
  return undefined;
}

/**
 * Wrap a language model so every JSON `responseFormat` it receives carries
 * the portable schema for `target`. Returns the model unchanged when no
 * rewrite applies.
 */
export function withPortableSchema(
  model: LanguageModelV4,
  target: SchemaTarget | undefined,
): LanguageModelV4 {
  if (target === undefined) return model;
  return wrapLanguageModel({
    model,
    middleware: {
      async transformParams({ params }) {
        const format = params.responseFormat;
        if (format?.type !== "json" || format.schema == null) return params;
        return {
          ...params,
          responseFormat: {
            ...format,
            schema: toPortableJsonSchema(
              format.schema,
              target,
            ) as typeof format.schema,
          },
        };
      },
    },
  });
}
