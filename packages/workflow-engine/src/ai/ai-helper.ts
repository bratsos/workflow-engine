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
 * Implementation is split across generate.ts, embeddings.ts, stream.ts, and
 * batch-helper.ts; this file wires them together behind the AIHelper
 * interface and owns createChild/recordCall/getStats - the state that
 * doesn't belong to any one AI call type.
 *
 * @example
 * ```typescript
 * const ai = createAIHelper("workflow.abc123").createChild("stage", "extraction");
 * const result = await ai.generateText("gemini-2.5-flash", prompt);
 * ```
 */

import type { ToolSet } from "ai";
import type { z } from "zod";
import { assertTimerMs } from "../kernel/helpers/host-support";
import type {
  AICallFlushOptions,
  AICallLogger,
  CreateAICallInput,
} from "../persistence/interface";
import { getBestProviderForModel } from "../utils/batch/model-mapping";
import { isTraceTextEnabled } from "../utils/logger";
import { AIBatchImpl } from "./batch-helper";
import { embed as embedImpl } from "./embeddings";
import { evaluate as evaluateImpl } from "./evaluate";
import {
  generateObject as generateObjectImpl,
  generateText as generateTextImpl,
} from "./generate";
import { getModel, type ModelKey } from "./model-helper";
import {
  forwardingProxy,
  traceProviderDiagnostic,
} from "./provider-diagnostics.js";
import { calculateCostWithDiscount, logger } from "./shared";
import { streamText as streamTextImpl } from "./stream";
import { transcribe as transcribeImpl } from "./transcribe";
import type {
  AIBatch,
  AIBatchProvider,
  AIEmbedResult,
  AIEvaluateResult,
  AIHelper,
  AIHelperChildOptions,
  AIHelperContext,
  AIHelperOptions,
  AIHelperStats,
  AIObjectResult,
  AIStreamResult,
  AITextResult,
  AITranscribeResult,
  BatchLogFn,
  BatchOptions,
  EmbedOptions,
  EvaluateOptions,
  EvaluationQuestions,
  EvaluationSpec,
  LogContext,
  ObjectOptions,
  ProviderResolver,
  RecordCallParams,
  StageAIHelperOptions,
  StreamOptions,
  StreamTextInput,
  TextInput,
  TextOptions,
  TranscribeOptions,
  TranscriptionAudio,
} from "./types";
import { AICallWriteTracker } from "./write-tracker";

// ============================================================================
// AIHelper Implementation
// ============================================================================

// Symbol.for, so a second copy of this module resolves the same key.
const CALL_LOGGER: unique symbol = Symbol.for("workflow-engine.callLogger");

/**
 * The policy-applying logger of a helper made here, including children. Spread,
 * Proxy and Object.create wrappers of such a helper resolve to it as well.
 */
export function callLoggerOf(helper: AIHelper): AICallLogger | undefined {
  return (helper as { [CALL_LOGGER]?: AICallLogger })[CALL_LOGGER];
}

type TextPolicy = AIHelperOptions["text"];
// Lower is stricter: no text, then the shortest expiry, then text kept without expiry.
const strictness = (text: TextPolicy) =>
  text?.store === "none" ? -1 : (text?.ttlMs ?? Number.POSITIVE_INFINITY);

/**
 * For a helper the engine cannot resolve: a logger with the attribution of the
 * first of `helpers` and the strictest text policy among them, counted by the
 * helper that has that policy. Undefined when none of them was made here.
 */
export function failSafeCallLogger(
  helpers: readonly AIHelper[],
): AICallLogger | undefined {
  return AIHelperImpl.failSafeLogger(helpers);
}

class AIHelperImpl implements AIHelper {
  /** Own and enumerable, so spread copies it; Proxy and Object.create reach it. */
  readonly [CALL_LOGGER]: AICallLogger;
  readonly topic: string;
  private readonly aiCallLogger: AICallLogger;
  private readonly logContext?: LogContext;
  private readonly batchLogFn?: BatchLogFn;
  private readonly providerResolver?: ProviderResolver;
  private readonly options?: StageAIHelperOptions;
  private readonly writes: AICallWriteTracker;
  private readonly trackedLogger: AICallLogger;

  constructor(
    topic: string,
    aiCallLogger: AICallLogger,
    logContext?: LogContext,
    providerResolver?: ProviderResolver,
    options?: StageAIHelperOptions,
    parentWrites?: AICallWriteTracker,
  ) {
    if (!aiCallLogger) {
      throw new Error(
        "AIHelperImpl requires a logger. Create one using createPrismaAICallLogger(prisma).",
      );
    }
    if (options?.timeout?.perCallMs !== undefined) {
      assertTimerMs("timeout.perCallMs", options.timeout.perCallMs);
    }
    this.topic = topic;
    this.aiCallLogger = aiCallLogger;
    this.logContext = logContext;
    this.providerResolver = providerResolver;
    this.options = options;
    this.writes = new AICallWriteTracker(parentWrites);
    const writes: Partial<AICallLogger> = {
      logCall: (input) => {
        const call = this.prepareCall(input);
        return this.trackWrite([call], () => aiCallLogger.logCall(call));
      },
      logBatchResults: (batchId, inputs) => {
        const calls = inputs.map((input) => this.prepareCall(input));
        return this.trackWrite(calls, () =>
          aiCallLogger.logBatchResults(batchId, calls),
        );
      },
      flush: (config) => this.flush(config),
    };
    // Reads and any logger-specific members are those of the configured logger.
    this.trackedLogger = forwardingProxy(aiCallLogger, (key, value) =>
      Object.hasOwn(writes, key) ? writes[key as keyof AICallLogger] : value,
    );
    this[CALL_LOGGER] = this.trackedLogger;

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
          .catch((err) =>
            logger.error(
              "Failed to persist log",
              ...(isTraceTextEnabled() ? [err] : []),
            ),
          );
        // Also log to console for immediate visibility. Workflow log messages
        // can quote provider responses.
        logger.debug(
          `[${level}] ${isTraceTextEnabled() ? message : "workflow log written"}`,
          meta ? JSON.stringify(meta) : "",
        );
      };
    }
    options?.onHelper?.(this);
  }

  private prepareCall(input: CreateAICallInput): CreateAICallInput {
    const { attribution, text } = this.options ?? {};
    const call: CreateAICallInput = {
      ...input,
      tenantId: attribution?.tenantId,
      labels: attribution?.labels,
      workflowRunId:
        attribution?.workflowRunId ?? this.logContext?.workflowRunId,
    };
    if (
      (text?.store === "none" || text?.ttlMs !== undefined) &&
      call.metadata &&
      typeof call.metadata === "object" &&
      Object.hasOwn(call.metadata, "error")
    ) {
      // A provider can quote the request in its error, and text retention
      // does not clear metadata.
      call.metadata = { ...call.metadata, error: "AI call failed" };
    }
    if (text?.store === "none") {
      call.prompt = "";
      call.response = "";
      if (
        call.metadata &&
        typeof call.metadata === "object" &&
        Object.hasOwn(call.metadata, "instructions")
      ) {
        const { instructions: _, ...metadata } = call.metadata as Record<
          string,
          unknown
        >;
        call.metadata = metadata;
      }
    } else if (text?.ttlMs !== undefined) {
      call.textExpiresAt = new Date(Date.now() + text.ttlMs);
    }
    return call;
  }

  private trackWrite(
    calls: CreateAICallInput[],
    write: () => void | Promise<void>,
  ): Promise<void> {
    const done = this.writes.begin();
    const onFailure = (error: unknown) => {
      this.writes.fail();
      for (const call of calls) {
        try {
          void Promise.resolve(this.options?.onLogError?.(error, call)).catch(
            () => {},
          );
        } catch {
          // A reporting callback cannot change the model result or block flush.
        }
      }
      done();
    };
    let result: void | Promise<void>;
    try {
      result = write();
    } catch (error) {
      // A synchronous throw still reaches the caller, as in earlier releases.
      onFailure(error);
      throw error;
    }
    if (!result) {
      done();
      return Promise.resolve();
    }
    // A database error can quote the row it refused; callers get a safe one.
    const tracked = Promise.resolve(result).then(done, (error: unknown) => {
      onFailure(error);
      traceProviderDiagnostic("AI call accounting write failed", error);
      throw new Error("AI call accounting write failed");
    });
    void tracked.catch(() => {});
    return tracked;
  }

  static failSafeLogger(
    helpers: readonly AIHelper[],
  ): AICallLogger | undefined {
    const made = helpers.filter((h) => h instanceof AIHelperImpl);
    const root = made[0];
    if (!root) return undefined;
    const strictest = made.reduce((a, b) =>
      strictness(b.options?.text) < strictness(a.options?.text) ? b : a,
    );
    return new AIHelperImpl(
      root.topic,
      root.aiCallLogger,
      root.logContext,
      root.providerResolver,
      { ...root.options, text: strictest.options?.text },
      strictest.writes,
    ).trackedLogger;
  }

  /** Bundle the state generateText/generateObject/embed/streamText/batch need. */
  private context(): AIHelperContext {
    return {
      topic: this.topic,
      aiCallLogger: this.trackedLogger,
      track: (work) => this.writes.track(work),
      onAccountingError: () => this.writes.fail(),
      providerResolver: this.providerResolver,
      routing: this.options?.routing,
      adapter: this.options?.adapter,
      timeout: this.options?.timeout,
    };
  }

  generateText<TTools extends ToolSet = ToolSet>(
    modelKey: ModelKey,
    prompt: TextInput,
    options?: TextOptions<TTools>,
  ): Promise<AITextResult> {
    return this.writes.track(
      generateTextImpl(this.context(), modelKey, prompt, options),
    );
  }

  generateObject<TSchema extends z.ZodTypeAny>(
    modelKey: ModelKey,
    prompt: TextInput,
    schema: TSchema,
    options?: ObjectOptions,
  ): Promise<AIObjectResult<z.infer<TSchema>>> {
    return this.writes.track(
      generateObjectImpl(this.context(), modelKey, prompt, schema, options),
    );
  }

  embed(
    modelKey: ModelKey,
    text: string | string[],
    options?: EmbedOptions,
  ): Promise<AIEmbedResult> {
    return this.writes.track(
      embedImpl(this.context(), modelKey, text, options),
    );
  }

  streamText(
    modelKey: ModelKey,
    input: StreamTextInput,
    options?: StreamOptions,
  ): AIStreamResult {
    return streamTextImpl(this.context(), modelKey, input, options);
  }

  evaluate<const Q extends EvaluationQuestions>(
    modelKey: ModelKey,
    spec: EvaluationSpec<Q>,
    options?: EvaluateOptions,
  ): Promise<AIEvaluateResult<Q>> {
    return this.writes.track(
      evaluateImpl(this.context(), modelKey, spec, options),
    );
  }

  transcribe(
    modelKey: ModelKey,
    audio: TranscriptionAudio,
    options?: TranscribeOptions,
  ): Promise<AITranscribeResult> {
    return this.writes.track(
      transcribeImpl(this.context(), modelKey, audio, options),
    );
  }

  batch<T = string>(
    modelKey: ModelKey,
    provider?: AIBatchProvider,
    options?: BatchOptions,
  ): AIBatch<T> {
    const resolvedProvider = provider ?? getBestProviderForModel(modelKey);
    if (!resolvedProvider) {
      throw new Error(
        `No known batch-capable provider found for model "${modelKey}". ` +
          `Supported batch providers are: "google", "anthropic", "openai", "openrouter". ` +
          `Pass an explicit provider to ai.batch(modelKey, provider).`,
      );
    }
    return new AIBatchImpl<T>(
      this.context(),
      modelKey,
      resolvedProvider,
      this.batchLogFn,
      options,
    );
  }

  createChild(
    segment: string,
    id?: string,
    options?: AIHelperChildOptions,
  ): AIHelper {
    const newTopic = id
      ? `${this.topic}.${segment}.${id}`
      : `${this.topic}.${segment}`;
    const parent = this.options;
    const attribution = options?.attribution;
    const childOptions: StageAIHelperOptions = {
      ...parent,
      attribution: {
        ...parent?.attribution,
        ...attribution,
        labels: attribution?.labels
          ? { ...parent?.attribution?.labels, ...attribution.labels }
          : parent?.attribution?.labels,
      },
      text: options?.text ? { ...parent?.text, ...options.text } : parent?.text,
    };
    return new AIHelperImpl(
      newTopic,
      this.aiCallLogger,
      this.logContext,
      this.providerResolver,
      childOptions,
      this.writes,
    );
  }

  recordCall(params: RecordCallParams): void {
    const {
      modelKey,
      callType,
      prompt,
      response,
      inputTokens,
      outputTokens,
      cachedInputTokens,
      reasoningTokens,
      servedBy,
      metadata,
    } = params;
    const isBatch = callType === "batch";
    const modelId =
      params.cost === undefined ? getModel(modelKey).id : modelKey;
    const cost =
      params.cost ??
      calculateCostWithDiscount(
        modelKey,
        inputTokens,
        outputTokens,
        isBatch,
        undefined,
        cachedInputTokens,
      );
    const costSource =
      params.cost === undefined
        ? "estimated"
        : (params.costSource ?? "reported");

    this.trackedLogger.logCall({
      topic: this.topic,
      callType,
      modelKey,
      modelId,
      prompt,
      response,
      inputTokens,
      outputTokens,
      cachedInputTokens,
      reasoningTokens,
      servedBy,
      cost,
      costSource,
      ...(costSource === "estimated"
        ? { estimatedCost: cost }
        : { reportedCost: cost }),
      metadata: isBatch ? { ...metadata, isBatch: true } : metadata,
    });
  }

  flush(options?: AICallFlushOptions) {
    return this.writes.flush(options);
  }

  async getStats(): Promise<AIHelperStats> {
    return this.aiCallLogger.getStats(this.topic);
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
  providerResolver?: ProviderResolver,
  options?: StageAIHelperOptions,
): AIHelper {
  return new AIHelperImpl(topic, logger, logContext, providerResolver, options);
}

// ============================================================================
// Public Re-exports
// ============================================================================
// ai-helper.ts is the module's established import path (src/index.ts,
// src/client.ts, and tests all import from here), so the pieces implemented
// in the split-out modules are re-exported from this file rather than
// requiring call sites to reach into ./types / ./embeddings directly.

export {
  getEmbeddingModelProvider,
  registerEmbeddingProvider,
} from "./embeddings";
export { AICallTimeoutError } from "./errors.js";
export {
  getEvaluationModelProvider,
  registerEvaluationProvider,
} from "./evaluate";
export type { ModelKey } from "./model-helper";
export {
  getTranscriptionModelProvider,
  registerTranscriptionProvider,
} from "./transcribe";
export type {
  AdapterEmbedRequest,
  AdapterEmbedResponse,
  AdapterObjectRequest,
  AdapterObjectResponse,
  AdapterStreamRequest,
  AdapterStreamResponse,
  AdapterTextRequest,
  AdapterTextResponse,
  AIAdapter,
  AIBatch,
  AIBatchCancelResult,
  AIBatchHandle,
  AIBatchProvider,
  AIBatchRequest,
  AIBatchResult,
  AIBatchSubmitOptions,
  AICallType,
  AIEmbedResult,
  AIEvaluateResult,
  AIHelper,
  AIHelperOptions,
  AIHelperStats,
  AIObjectResult,
  AISDKStreamResult,
  AIStreamResult,
  AITextResult,
  AITranscribeResult,
  BatchLogFn,
  BatchOptions,
  BatchReclaimPolicy,
  ContentPart,
  EmbedOptions,
  EvaluateOptions,
  EvaluationAnswer,
  EvaluationInput,
  EvaluationQuestion,
  EvaluationQuestions,
  EvaluationSpec,
  LogContext,
  MediaPart,
  ObjectOptions,
  OpenRouterRoutingOptions,
  ProviderResolver,
  RecordCallParams,
  StreamOptions,
  StreamTextInput,
  TextInput,
  TextOptions,
  TextPart,
  TranscribeOptions,
  TranscriptionAudio,
} from "./types";
