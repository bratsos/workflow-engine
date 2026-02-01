/**
 * Low-Level Batch Provider Types
 *
 * These types are used internally by batch providers (Google, Anthropic, OpenAI).
 * They have more fields than the high-level user-facing types in ai/ai-helper.ts.
 *
 * For the user-facing batch API, see:
 * - AIBatchRequest - simple request with id, prompt, schema
 * - AIBatchResult<T> - result with id, result, tokens
 * - AIBatchHandle - handle with id, status, provider
 *
 * These provider-level types include additional fields like:
 * - BatchHandle: requestCount, createdAt, metadata
 * - BaseBatchRequest: model, system, maxTokens, temperature, tools
 * - RawBatchResult: raw text before parsing, index
 */

import type { ToolSet } from "ai";
import type { z } from "zod";
import type { ModelKey } from "../../ai/model-helper";
import type { LogLevel } from "../../core/types";

/** Tool choice options compatible with AI SDK */
export type BatchToolChoice =
  | "auto"
  | "required"
  | "none"
  | { type: "tool"; toolName: string };

// =============================================================================
// Core Batch Types
// =============================================================================

/**
 * Handle returned when a batch is submitted
 */
export interface BatchHandle {
  /** Unique identifier for the batch (provider-specific format) */
  id: string;
  /** Provider name (google, anthropic, openai) */
  provider: string;
  /** Number of requests in the batch */
  requestCount: number;
  /** When the batch was created */
  createdAt: Date;
  /** Provider-specific metadata */
  metadata?: Record<string, unknown>;
}

/**
 * Status of a batch job
 */
export interface BatchStatus {
  /** Current state of the batch */
  state: BatchState;
  /** Number of requests processed so far */
  processedCount: number;
  /** Total number of requests in the batch */
  totalCount: number;
  /** Number of successful requests (if available) */
  succeededCount?: number;
  /** Number of failed requests (if available) */
  failedCount?: number;
  /** Error message if batch failed */
  error?: string;
  /** Estimated completion time (if available) */
  estimatedCompletion?: Date;
  /** Total input tokens used (available when batch is complete) */
  totalInputTokens?: number;
  /** Total output tokens used (available when batch is complete) */
  totalOutputTokens?: number;
}

export type BatchState =
  | "pending"
  | "processing"
  | "completed"
  | "failed"
  | "cancelled";

/**
 * Result of a single request in a batch
 */
export interface BatchResult<T> {
  /** Index in the original request array */
  index: number;
  /** Custom ID if provided */
  customId?: string;
  /** Parsed/validated data */
  data: T;
  /** Input tokens used */
  inputTokens: number;
  /** Output tokens used */
  outputTokens: number;
  /** Status of this individual result */
  status: "succeeded" | "failed";
  /** Error message if this specific request failed */
  error?: string;
}

/**
 * Raw result from a provider (before schema validation)
 */
export interface RawBatchResult {
  index: number;
  customId?: string;
  text: string;
  inputTokens: number;
  outputTokens: number;
  error?: string;
}

// =============================================================================
// Request Types
// =============================================================================

/**
 * Base request configuration shared across providers
 */
export interface BaseBatchRequest {
  /** The prompt/content to send */
  prompt: string;
  /** Optional custom ID for tracking */
  customId?: string;
  /** Model to use - accepts ModelKey from model-helper.ts */
  model?: ModelKey;
  /** System prompt (if supported) */
  system?: string;
  /** Maximum tokens to generate */
  maxTokens?: number;
  /** Temperature for generation */
  temperature?: number;
  /** Optional Zod schema for structured output */
  schema?: z.ZodTypeAny;
  /** Tool definitions (same as AI SDK generateText/streamText) */
  tools?: ToolSet;
  /** Tool choice mode */
  toolChoice?: BatchToolChoice;
}

/**
 * Request with schema for structured output
 */
export interface BatchRequestWithSchema<TSchema extends z.ZodTypeAny>
  extends BaseBatchRequest {
  schema: TSchema;
}

/**
 * Request without schema (plain text output)
 */
export interface BatchRequestText extends BaseBatchRequest {
  schema?: never;
}

/**
 * Union type for batch requests
 */
export type BatchRequest<TSchema extends z.ZodTypeAny = z.ZodTypeAny> =
  | BatchRequestWithSchema<TSchema>
  | BatchRequestText;

// =============================================================================
// Provider Interface
// =============================================================================

/**
 * Interface that all batch providers must implement
 */
export interface BatchProvider<
  TRequest extends BaseBatchRequest = BaseBatchRequest,
  TRawResult extends RawBatchResult = RawBatchResult,
> {
  /** Provider name (google, anthropic, openai) */
  readonly name: string;

  /** Whether this provider supports batching */
  readonly supportsBatching: boolean;

  /**
   * Submit requests to batch processing
   * @param requests Array of requests to process
   * @param options Provider-specific options
   * @returns Handle to track the batch
   */
  submit(
    requests: TRequest[],
    options?: BatchSubmitOptions,
  ): Promise<BatchHandle>;

  /**
   * Check the status of a batch
   * @param handle Batch handle from submit()
   * @returns Current status
   */
  checkStatus(handle: BatchHandle): Promise<BatchStatus>;

  /**
   * Retrieve results from a completed batch
   * @param handle Batch handle from submit()
   * @returns Array of raw results
   */
  getResults(handle: BatchHandle): Promise<TRawResult[]>;

  /**
   * Cancel a running batch (optional - not all providers support this)
   * @param handle Batch handle from submit()
   */
  cancel?(handle: BatchHandle): Promise<void>;
}

export interface BatchSubmitOptions {
  /** Display name for the batch (if supported) */
  displayName?: string;
  /** Completion window (e.g., "24h" for OpenAI) */
  completionWindow?: string;
  /** Custom metadata to attach */
  metadata?: Record<string, string>;
}

// =============================================================================
// Serialization Types (for suspend/resume)
// =============================================================================

/**
 * Serialized batch for persistence during workflow suspension
 */
export interface SerializedBatch {
  handle: BatchHandle;
  providerName: string;
  /** Serialized schema definitions (if any) */
  schemaDefinitions?: unknown[];
}

// =============================================================================
// Logger Interface
// =============================================================================

/**
 * Logger interface for batch operations
 */
export interface BatchLogger {
  log: (
    level: LogLevel,
    message: string,
    meta?: Record<string, unknown>,
  ) => void;
}

// =============================================================================
// Metrics Types
// =============================================================================

/**
 * Aggregated metrics for a batch
 */
export interface BatchMetrics {
  provider: string;
  model: string;
  requestCount: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  estimatedCost: number;
  actualDuration: number;
  successRate: number;
}

// =============================================================================
// Provider-Specific Request Types
// =============================================================================

export interface GoogleBatchRequest extends BaseBatchRequest {
  // Google-specific extensions can go here
}

export interface AnthropicBatchRequest extends BaseBatchRequest {
  // Anthropic-specific extensions can go here
}

export interface OpenAIBatchRequest extends BaseBatchRequest {
  // OpenAI-specific extensions can go here
}
