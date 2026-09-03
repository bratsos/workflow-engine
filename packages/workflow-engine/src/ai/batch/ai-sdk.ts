import type {
  Experimental_BatchModelV4,
  Experimental_BatchV4ItemResult,
  Experimental_BatchV4StartOptions,
  Experimental_BatchV4Status,
  Experimental_LanguageModelV4BatchRequest,
  JSONSchema7,
  LanguageModelV4CallOptions,
  LanguageModelV4GenerateResult,
  LanguageModelV4Prompt,
  LanguageModelV4Text,
} from "@ai-sdk/provider";
import {
  createGoogleBatchFetch,
  type FetchLike,
  toGoogleResponseSchema,
} from "./google-json-schema";
import {
  type EngineBatchItemResult,
  type EngineBatchModel,
  type EngineBatchRef,
  type EngineBatchRequest,
  type EngineBatchStatus,
  toJsonSchema,
} from "./model";

function isBatchModel(
  m: unknown,
): m is Experimental_BatchModelV4<
  Experimental_LanguageModelV4BatchRequest,
  LanguageModelV4GenerateResult
> {
  return (
    typeof m === "object" &&
    m !== null &&
    "experimental_doStartBatch" in m &&
    typeof (m as any).experimental_doStartBatch === "function" &&
    "experimental_doGetBatchStatus" in m &&
    typeof (m as any).experimental_doGetBatchStatus === "function" &&
    "experimental_doGetBatchResults" in m &&
    typeof (m as any).experimental_doGetBatchResults === "function"
  );
}

function mapAiSdkStatus(
  status: Experimental_BatchV4Status["status"],
): EngineBatchStatus["status"] {
  switch (status) {
    case "pending":
      return "pending";
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    default:
      return "failed";
  }
}

function mapRequestCounts(
  counts: Experimental_BatchV4Status["requestCounts"],
): EngineBatchStatus["requestCounts"] {
  if (!counts) return undefined;
  return {
    total: counts.total,
    pending: counts.pending,
    completed: counts.completed,
    failed: counts.failed,
  };
}

function buildPrompt(req: EngineBatchRequest): LanguageModelV4Prompt {
  const prompt: LanguageModelV4Prompt = [];
  if (req.system && req.system.trim().length > 0) {
    prompt.push({
      role: "system",
      content: req.system,
    });
  }
  prompt.push({
    role: "user",
    content: [
      {
        type: "text",
        text: req.prompt,
      },
    ],
  });
  return prompt;
}

/**
 * Iterate a ReadableStream without buffering it.
 *
 * Uses the reader API rather than `for await`: async iteration on
 * ReadableStream is available in Node but is still not universal across the
 * runtimes this package targets (workerd, browsers), whereas `getReader()` is.
 */
async function* readableStreamToAsyncIterable<T>(
  stream: ReadableStream<T>,
): AsyncIterable<T> {
  const reader = stream.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      yield value;
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // Ignore cancellation error if stream is already closed/errored
    }
    reader.releaseLock();
  }
}

/**
 * Creates an EngineBatchModel adapter wrapping an AI SDK model implementing Experimental_BatchLanguageModelV4.
 */
export function fromAiSdk(
  model: unknown,
  opts: { provider: string; modelId: string },
): EngineBatchModel {
  if (!isBatchModel(model)) {
    throw new Error(
      `Model "${opts.provider}:${opts.modelId}" is not batch-capable (missing experimental_doStartBatch, experimental_doGetBatchStatus, or experimental_doGetBatchResults). ` +
        `If using OpenAI, note that openai.chat() is not batch-capable; use openai() or openai.responses() instead.`,
    );
  }

  const batchModel = model;

  return {
    provider: opts.provider,
    modelId: opts.modelId,

    async start(
      requests: EngineBatchRequest[],
      callOpts?: {
        abortSignal?: AbortSignal;
        headers?: Record<string, string>;
      },
    ): Promise<EngineBatchRef & EngineBatchStatus> {
      const batchRequests: Experimental_LanguageModelV4BatchRequest[] =
        requests.map((req) => {
          let responseFormat:
            | LanguageModelV4CallOptions["responseFormat"]
            | undefined;
          if (req.schema) {
            responseFormat = {
              type: "json",
              schema: toJsonSchema(req.schema) as JSONSchema7,
            };
          }

          return {
            id: req.id,
            options: {
              prompt: buildPrompt(req),
              ...(req.maxOutputTokens !== undefined
                ? { maxOutputTokens: req.maxOutputTokens }
                : {}),
              ...(req.temperature !== undefined
                ? { temperature: req.temperature }
                : {}),
              ...(responseFormat ? { responseFormat } : {}),
            },
          };
        });

      const startOptions: Experimental_BatchV4StartOptions<Experimental_LanguageModelV4BatchRequest> =
        {
          requests: batchRequests,
          abortSignal: callOpts?.abortSignal,
          headers: callOpts?.headers,
        };

      const startResult =
        await batchModel.experimental_doStartBatch(startOptions);

      const ref: EngineBatchRef = {
        version: 1,
        type: "text",
        id: startResult.batchId,
        provider: opts.provider,
        modelId: opts.modelId,
      };

      return {
        ...ref,
        status: mapAiSdkStatus(startResult.status),
        rawStatus: startResult.rawStatus,
        requestCounts: mapRequestCounts(startResult.requestCounts),
        error: startResult.error?.message,
      };
    },

    async status(
      ref: EngineBatchRef,
      callOpts?: {
        abortSignal?: AbortSignal;
        headers?: Record<string, string>;
      },
    ): Promise<EngineBatchStatus> {
      const res = await batchModel.experimental_doGetBatchStatus({
        batchId: ref.id,
        abortSignal: callOpts?.abortSignal,
        headers: callOpts?.headers,
      } as any);

      return {
        status: mapAiSdkStatus(res.status),
        rawStatus: res.rawStatus,
        requestCounts: mapRequestCounts(res.requestCounts),
        error: res.error?.message,
      };
    },

    async *results(
      ref: EngineBatchRef,
      callOpts?: {
        abortSignal?: AbortSignal;
        headers?: Record<string, string>;
      },
    ): AsyncIterable<EngineBatchItemResult> {
      const stream = await batchModel.experimental_doGetBatchResults({
        batchId: ref.id,
        abortSignal: callOpts?.abortSignal,
        headers: callOpts?.headers,
      } as any);

      for await (const item of readableStreamToAsyncIterable(
        stream as ReadableStream<
          Experimental_BatchV4ItemResult<LanguageModelV4GenerateResult>
        >,
      )) {
        if (item.status === "succeeded") {
          const textParts = (item.result.content ?? []).filter(
            (part): part is LanguageModelV4Text => part.type === "text",
          );
          const text = textParts.map((p) => p.text).join("");
          const inputTokens = item.result.usage?.inputTokens?.total ?? 0;
          const outputTokens = item.result.usage?.outputTokens?.total ?? 0;
          yield {
            id: item.id,
            status: "succeeded",
            text,
            inputTokens,
            outputTokens,
          };
        } else {
          yield {
            id: item.id,
            status: item.status,
            error: item.error?.message,
          };
        }
      }
    },
  };
}

/** Credentials and transport for a vendor batch model (from `BatchOptions`). */
export interface AiSdkBatchModelOptions {
  apiKey?: string;
  baseURL?: string;
  fetch?: FetchLike;
  /** Receives a diagnostic the engine cannot act on (e.g. a lossy upload). */
  onWarning?: (message: string) => void;
}

/**
 * Google: the batch endpoint only enforces the OpenAPI `responseSchema`,
 * and the provider's conversion to it loses unions, so the engine's own
 * union-preserving conversion is substituted into the inline batch body at
 * the fetch boundary — see google-json-schema.ts.
 */
async function resolveGoogleBatchModel(
  modelId: string,
  options: AiSdkBatchModelOptions,
): Promise<EngineBatchModel> {
  const { createGoogleGenerativeAI } = await import("@ai-sdk/google");
  const schemasByKey = new Map<string, Record<string, unknown>>();
  let warnedFileUpload = false;
  const provider = createGoogleGenerativeAI({
    ...(options.apiKey !== undefined ? { apiKey: options.apiKey } : {}),
    ...(options.baseURL !== undefined ? { baseURL: options.baseURL } : {}),
    fetch: createGoogleBatchFetch(options.fetch, schemasByKey, () => {
      if (warnedFileUpload) return;
      warnedFileUpload = true;
      options.onWarning?.(
        "Google batch was too large to submit inline and was uploaded as a file; " +
          "the provider's OpenAPI responseSchema is used there, which cannot express " +
          "nested unions. Lower maxRequestsPerBatch to keep submissions inline.",
      );
    }) as typeof fetch,
  });
  const model = provider(modelId);
  const providerId = (model as any).provider ?? "google.generative-ai";
  const inner = fromAiSdk(model, { provider: providerId, modelId });
  return {
    ...inner,
    async start(requests, callOpts) {
      const keys: string[] = [];
      for (const req of requests) {
        if (!req.schema) continue;
        schemasByKey.set(req.id, toGoogleResponseSchema(req.schema));
        keys.push(req.id);
      }
      try {
        return await inner.start(requests, callOpts);
      } finally {
        for (const key of keys) schemasByKey.delete(key);
      }
    },
  };
}

/**
 * Whether a dynamic `import()` of `pkgName` failed because the package is
 * not installed. Node reports `ERR_MODULE_NOT_FOUND` / "Cannot find
 * package"; Vite reports "Failed to load url"; workerd (Cloudflare
 * Workers) throws `No such module "<pkg>".` with no code. Any import
 * failure that names the package counts, so the caller can fall back
 * instead of failing the submit.
 */
export function isMissingPackageError(err: unknown, pkgName: string): boolean {
  if (!(err instanceof Error)) return false;
  if (
    "code" in err &&
    (err as { code?: unknown }).code === "ERR_MODULE_NOT_FOUND"
  )
    return true;
  const message = err.message;
  return (
    message.includes("Cannot find package") ||
    message.includes("Cannot find module") ||
    message.includes("Failed to load url") ||
    message.includes("No such module") ||
    message.includes(pkgName)
  );
}

/**
 * Resolves an AI SDK batch model dynamically using lazy imports for optional peer dependencies.
 */
export async function resolveAiSdkBatchModel(
  vendor: "google" | "anthropic" | "openai",
  modelId: string,
  options: AiSdkBatchModelOptions = {},
): Promise<EngineBatchModel> {
  const credentials = {
    ...(options.apiKey !== undefined ? { apiKey: options.apiKey } : {}),
    ...(options.baseURL !== undefined ? { baseURL: options.baseURL } : {}),
    ...(options.fetch !== undefined
      ? { fetch: options.fetch as typeof fetch }
      : {}),
  };
  try {
    if (vendor === "google") {
      return await resolveGoogleBatchModel(modelId, options);
    }
    if (vendor === "anthropic") {
      const { createAnthropic } = await import("@ai-sdk/anthropic");
      const model = createAnthropic(credentials)(modelId);
      const providerId = (model as any).provider ?? "anthropic.messages";
      return fromAiSdk(model, { provider: providerId, modelId });
    }
    if (vendor === "openai") {
      const { createOpenAI } = await import("@ai-sdk/openai");
      // For OpenAI use the default callable / .responses(), NEVER .chat()
      const model = createOpenAI(credentials)(modelId);
      const providerId = (model as any).provider ?? "openai.responses";
      return fromAiSdk(model, { provider: providerId, modelId });
    }
    const _exhaustive: never = vendor;
    throw new Error(`Unsupported vendor: ${_exhaustive}`);
  } catch (err: unknown) {
    const pkgName =
      vendor === "google"
        ? "@ai-sdk/google"
        : vendor === "anthropic"
          ? "@ai-sdk/anthropic"
          : "@ai-sdk/openai";
    if (isMissingPackageError(err, pkgName)) {
      const causeMsg = err instanceof Error ? `: ${err.message}` : "";
      throw new Error(
        `Package "${pkgName}" is required to use vendor "${vendor}". Please install ${pkgName}${causeMsg}.`,
      );
    }
    throw err;
  }
}
