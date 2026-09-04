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
 *   They also require every property to be listed in `required`, so an
 *   optional property is sent as required-but-nullable
 *   (`anyOf: [<original>, { type: "null" }]`), the way OpenAI documents
 *   it. The model then answers `null` where the caller's Zod schema has
 *   `.optional()`, so before validation `stripOptionalNulls` removes the
 *   `null` values of properties that were optional and not nullable in the
 *   ORIGINAL schema (recursively: nested objects, arrays, union members).
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

import type {
  LanguageModelV4,
  LanguageModelV4CallOptions,
  LanguageModelV4Content,
} from "@ai-sdk/provider";
import { wrapLanguageModel } from "ai";
import type { ModelConfig } from "./model-helper";

export type SchemaTarget = "openai" | "google";

type JsonNode = Record<string, unknown>;

function isObject(value: unknown): value is JsonNode {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Follows a local `$ref` (`#/$defs/x`, `#/definitions/x`, ...) in `root`. */
function resolveRef(node: JsonNode, root: JsonNode): JsonNode {
  let current: JsonNode = node;
  for (let hops = 0; hops < 32 && typeof current.$ref === "string"; hops++) {
    const ref = current.$ref as string;
    if (!ref.startsWith("#/")) return current;
    let target: unknown = root;
    for (const segment of ref.slice(2).split("/")) {
      const key = segment.replace(/~1/g, "/").replace(/~0/g, "~");
      if (!isObject(target)) return current;
      target = target[key];
    }
    if (!isObject(target)) return current;
    current = target;
  }
  return current;
}

/** Whether `node` (in the original schema) already admits `null`. */
function acceptsNull(node: unknown, root: JsonNode): boolean {
  if (!isObject(node)) return false;
  const resolved = resolveRef(node, root);
  if (resolved.type === "null") return true;
  if (Array.isArray(resolved.type) && resolved.type.includes("null")) {
    return true;
  }
  if (resolved.const === null) return true;
  if (Array.isArray(resolved.enum) && resolved.enum.includes(null)) return true;
  if (resolved.nullable === true) return true;
  for (const key of ["anyOf", "oneOf"] as const) {
    const branches = resolved[key];
    if (Array.isArray(branches) && branches.some((b) => acceptsNull(b, root))) {
      return true;
    }
  }
  return false;
}

/** `converted` widened to also accept `null`, flattening a bare `anyOf`. */
function nullable(converted: unknown): JsonNode {
  if (
    isObject(converted) &&
    Array.isArray(converted.anyOf) &&
    Object.keys(converted).every((k) => k === "anyOf" || k === "description")
  ) {
    return {
      ...converted,
      anyOf: [...(converted.anyOf as unknown[]), { type: "null" }],
    };
  }
  return { anyOf: [converted, { type: "null" }] };
}

function convert(node: unknown, target: SchemaTarget, root: JsonNode): unknown {
  if (Array.isArray(node))
    return node.map((item) => convert(item, target, root));
  if (!isObject(node)) return node;
  const out: JsonNode = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === "oneOf") continue;
    if (key === "properties" && target === "openai" && isObject(value))
      continue;
    out[key] = convert(value, target, root);
  }
  if (Array.isArray(node.oneOf)) {
    const branches = (node.oneOf as unknown[]).map((b) =>
      convert(b, target, root),
    );
    out.anyOf = Array.isArray(out.anyOf)
      ? [...(out.anyOf as unknown[]), ...branches]
      : branches;
  }
  if (target === "openai" && isObject(node.properties)) {
    // OpenAI strict: every property is required; an optional one becomes
    // nullable so the model can still leave it out (as `null`).
    const required = new Set(
      Array.isArray(node.required) ? (node.required as unknown[]) : [],
    );
    const properties: JsonNode = {};
    for (const [name, prop] of Object.entries(node.properties)) {
      const converted = convert(prop, target, root);
      properties[name] =
        required.has(name) || acceptsNull(prop, root)
          ? converted
          : nullable(converted);
    }
    out.properties = properties;
    out.required = Object.keys(properties);
    if (out.additionalProperties === undefined) {
      out.additionalProperties = false;
    }
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
  return convert(rest, target, rest) as Record<string, unknown>;
}

/** The union branches of `node` that can describe an object value. */
function objectBranches(node: JsonNode, root: JsonNode): JsonNode[] {
  const branches: JsonNode[] = [];
  for (const key of ["anyOf", "oneOf"] as const) {
    const list = node[key];
    if (!Array.isArray(list)) continue;
    for (const branch of list) {
      if (!isObject(branch)) continue;
      const resolved = resolveRef(branch, root);
      if (isObject(resolved.properties) || resolved.type === "object") {
        branches.push(resolved);
      }
    }
  }
  return branches;
}

/** Whether every `const`/single-`enum` property of `branch` matches `value`. */
function branchMatches(branch: JsonNode, value: JsonNode): boolean {
  if (!isObject(branch.properties)) return true;
  let discriminated = false;
  for (const [name, prop] of Object.entries(branch.properties)) {
    if (!isObject(prop)) continue;
    const literal =
      prop.const !== undefined
        ? prop.const
        : Array.isArray(prop.enum) && prop.enum.length === 1
          ? prop.enum[0]
          : undefined;
    if (literal === undefined) continue;
    discriminated = true;
    if (value[name] !== literal) return false;
  }
  return discriminated;
}

function stripNode(value: unknown, node: unknown, root: JsonNode): unknown {
  if (!isObject(node) || value === null || typeof value !== "object") {
    return value;
  }
  const schema = resolveRef(node, root);

  if (Array.isArray(value)) {
    const items = schema.items;
    if (Array.isArray(items)) {
      return value.map((item, i) => stripNode(item, items[i], root));
    }
    if (isObject(items)) {
      return value.map((item) => stripNode(item, items, root));
    }
    const branches = [
      ...(Array.isArray(schema.anyOf) ? schema.anyOf : []),
      ...(Array.isArray(schema.oneOf) ? schema.oneOf : []),
    ].filter((b) => isObject(b) && resolveRef(b, root).type === "array");
    return branches.length === 1 ? stripNode(value, branches[0], root) : value;
  }

  const object = value as JsonNode;

  // A union: narrow to the branch the discriminator selects, else apply
  // every object branch (a null is stripped only when each branch that
  // defines the property agrees it is optional and not nullable).
  if (!isObject(schema.properties)) {
    const branches = objectBranches(schema, root);
    if (branches.length === 0) return value;
    const matching = branches.filter((b) => branchMatches(b, object));
    if (matching.length === 1) return stripNode(value, matching[0], root);
    let out: JsonNode = { ...object };
    for (const [key, entry] of Object.entries(object)) {
      const defining = branches.filter(
        (b) => isObject(b.properties) && b.properties[key] !== undefined,
      );
      if (defining.length === 0) continue;
      if (entry === null) {
        const strippable = defining.every((b) => {
          const required = Array.isArray(b.required) ? b.required : [];
          return (
            !required.includes(key) &&
            !acceptsNull((b.properties as JsonNode)[key], root)
          );
        });
        if (strippable) {
          const { [key]: _dropped, ...rest } = out;
          out = rest;
        }
        continue;
      }
      let next: unknown = entry;
      for (const b of defining) {
        next = stripNode(next, (b.properties as JsonNode)[key], root);
      }
      out[key] = next;
    }
    return out;
  }

  const properties = schema.properties as JsonNode;
  const required = new Set(
    Array.isArray(schema.required) ? (schema.required as unknown[]) : [],
  );
  const out: JsonNode = {};
  for (const [key, entry] of Object.entries(object)) {
    const prop = properties[key];
    if (prop === undefined) {
      out[key] = isObject(schema.additionalProperties)
        ? stripNode(entry, schema.additionalProperties, root)
        : entry;
      continue;
    }
    if (entry === null) {
      if (!required.has(key) && !acceptsNull(prop, root)) continue;
      out[key] = entry;
      continue;
    }
    out[key] = stripNode(entry, prop, root);
  }
  return out;
}

/**
 * `value` (a model's parsed JSON reply) with every `null` removed where the
 * ORIGINAL schema — the one `toPortableJsonSchema(…, "openai")` was fed —
 * has an optional, non-nullable property, so the caller's Zod schema
 * parses it. Nested objects, arrays and union members are covered; a `null`
 * the original schema admits (required or `.nullable()`) is kept. Never
 * mutates its input.
 */
export function stripOptionalNulls(
  value: unknown,
  jsonSchema: unknown,
): unknown {
  if (!isObject(jsonSchema)) return value;
  return stripNode(value, jsonSchema, jsonSchema);
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

/** A JSON text with the optional-property nulls of `original` removed. */
function stripJsonText(text: string, original: unknown): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return text;
  }
  const stripped = stripOptionalNulls(parsed, original);
  return stripped === parsed ? text : JSON.stringify(stripped);
}

/**
 * Wrap a language model so every JSON `responseFormat` it receives carries
 * the portable schema for `target`, and (OpenAI) so a generated reply has
 * the nulls of optional properties removed before the AI SDK validates it
 * against the original schema. Returns the model unchanged when no rewrite
 * applies. A streamed reply is sent the portable schema too; its text is
 * not rewritten (the engine's `streamText` has no structured output).
 */
export function withPortableSchema(
  model: LanguageModelV4,
  target: SchemaTarget | undefined,
): LanguageModelV4 {
  if (target === undefined) return model;
  const prepare = (
    params: LanguageModelV4CallOptions,
  ): { params: LanguageModelV4CallOptions; original: unknown } => {
    const format = params.responseFormat;
    if (format?.type !== "json" || format.schema == null) {
      return { params, original: undefined };
    }
    return {
      original: format.schema,
      params: {
        ...params,
        responseFormat: {
          ...format,
          schema: toPortableJsonSchema(
            format.schema,
            target,
          ) as typeof format.schema,
        },
      },
    };
  };
  return wrapLanguageModel({
    model,
    middleware: {
      async wrapGenerate({ params, model: inner }) {
        const { params: sent, original } = prepare(params);
        const result = await inner.doGenerate(sent);
        if (target !== "openai" || original === undefined) return result;
        const content: LanguageModelV4Content[] = result.content.map((part) =>
          part.type === "text"
            ? { ...part, text: stripJsonText(part.text, original) }
            : part,
        );
        return { ...result, content };
      },
      async wrapStream({ params, model: inner }) {
        return inner.doStream(prepare(params).params);
      },
    },
  });
}
