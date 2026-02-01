/**
 * AI Helper - Unified AI interaction tracking with hierarchical topics
 *
 * This is the new unified AI tracking system that replaces workflow-specific tracking.
 * It supports:
 * - Hierarchical topics for flexible categorization (e.g., "workflow.abc.stage.extraction")
 * - All AI call types: generateText, generateObject, embed, streamText, batch
 * - Automatic cost calculation with batch discounts
 * - Persistent DB logging to AICall table
 *
 * @example
 * ```typescript
 * const ai = createAIHelper("workflow.abc123").createChild("stage", "extraction");
 * const result = await ai.generateText("gemini-2.5-flash", prompt);
 * ```
 */

import { google } from "@ai-sdk/google";
import { openrouter } from "@openrouter/ai-sdk-provider";
import type { StepResult, ToolSet } from "ai";
import { embed, generateObject, generateText, streamText } from "ai";
import type { z } from "zod";
import type { AICallLogger } from "../persistence";
import { getBestProviderForModel } from "../utils/batch/model-mapping";
import { AnthropicBatchProvider } from "../utils/batch/providers/anthropic-batch";
import { GoogleBatchProvider } from "../utils/batch/providers/google-batch";
import { OpenAIBatchProvider } from "../utils/batch/providers/openai-batch";
import { createLogger } from "../utils/logger";
import {
  calculateCost,
  getModel,
  type ModelConfig,
  type ModelKey,
} from "./model-helper";

const logger = createLogger("AIHelper");

// Default embedding dimensions (can be overridden via options)
const DEFAULT_EMBEDDING_DIMENSIONS = 768;

// ============================================================================
// Types
// ============================================================================

export type AICallType = "text" | "object" | "embed" | "stream" | "batch";

export interface AITextResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
  cost: number;
  /** Structured output when experimental_output is used */
  output?: any;
}

export interface AIObjectResult<T> {
  object: T;
  inputTokens: number;
  outputTokens: number;
  cost: number;
}

export interface AIEmbedResult {
  embedding: number[]; // Single embedding (first one)
  embeddings: number[][]; // All embeddings (for batch)
  dimensions: number; // Dimensionality of embeddings
  inputTokens: number;
  cost: number;
}

// Type for the raw AI SDK streamText result
export type AISDKStreamResult = ReturnType<typeof streamText>;

export interface AIStreamResult {
  stream: AsyncIterable<string>;
  getUsage(): Promise<{
    inputTokens: number;
    outputTokens: number;
    cost: number;
  }>;
  /** The raw AI SDK result - use this for methods like toUIMessageStreamResponse */
  rawResult: AISDKStreamResult;
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
  /** Tool definitions for the model to use */
  tools?: TTools;
  /** Tool choice: 'auto' (default), 'required' (force tool use), 'none', or specific tool name */
  toolChoice?: Parameters<typeof generateText>[0]["toolChoice"];
  /** Condition to stop tool execution (e.g., stepCountIs(3)) */
  stopWhen?: Parameters<typeof generateText>[0]["stopWhen"];
  /** Callback fired when each step completes (for collecting tool results) */
  onStepFinish?: (stepResult: StepResult<TTools>) => Promise<void> | void;
  /** Experimental structured output - use with tools for combined tool calling + structured output */
  experimental_output?: Parameters<
    typeof generateText
  >[0]["experimental_output"];
}

export interface ObjectOptions<TTools extends ToolSet = ToolSet> {
  temperature?: number;
  maxTokens?: number;
  /** Tool definitions for the model to use */
  tools?: TTools;
  /** Condition to stop tool execution (e.g., stepCountIs(3)) */
  stopWhen?: Parameters<typeof generateText>[0]["stopWhen"];
  /** Callback fired when each step completes (for collecting tool results) */
  onStepFinish?: (stepResult: StepResult<TTools>) => Promise<void> | void;
}

export interface EmbedOptions {
  taskType?: "RETRIEVAL_QUERY" | "RETRIEVAL_DOCUMENT" | "SEMANTIC_SIMILARITY";
  /** Override the default embedding dimensions (from embedding-config.ts) */
  dimensions?: number;
}

export interface StreamOptions {
  temperature?: number;
  maxTokens?: number;
  onChunk?: (chunk: string) => void;
  /** Tool definitions for the model to use */
  tools?: Parameters<typeof streamText>[0]["tools"];
  /** Condition to stop tool execution (e.g., stepCountIs(3)) */
  stopWhen?: Parameters<typeof streamText>[0]["stopWhen"];
  /** Callback fired when each step completes (for collecting tool results) */
  onStepFinish?: Parameters<typeof streamText>[0]["onStepFinish"];
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
  | { prompt: string; messages?: never; system?: string }
  | {
      messages: Parameters<typeof streamText>[0]["messages"];
      prompt?: never;
      system?: string;
    };

// =============================================================================
// High-Level Batch Types (User-Facing API)
// =============================================================================
// These types are for the AIHelper.batch() API. They are distinct from the
// low-level provider types in utils/batch/types.ts which have more fields
// for internal provider communication.

/** Provider identifier for batch operations */
export type AIBatchProvider = "google" | "anthropic" | "openai";

/** @deprecated Use AIBatchProvider instead */
export type BatchProvider = AIBatchProvider;

/** A request to be processed in a batch */
export interface AIBatchRequest {
  /** Unique identifier for this request (used to match results) */
  id: string;
  /** The prompt to send to the model */
  prompt: string;
  /** Optional Zod schema for structured JSON output */
  schema?: z.ZodTypeAny;
}

/** @deprecated Use AIBatchRequest instead */
export type BatchRequest = AIBatchRequest;

/** Result of a single request in a batch */
export interface AIBatchResult<T = string> {
  /** The request ID (matches the id from AIBatchRequest) */
  id: string;
  /** Original prompt (may be empty if not available from provider) */
  prompt: string;
  /** The parsed result (JSON object if schema was provided, otherwise string) */
  result: T;
  /** Input tokens used */
  inputTokens: number;
  /** Output tokens used */
  outputTokens: number;
  /** Status of this individual result */
  status: "succeeded" | "failed";
  /** Error message if status is "failed" */
  error?: string;
}

/** @deprecated Use AIBatchResult instead */
export type BatchResult<T = string> = AIBatchResult<T>;

/** Handle for tracking a submitted batch */
export interface AIBatchHandle {
  /** Batch identifier from the provider */
  id: string;
  /** Current status of the batch */
  status: "pending" | "processing" | "completed" | "failed";
  /** The provider used for this batch (for resume support) */
  provider?: AIBatchProvider;
}

/** @deprecated Use AIBatchHandle instead */
export type BatchHandle = AIBatchHandle;

/** Interface for batch operations on an AI model */
export interface AIBatch<T = string> {
  /** Submit requests for batch processing */
  submit(requests: AIBatchRequest[]): Promise<AIBatchHandle>;
  /** Check the status of a batch */
  getStatus(batchId: string): Promise<AIBatchHandle>;
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

export interface AIHelperStats {
  totalCalls: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCost: number;
  perModel: Record<
    string,
    { calls: number; inputTokens: number; outputTokens: number; cost: number }
  >;
}

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

  // Batch Methods - provider is optional, will auto-detect based on model
  batch<T = string>(modelKey: ModelKey, provider?: AIBatchProvider): AIBatch<T>;

  // Hierarchy Methods
  createChild(segment: string, id?: string): AIHelper;

  // Manual Recording (new object-based API)
  recordCall(params: RecordCallParams): void;

  // Manual Recording (legacy positional API for workflow compatibility)
  recordCall(
    modelKey: ModelKey,
    prompt: string,
    response: string,
    tokens: { input: number; output: number },
    options?: {
      callType?: AICallType;
      isBatch?: boolean;
      metadata?: Record<string, unknown>;
    },
  ): void;
  // Stats (queries DB)
  getStats(): Promise<AIHelperStats>;
}

// ============================================================================
// Helper Functions
// ============================================================================

function getModelProvider(modelConfig: ModelConfig) {
  if (modelConfig.provider === "openrouter") {
    // strict pricing: don't pay more than the model's defined cost
    // this effectively prevents routing to more expensive providers
    return openrouter(modelConfig.id, {
      extraBody: {
        provider: {
          sort: "throughput",
          max_price: {
            prompt: modelConfig.inputCostPerMillion,
            completion: modelConfig.outputCostPerMillion,
          },
        },
      },
    });
  }
  return google(modelConfig.id);
}

function calculateCostWithDiscount(
  modelKey: ModelKey,
  inputTokens: number,
  outputTokens: number,
  isBatch: boolean = false,
): number {
  const model = getModel(modelKey);
  const baseCost = calculateCost(modelKey, inputTokens, outputTokens);

  if (isBatch && model.batchDiscountPercent) {
    return baseCost.totalCost * (1 - model.batchDiscountPercent / 100);
  }

  return baseCost.totalCost;
}

// ============================================================================
// AIHelper Implementation
// ============================================================================

class AIHelperImpl implements AIHelper {
  readonly topic: string;
  private readonly aiCallLogger: AICallLogger;
  private readonly logContext?: LogContext;
  private readonly batchLogFn?: BatchLogFn;

  constructor(
    topic: string,
    aiCallLogger: AICallLogger,
    logContext?: LogContext,
  ) {
    if (!aiCallLogger) {
      throw new Error(
        "AIHelperImpl requires a logger. Create one using createPrismaAICallLogger(prisma).",
      );
    }
    this.topic = topic;
    this.aiCallLogger = aiCallLogger;
    this.logContext = logContext;

    // Create batch log function if logContext is provided
    if (logContext) {
      this.batchLogFn = (level, message, meta) => {
        // Fire and forget - don't block on persistence logging
        logContext
          .createLog({
            workflowRunId: logContext.workflowRunId,
            workflowStageId: logContext.stageRecordId,
            level,
            message,
            metadata: meta,
          })
          .catch((err) => logger.error("Failed to persist log:", err));
        // Also log to console for immediate visibility
        logger.debug(`[${level}] ${message}`, meta ? JSON.stringify(meta) : "");
      };
    }
  }

  async generateText<TTools extends ToolSet = ToolSet>(
    modelKey: ModelKey,
    prompt: TextInput,
    options: TextOptions<TTools> = {} as TextOptions<TTools>,
  ): Promise<AITextResult> {
    const modelConfig = getModel(modelKey);
    const model = getModelProvider(modelConfig);
    const startTime = Date.now();

    // Determine if we have multimodal content
    const isMultimodal = Array.isArray(prompt);
    const hasTools = options.tools !== undefined;
    const hasOutputSchema = options.experimental_output !== undefined;

    // Extract text prompt for logging (for multimodal, join text parts)
    const promptForLog = isMultimodal
      ? (prompt as ContentPart[])
          .filter((p): p is TextPart => p.type === "text")
          .map((p) => p.text)
          .join("\n") || "[multimodal content]"
      : (prompt as string);

    // Debug logging
    if (hasTools || hasOutputSchema) {
      logger.debug(
        `generateText config: hasTools=${hasTools}, hasOutputSchema=${hasOutputSchema}, toolNames=${hasTools ? Object.keys(options.tools || {}).join(", ") : "none"}`,
      );
    }

    // Create internal wrapper that logs tool usage and then calls user's callback
    const wrappedOnStepFinish = options.onStepFinish
      ? async (stepResult: StepResult<TTools>) => {
          // Log each tool result to a child topic
          if (stepResult.toolResults && Array.isArray(stepResult.toolResults)) {
            for (const toolResult of stepResult.toolResults) {
              const result = toolResult as {
                toolName?: string;
                toolCallId?: string;
                input?: unknown;
                output?: unknown;
              };
              if (result.toolName) {
                const childTopic = `${this.topic}.tool.${result.toolName}`;
                this.aiCallLogger.logCall({
                  topic: childTopic,
                  callType: "text",
                  modelKey: modelKey,
                  modelId: modelConfig.id,
                  prompt: JSON.stringify(result.input ?? {}, null, 2),
                  response: JSON.stringify(result.output ?? {}, null, 2),
                  inputTokens: stepResult.usage.inputTokens || 0,
                  outputTokens: stepResult.usage.outputTokens || 0,
                  cost: calculateCostWithDiscount(
                    modelKey,
                    stepResult.usage.inputTokens || 0,
                    stepResult.usage.outputTokens || 0,
                  ),
                  metadata: {
                    toolName: result.toolName,
                    toolCallId: result.toolCallId,
                    finishReason: stepResult.finishReason,
                  },
                });
              }
            }
          }
          // Call user's callback
          await options.onStepFinish?.(stepResult);
        }
      : undefined;

    // Build request based on input type
    const baseOptions = {
      model,
      temperature: options.temperature ?? 0.7,
      maxOutputTokens: options.maxTokens,
      // Tool-related options (only included if tools are provided)
      ...(hasTools && {
        tools: options.tools,
        // Cast to any because TTools generic doesn't match NoInfer<ToolSet> at compile time
        toolChoice: options.toolChoice as Parameters<
          typeof generateText
        >[0]["toolChoice"],
        stopWhen: options.stopWhen,
        onStepFinish: wrappedOnStepFinish as Parameters<
          typeof generateText
        >[0]["onStepFinish"],
      }),
      // Experimental structured output (for tools + schema)
      ...(hasOutputSchema && {
        experimental_output: options.experimental_output,
      }),
    };

    // Trace log before AI call
    logger.debug(`generateText request`, {
      model: modelKey,
      modelId: modelConfig.id,
      prompt:
        promptForLog.substring(0, 500) +
        (promptForLog.length > 500 ? "..." : ""),
      temperature: options.temperature ?? 0.7,
      maxTokens: options.maxTokens,
      hasTools,
      hasOutputSchema,
      isMultimodal,
    });

    try {
      // Cast to 'as any' to bypass AI SDK's strict NoInfer<TTools> constraints
      // Our TextOptions<TTools> provides proper typing at the interface level
      const result = isMultimodal
        ? await generateText({
            ...baseOptions,
            messages: [
              {
                role: "user" as const,
                content: (prompt as ContentPart[]).map((part) =>
                  part.type === "text"
                    ? { type: "text" as const, text: part.text }
                    : {
                        type: "file" as const,
                        data: part.data,
                        mediaType: part.mediaType,
                        ...(part.filename && { filename: part.filename }),
                      },
                ),
              },
            ],
          } as any)
        : await generateText({
            ...baseOptions,
            prompt,
          } as any);

      // Debug logging for result
      if (hasTools || hasOutputSchema) {
        const resultAny = result as { steps?: unknown[]; output?: unknown };
        logger.debug(
          `generateText result: stepsCount=${resultAny.steps?.length ?? 0}, hasOutput=${resultAny.output !== undefined}, finishReason=${result.finishReason}`,
        );
      }

      const inputTokens = result.usage?.inputTokens ?? 0;
      const outputTokens = result.usage?.outputTokens ?? 0;
      const cost = calculateCostWithDiscount(
        modelKey,
        inputTokens,
        outputTokens,
      );
      const durationMs = Date.now() - startTime;

      // Log the call (including error cases where finishReason is "error")
      this.aiCallLogger.logCall({
        topic: this.topic,
        callType: "text",
        modelKey,
        modelId: modelConfig.id,
        prompt: promptForLog,
        response: result.text,
        inputTokens,
        outputTokens,
        cost,
        metadata: {
          temperature: options.temperature,
          maxTokens: options.maxTokens,
          finishReason: result.finishReason,
          durationMs,
          isMultimodal,
          ...(result.finishReason === "error" && { status: "error" }),
          ...(isMultimodal && {
            mediaTypes: (prompt as ContentPart[])
              .filter((p): p is MediaPart => p.type === "file")
              .map((p) => p.mediaType),
          }),
        },
      });

      // Trace log after successful AI call
      logger.debug(`generateText response`, {
        model: modelKey,
        response:
          result.text.substring(0, 500) +
          (result.text.length > 500 ? "..." : ""),
        inputTokens,
        outputTokens,
        cost: cost.toFixed(6),
        durationMs,
        finishReason: result.finishReason,
      });

      return {
        text: result.text,
        inputTokens,
        outputTokens,
        cost,
        // Include structured output if experimental_output was used
        ...(hasOutputSchema && {
          output: (result as { output?: unknown }).output,
        }),
      };
    } catch (error) {
      // Log the failed call before re-throwing
      const durationMs = Date.now() - startTime;
      const errorMessage =
        error instanceof Error ? error.message : String(error);

      // Trace log for error
      logger.error(`generateText error`, {
        model: modelKey,
        error: errorMessage,
        durationMs,
      });

      this.aiCallLogger.logCall({
        topic: this.topic,
        callType: "text",
        modelKey,
        modelId: modelConfig.id,
        prompt: promptForLog,
        response: "",
        inputTokens: 0,
        outputTokens: 0,
        cost: 0,
        metadata: {
          temperature: options.temperature,
          maxTokens: options.maxTokens,
          finishReason: "error",
          durationMs,
          isMultimodal,
          status: "error",
          error: errorMessage,
        },
      });

      throw error;
    }
  }

  async generateObject<TSchema extends z.ZodTypeAny>(
    modelKey: ModelKey,
    prompt: TextInput,
    schema: TSchema,
    options: ObjectOptions = {},
  ): Promise<AIObjectResult<z.infer<TSchema>>> {
    const modelConfig = getModel(modelKey);
    const model = getModelProvider(modelConfig);
    const startTime = Date.now();

    // Determine if we have multimodal content
    const isMultimodal = Array.isArray(prompt);
    const hasTools = options.tools !== undefined;

    // Extract text prompt for logging (for multimodal, join text parts)
    const promptForLog = isMultimodal
      ? (prompt as ContentPart[])
          .filter((p): p is TextPart => p.type === "text")
          .map((p) => p.text)
          .join("\n") || "[multimodal content]"
      : (prompt as string);

    // Build request based on input type
    const baseOptions = {
      model,
      schema,
      temperature: options.temperature ?? 0,
      maxOutputTokens: options.maxTokens,
      // Tool-related options (only included if tools are provided)
      ...(hasTools && {
        tools: options.tools,
        stopWhen: options.stopWhen,
        onStepFinish: options.onStepFinish,
      }),
    };

    // Trace log before AI call
    logger.debug(`generateObject request`, {
      model: modelKey,
      modelId: modelConfig.id,
      prompt:
        promptForLog.substring(0, 500) +
        (promptForLog.length > 500 ? "..." : ""),
      temperature: options.temperature ?? 0,
      maxTokens: options.maxTokens,
      hasTools,
      isMultimodal,
    });

    try {
      const result = isMultimodal
        ? await generateObject({
            ...baseOptions,
            messages: [
              {
                role: "user" as const,
                content: (prompt as ContentPart[]).map((part) =>
                  part.type === "text"
                    ? { type: "text" as const, text: part.text }
                    : {
                        type: "file" as const,
                        data: part.data,
                        mediaType: part.mediaType,
                        ...(part.filename && { filename: part.filename }),
                      },
                ),
              },
            ],
          })
        : await generateObject({
            ...baseOptions,
            prompt,
          });

      const inputTokens = result.usage?.inputTokens ?? 0;
      const outputTokens = result.usage?.outputTokens ?? 0;
      const cost = calculateCostWithDiscount(
        modelKey,
        inputTokens,
        outputTokens,
      );
      const durationMs = Date.now() - startTime;

      // Log the call (including error cases where finishReason is "error")
      this.aiCallLogger.logCall({
        topic: this.topic,
        callType: "object",
        modelKey,
        modelId: modelConfig.id,
        prompt: promptForLog,
        response: JSON.stringify(result.object, null, 2),
        inputTokens,
        outputTokens,
        cost,
        metadata: {
          temperature: options.temperature,
          maxTokens: options.maxTokens,
          finishReason: result.finishReason,
          durationMs,
          isMultimodal,
          ...(result.finishReason === "error" && { status: "error" }),
          ...(isMultimodal && {
            mediaTypes: (prompt as ContentPart[])
              .filter((p): p is MediaPart => p.type === "file")
              .map((p) => p.mediaType),
          }),
        },
      });

      // Trace log after successful AI call
      const responseStr = JSON.stringify(result.object);
      logger.debug(`generateObject response`, {
        model: modelKey,
        response:
          responseStr.substring(0, 500) +
          (responseStr.length > 500 ? "..." : ""),
        inputTokens,
        outputTokens,
        cost: cost.toFixed(6),
        durationMs,
        finishReason: result.finishReason,
      });

      return {
        object: result.object as z.infer<TSchema>,
        inputTokens,
        outputTokens,
        cost,
      };
    } catch (error) {
      // Log the failed call before re-throwing
      const durationMs = Date.now() - startTime;
      const errorMessage =
        error instanceof Error ? error.message : String(error);

      // Trace log for error
      logger.error(`generateObject error`, {
        model: modelKey,
        error: errorMessage,
        durationMs,
      });

      this.aiCallLogger.logCall({
        topic: this.topic,
        callType: "object",
        modelKey,
        modelId: modelConfig.id,
        prompt: promptForLog,
        response: "",
        inputTokens: 0,
        outputTokens: 0,
        cost: 0,
        metadata: {
          temperature: options.temperature,
          maxTokens: options.maxTokens,
          finishReason: "error",
          durationMs,
          isMultimodal,
          status: "error",
          error: errorMessage,
        },
      });

      throw error;
    }
  }

  async embed(
    modelKey: ModelKey,
    text: string | string[],
    options: EmbedOptions = {},
  ): Promise<AIEmbedResult> {
    const modelConfig = getModel(modelKey);
    const texts = Array.isArray(text) ? text : [text];
    const startTime = Date.now();

    // Use dimensions from options, or fall back to active config
    const dimensions = options.dimensions ?? DEFAULT_EMBEDDING_DIMENSIONS;

    // Trace log before embed call
    const textPreview =
      texts.length === 1
        ? texts[0].substring(0, 200) + (texts[0].length > 200 ? "..." : "")
        : `[${texts.length} texts]`;
    logger.debug(`embed request`, {
      model: modelKey,
      modelId: modelConfig.id,
      textCount: texts.length,
      textPreview,
      dimensions,
      taskType: options.taskType ?? "RETRIEVAL_DOCUMENT",
    });

    try {
      // For single text, use embed directly
      // For multiple texts, we need to call embed for each (AI SDK doesn't have batch embed)
      const embeddings: number[][] = [];
      let totalInputTokens = 0;

      for (const t of texts) {
        // Strip google/ prefix if present - Google SDK expects just the model name
        const embeddingModelId = modelConfig.id.replace(/^google\//, "");

        const result = await embed({
          model: google.embeddingModel(embeddingModelId),
          value: t,
          providerOptions: {
            google: {
              outputDimensionality: dimensions,
              taskType: options.taskType ?? "RETRIEVAL_DOCUMENT",
            },
          },
        });

        embeddings.push(result.embedding);
        totalInputTokens += result.usage?.tokens || 0;
      }

      const outputTokens = 0; // Embeddings have no output tokens
      const cost = calculateCostWithDiscount(
        modelKey,
        totalInputTokens,
        outputTokens,
      );
      const durationMs = Date.now() - startTime;

      this.aiCallLogger.logCall({
        topic: this.topic,
        callType: "embed",
        modelKey,
        modelId: modelConfig.id,
        prompt: texts.length === 1 ? texts[0] : `[${texts.length} texts]`,
        response: `[${embeddings.length} embeddings, ${dimensions} dims]`,
        inputTokens: totalInputTokens,
        outputTokens,
        cost,
        metadata: {
          taskType: options.taskType,
          textCount: texts.length,
          dimensions,
          durationMs,
        },
      });

      // Trace log after successful embed call
      logger.debug(`embed response`, {
        model: modelKey,
        embeddingsCount: embeddings.length,
        dimensions,
        inputTokens: totalInputTokens,
        cost: cost.toFixed(6),
        durationMs,
      });

      return {
        embedding: embeddings[0], // Convenience: first embedding
        embeddings, // All embeddings
        dimensions, // Dimensionality used
        inputTokens: totalInputTokens,
        cost,
      };
    } catch (error) {
      // Log the failed call before re-throwing
      const durationMs = Date.now() - startTime;
      const errorMessage =
        error instanceof Error ? error.message : String(error);

      // Trace log for error
      logger.error(`embed error`, {
        model: modelKey,
        error: errorMessage,
        durationMs,
      });

      this.aiCallLogger.logCall({
        topic: this.topic,
        callType: "embed",
        modelKey,
        modelId: modelConfig.id,
        prompt: texts.length === 1 ? texts[0] : `[${texts.length} texts]`,
        response: "",
        inputTokens: 0,
        outputTokens: 0,
        cost: 0,
        metadata: {
          taskType: options.taskType,
          textCount: texts.length,
          dimensions,
          durationMs,
          status: "error",
          error: errorMessage,
        },
      });

      throw error;
    }
  }

  streamText(
    modelKey: ModelKey,
    input: StreamTextInput,
    options: StreamOptions = {},
  ): AIStreamResult {
    const modelConfig = getModel(modelKey);
    const model = getModelProvider(modelConfig);
    const startTime = Date.now();
    const hasTools = options.tools !== undefined;

    // For logging, extract prompt string
    const promptForLog =
      "prompt" in input && input.prompt
        ? input.prompt
        : JSON.stringify(input.messages);

    // Track whether we've logged an error (to avoid duplicate logs)
    let errorLogged = false;

    // Error handler that logs the error to DB
    const logError = (error: unknown) => {
      if (errorLogged) return;
      errorLogged = true;

      const durationMs = Date.now() - startTime;
      const errorMessage =
        error instanceof Error ? error.message : String(error);

      this.aiCallLogger.logCall({
        topic: this.topic,
        callType: "stream",
        modelKey,
        modelId: modelConfig.id,
        prompt: promptForLog,
        response: "",
        inputTokens: 0,
        outputTokens: 0,
        cost: 0,
        metadata: {
          temperature: options.temperature,
          maxTokens: options.maxTokens,
          durationMs,
          status: "error",
          error: errorMessage,
          ...(input.system ? { system: input.system } : {}),
        },
      });
    };

    // Trace log before stream starts
    logger.debug(`streamText request`, {
      model: modelKey,
      modelId: modelConfig.id,
      prompt:
        promptForLog.substring(0, 500) +
        (promptForLog.length > 500 ? "..." : ""),
      temperature: options.temperature ?? 0.7,
      maxTokens: options.maxTokens,
      hasTools,
      hasSystem: !!input.system,
    });

    // Build the streamText params based on input type
    const baseParams = {
      model,
      temperature: options.temperature ?? 0.7,
      maxOutputTokens: options.maxTokens,
      ...(input.system ? { system: input.system } : {}),
      // Tool-related options (only included if tools are provided)
      ...(hasTools && {
        tools: options.tools,
        stopWhen: options.stopWhen,
        onStepFinish: options.onStepFinish,
      }),
      // Error callback to log streaming errors
      onError: ({ error }: { error: unknown }) => {
        logError(error);
      },
    };

    const result =
      "messages" in input && input.messages
        ? streamText({ ...baseParams, messages: input.messages })
        : streamText({
            ...baseParams,
            prompt: (input as { prompt: string }).prompt,
          });

    let fullText = "";
    let chunkCount = 0;
    let streamConsumed = false;
    let usageResolved = false;
    let cachedUsage: {
      inputTokens: number;
      outputTokens: number;
      cost: number;
    } | null = null;

    // Create async iterable that collects text and calls onChunk
    const streamIterable: AsyncIterable<string> = {
      [Symbol.asyncIterator]: () => {
        const reader = result.textStream[Symbol.asyncIterator]();
        return {
          async next() {
            try {
              const { done, value } = await reader.next();
              if (done) {
                streamConsumed = true;
                return { done: true, value: undefined };
              }
              fullText += value;
              chunkCount++;
              options.onChunk?.(value);
              return { done: false, value };
            } catch (error) {
              // Log streaming error before re-throwing
              logError(error);
              throw error;
            }
          },
        };
      },
    };

    // Create usage getter that waits for stream completion and persists
    const getUsage = async () => {
      // Return cached usage if already resolved
      if (usageResolved && cachedUsage) {
        return cachedUsage;
      }

      // If stream not yet consumed, consume it first
      if (!streamConsumed) {
        for await (const _ of streamIterable) {
          // Consume the stream
        }
      }

      const usage = await result.usage;
      const inputTokens = usage?.inputTokens ?? 0;
      const outputTokens = usage?.outputTokens ?? 0;
      const cost = calculateCostWithDiscount(
        modelKey,
        inputTokens,
        outputTokens,
      );
      const durationMs = Date.now() - startTime;

      // Only persist once
      if (!usageResolved) {
        usageResolved = true;
        cachedUsage = { inputTokens, outputTokens, cost };

        // Trace log after stream completion
        logger.debug(`streamText response`, {
          model: modelKey,
          response:
            fullText.substring(0, 500) + (fullText.length > 500 ? "..." : ""),
          inputTokens,
          outputTokens,
          cost: cost.toFixed(6),
          durationMs,
          chunkCount,
        });

        // Persist to DB
        this.aiCallLogger.logCall({
          topic: this.topic,
          callType: "stream",
          modelKey,
          modelId: modelConfig.id,
          prompt: promptForLog,
          response: fullText,
          inputTokens,
          outputTokens,
          cost,
          metadata: {
            temperature: options.temperature,
            maxTokens: options.maxTokens,
            streamChunks: chunkCount,
            durationMs,
            ...(input.system ? { system: input.system } : {}),
          },
        });
      }

      return cachedUsage ?? { inputTokens, outputTokens, cost };
    };

    return {
      stream: streamIterable,
      getUsage,
      rawResult: result,
    };
  }

  batch<T = string>(
    modelKey: ModelKey,
    provider?: AIBatchProvider,
  ): AIBatch<T> {
    const resolvedProvider =
      provider ?? getBestProviderForModel(modelKey) ?? "google";
    return new AIBatchImpl<T>(
      this,
      modelKey,
      resolvedProvider,
      this.batchLogFn,
    );
  }

  createChild(segment: string, id?: string): AIHelper {
    const newTopic = id
      ? `${this.topic}.${segment}.${id}`
      : `${this.topic}.${segment}`;
    // Preserve logContext for child helpers (same workflow context)
    return new AIHelperImpl(newTopic, this.aiCallLogger, this.logContext);
  }

  /** @internal Get the logger for batch operations */
  getLogger(): AICallLogger {
    return this.aiCallLogger;
  }

  // Overloaded recordCall to support both new object-based API and legacy positional API
  recordCall(
    paramsOrModelKey: RecordCallParams | ModelKey,
    prompt?: string,
    response?: string,
    tokens?: { input: number; output: number },
    options?: {
      callType?: AICallType;
      isBatch?: boolean;
      metadata?: Record<string, unknown>;
    },
  ): void {
    let modelKey: ModelKey;
    let actualPrompt: string;
    let actualResponse: string;
    let inputTokens: number;
    let outputTokens: number;
    let callType: AICallType;
    let isBatch: boolean;
    let metadata: Record<string, unknown> | undefined;

    // Check if first argument is the new object-based params or legacy modelKey string
    if (
      typeof paramsOrModelKey === "object" &&
      "modelKey" in paramsOrModelKey
    ) {
      // New object-based API
      const params = paramsOrModelKey as RecordCallParams;
      modelKey = params.modelKey;
      actualPrompt = params.prompt;
      actualResponse = params.response;
      inputTokens = params.inputTokens;
      outputTokens = params.outputTokens;
      callType = params.callType;
      isBatch = callType === "batch";
      metadata = params.metadata;
    } else {
      // Legacy positional API
      if (!prompt || !response || !tokens) {
        throw new Error(
          "recordCall: legacy API requires prompt, response, and tokens",
        );
      }
      modelKey = paramsOrModelKey as ModelKey;
      actualPrompt = prompt;
      actualResponse = response;
      inputTokens = tokens.input;
      outputTokens = tokens.output;
      callType = options?.callType ?? "text";
      isBatch = options?.isBatch ?? false;
      metadata = options?.metadata;
    }

    const modelConfig = getModel(modelKey);
    const cost = calculateCostWithDiscount(
      modelKey,
      inputTokens,
      outputTokens,
      isBatch,
    );

    // Persist to DB (fire and forget)
    this.aiCallLogger.logCall({
      topic: this.topic,
      callType,
      modelKey,
      modelId: modelConfig.id,
      prompt: actualPrompt,
      response: actualResponse,
      inputTokens,
      outputTokens,
      cost,
      metadata: isBatch ? { ...metadata, isBatch: true } : metadata,
    });
  }

  async getStats(): Promise<AIHelperStats> {
    return this.aiCallLogger.getStats(this.topic);
  }
}

// ============================================================================
// Batch Implementation
// ============================================================================

class AIBatchImpl<T = string> implements AIBatch<T> {
  private googleProvider: GoogleBatchProvider | null = null;
  private anthropicProvider: AnthropicBatchProvider | null = null;
  private openaiProvider: OpenAIBatchProvider | null = null;

  constructor(
    private helper: AIHelperImpl,
    private modelKey: ModelKey,
    private provider: AIBatchProvider,
    private batchLogFn?: BatchLogFn,
  ) {
    // Create a logger adapter for batch providers
    // Uses provided log function (for persistence) or falls back to console
    const batchLogger = {
      log: (
        level: "DEBUG" | "INFO" | "WARN" | "ERROR",
        message: string,
        meta?: Record<string, unknown>,
      ) => {
        if (this.batchLogFn) {
          this.batchLogFn(level, `[Batch:${provider}] ${message}`, meta);
        } else {
          logger.debug(
            `[Batch:${provider}] [${level}] ${message}`,
            meta ? JSON.stringify(meta) : "",
          );
        }
      },
    };

    // Initialize the actual provider with logger
    if (provider === "google") {
      this.googleProvider = new GoogleBatchProvider({}, batchLogger);
    } else if (provider === "anthropic") {
      this.anthropicProvider = new AnthropicBatchProvider({}, batchLogger);
    } else if (provider === "openai") {
      this.openaiProvider = new OpenAIBatchProvider({}, batchLogger);
    }
  }

  async submit(requests: AIBatchRequest[]): Promise<AIBatchHandle> {
    // Trace log before batch submission
    logger.debug(`batch submit request`, {
      provider: this.provider,
      model: this.modelKey,
      requestCount: requests.length,
      requestIds: requests.slice(0, 10).map((r) => r.id),
      hasMoreRequests: requests.length > 10,
    });

    const jsonSystemPrompt =
      "You must respond with valid JSON only. No markdown, no explanation, just the JSON object.";

    if (this.provider === "google" && this.googleProvider) {
      const googleRequests = requests.map((req) => ({
        id: req.id,
        prompt: req.prompt,
        model: this.modelKey,
        ...(req.schema && { system: jsonSystemPrompt, schema: req.schema }),
      }));
      const handle = await this.googleProvider.submit(googleRequests);
      logger.debug(`batch submitted`, {
        provider: "google",
        batchId: handle.id,
        requestCount: requests.length,
      });
      return { id: handle.id, status: "pending", provider: this.provider };
    }

    if (this.provider === "anthropic" && this.anthropicProvider) {
      const anthropicRequests = requests.map((req) => ({
        customId: req.id,
        prompt: req.prompt,
        model: this.modelKey,
        ...(req.schema && { system: jsonSystemPrompt }),
      }));
      const handle = await this.anthropicProvider.submit(anthropicRequests);
      logger.debug(`batch submitted`, {
        provider: "anthropic",
        batchId: handle.id,
        requestCount: requests.length,
      });
      return { id: handle.id, status: "pending", provider: this.provider };
    }

    if (this.provider === "openai" && this.openaiProvider) {
      const openaiRequests = requests.map((req) => ({
        customId: req.id,
        prompt: req.prompt,
        model: this.modelKey,
        ...(req.schema && { system: jsonSystemPrompt }),
      }));
      const handle = await this.openaiProvider.submit(openaiRequests);
      logger.debug(`batch submitted`, {
        provider: "openai",
        batchId: handle.id,
        requestCount: requests.length,
      });
      return { id: handle.id, status: "pending", provider: this.provider };
    }

    throw new Error(
      `Batch submission for provider "${this.provider}" not yet implemented. ` +
        `Use recordCall() to manually record batch results.`,
    );
  }

  async getStatus(batchId: string): Promise<AIBatchHandle> {
    const handle = {
      id: batchId,
      provider: this.provider,
      requestCount: 0,
      createdAt: new Date(),
    };
    let status: { state: string };

    if (this.provider === "google" && this.googleProvider) {
      status = await this.googleProvider.checkStatus(handle);
    } else if (this.provider === "anthropic" && this.anthropicProvider) {
      status = await this.anthropicProvider.checkStatus(handle);
    } else if (this.provider === "openai" && this.openaiProvider) {
      status = await this.openaiProvider.checkStatus(handle);
    } else {
      throw new Error(
        `Batch status check for provider "${this.provider}" not yet implemented.`,
      );
    }

    let batchStatus: "pending" | "processing" | "completed" | "failed";
    switch (status.state) {
      case "completed":
        batchStatus = "completed";
        break;
      case "failed":
        batchStatus = "failed";
        break;
      case "processing":
        batchStatus = "processing";
        break;
      default:
        batchStatus = "pending";
    }

    return { id: batchId, status: batchStatus, provider: this.provider };
  }

  async getResults(
    batchId: string,
    metadata?: Record<string, unknown>,
  ): Promise<AIBatchResult<T>[]> {
    // Debug: Log received metadata to trace customIds flow
    if (this.batchLogFn) {
      this.batchLogFn("DEBUG", `[AIBatch:getResults] Received metadata`, {
        hasMetadata: !!metadata,
        metadataKeys: metadata ? Object.keys(metadata) : [],
        hasCustomIds: !!metadata?.customIds,
        customIdsCount: Array.isArray(metadata?.customIds)
          ? metadata.customIds.length
          : 0,
      });
    }

    const handle = {
      id: batchId,
      provider: this.provider,
      requestCount: 0,
      createdAt: new Date(),
      metadata,
    };
    let rawResults: Array<{
      customId?: string;
      text: string;
      inputTokens: number;
      outputTokens: number;
      error?: string;
    }>;

    if (this.provider === "google" && this.googleProvider) {
      // Pass metadata for customId mapping
      rawResults = await this.googleProvider.getResults(handle);
    } else if (this.provider === "anthropic" && this.anthropicProvider) {
      rawResults = await this.anthropicProvider.getResults(handle);
    } else if (this.provider === "openai" && this.openaiProvider) {
      rawResults = await this.openaiProvider.getResults(handle);
    } else {
      throw new Error(
        `Batch results for provider "${this.provider}" not yet implemented. ` +
          `Use recordCall() to manually record batch results.`,
      );
    }

    // Trace log after results retrieved
    const totalInputTokens = rawResults.reduce(
      (sum, r) => sum + (r.inputTokens || 0),
      0,
    );
    const totalOutputTokens = rawResults.reduce(
      (sum, r) => sum + (r.outputTokens || 0),
      0,
    );
    const failedCount = rawResults.filter((r) => r.error).length;
    logger.debug(`batch getResults response`, {
      batchId,
      provider: this.provider,
      resultCount: rawResults.length,
      failedCount,
      totalInputTokens,
      totalOutputTokens,
    });

    // Transform RawBatchResult to AIBatchResult<T>
    const results: AIBatchResult<T>[] = rawResults.map((raw, index) => {
      // Check if this request failed
      if (raw.error) {
        return {
          id: raw.customId || `result-${index}`,
          prompt: "", // Not available from raw results
          result: {} as T, // Empty result for failed requests
          inputTokens: raw.inputTokens || 0,
          outputTokens: raw.outputTokens || 0,
          status: "failed" as const,
          error: raw.error,
        };
      }

      // Try to parse JSON if the result looks like JSON
      let parsedResult: T;
      try {
        // Clean markdown code blocks before parsing
        let cleaned = raw.text.trim();
        if (cleaned.startsWith("```json")) {
          cleaned = cleaned.slice(7);
        } else if (cleaned.startsWith("```")) {
          cleaned = cleaned.slice(3);
        }
        if (cleaned.endsWith("```")) {
          cleaned = cleaned.slice(0, -3);
        }
        cleaned = cleaned.trim();
        parsedResult = JSON.parse(cleaned) as T;
      } catch {
        parsedResult = raw.text as unknown as T;
      }

      return {
        id: raw.customId || `result-${index}`,
        prompt: "", // Not available from raw results
        result: parsedResult,
        inputTokens: raw.inputTokens || 0,
        outputTokens: raw.outputTokens || 0,
        status: "succeeded" as const,
      };
    });

    // Auto-record results
    await this.recordResults(batchId, results);

    return results;
  }

  async isRecorded(batchId: string): Promise<boolean> {
    return this.helper.getLogger().isRecorded(batchId);
  }

  /**
   * Record batch results manually.
   * Use this when batch provider integration is not yet implemented.
   */
  async recordResults(
    batchId: string,
    results: AIBatchResult<T>[],
  ): Promise<void> {
    // Check if already recorded
    if (await this.isRecorded(batchId)) {
      logger.debug(`Batch ${batchId} already recorded, skipping.`);
      return;
    }

    const modelConfig = getModel(this.modelKey);
    const discountPercent = modelConfig.batchDiscountPercent ?? 0;

    // Record all results via logger
    await this.helper.getLogger().logBatchResults(
      batchId,
      results.map((r) => {
        const baseCost = calculateCost(
          this.modelKey,
          r.inputTokens,
          r.outputTokens,
        );
        const cost = baseCost.totalCost * (1 - discountPercent / 100);

        return {
          topic: this.helper.topic,
          callType: "batch",
          modelKey: this.modelKey,
          modelId: modelConfig.id,
          prompt: r.prompt,
          response:
            typeof r.result === "string" ? r.result : JSON.stringify(r.result),
          inputTokens: r.inputTokens,
          outputTokens: r.outputTokens,
          cost,
          metadata: { batchId, requestId: r.id },
        };
      }),
    );
  }
}

// ============================================================================
// Factory Function
// ============================================================================

/**
 * Create an AI helper instance with topic-based tracking.
 *
 * @param topic - Initial topic path (e.g., "workflow.abc123" or "reranker")
 * @returns AIHelper instance
 *
 * @example
 * ```typescript
 * // Simple topic
 * const ai = createAIHelper("reranker");
 *
 * // Hierarchical topic
 * const ai = createAIHelper("workflow.abc123", logger)
 *   .createChild("stage", "extraction");
 * // topic: "workflow.abc123.stage.extraction"
 *
 * // Use AI methods
 * const result = await ai.generateText("gemini-2.5-flash", prompt);
 * ```
 */
export function createAIHelper(
  topic: string,
  logger: AICallLogger,
  logContext?: LogContext,
): AIHelper {
  return new AIHelperImpl(topic, logger, logContext);
}

// Re-export types from this module
export type { ModelKey } from "./model-helper";
