/**
 * AI Helper - Shared Types
 *
 * Type definitions for the AI helper module: request/response shapes,
 * options, and the AIHelper/AIBatch public interfaces. Implementations live
 * in generate.ts, embeddings.ts, stream.ts, and batch-helper.ts; ai-helper.ts
 * wires them together and re-exports the public surface from here.
 */

import type { generateText, streamText, ToolSet } from "ai";
import type { z } from "zod";
import type { AICallLogger } from "../persistence";
import type { AIHelperStats } from "../persistence/interface";
import type { ModelConfig, ModelKey } from "./model-helper";
import type { OpenRouterRoutingOptions } from "./shared";

export type { OpenRouterRoutingOptions };

export interface AIHelperOptions {
  routing?: OpenRouterRoutingOptions;
  /** Optional transport adapter used instead of the AI SDK for selected calls. */
  adapter?: AIAdapter;
  /** Default timeout applied to each non-batch AI call. */
  timeout?: {
    perCallMs?: number;
  };
}

/**
 * Custom provider resolver. Given a ModelConfig, return an AI SDK
 * LanguageModel to use, or null/undefined to fall back to built-in resolution.
 */
export type ProviderResolver = (
  modelConfig: ModelConfig,
) => import("@ai-sdk/provider").LanguageModelV4 | null | undefined;

export type AICallType =
  | "text"
  | "object"
  | "embed"
  | "stream"
  | "batch"
  | "evaluate"
  | "transcribe";

/** Normalized request passed to an adapter for text generation. */
export interface AdapterTextRequest {
  model: ModelConfig;
  prompt: TextInput;
  options: TextOptions;
}

/** Normalized request passed to an adapter for structured generation. */
export interface AdapterObjectRequest {
  model: ModelConfig;
  prompt: TextInput;
  schema: z.ZodTypeAny;
  options: ObjectOptions;
}

/** Normalized request passed to an adapter for embedding generation. */
export interface AdapterEmbedRequest {
  model: ModelConfig;
  values: string[];
  options: EmbedOptions;
}

/** Normalized request passed to an adapter for streaming generation. */
export interface AdapterStreamRequest {
  model: ModelConfig;
  prompt?: string;
  messages?: Parameters<typeof streamText>[0]["messages"];
  instructions?: string;
  options: StreamOptions;
}

export interface AdapterTextResponse {
  /** Cost the adapter measured itself, in USD; recorded as a reported cost. */
  costUsd?: number;
  text: string;
  inputTokens: number;
  outputTokens: number;
  object?: unknown;
  reasoning?: string;
  providerMetadata?: Record<string, unknown>;
}

export interface AdapterObjectResponse {
  /** Cost the adapter measured itself, in USD; recorded as a reported cost. */
  costUsd?: number;
  object: unknown;
  inputTokens: number;
  outputTokens: number;
  reasoning?: string;
  providerMetadata?: Record<string, unknown>;
}

export interface AdapterEmbedResponse {
  /** Cost the adapter measured itself, in USD; recorded as a reported cost. */
  costUsd?: number;
  embeddings: number[][];
  inputTokens: number;
  outputTokens?: number;
  providerMetadata?: Record<string, unknown>;
}

export interface AdapterStreamResponse {
  /** Cost the adapter measured itself, in USD; recorded as a reported cost. */
  costUsd?: number;
  stream: AsyncIterable<string>;
  text?: string;
  inputTokens?: number;
  outputTokens?: number;
  reasoning?: string;
  providerMetadata?: Record<string, unknown>;
}

/**
 * Optional AI transport seam. The helper retains topic, logging, cost, and
 * error semantics around these normalized operations.
 */
export interface AIAdapter {
  generateText?(req: AdapterTextRequest): Promise<AdapterTextResponse>;
  generateObject?(req: AdapterObjectRequest): Promise<AdapterObjectResponse>;
  embed?(req: AdapterEmbedRequest): Promise<AdapterEmbedResponse>;
  streamText?(req: AdapterStreamRequest): AdapterStreamResponse;
}

export interface AITextResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
  cost: number;
  /** Actual USD cost as reported by the provider, when available. Undefined on providers that do not report it. */
  reportedCostUsd?: number;
  /** Whether `cost` came from the provider or from the static price table. */
  costSource?: "reported" | "estimated";
  /** Structured output when `output` is used */
  output?: any;
  /**
   * Reasoning/thinking text emitted by the model, when available. Reasoning
   * models (e.g. via `providerOptions.anthropic.thinking` or OpenRouter's
   * `reasoning`) emit on a separate channel; this surfaces it. It is NOT part
   * of `text` (the answer). Undefined when the model produced no reasoning.
   */
  reasoning?: string;
}

export interface AIObjectResult<T> {
  object: T;
  inputTokens: number;
  outputTokens: number;
  cost: number;
  /** Actual USD cost as reported by the provider, when available. Undefined on providers that do not report it. */
  reportedCostUsd?: number;
  /** Whether `cost` came from the provider or from the static price table. */
  costSource?: "reported" | "estimated";
  reasoning?: string;
}

// ============================================================================
// Evaluation (decision models such as TypeSafe's Jev)
// ============================================================================

/**
 * Shared state, instructions, or a criterion description for an evaluation:
 * plain text, a JSON object, or a JSON array.
 */
export type EvaluationInput =
  | string
  | Readonly<import("@ai-sdk/provider").JSONObject>
  | readonly import("@ai-sdk/provider").JSONValue[];

/**
 * One judgment to make about the shared state.
 *
 * - `choice`: pick one of the named options in `criteria`.
 * - `score`: place the state on an ordered scale; `criteria` lists the
 *   levels from lowest to highest (at least two).
 * - `boolean`: the probability that the statement in `instructions` is true.
 *   `criteria` is optional; when given, both `true` and `false` must be.
 */
export type EvaluationQuestion =
  | {
      readonly type: "choice";
      readonly instructions: EvaluationInput;
      /** Option name to description. At least one option. */
      readonly criteria: Readonly<Record<string, EvaluationInput | null>>;
    }
  | {
      readonly type: "score";
      readonly instructions: EvaluationInput;
      /** Ordered levels, lowest first, indexed from zero. */
      readonly criteria: readonly (EvaluationInput | null)[];
    }
  | {
      readonly type: "boolean";
      readonly instructions: EvaluationInput;
      readonly criteria?: {
        readonly true?: EvaluationInput | null;
        readonly false?: EvaluationInput | null;
      };
    };

/** The questions of one evaluation, keyed by the id each answer comes back under. */
export type EvaluationQuestions = Readonly<Record<string, EvaluationQuestion>>;

/**
 * The typed answer to one question, derived from that question:
 * a `choice` answer's `choice` is the union of its criteria keys.
 */
export type EvaluationAnswer<Q extends EvaluationQuestion> = Q extends {
  type: "choice";
  criteria: infer C;
}
  ? {
      type: "choice";
      /** The selected option: the most probable one when a distribution exists. */
      choice: Extract<keyof C, string>;
      /** Probability per option, when the model reports a distribution. */
      probabilities?: Record<Extract<keyof C, string>, number>;
      /** Provider-reported confidence in the selection, when available. */
      confidence?: number;
    }
  : Q extends { type: "score" }
    ? {
        type: "score";
        /** Fractional position in [0, levels - 1]; the probability-weighted mean when a distribution exists. */
        score: number;
        /** Probability per level, keyed by the zero-based level index. */
        probabilities?: Record<string, number>;
        /** Provider-reported confidence, when available. */
        confidence?: number;
        /** Level index to its description, as the provider echoed it. */
        legend?: Record<string, string>;
      }
    : {
        type: "boolean";
        /** Estimated probability that the statement is true, in [0, 1]. Not a confidence. */
        probability: number;
      };

/** The state and questions of one evaluation. */
export interface EvaluationSpec<Q extends EvaluationQuestions> {
  /** One shared state every question is answered against. */
  state: EvaluationInput;
  questions: Q;
}

export interface EvaluateOptions {
  /** Abort signal to cancel the call (pass-through) */
  abortSignal?: AbortSignal;
  /** Override the helper-level per-call timeout. */
  timeoutMs?: number;
  /** Retries for transient provider failures. Defaults to the AI SDK's 2. */
  maxRetries?: number;
  /** Extra HTTP headers for the request. */
  headers?: Record<string, string>;
  /** Provider-specific options passed through to the AI SDK. */
  providerOptions?: Record<string, Record<string, unknown>>;
}

export interface AIEvaluateResult<Q extends EvaluationQuestions> {
  /** Exactly one answer per question, under the question's id. */
  answers: { [K in keyof Q]: EvaluationAnswer<Q[K]> };
  inputTokens: number;
  outputTokens: number;
  cost: number;
  /** Actual USD cost as reported by the provider, when available. */
  reportedCostUsd?: number;
  /** Whether `cost` came from the provider or from the static price table. */
  costSource?: "reported" | "estimated";
}

// ============================================================================
// Transcription
// ============================================================================

/**
 * Audio to transcribe: raw bytes, a base64 string, or a URL the AI SDK
 * downloads (up to its 2 GiB default) before sending.
 */
export type TranscriptionAudio = Uint8Array | ArrayBuffer | string | URL;

export interface TranscribeOptions {
  /** Abort signal to cancel the call (pass-through) */
  abortSignal?: AbortSignal;
  /** Override the helper-level per-call timeout. */
  timeoutMs?: number;
  /** Retries for transient provider failures. Defaults to the AI SDK's 2. */
  maxRetries?: number;
  /** Extra HTTP headers for the request. */
  headers?: Record<string, string>;
  /**
   * Provider-specific options passed through to the AI SDK, e.g.
   * `{ openai: { language: "en", timestampGranularities: ["segment"] } }`.
   */
  providerOptions?: Record<string, Record<string, unknown>>;
}

export interface AITranscribeResult {
  /** The full transcript. */
  text: string;
  /** Timed segments, when the provider returns them. */
  segments: Array<{ text: string; startSecond: number; endSecond: number }>;
  /** Detected language (ISO-639-1), when the provider reports it. */
  language?: string;
  /** Duration of the audio in seconds, when the provider reports it. */
  durationInSeconds?: number;
  cost: number;
  /** Actual USD cost as reported by the provider, when available. */
  reportedCostUsd?: number;
  /** Whether `cost` came from the provider or from the registry's prices. */
  costSource?: "reported" | "estimated";
}

export interface AIEmbedResult {
  embedding: number[]; // Single embedding (first one)
  embeddings: number[][]; // All embeddings (for batch)
  dimensions: number; // Dimensionality of embeddings
  inputTokens: number;
  cost: number;
  /** Actual USD cost as reported by the provider, when available. Undefined on providers that do not report it. */
  reportedCostUsd?: number;
  /** Whether `cost` came from the provider or from the static price table. */
  costSource?: "reported" | "estimated";
}

// Type for the raw AI SDK streamText result
export type AISDKStreamResult = ReturnType<typeof streamText>;

export interface AIStreamResult {
  stream: AsyncIterable<string>;
  getUsage(): Promise<{
    inputTokens: number;
    outputTokens: number;
    cost: number;
    /** Actual USD cost as reported by the provider, when available. Undefined on providers that do not report it. */
    reportedCostUsd?: number;
    /** Whether `cost` came from the provider or from the static price table. */
    costSource?: "reported" | "estimated";
  }>;
  /**
   * The full answer text, after the stream completes. Consumes the stream if
   * not already consumed. When the model streamed nothing on the text channel
   * (e.g. a reasoning model), this reconciles against the buffered final text,
   * so a text answer is never lost. May be `""` for a reasoning-only response —
   * in that case the content is in {@link getReasoning}.
   */
  getText(): Promise<string>;
  /**
   * The model's reasoning/thinking text, when available. Reasoning is a
   * separate channel from the answer; a model can reason without emitting any
   * answer text (in which case `getText()` is empty but this is not). Resolves
   * to `undefined` when the model produced no reasoning.
   */
  getReasoning(): Promise<string | undefined>;
  /** The raw AI SDK result - use this for methods like toUIMessageStreamResponse */
  /** Undefined when the stream was supplied by an AIAdapter. */
  rawResult: AISDKStreamResult | undefined;
}

/**
 * Context for logging to workflow persistence (optional).
 * When provided, batch operations can log to the database.
 */
export interface LogContext {
  workflowRunId: string;
  stageRecordId: string;
  /** Function to create a log entry in persistence */
  createLog: (data: {
    workflowRunId: string;
    workflowStageId: string;
    level: "DEBUG" | "INFO" | "WARN" | "ERROR";
    message: string;
    metadata?: Record<string, unknown>;
  }) => Promise<void>;
}

/** Log function type for batch operations */
export type BatchLogFn = (
  level: "DEBUG" | "INFO" | "WARN" | "ERROR",
  message: string,
  meta?: Record<string, unknown>,
) => void;

export interface TextOptions<TTools extends ToolSet = ToolSet> {
  temperature?: number;
  maxTokens?: number;
  /** Maximum number of retries for the AI SDK call (pass-through) */
  maxRetries?: number;
  /** Abort signal to cancel the AI SDK call (pass-through) */
  abortSignal?: AbortSignal;
  /** Override the helper-level per-call timeout. */
  timeoutMs?: number;
  /** Tool definitions for the model to use */
  tools?: TTools;
  /** Tool choice: 'auto' (default), 'required' (force tool use), 'none', or specific tool name */
  toolChoice?: Parameters<typeof generateText>[0]["toolChoice"];
  /** Condition to stop tool execution (e.g., stepCountIs(3)) */
  stopWhen?: Parameters<typeof generateText>[0]["stopWhen"];
  /** Callback fired when each step completes (for collecting tool results) */
  onStepEnd?: Parameters<typeof generateText>[0]["onStepEnd"];
  /** Structured output - use with tools for combined tool calling + structured output */
  output?: Parameters<typeof generateText>[0]["output"];
  /**
   * Provider-specific options passed directly to the AI SDK call. Use this to
   * control reasoning per call, e.g.
   * `{ openrouter: { reasoning: { enabled: false } } }` or
   * `{ anthropic: { thinking: { type: "disabled" } } }`.
   */
  providerOptions?: Record<string, Record<string, unknown>>;
}

export interface ObjectOptions<TTools extends ToolSet = ToolSet> {
  temperature?: number;
  maxTokens?: number;
  /** Maximum number of retries for the AI SDK call (pass-through) */
  maxRetries?: number;
  /** Abort signal to cancel the AI SDK call (pass-through) */
  abortSignal?: AbortSignal;
  /** Override the helper-level per-call timeout. */
  timeoutMs?: number;
  /** Tool definitions for the model to use */
  tools?: TTools;
  /** Condition to stop tool execution (e.g., stepCountIs(3)) */
  stopWhen?: Parameters<typeof generateText>[0]["stopWhen"];
  /** Callback fired when each step completes (for collecting tool results) */
  onStepEnd?: Parameters<typeof generateText>[0]["onStepEnd"];
  /**
   * Provider-specific options passed directly to the AI SDK call (e.g.
   * `{ anthropic: { thinking: { type: "disabled" } } }`).
   */
  providerOptions?: Record<string, Record<string, unknown>>;
}

export interface EmbedOptions {
  taskType?: "RETRIEVAL_QUERY" | "RETRIEVAL_DOCUMENT" | "SEMANTIC_SIMILARITY";
  /** Override the default embedding dimensions (DEFAULT_EMBEDDING_DIMENSIONS in embeddings.ts) */
  dimensions?: number;
  /** Abort signal to cancel the AI SDK call (pass-through) */
  abortSignal?: AbortSignal;
  /** Override the helper-level per-call timeout. */
  timeoutMs?: number;
  /** Provider-specific options passed directly to the AI SDK's embed() call */
  providerOptions?: Record<string, Record<string, unknown>>;
}

export interface StreamOptions {
  temperature?: number;
  maxTokens?: number;
  /** Maximum number of retries for the AI SDK call (pass-through) */
  maxRetries?: number;
  /** Abort signal to cancel the AI SDK call (pass-through) */
  abortSignal?: AbortSignal;
  /** Override the helper-level per-call timeout. */
  timeoutMs?: number;
  onChunk?: (chunk: string) => void;
  /** Tool definitions for the model to use */
  tools?: Parameters<typeof streamText>[0]["tools"];
  /** Condition to stop tool execution (e.g., stepCountIs(3)) */
  stopWhen?: Parameters<typeof streamText>[0]["stopWhen"];
  /** Callback fired when each step completes (for collecting tool results) */
  onStepEnd?: Parameters<typeof streamText>[0]["onStepEnd"];
  /**
   * Provider-specific options passed directly to the AI SDK call. Use this to
   * control reasoning per call, e.g.
   * `{ openrouter: { reasoning: { enabled: false } } }` or
   * `{ anthropic: { thinking: { type: "disabled" } } }`.
   */
  providerOptions?: Record<string, Record<string, unknown>>;
}

// Multimodal content types for generateText/generateObject
export interface MediaPart {
  type: "file";
  data: Buffer | Uint8Array | string; // Base64 or binary data
  mediaType: string; // IANA media type (e.g., "image/png", "application/pdf")
  filename?: string;
}

export interface TextPart {
  type: "text";
  text: string;
}

export type ContentPart = TextPart | MediaPart;

// Input types - can be string (simple) or array of parts (multimodal)
export type TextInput = string | ContentPart[];

// Input types for streamText - mirrors AI SDK's flexible input
export type StreamTextInput =
  | { prompt: string; messages?: never; instructions?: string }
  | {
      messages: Parameters<typeof streamText>[0]["messages"];
      prompt?: never;
      instructions?: string;
    };

import type { EngineBatchRef } from "./batch/model";

// =============================================================================
// High-Level Batch Types (User-Facing API)
// =============================================================================
// These types are for the AIHelper.batch() API.

/** Provider identifier for batch operations */
export type AIBatchProvider = "google" | "anthropic" | "openai" | "openrouter";

export interface BatchOptions {
  apiKey?: string;
  baseURL?: string;
  fetch?: typeof globalThis.fetch;
  endpoint?:
    | "/v1/chat/completions"
    | "/v1/responses"
    | "/v1/messages"
    | "/v1/embeddings";
  maxRequestsPerBatch?: number;
  maxPartitions?: number;
  /**
   * Abort signal to cancel batch operations. Applies to every provider call
   * this batch handle makes (submit, status polls, result fetches).
   */
  abortSignal?: AbortSignal;
}

/** A request to be processed in a batch */
export interface AIBatchRequest {
  /** Unique identifier for this request (used to match results) */
  id: string;
  /** The prompt to send to the model */
  prompt: string;
  /** Optional Zod schema for structured JSON output */
  schema?: z.ZodTypeAny;
  /** P6c: previously impossible to set; two of three old providers silently capped output at 1024. */
  maxTokens?: number;
  system?: string;
  temperature?: number;
}

/** Result of a single request in a batch */
export type AIBatchResult<T = string> =
  | {
      /** The request ID (matches the id from AIBatchRequest) */
      id: string;
      /** Original prompt (may be empty if not available from provider) */
      prompt: string;
      /**
       * The parsed result. When a schema was provided and validation succeeded,
       * `validated` is `true`. When no schema was available at retrieval time
       * (the default after suspend/resume), this is the unvalidated parsed JSON
       * or string output, and `validated` is `false`.
       */
      result: T;
      /** Input tokens used */
      inputTokens: number;
      /** Output tokens used */
      outputTokens: number;
      status: "succeeded";
      error?: undefined;
      /**
       * True only when a schema was available at retrieval time and the response
       * was successfully parsed and validated against it. False/undefined when
       * no schema was available (e.g. after a suspend/resume without re-supplying schemas).
       */
      validated?: boolean;
    }
  | {
      id: string;
      prompt: string;
      /** No result is available for a failed request. */
      result?: undefined;
      inputTokens: number;
      outputTokens: number;
      status: "failed";
      /** Error message describing why the request failed. */
      error: string;
      /** Always false on failed requests. */
      validated?: boolean;
      /**
       * The model's raw reply when the request reached the model but its
       * output could not be parsed or validated (absent when the provider
       * itself failed the request). Stored on the accounting row.
       */
      responseText?: string;
    };

/** Handle for tracking a submitted batch */
export interface AIBatchHandle {
  /** Batch identifier from the provider */
  id: string;
  /** Current status of the batch */
  status: "pending" | "processing" | "completed" | "failed";
  /** The provider used for this batch (for resume support) */
  provider?: AIBatchProvider;
  /** Versioned serializable handle(s). Persist in suspendedState.metadata.batchRefs. */
  refs?: EngineBatchRef[];
  /** Every batch this submit fanned out into. Length 1 unless partitioned. */
  batchIds?: string[];
  requestCounts?: { total: number; completed: number; failed: number };
  /** Total number of requests expected in the batch */
  totalRequests?: number;
  error?: string;
}

/** How a replayed submit behaves after a worker crashed mid-submission. */
export type BatchReclaimPolicy = "adopt" | "resubmit";

/** Crash-recovery inputs for one `AIBatch.submit` call. */
export interface AIBatchSubmitOptions {
  /**
   * Deterministic key naming this submission, from a durable step's
   * `StepRunContext.externalKey`. Stamped into provider-side metadata (one
   * sub-key per partition) so a replay can find what was already created.
   */
  externalKey?: string;
  /**
   * True when this call is a replay of a submit whose outcome was never
   * recorded — a worker died with the lease held. Only then does the engine
   * search the provider before creating anything.
   */
  recovering?: boolean;
  /**
   * `"adopt"` (default): on a recovering submit, adopt the batch already
   * carrying the external key, and fail with `BatchNotAdoptableError` when
   * the transport has no searchable field. `"resubmit"`: create a new batch
   * regardless, accepting that the earlier one is orphaned and still billed.
   */
  onReclaim?: BatchReclaimPolicy;
}

/** Interface for batch operations on an AI model */
export interface AIBatch<T = string> {
  /** Submit requests for batch processing */
  submit(
    requests: AIBatchRequest[],
    options?: AIBatchSubmitOptions,
  ): Promise<AIBatchHandle>;
  /** Check the status of a batch */
  getStatus(
    batchId: string,
    metadata?: Record<string, unknown>,
  ): Promise<AIBatchHandle>;
  /** Retrieve results from a completed batch */
  getResults(
    batchId: string,
    metadata?: Record<string, unknown>,
  ): Promise<AIBatchResult<T>[]>;
  /** Check if results have been recorded for this batch */
  isRecorded(batchId: string): Promise<boolean>;
  /** Record batch results manually when batch provider integration is not implemented */
  recordResults(batchId: string, results: AIBatchResult<T>[]): Promise<void>;
}

export interface RecordCallParams {
  modelKey: ModelKey;
  callType: AICallType;
  prompt: string;
  response: string;
  inputTokens: number;
  outputTokens: number;
  metadata?: Record<string, unknown>;
}

// Single definition lives in persistence/interface.ts (the persistence layer
// owns AI call stats); re-exported here so AIHelper.getStats() and consumers
// of this module share the same type instead of two identical copies.
export type { AIHelperStats };

// ============================================================================
// AIHelper Interface
// ============================================================================

export interface AIHelper {
  /** Current topic path */
  readonly topic: string;

  // Core AI Methods
  generateText<TTools extends ToolSet = ToolSet>(
    modelKey: ModelKey,
    prompt: TextInput,
    options?: TextOptions<TTools>,
  ): Promise<AITextResult>;

  generateObject<TSchema extends z.ZodTypeAny>(
    modelKey: ModelKey,
    prompt: TextInput,
    schema: TSchema,
    options?: ObjectOptions,
  ): Promise<AIObjectResult<z.infer<TSchema>>>;

  embed(
    modelKey: ModelKey,
    text: string | string[],
    options?: EmbedOptions,
  ): Promise<AIEmbedResult>;

  streamText(
    modelKey: ModelKey,
    input: StreamTextInput,
    options?: StreamOptions,
  ): AIStreamResult;

  /**
   * Answer typed questions about one shared state with a decision model
   * (`isEvaluationModel` in the registry, e.g. TypeSafe's Jev). Each
   * answer's type follows from its question, so a `choice` answer is the
   * union of that question's criteria keys.
   */
  evaluate<const Q extends EvaluationQuestions>(
    modelKey: ModelKey,
    spec: EvaluationSpec<Q>,
    options?: EvaluateOptions,
  ): Promise<AIEvaluateResult<Q>>;

  /**
   * Transcribe audio with a speech-to-text model (`isTranscriptionModel` in
   * the registry). Cost is estimated per minute of audio
   * (`transcriptionCostPerMinute`) or per reported token, whichever the
   * provider bills by, unless the provider reports a USD cost itself.
   */
  transcribe(
    modelKey: ModelKey,
    audio: TranscriptionAudio,
    options?: TranscribeOptions,
  ): Promise<AITranscribeResult>;

  // Batch Methods - provider is optional, will auto-detect based on model
  batch<T = string>(
    modelKey: ModelKey,
    provider?: AIBatchProvider,
    options?: BatchOptions,
  ): AIBatch<T>;

  // Hierarchy Methods
  createChild(segment: string, id?: string): AIHelper;

  // Manual Recording (new object-based API)
  recordCall(params: RecordCallParams): void;

  // Stats (queries DB)
  getStats(): Promise<AIHelperStats>;
}

// ============================================================================
// Internal Context (not part of the public API)
// ============================================================================

/**
 * Shared state that generateText/generateObject/embed/streamText/batch need
 * from AIHelperImpl. Passed explicitly instead of `this` so the AI SDK calls
 * can live in standalone modules (generate.ts, embeddings.ts, stream.ts,
 * batch-helper.ts) rather than as methods on one large class.
 */
export interface AIHelperContext {
  readonly topic: string;
  readonly aiCallLogger: AICallLogger;
  readonly providerResolver?: ProviderResolver;
  readonly routing?: OpenRouterRoutingOptions;
  readonly adapter?: AIAdapter;
  readonly timeout?: AIHelperOptions["timeout"];
}
