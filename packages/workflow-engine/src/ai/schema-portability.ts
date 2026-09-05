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
 *   `.optional()`, so before validation `restorePortableValue` removes the
 *   `null` values of properties that were optional and not nullable in the
 *   ORIGINAL schema (recursively: nested objects, arrays, union members).
 *   They have no map type either: `z.record` emits `{ type: "object",
 *   propertyNames, additionalProperties: <schema> }`, and strict mode
 *   permits neither `propertyNames` nor a non-`false` `additionalProperties`
 *   (`'propertyNames' is not permitted`). A record is therefore sent as an
 *   array of `{ key, value }` pairs (an enum key constraint is kept on
 *   `key`), and `restorePortableValue` rebuilds the object from the pairs
 *   before validation (last duplicate key wins). Whatever strict mode still
 *   cannot express (`patternProperties`, `if`/`then`/`else`, ...) is
 *   rejected here with `UnportableSchemaError`, naming the JSON path and the
 *   keyword, before any request is sent.
 * - Gemini's `responseSchema` has no `oneOf` either; `@ai-sdk/google`
 *   forwards it verbatim and the API drops the union, so a discriminated
 *   union comes back flat. It handles `anyOf` (including `null` branches),
 *   `const`, `enum` and `$ref` itself, so only the union keyword needs
 *   rewriting on the realtime path. Records are untouched for Google: the
 *   provider's OpenAPI converter expresses `additionalProperties` natively
 *   (verified live in the third consumer round). (The Google *batch* path
 *   substitutes the engine's full OpenAPI conversion at the fetch boundary
 *   instead — see batch/google-json-schema.ts.)
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
  LanguageModelV4StreamPart,
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

/**
 * Thrown by `toPortableJsonSchema(…, "openai")` — and so by every
 * structured-output call and batch submit bound for an OpenAI or OpenRouter
 * model — when the schema uses a keyword OpenAI's strict structured outputs
 * cannot express and the engine has no rewrite for. Raised at the engine
 * boundary, before any request is sent, instead of a provider 400 per item.
 */
export class UnportableSchemaError extends Error {
  readonly name = "UnportableSchemaError";
  constructor(
    readonly target: SchemaTarget,
    /** JSON pointer to the schema node carrying the keyword (`""` = root). */
    readonly path: string,
    readonly keyword: string,
  ) {
    super(
      `Schema keyword "${keyword}" at ${path || "the root"} cannot be expressed ` +
        `for the "${target}" structured-output target (OpenAI strict mode); ` +
        `rewrite that part of the schema before calling the model.`,
    );
  }
}

/**
 * Keywords OpenAI strict structured outputs reject and the engine does not
 * rewrite. `propertyNames` and a schema-valued `additionalProperties` are
 * rewritten (records → pairs) and `oneOf` → `anyOf`, so they are not here.
 */
const OPENAI_UNSUPPORTED_KEYWORDS = new Set([
  "patternProperties",
  "unevaluatedProperties",
  "minProperties",
  "maxProperties",
  "unevaluatedItems",
  "contains",
  "minContains",
  "maxContains",
  "uniqueItems",
  "not",
  "if",
  "then",
  "else",
  "dependentRequired",
  "dependentSchemas",
]);

/** Keys whose values are data, not sub-schemas: copied verbatim. */
const LITERAL_KEYS = new Set([
  "const",
  "enum",
  "default",
  "examples",
  "description",
  "title",
]);

/**
 * Whether `node` is what `z.record` (or `z.partialRecord`) emits: an object
 * schema with no `properties` whose members are described by
 * `additionalProperties` and/or `propertyNames`.
 */
function isRecordSchema(node: JsonNode): boolean {
  return (
    node.type === "object" &&
    !isObject(node.properties) &&
    (isObject(node.additionalProperties) || isObject(node.propertyNames))
  );
}

function escapePointer(segment: string): string {
  return segment.replace(/~/g, "~0").replace(/\//g, "~1");
}

/**
 * OpenAI strict has no map type: a record becomes an array of `{ key, value }`
 * objects. An `enum` on `propertyNames` is kept on `key`; a `required` list
 * (a full record over an enum key) has no array counterpart and is dropped —
 * the caller's Zod schema still enforces it after the inverse transform.
 */
function recordToPairs(node: JsonNode, root: JsonNode, path: string): JsonNode {
  const names = isObject(node.propertyNames) ? node.propertyNames : {};
  const key: JsonNode = { type: "string" };
  if (Array.isArray(names.enum)) key.enum = names.enum;
  const valueSchema = isObject(node.additionalProperties)
    ? node.additionalProperties
    : {};
  const out: JsonNode = {};
  if (typeof node.description === "string") out.description = node.description;
  out.type = "array";
  out.items = {
    type: "object",
    properties: {
      key,
      value: convert(
        valueSchema,
        "openai",
        root,
        `${path}/additionalProperties`,
      ),
    },
    required: ["key", "value"],
    additionalProperties: false,
  };
  return out;
}

function convert(
  node: unknown,
  target: SchemaTarget,
  root: JsonNode,
  path = "",
): unknown {
  if (Array.isArray(node))
    return node.map((item, i) => convert(item, target, root, `${path}/${i}`));
  if (!isObject(node)) return node;
  if (target === "openai") {
    for (const key of Object.keys(node)) {
      if (OPENAI_UNSUPPORTED_KEYWORDS.has(key)) {
        throw new UnportableSchemaError(target, path, key);
      }
    }
    if (isRecordSchema(node)) return recordToPairs(node, root, path);
  }
  const out: JsonNode = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === "oneOf") continue;
    if (target === "openai") {
      if (key === "properties" && isObject(value)) continue;
      // Dropped everywhere: strict mode has no key constraints, and the
      // record case that carries them was rewritten above.
      if (key === "propertyNames") continue;
    }
    out[key] = LITERAL_KEYS.has(key)
      ? value
      : convert(value, target, root, `${path}/${escapePointer(key)}`);
  }
  if (Array.isArray(node.oneOf)) {
    const branches = (node.oneOf as unknown[]).map((b, i) =>
      convert(b, target, root, `${path}/oneOf/${i}`),
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
      const converted = convert(
        prop,
        target,
        root,
        `${path}/properties/${escapePointer(name)}`,
      );
      properties[name] =
        required.has(name) || acceptsNull(prop, root)
          ? converted
          : nullable(converted);
    }
    out.properties = properties;
    out.required = Object.keys(properties);
    // Strict mode admits only `false` here; a catchall schema
    // (`z.looseObject`, `.catchall()`) cannot be expressed and is dropped —
    // the caller's Zod schema still accepts whatever the model adds.
    out.additionalProperties = false;
  }
  return out;
}

/**
 * A JSON Schema (as `z.toJSONSchema` emits it) rewritten for `target`.
 * Never mutates its input. Throws `UnportableSchemaError` for the `openai`
 * target when the schema uses a keyword strict mode cannot express.
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

  // A record: the OpenAI target sent it as `{ key, value }` pairs, so an
  // array reply is rebuilt into the object (last duplicate key wins); an
  // object reply (another target, or a lenient model) keeps its shape.
  // Values are restored either way.
  if (isRecordSchema(schema)) {
    const valueSchema = schema.additionalProperties;
    const restore = (entry: unknown) =>
      isObject(valueSchema) ? stripNode(entry, valueSchema, root) : entry;
    if (Array.isArray(value)) {
      const pairs = value.every(
        (item) => isObject(item) && typeof item.key === "string",
      );
      if (!pairs) return value;
      const out: JsonNode = {};
      for (const item of value as JsonNode[]) {
        out[item.key as string] = restore(item.value);
      }
      return out;
    }
    const out: JsonNode = {};
    for (const [key, entry] of Object.entries(value as JsonNode)) {
      out[key] = restore(entry);
    }
    return out;
  }

  if (Array.isArray(value)) {
    const items = schema.items;
    if (Array.isArray(items)) {
      return value.map((item, i) => stripNode(item, items[i], root));
    }
    if (isObject(items)) {
      return value.map((item) => stripNode(item, items, root));
    }
    // A union: the one branch that describes an array — or a record, which
    // the OpenAI target sent as an array of pairs.
    const branches = [
      ...(Array.isArray(schema.anyOf) ? schema.anyOf : []),
      ...(Array.isArray(schema.oneOf) ? schema.oneOf : []),
    ].filter((b) => {
      if (!isObject(b)) return false;
      const resolved = resolveRef(b, root);
      return resolved.type === "array" || isRecordSchema(resolved);
    });
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
 * `value` (a model's parsed JSON reply) brought back to the shape of the
 * ORIGINAL schema — the one `toPortableJsonSchema(…, "openai")` was fed —
 * so the caller's Zod schema parses it: every `null` is removed where the
 * schema has an optional, non-nullable property, and every record the
 * target received as `{ key, value }` pairs is rebuilt into an object.
 * Nested objects, arrays, union members and `$defs` are covered; a `null`
 * the original schema admits (required or `.nullable()`) is kept. Never
 * mutates its input.
 */
export function restorePortableValue(
  value: unknown,
  jsonSchema: unknown,
): unknown {
  if (!isObject(jsonSchema)) return value;
  return stripNode(value, jsonSchema, jsonSchema);
}

/** The 1.0.0-alpha.4 name of `restorePortableValue`; same function. */
export const stripOptionalNulls = restorePortableValue;

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

/** A JSON text restored to the shape of `original` (see restorePortableValue). */
function restoreJsonText(text: string, original: unknown): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return text;
  }
  const restored = restorePortableValue(parsed, original);
  return restored === parsed ? text : JSON.stringify(restored);
}

/**
 * Wrap a language model so every JSON `responseFormat` it receives carries
 * the portable schema for `target`, and (OpenAI) so a generated reply is
 * restored to the original schema's shape — optional-property nulls
 * removed, record pairs rebuilt — before the AI SDK validates it against
 * the original schema. Returns the model unchanged when no rewrite applies.
 * A streamed JSON reply is restored too: its text deltas are buffered per
 * text part and emitted as one delta at `text-end`, since the rewrite needs
 * the whole document (the engine's own `streamText` has no structured
 * output, so only a direct `streamText` + `Output.object` on the wrapped
 * model sees this).
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
            ? { ...part, text: restoreJsonText(part.text, original) }
            : part,
        );
        return { ...result, content };
      },
      async wrapStream({ params, model: inner }) {
        const { params: sent, original } = prepare(params);
        const result = await inner.doStream(sent);
        if (target !== "openai" || original === undefined) return result;
        const buffered = new Map<string, string>();
        const emit = (
          controller: TransformStreamDefaultController<LanguageModelV4StreamPart>,
          id: string,
        ) => {
          const text = buffered.get(id);
          buffered.delete(id);
          if (text !== undefined) {
            controller.enqueue({
              type: "text-delta",
              id,
              delta: restoreJsonText(text, original),
            });
          }
        };
        const stream = result.stream.pipeThrough(
          new TransformStream<
            LanguageModelV4StreamPart,
            LanguageModelV4StreamPart
          >({
            transform(part, controller) {
              if (part.type === "text-delta") {
                buffered.set(
                  part.id,
                  (buffered.get(part.id) ?? "") + part.delta,
                );
                return;
              }
              if (part.type === "text-end") emit(controller, part.id);
              controller.enqueue(part);
            },
            flush(controller) {
              for (const id of [...buffered.keys()]) emit(controller, id);
            },
          }),
        );
        return { ...result, stream };
      },
    },
  });
}
