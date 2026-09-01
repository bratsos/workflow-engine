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

export interface EngineBatchModel {
  readonly provider: string;
  readonly modelId: string;
  start(
    requests: EngineBatchRequest[],
    opts?: {
      abortSignal?: AbortSignal;
      headers?: Record<string, string>;
    },
  ): Promise<EngineBatchRef & EngineBatchStatus>;
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
