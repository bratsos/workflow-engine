import { z } from "zod";

/** Versioned, JSON-serializable handle. Safe to persist in suspendedState. */
export interface EngineBatchRef {
  readonly version: 1;
  readonly type: "text";
  readonly id: string;
  readonly provider: string;
  readonly modelId: string;
}

export interface EngineBatchStatus {
  status: "pending" | "processing" | "completed" | "failed";
  rawStatus?: string;
  requestCounts?: {
    total: number;
    pending: number;
    completed: number;
    failed: number;
  };
  error?: string;
}

export interface EngineBatchRequest {
  /** Caller-supplied correlation id. Must survive round-trip verbatim. */
  id: string;
  prompt: string;
  system?: string;
  maxOutputTokens?: number;
  temperature?: number;
  /** When set, requests native structured output via responseFormat. */
  schema?: z.ZodTypeAny;
}

export type EngineBatchItemResult =
  | {
      id: string;
      status: "succeeded";
      text: string;
      inputTokens: number;
      outputTokens: number;
    }
  | {
      id: string;
      status: "failed" | "cancelled" | "expired";
      error?: string;
      inputTokens?: number;
      outputTokens?: number;
    };

/**
 * Whether a transport can find a batch it already created after the worker
 * that created it died.
 *
 * - `"metadata"`: the creation carries the engine's external key in a
 *   provider-side field the engine can search — OpenAI's batch `metadata`,
 *   Gemini's batch `displayName`. `adopt()` is implemented.
 * - `"none"`: the provider offers neither request idempotency the engine can
 *   rely on nor a searchable field. A re-submit would create and bill a
 *   second batch, so the engine refuses instead (Anthropic Message Batches
 *   carry no metadata; OpenRouter's beta batch body takes only `endpoint`,
 *   `model` and `requests`).
 */
export type EngineBatchRecovery = "metadata" | "none";

export interface EngineBatchStartOptions {
  abortSignal?: AbortSignal;
  headers?: Record<string, string>;
  /**
   * Deterministic key naming this batch, from `StepRunContext.externalKey`.
   * Adapters stamp it into whatever provider-side field survives creation so
   * `adopt()` can find the batch again after a crash.
   */
  externalKey?: string;
}

export interface EngineBatchModel {
  readonly provider: string;
  readonly modelId: string;
  /** How, if at all, a crashed submit can be recovered on this transport. */
  readonly recovery?: EngineBatchRecovery;
  start(
    requests: EngineBatchRequest[],
    opts?: EngineBatchStartOptions,
  ): Promise<EngineBatchRef & EngineBatchStatus>;
  /**
   * Find a batch this engine already created under `externalKey`, if one
   * exists. Implemented only when `recovery` is `"metadata"`. Returns `null`
   * when the provider has no such batch — which, on a reclaim, means the
   * crashed worker died before the provider accepted the creation.
   */
  adopt?(
    externalKey: string,
    opts?: { abortSignal?: AbortSignal; headers?: Record<string, string> },
  ): Promise<(EngineBatchRef & EngineBatchStatus) | null>;
  status(
    ref: EngineBatchRef,
    opts?: {
      abortSignal?: AbortSignal;
      headers?: Record<string, string>;
    },
  ): Promise<EngineBatchStatus>;
  results(
    ref: EngineBatchRef,
    opts?: {
      abortSignal?: AbortSignal;
      headers?: Record<string, string>;
    },
  ): AsyncIterable<EngineBatchItemResult>;
}

/** Zod schema validating EngineBatchRef when restoring untrusted persisted state. */
export const EngineBatchRefSchema = z.object({
  version: z.literal(1),
  type: z.literal("text"),
  id: z.string().min(1, "Batch ref id must be non-empty"),
  provider: z.string().min(1, "Batch ref provider must be non-empty"),
  modelId: z.string().min(1, "Batch ref modelId must be non-empty"),
});

/** Type guard for EngineBatchRef. */
export function isEngineBatchRef(v: unknown): v is EngineBatchRef {
  return EngineBatchRefSchema.safeParse(v).success;
}

/** Converts a Zod schema to a JSON Schema object for provider structured output. */
export function toJsonSchema(schema: z.ZodTypeAny): Record<string, unknown> {
  return z.toJSONSchema(schema) as Record<string, unknown>;
}
