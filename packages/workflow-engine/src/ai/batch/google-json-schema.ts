/**
 * Google batch structured output.
 *
 * `@ai-sdk/google` (4.x, checked up to 4.0.63) can only express a response
 * schema as Gemini's OpenAPI-style `generationConfig.responseSchema`, which
 * it derives with `convertJSONSchemaToOpenAPISchema` — a lossy conversion
 * for nested discriminated unions (the model then emits `null`/strings
 * where an object was required). Gemini's API also accepts
 * `generationConfig.responseJsonSchema`, a full JSON Schema, which is what
 * the 0.13 batch helper sent through `@google/genai`.
 *
 * The provider offers no option for `responseJsonSchema`, so the engine
 * rewrites the inline `:batchGenerateContent` request body at the `fetch`
 * boundary: every inlined request is keyed by `metadata.key` (the engine's
 * request id), and the engine knows the full JSON Schema for that id.
 */

import type { z } from "zod";
import { toJsonSchema } from "./model";

export type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

/** JSON Schema for Gemini's `responseJsonSchema`: `$schema` is not needed. */
export function toGoogleJsonSchema(
  schema: z.ZodTypeAny,
): Record<string, unknown> {
  const { $schema: _omit, ...rest } = toJsonSchema(schema);
  return rest;
}

interface InlinedRequest {
  request?: {
    generationConfig?: Record<string, unknown>;
    [key: string]: unknown;
  };
  metadata?: { key?: string };
}

/**
 * Replace `generationConfig.responseSchema` with the full JSON Schema for
 * every inlined request whose key the engine knows. Returns the number of
 * requests rewritten.
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
    const jsonSchema = schemasByKey.get(key);
    if (!jsonSchema) continue;
    delete config.responseSchema;
    config.responseMimeType = "application/json";
    config.responseJsonSchema = jsonSchema;
    rewritten++;
  }
  return rewritten;
}

/**
 * Wrap a fetch so inline Google batch submissions carry the full JSON
 * Schema. Requests that are not inline batch creations pass through
 * untouched; a batch too large to inline (Google's 20 MB limit, which the
 * engine's `maxRequestsPerBatch` partitioning normally keeps well clear
 * of) is uploaded as a file and cannot be rewritten — `onFileUpload` is
 * invoked so the caller can warn that union schemas may be lossy there.
 */
export function createGoogleBatchFetch(
  base: FetchLike | undefined,
  schemasByKey: ReadonlyMap<string, Record<string, unknown>>,
  onFileUpload?: () => void,
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
      schemasByKey.size === 0 ||
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
    const body = parsed as {
      batch?: { inputConfig?: { fileName?: string } };
    };
    if (body?.batch?.inputConfig?.fileName !== undefined) {
      onFileUpload?.();
      return underlying(input, init);
    }
    if (rewriteGoogleBatchBody(parsed, schemasByKey) === 0) {
      return underlying(input, init);
    }
    return underlying(input, { ...init, body: JSON.stringify(parsed) });
  };
}
