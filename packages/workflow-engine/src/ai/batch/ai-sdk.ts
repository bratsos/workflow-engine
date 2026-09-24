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
import {
  type EngineBatchItemResult,
  type EngineBatchModel,
  type EngineBatchRef,
  type EngineBatchRequest,
  type EngineBatchStatus,
  toJsonSchema,
} from "./model";

// ---------------------------------------------------------------------------
// The two AI SDK batch seams.
//
// Earlier vendor releases put the batch methods on the language model
// (`experimental_doStartBatch` / `doGetBatchStatus` / `doGetBatchResults`).
// `@ai-sdk/google` 4.0.65 and the current `@ai-sdk/openai` /
// `@ai-sdk/anthropic` moved them onto the provider:
// `provider.experimental_batch()` returns one batch object whose requests
// each name their `modelId` and `type`. The HTTP calls underneath are the
// same. The engine drives whichever seam the installed release exposes, and
// declares the shapes it calls itself because `@ai-sdk/provider` dropped the
// per-model types when it introduced the provider-level ones.
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
  readonly warnings?: Array<{
    readonly requestId?: string;
    readonly warning: SharedV4Warning;
  }>;
};

export type BatchOperationOptions = {
  readonly batchId: string;
  readonly providerOptions?: SharedV4ProviderOptions;
  readonly abortSignal?: AbortSignal;
  readonly headers?: Record<string, string | undefined>;
};

export type BatchItemResult<RESULT = LanguageModelV4GenerateResult> = {
  readonly type?: "text" | "image";
} & (
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
    }
);

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

export type BatchStartOptions<REQUEST> = {
  readonly requests: ReadonlyArray<REQUEST>;
  readonly providerOptions?: SharedV4ProviderOptions;
  readonly abortSignal?: AbortSignal;
  readonly headers?: Record<string, string | undefined>;
  readonly webhookUrl?: string;
};

/** The per-model seam of earlier vendor releases. */
export type BatchLanguageModel = {
  experimental_doStartBatch(
    options: BatchStartOptions<LanguageModelBatchRequest>,
  ): PromiseLike<BatchStartResult>;
  experimental_doGetBatchStatus(
    options: BatchOperationOptions,
  ): PromiseLike<BatchStatus>;
  experimental_doGetBatchResults(
    options: BatchOperationOptions,
  ): PromiseLike<ReadableStream<BatchItemResult>>;
};

/** The provider-level seam of current vendor releases. */
type ProviderBatch = {
  doStartBatch(
    options: BatchStartOptions<
      LanguageModelBatchRequest & {
        readonly type: "text";
        readonly modelId: string;
      }
    >,
  ): PromiseLike<BatchStartResult>;
  doGetBatchStatus(options: BatchOperationOptions): PromiseLike<BatchStatus>;
  doGetBatchResults(
    options: BatchOperationOptions,
  ): PromiseLike<ReadableStream<BatchItemResult>>;
};

/** The three operations either seam provides, normalised to one shape. */
interface BatchSeamOps {
  start(
    options: BatchStartOptions<LanguageModelBatchRequest>,
  ): PromiseLike<BatchStartResult>;
  status(options: BatchOperationOptions): PromiseLike<BatchStatus>;
  results(
    options: BatchOperationOptions,
  ): PromiseLike<ReadableStream<BatchItemResult>>;
}

function isBatchModel(m: unknown): m is BatchLanguageModel {
  return (
    typeof m === "object" &&
    m !== null &&
    typeof (m as { experimental_doStartBatch?: unknown })
      .experimental_doStartBatch === "function" &&
    typeof (m as { experimental_doGetBatchStatus?: unknown })
      .experimental_doGetBatchStatus === "function" &&
    typeof (m as { experimental_doGetBatchResults?: unknown })
      .experimental_doGetBatchResults === "function"
  );
}

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

function notBatchCapable(opts: { provider: string; modelId: string }): Error {
  return new Error(
    `Model "${opts.provider}:${opts.modelId}" is not batch-capable (the vendor SDK exposes neither provider.experimental_batch() nor the per-model experimental_doStartBatch / experimental_doGetBatchStatus / experimental_doGetBatchResults). ` +
      `If using OpenAI, note that openai.chat() is not batch-capable; use openai() or openai.responses() instead.`,
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

/**
 * Creates an EngineBatchModel adapter wrapping an AI SDK model that implements
 * the per-model batch seam of earlier vendor releases.
 */
export function fromAiSdk(
  model: unknown,
  opts: { provider: string; modelId: string },
): EngineBatchModel {
  if (!isBatchModel(model)) throw notBatchCapable(opts);
  const batchModel = model;
  return buildEngineBatchModel(
    {
      start: (options) => batchModel.experimental_doStartBatch(options),
      status: (options) => batchModel.experimental_doGetBatchStatus(options),
      results: (options) => batchModel.experimental_doGetBatchResults(options),
    },
    opts,
  );
}

/**
 * Creates an EngineBatchModel adapter wrapping a provider-level AI SDK batch
 * (`provider.experimental_batch()` on current vendor releases). Every request
 * is sent as a `text` request for `opts.modelId`.
 */
export function fromAiSdkProviderBatch(
  batch: unknown,
  opts: { provider: string; modelId: string },
): EngineBatchModel {
  if (!isProviderBatch(batch)) throw notBatchCapable(opts);
  return buildEngineBatchModel(
    {
      start: (options) =>
        batch.doStartBatch({
          ...options,
          requests: options.requests.map((request) => ({
            ...request,
            type: "text" as const,
            modelId: opts.modelId,
          })),
        }),
      status: (options) => batch.doGetBatchStatus(options),
      results: (options) => batch.doGetBatchResults(options),
    },
    opts,
  );
}

/**
 * The engine batch model for a vendor provider: its provider-level batch
 * when the installed release exposes one, else the language model's own
 * batch methods. The ref's provider id is the language model's either way,
 * so a batch submitted before a vendor upgrade is polled the same after it.
 */
export function fromAiSdkProvider(
  provider: unknown,
  modelId: string,
  defaultProviderId: string,
): EngineBatchModel {
  const model = (provider as (id: string) => unknown)(modelId);
  const opts = {
    provider:
      (model as { provider?: string } | null)?.provider ?? defaultProviderId,
    modelId,
  };
  const factory = (provider as { experimental_batch?: unknown })
    .experimental_batch;
  if (typeof factory === "function") {
    return fromAiSdkProviderBatch(factory.call(provider), opts);
  }
  return fromAiSdk(model, opts);
}

function buildEngineBatchModel(
  seam: BatchSeamOps,
  opts: { provider: string; modelId: string },
): EngineBatchModel {
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
      const batchRequests: LanguageModelBatchRequest[] = requests.map((req) => {
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

      const startResult = await seam.start({
        requests: batchRequests,
        abortSignal: callOpts?.abortSignal,
        headers: callOpts?.headers,
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

/**
 * Resolves an AI SDK batch model dynamically using lazy imports for optional peer dependencies.
 */
export async function resolveAiSdkBatchModel(
  vendor: "google" | "anthropic" | "openai",
  modelId: string,
): Promise<EngineBatchModel> {
  try {
    if (vendor === "google") {
      const { google } = await import("@ai-sdk/google");
      return fromAiSdkProvider(google, modelId, "google.generative-ai");
    }
    if (vendor === "anthropic") {
      const { anthropic } = await import("@ai-sdk/anthropic");
      return fromAiSdkProvider(anthropic, modelId, "anthropic.messages");
    }
    if (vendor === "openai") {
      const { openai } = await import("@ai-sdk/openai");
      // For OpenAI use the default callable / .responses(), NEVER .chat()
      return fromAiSdkProvider(openai, modelId, "openai.responses");
    }
    const _exhaustive: never = vendor;
    throw new Error(`Unsupported vendor: ${_exhaustive}`);
  } catch (err: unknown) {
    if (
      err instanceof Error &&
      (("code" in err && (err as any).code === "ERR_MODULE_NOT_FOUND") ||
        err.message.includes("Cannot find package") ||
        err.message.includes("Cannot find module") ||
        err.message.includes("Failed to load url"))
    ) {
      const pkgName =
        vendor === "google"
          ? "@ai-sdk/google"
          : vendor === "anthropic"
            ? "@ai-sdk/anthropic"
            : "@ai-sdk/openai";
      const causeMsg = err instanceof Error ? `: ${err.message}` : "";
      throw new Error(
        `Package "${pkgName}" is required to use vendor "${vendor}". Please install ${pkgName}${causeMsg}.`,
      );
    }
    throw err;
  }
}
