import type {
  JSONSchema7,
  LanguageModelV4CallOptions,
  LanguageModelV4GenerateResult,
  LanguageModelV4Prompt,
  LanguageModelV4Text,
  SharedV4ProviderMetadata,
  SharedV4ProviderOptions,
  SharedV4Warning,
} from "@ai-sdk/provider";
import { toPortableJsonSchema } from "../schema-portability";
import {
  adoptedRef,
  adoptGoogleBatch,
  adoptOpenAIBatch,
  createGoogleDisplayNameStamp,
  createOpenAIBatchFetch,
} from "./adoption";
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
  type EngineBatchStartOptions,
  type EngineBatchStatus,
  toJsonSchema,
} from "./model";

// ---------------------------------------------------------------------------
// The per-model batch seam this transport calls.
//
// These mirror the experimental types `@ai-sdk/provider` 4.0.9 exported
// (`Experimental_BatchModelV4` and friends): the vendor SDKs this transport
// supports put `experimental_doStartBatch` / `doGetBatchStatus` /
// `doGetBatchResults` on the language model. Later `@ai-sdk/provider`
// releases replaced that seam with a provider-level one and dropped these
// exports, so the engine declares the shapes it calls rather than importing
// experimental types that no longer exist. Detection stays structural
// (`isBatchModel`), exactly as before.
// ---------------------------------------------------------------------------

export type BatchError = {
  readonly message: string;
  readonly type?: string;
  readonly code?: string;
  readonly statusCode?: number;
};

export type BatchStatus = {
  readonly status: "pending" | "completed" | "failed";
  readonly rawStatus?: string;
  readonly requestCounts?: {
    readonly total: number;
    readonly pending: number;
    readonly completed: number;
    readonly failed: number;
  };
  readonly error?: BatchError;
  readonly createdAt?: string;
  readonly expiresAt?: string;
  readonly providerMetadata?: SharedV4ProviderMetadata;
};

export type BatchStartResult = BatchStatus & {
  readonly batchId: string;
  readonly warnings: Array<{
    readonly requestId?: string;
    readonly warning: SharedV4Warning;
  }>;
};

export type BatchStartOptions<REQUEST> = {
  readonly requests: ReadonlyArray<REQUEST>;
  readonly providerOptions?: SharedV4ProviderOptions;
  readonly abortSignal?: AbortSignal;
  readonly headers?: Record<string, string | undefined>;
  readonly webhookUrl?: string;
};

export type BatchOperationOptions = {
  readonly batchId: string;
  readonly providerOptions?: SharedV4ProviderOptions;
  readonly abortSignal?: AbortSignal;
  readonly headers?: Record<string, string | undefined>;
};

export type BatchItemResult<RESULT> =
  | {
      readonly id: string;
      readonly status: "succeeded";
      readonly result: RESULT;
    }
  | {
      readonly id: string;
      readonly status: "failed";
      readonly error: BatchError;
      readonly providerMetadata?: SharedV4ProviderMetadata;
    }
  | {
      readonly id: string;
      readonly status: "cancelled" | "expired";
      readonly error?: BatchError;
      readonly providerMetadata?: SharedV4ProviderMetadata;
    };

export type LanguageModelBatchRequest = {
  readonly id: string;
  readonly options: Pick<
    LanguageModelV4CallOptions,
    | "prompt"
    | "maxOutputTokens"
    | "temperature"
    | "stopSequences"
    | "topP"
    | "topK"
    | "presencePenalty"
    | "frequencyPenalty"
    | "seed"
    | "reasoning"
    | "responseFormat"
    | "toolChoice"
    | "tools"
    | "providerOptions"
  >;
};

export type BatchLanguageModel = {
  experimental_doStartBatch(
    options: BatchStartOptions<LanguageModelBatchRequest>,
  ): PromiseLike<BatchStartResult>;
  experimental_doGetBatchStatus(
    options: BatchOperationOptions,
  ): PromiseLike<BatchStatus>;
  experimental_doGetBatchResults(
    options: BatchOperationOptions,
  ): PromiseLike<
    ReadableStream<BatchItemResult<LanguageModelV4GenerateResult>>
  >;
};

// ---------------------------------------------------------------------------
// The provider-level batch seam.
//
// Newer vendor releases (`@ai-sdk/google` 4.0.65+, and the current
// `@ai-sdk/openai` / `@ai-sdk/anthropic`) moved batching off the language
// model onto the provider: `provider.experimental_batch()` returns one batch
// object whose requests each name their `modelId` and `type`. The HTTP calls
// underneath are unchanged, so the engine's fetch-level hooks (Google schema
// substitution and display-name stamp, OpenAI metadata stamp) apply to both.
// A vendor release is driven through whichever seam it exposes.
// ---------------------------------------------------------------------------

export type ProviderTextBatchRequest = LanguageModelBatchRequest & {
  readonly type: "text";
  readonly modelId: string;
};

export type ProviderBatchItemResult = {
  readonly type?: "text" | "image";
} & BatchItemResult<LanguageModelV4GenerateResult>;

export type ProviderBatch = {
  readonly provider?: string;
  doStartBatch(
    options: BatchStartOptions<ProviderTextBatchRequest>,
  ): PromiseLike<BatchStartResult>;
  doGetBatchStatus(options: BatchOperationOptions): PromiseLike<BatchStatus>;
  doGetBatchResults(
    options: BatchOperationOptions,
  ): PromiseLike<ReadableStream<ProviderBatchItemResult>>;
};

function isProviderBatch(b: unknown): b is ProviderBatch {
  return (
    typeof b === "object" &&
    b !== null &&
    typeof (b as { doStartBatch?: unknown }).doStartBatch === "function" &&
    typeof (b as { doGetBatchStatus?: unknown }).doGetBatchStatus ===
      "function" &&
    typeof (b as { doGetBatchResults?: unknown }).doGetBatchResults ===
      "function"
  );
}

/**
 * Thrown when a vendor model exposes neither batch seam. The batch helper
 * falls back to the OpenRouter transport on it when OpenRouter can batch the
 * model, the same way it does when the vendor package is not installed.
 */
export class NotBatchCapableError extends Error {
  readonly provider: string;
  readonly modelId: string;

  constructor(provider: string, modelId: string) {
    super(
      `Model "${provider}:${modelId}" is not batch-capable: the vendor SDK exposes neither ` +
        `provider.experimental_batch() nor the per-model experimental_doStartBatch / ` +
        `experimental_doGetBatchStatus / experimental_doGetBatchResults. ` +
        `If using OpenAI, note that openai.chat() is not batch-capable; use openai() or openai.responses() instead.`,
    );
    this.name = "NotBatchCapableError";
    this.provider = provider;
    this.modelId = modelId;
  }
}

/** Detect `NotBatchCapableError` across duplicated package bundles. */
export function isNotBatchCapableError(
  error: unknown,
): error is NotBatchCapableError {
  return error instanceof Error && error.name === "NotBatchCapableError";
}

function isBatchModel(m: unknown): m is BatchLanguageModel {
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
  status: BatchStatus["status"],
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
  counts: BatchStatus["requestCounts"],
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

/** The three operations either seam provides, normalised to one shape. */
interface BatchSeamOps {
  start(
    requests: LanguageModelBatchRequest[],
    callOpts: { abortSignal?: AbortSignal; headers?: Record<string, string> },
  ): PromiseLike<BatchStartResult>;
  status(options: BatchOperationOptions): PromiseLike<BatchStatus>;
  results(
    options: BatchOperationOptions,
  ): PromiseLike<
    ReadableStream<BatchItemResult<LanguageModelV4GenerateResult>>
  >;
}

/**
 * Creates an EngineBatchModel adapter wrapping an AI SDK model that implements
 * the per-model batch seam (`BatchLanguageModel` above).
 */
export function fromAiSdk(
  model: unknown,
  opts: { provider: string; modelId: string },
): EngineBatchModel {
  if (!isBatchModel(model)) {
    throw new NotBatchCapableError(opts.provider, opts.modelId);
  }
  const batchModel = model;
  return buildEngineBatchModel(
    {
      start: (requests, callOpts) =>
        batchModel.experimental_doStartBatch({ requests, ...callOpts }),
      status: (options) => batchModel.experimental_doGetBatchStatus(options),
      results: (options) => batchModel.experimental_doGetBatchResults(options),
    },
    opts,
  );
}

/**
 * Creates an EngineBatchModel adapter wrapping a provider-level AI SDK batch
 * (`provider.experimental_batch()`, see `ProviderBatch` above). Every request
 * is sent as a `text` request for `opts.modelId`.
 */
export function fromAiSdkProviderBatch(
  batch: unknown,
  opts: { provider: string; modelId: string },
): EngineBatchModel {
  if (!isProviderBatch(batch)) {
    throw new NotBatchCapableError(opts.provider, opts.modelId);
  }
  return buildEngineBatchModel(
    {
      start: (requests, callOpts) =>
        batch.doStartBatch({
          requests: requests.map((request) => ({
            ...request,
            type: "text" as const,
            modelId: opts.modelId,
          })),
          ...callOpts,
        }),
      status: (options) => batch.doGetBatchStatus(options),
      results: (options) => batch.doGetBatchResults(options),
    },
    opts,
  );
}

/**
 * The engine batch model for a vendor provider instance: its provider-level
 * batch when the release exposes one, else the language model's per-model
 * seam. Throws `NotBatchCapableError` when it has neither.
 */
export function fromAiSdkProvider(
  provider: unknown,
  opts: { provider: string; modelId: string },
): EngineBatchModel {
  const factory = (provider as { experimental_batch?: unknown })
    .experimental_batch;
  if (typeof factory === "function") {
    return fromAiSdkProviderBatch(factory.call(provider), opts);
  }
  return fromAiSdk((provider as (id: string) => unknown)(opts.modelId), opts);
}

function buildEngineBatchModel(
  seam: BatchSeamOps,
  opts: { provider: string; modelId: string },
): EngineBatchModel {
  return {
    provider: opts.provider,
    modelId: opts.modelId,
    // Overridden by the vendor wrappers below where the provider offers a
    // searchable field. Plain AI SDK transports (Anthropic Message Batches)
    // have none, so a crashed submit there is not recoverable.
    recovery: "none" as const,

    async start(
      requests: EngineBatchRequest[],
      callOpts?: EngineBatchStartOptions,
    ): Promise<EngineBatchRef & EngineBatchStatus> {
      const batchRequests: LanguageModelBatchRequest[] = requests.map((req) => {
        let responseFormat:
          | LanguageModelV4CallOptions["responseFormat"]
          | undefined;
        if (req.schema) {
          // OpenAI's batch endpoint applies the same strict rules as its
          // realtime one (no `oneOf`); Google's schema is substituted at
          // the fetch boundary and Anthropic takes JSON Schema as is.
          const jsonSchema = opts.provider.startsWith("openai")
            ? toPortableJsonSchema(toJsonSchema(req.schema), "openai")
            : toJsonSchema(req.schema);
          responseFormat = {
            type: "json",
            schema: jsonSchema as JSONSchema7,
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

      const startResult = await seam.start(batchRequests, {
        ...(callOpts?.abortSignal ? { abortSignal: callOpts.abortSignal } : {}),
        ...(callOpts?.headers ? { headers: callOpts.headers } : {}),
      });

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
      const res = await seam.status({
        batchId: ref.id,
        abortSignal: callOpts?.abortSignal,
        headers: callOpts?.headers,
      });

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
      const stream = await seam.results({
        batchId: ref.id,
        abortSignal: callOpts?.abortSignal,
        headers: callOpts?.headers,
      });

      for await (const item of readableStreamToAsyncIterable(stream)) {
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
  // The key the in-flight start() is creating a batch under, read by the
  // fetch wrapper that stamps it over the SDK's generated displayName.
  let currentExternalKey: string | undefined;
  const provider = createGoogleGenerativeAI({
    ...(options.apiKey !== undefined ? { apiKey: options.apiKey } : {}),
    ...(options.baseURL !== undefined ? { baseURL: options.baseURL } : {}),
    fetch: createGoogleBatchFetch(
      options.fetch,
      schemasByKey,
      () => {
        if (warnedFileUpload) return;
        warnedFileUpload = true;
        options.onWarning?.(
          "Google batch was too large to submit inline and was uploaded as a file; " +
            "the provider's OpenAPI responseSchema is used there, which cannot express " +
            "nested unions. Lower maxRequestsPerBatch to keep submissions inline.",
        );
      },
      createGoogleDisplayNameStamp(() => currentExternalKey),
    ) as typeof fetch,
  });
  // The ref's provider id stays the language model's, whichever seam runs,
  // so a batch submitted before an SDK upgrade is polled the same way after.
  const providerId =
    (provider(modelId) as { provider?: string }).provider ??
    "google.generative-ai";
  const inner = fromAiSdkProvider(provider, { provider: providerId, modelId });
  const apiKey = resolveVendorApiKey("google", options);
  const baseURL = options.baseURL ?? GOOGLE_BATCH_BASE_URL;
  return {
    ...inner,
    // Gemini batch creation is explicitly not idempotent ("if you send the
    // same creation request twice, two separate batch jobs will be
    // created"), but the job carries a displayName the engine controls and
    // `GET /v1beta/batches` lists it, so a crashed submit is recoverable.
    recovery: "metadata" as const,
    async start(requests, callOpts) {
      const keys: string[] = [];
      for (const req of requests) {
        if (!req.schema) continue;
        schemasByKey.set(req.id, toGoogleResponseSchema(req.schema));
        keys.push(req.id);
      }
      currentExternalKey = callOpts?.externalKey;
      try {
        return await inner.start(requests, callOpts);
      } finally {
        currentExternalKey = undefined;
        for (const key of keys) schemasByKey.delete(key);
      }
    },
    async adopt(externalKey, adoptOpts) {
      if (!apiKey) return null;
      const found = await adoptGoogleBatch(
        {
          fetch: options.fetch,
          baseURL,
          apiKey,
          ...(adoptOpts?.headers ? { headers: adoptOpts.headers } : {}),
          ...(adoptOpts?.abortSignal
            ? { abortSignal: adoptOpts.abortSignal }
            : {}),
        },
        externalKey,
      );
      return found ? adoptedRef(found, providerId, modelId) : null;
    },
  };
}

const GOOGLE_BATCH_BASE_URL =
  "https://generativelanguage.googleapis.com/v1beta";
const OPENAI_BATCH_BASE_URL = "https://api.openai.com/v1";

/**
 * The key the vendor SDK would resolve for itself. Needed separately because
 * adoption lists batches over plain `fetch` rather than through the SDK.
 */
function resolveVendorApiKey(
  vendor: "google" | "openai",
  options: AiSdkBatchModelOptions,
): string | undefined {
  if (options.apiKey !== undefined) return options.apiKey;
  if (typeof process === "undefined") return undefined;
  const env = process.env ?? {};
  return vendor === "google"
    ? (env.GOOGLE_GENERATIVE_AI_API_KEY ?? env.GEMINI_API_KEY)
    : env.OPENAI_API_KEY;
}

/**
 * OpenAI: `POST /v1/batches` accepts a `metadata` map and `GET /v1/batches`
 * returns it, so the engine stamps the step's external key at the fetch
 * boundary (the provider exposes no hook for it) and searches the list on a
 * reclaim.
 */
async function resolveOpenAIBatchModel(
  modelId: string,
  options: AiSdkBatchModelOptions,
): Promise<EngineBatchModel> {
  const { createOpenAI } = await import("@ai-sdk/openai");
  let currentExternalKey: string | undefined;
  // For OpenAI use the default callable / .responses(), NEVER .chat()
  const provider = createOpenAI({
    ...(options.apiKey !== undefined ? { apiKey: options.apiKey } : {}),
    ...(options.baseURL !== undefined ? { baseURL: options.baseURL } : {}),
    fetch: createOpenAIBatchFetch(
      options.fetch,
      () => currentExternalKey,
    ) as typeof fetch,
  });
  const providerId =
    (provider(modelId) as { provider?: string }).provider ?? "openai.responses";
  const inner = fromAiSdkProvider(provider, { provider: providerId, modelId });
  const apiKey = resolveVendorApiKey("openai", options);
  const baseURL = options.baseURL ?? OPENAI_BATCH_BASE_URL;
  return {
    ...inner,
    recovery: "metadata" as const,
    async start(requests, callOpts) {
      currentExternalKey = callOpts?.externalKey;
      try {
        return await inner.start(requests, callOpts);
      } finally {
        currentExternalKey = undefined;
      }
    },
    async adopt(externalKey, adoptOpts) {
      if (!apiKey) return null;
      const found = await adoptOpenAIBatch(
        {
          fetch: options.fetch,
          baseURL,
          apiKey,
          ...(adoptOpts?.headers ? { headers: adoptOpts.headers } : {}),
          ...(adoptOpts?.abortSignal
            ? { abortSignal: adoptOpts.abortSignal }
            : {}),
        },
        externalKey,
      );
      return found ? adoptedRef(found, providerId, modelId) : null;
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
      const provider = createAnthropic(credentials);
      const providerId =
        (provider(modelId) as { provider?: string }).provider ??
        "anthropic.messages";
      return fromAiSdkProvider(provider, { provider: providerId, modelId });
    }
    if (vendor === "openai") {
      return await resolveOpenAIBatchModel(modelId, options);
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
