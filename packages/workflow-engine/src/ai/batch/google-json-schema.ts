/**
 * Google batch structured output.
 *
 * Gemini's `batchGenerateContent` endpoint does not honour
 * `generationConfig.responseJsonSchema` (the full JSON Schema the realtime
 * `generateContent` endpoint accepts): probed live against
 * `gemini-3.1-flash-lite-preview`, a small schema is accepted and silently
 * ignored (the reply does not follow it) and a schema of the size a real
 * stage sends is rejected per request with `code 3 "Request contains an
 * invalid argument"`. The only structured-output mode the batch endpoint
 * enforces is the OpenAPI-style `generationConfig.responseSchema`.
 *
 * `@ai-sdk/google` (4.x, checked up to 4.0.63) derives that schema with
 * `convertJSONSchemaToOpenAPISchema`, which forwards `oneOf` — a keyword
 * Gemini's `Schema` does not have (it only knows `anyOf`) — so a
 * discriminated union (zod's `z.discriminatedUnion` emits `oneOf`) is
 * dropped by the API and the model emits a flat object where the union was
 * required; it also drops `minItems`/`maxItems`. The engine therefore
 * converts the JSON Schema itself (`toGeminiResponseSchema`): `oneOf` and
 * `anyOf` become `anyOf`, `const` becomes a one-value `enum`, a `null`
 * branch becomes `nullable`, `$ref`s into `$defs` are inlined, the array
 * bounds are kept, and every keyword Gemini rejects is dropped. Verified
 * live: a 7 KB schema with two nested discriminated unions and sixteen
 * nullable fields returns output that validates against the original
 * JSON Schema.
 *
 * The provider offers no hook for the schema it sends, so the engine
 * rewrites the inline `:batchGenerateContent` request body at the `fetch`
 * boundary: every inlined request is keyed by `metadata.key` (the engine's
 * request id), and the engine knows the schema for that id.
 */

import type { z } from "zod";
import { toJsonSchema } from "./model";

export type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

type JsonSchemaNode = Record<string, unknown>;
type GeminiSchema = Record<string, unknown>;

const STRING_FORMATS: ReadonlySet<string> = new Set(["date-time"]);
const NUMBER_FORMATS: ReadonlySet<string> = new Set(["float", "double"]);
const INTEGER_FORMATS: ReadonlySet<string> = new Set(["int32", "int64"]);
const PASSTHROUGH_KEYWORDS = [
  "minItems",
  "maxItems",
  "minimum",
  "maximum",
  "minLength",
  "maxLength",
  "pattern",
] as const;

function isNullBranch(branch: unknown): boolean {
  return (
    typeof branch === "object" &&
    branch !== null &&
    (branch as JsonSchemaNode).type === "null"
  );
}

/**
 * Convert a JSON Schema (as `z.toJSONSchema` emits it) into the OpenAPI
 * `Schema` Gemini's `responseSchema` accepts, keeping unions, enums,
 * nullability and array bounds.
 *
 * Throws on a `$ref` that is not a direct child of the root `$defs` /
 * `definitions`, or that is recursive: Gemini's schema cannot express
 * either.
 */
export function toGeminiResponseSchema(jsonSchema: unknown): GeminiSchema {
  const root =
    typeof jsonSchema === "object" && jsonSchema !== null
      ? (jsonSchema as JsonSchemaNode)
      : {};
  const defs: Record<string, unknown> = {
    ...((root.definitions as Record<string, unknown> | undefined) ?? {}),
    ...((root.$defs as Record<string, unknown> | undefined) ?? {}),
  };
  const resolving = new Set<string>();

  function convert(input: unknown): GeminiSchema {
    if (typeof input !== "object" || input === null) {
      return { type: "object", properties: {} };
    }
    const node = input as JsonSchemaNode;

    if (typeof node.$ref === "string") {
      const match = /^#\/(?:\$defs|definitions)\/([^/]+)$/.exec(node.$ref);
      const name = match ? decodeURIComponent(match[1]!) : undefined;
      if (name === undefined || !(name in defs)) {
        throw new Error(
          `Gemini response schemas only support references to root-level $defs; got ${node.$ref}`,
        );
      }
      if (resolving.has(name)) {
        throw new Error(
          `Gemini response schemas cannot express the recursive reference ${node.$ref}`,
        );
      }
      resolving.add(name);
      try {
        const { $ref: _ref, ...siblings } = node;
        return convert({ ...(defs[name] as JsonSchemaNode), ...siblings });
      } finally {
        resolving.delete(name);
      }
    }

    const out: GeminiSchema = {};
    let nullable = false;
    let type: unknown = node.type;

    if (Array.isArray(type)) {
      nullable = type.includes("null");
      const rest = type.filter((t) => t !== "null");
      if (rest.length === 1) {
        type = rest[0];
      } else if (rest.length === 0) {
        type = "null";
      } else {
        out.anyOf = rest.map((t) => ({ type: t }));
        type = undefined;
      }
    }

    const union = (node.anyOf ?? node.oneOf) as unknown[] | undefined;
    if (Array.isArray(union)) {
      const branches = union.filter((b) => !isNullBranch(b));
      if (branches.length < union.length) nullable = true;
      if (branches.length === 1) {
        Object.assign(out, convert(branches[0]));
      } else if (branches.length > 1) {
        out.anyOf = branches.map(convert);
      }
    }

    if (Array.isArray(node.allOf)) {
      // Gemini has no allOf: merge object branches (zod intersections).
      for (const branch of node.allOf) {
        const converted = convert(branch);
        for (const [key, value] of Object.entries(converted)) {
          if (key === "properties") {
            out.properties = {
              ...((out.properties as Record<string, unknown>) ?? {}),
              ...(value as Record<string, unknown>),
            };
          } else if (key === "required") {
            out.required = [
              ...((out.required as string[]) ?? []),
              ...(value as string[]),
            ];
          } else {
            out[key] = value;
          }
        }
      }
    }

    if (
      type !== undefined &&
      out.type === undefined &&
      out.anyOf === undefined
    ) {
      out.type = type;
    }
    if (typeof node.description === "string") {
      out.description = node.description;
    }

    const enumValues =
      (node.enum as unknown[] | undefined) ??
      (node.const !== undefined ? [node.const] : undefined);
    if (Array.isArray(enumValues)) {
      const values = enumValues.filter((v) => v !== null);
      if (values.length < enumValues.length) nullable = true;
      if (values.length > 0) {
        out.enum = values.map(String);
        if (out.type === undefined) {
          const first = values[0];
          out.type =
            typeof first === "number"
              ? "number"
              : typeof first === "boolean"
                ? "boolean"
                : "string";
        }
        if (out.type !== "string") out.format = "enum";
      }
    }

    if (typeof node.properties === "object" && node.properties !== null) {
      const properties: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(
        node.properties as Record<string, unknown>,
      )) {
        properties[key] = convert(value);
      }
      out.properties = properties;
      if (out.type === undefined) out.type = "object";
    }
    if (Array.isArray(node.required) && node.required.length > 0) {
      out.required = node.required;
    }
    if (
      node.items !== undefined &&
      !Array.isArray(node.items) &&
      typeof node.items === "object"
    ) {
      out.items = convert(node.items);
      if (out.type === undefined) out.type = "array";
    }
    for (const keyword of PASSTHROUGH_KEYWORDS) {
      if (node[keyword] !== undefined) out[keyword] = node[keyword];
    }
    if (typeof node.format === "string" && out.format === undefined) {
      const format = node.format;
      if (
        (out.type === "string" && STRING_FORMATS.has(format)) ||
        (out.type === "number" && NUMBER_FORMATS.has(format)) ||
        (out.type === "integer" && INTEGER_FORMATS.has(format))
      ) {
        out.format = format;
      }
    }
    if (nullable) out.nullable = true;
    if (
      out.type === "object" &&
      out.properties === undefined &&
      out.anyOf === undefined
    ) {
      out.properties = {};
    }
    return out;
  }

  return convert(root);
}

/** Gemini `responseSchema` for a Zod schema. */
export function toGoogleResponseSchema(
  schema: z.ZodTypeAny,
): Record<string, unknown> {
  return toGeminiResponseSchema(toJsonSchema(schema));
}

interface InlinedRequest {
  request?: {
    generationConfig?: Record<string, unknown>;
    [key: string]: unknown;
  };
  metadata?: { key?: string };
}

/**
 * Replace `generationConfig.responseSchema` with the engine's conversion
 * for every inlined request whose key the engine knows. Returns the number
 * of requests rewritten.
 */
export function rewriteGoogleBatchBody(
  body: unknown,
  schemasByKey: ReadonlyMap<string, Record<string, unknown>>,
): number {
  const requests = (
    body as {
      batch?: { inputConfig?: { requests?: { requests?: InlinedRequest[] } } };
    }
  )?.batch?.inputConfig?.requests?.requests;
  if (!Array.isArray(requests)) return 0;
  let rewritten = 0;
  for (const entry of requests) {
    const key = entry?.metadata?.key;
    const config = entry?.request?.generationConfig;
    if (!key || !config) continue;
    const responseSchema = schemasByKey.get(key);
    if (!responseSchema) continue;
    delete config.responseJsonSchema;
    config.responseMimeType = "application/json";
    config.responseSchema = responseSchema;
    rewritten++;
  }
  return rewritten;
}

/**
 * Wrap a fetch so inline Google batch submissions carry the engine's
 * `responseSchema`. Requests that are not inline batch creations pass
 * through untouched; a batch too large to inline (Google's 20 MB limit,
 * which the engine's `maxRequestsPerBatch` partitioning normally keeps well
 * clear of) is uploaded as a file and cannot be rewritten — `onFileUpload`
 * is invoked so the caller can warn that union schemas may be lossy there.
 */
export function createGoogleBatchFetch(
  base: FetchLike | undefined,
  schemasByKey: ReadonlyMap<string, Record<string, unknown>>,
  onFileUpload?: () => void,
  /**
   * Rewrites the creation body in place (the engine stamps the durable
   * step's external key over the SDK's generated `batch.displayName`, which
   * is what makes a crashed Google submit recoverable) and reports whether
   * it changed anything. Applies to both the inline and the file-upload
   * creation, which send the same `batch` envelope.
   */
  stampBody?: (body: unknown) => boolean,
): FetchLike {
  const underlying: FetchLike = base ?? ((input, init) => fetch(input, init));
  return async (input, init) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    if (
      !url.includes(":batchGenerateContent") ||
      (schemasByKey.size === 0 && stampBody === undefined) ||
      typeof init?.body !== "string"
    ) {
      return underlying(input, init);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(init.body);
    } catch {
      return underlying(input, init);
    }
    let changed = stampBody?.(parsed) === true;
    const body = parsed as {
      batch?: { inputConfig?: { fileName?: string } };
    };
    if (body?.batch?.inputConfig?.fileName !== undefined) {
      onFileUpload?.();
    } else if (
      schemasByKey.size > 0 &&
      rewriteGoogleBatchBody(parsed, schemasByKey) > 0
    ) {
      changed = true;
    }
    if (!changed) return underlying(input, init);
    return underlying(input, { ...init, body: JSON.stringify(parsed) });
  };
}
