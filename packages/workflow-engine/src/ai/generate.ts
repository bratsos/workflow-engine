/**
 * AI Helper - generateText / generateObject
 *
 * Text and structured-object generation on top of the AI SDK, plus the
 * multimodal message building, prompt-for-log extraction, and failure
 * logging shared with embeddings.ts and stream.ts.
 */

import type { SharedV4ProviderOptions } from "@ai-sdk/provider";
import type { ToolSet } from "ai";
import { generateText as aiGenerateText, Output } from "ai";
import type { z } from "zod";
import { AICallTimeoutError } from "./errors";
import { getModel, type ModelKey } from "./model-helper";
import {
  originalProviderError,
  protectProviderWarnings,
  providerError,
} from "./provider-diagnostics.js";
import {
  assertAdapterProviderPolicy,
  type CostResolution,
  explainRoutingError,
  extractReportedCost,
  extractStepProvider,
  extractUsageDetails,
  logger,
  type ProviderResultLike,
  resolveCost,
  resolveLanguageModel,
  summarizeStepProviders,
} from "./shared";
import { costResultLikeForSteps } from "./step-cost";
import { createCallTimeout, runWithCallTimeout } from "./timeouts.js";
import type {
  AICallType,
  AIHelperContext,
  AIObjectResult,
  AITextResult,
  ContentPart,
  MediaPart,
  ObjectOptions,
  TextInput,
  TextOptions,
  TextPart,
} from "./types";

/** Extract a loggable prompt string, joining multimodal text parts. */
export function extractPromptForLog(prompt: TextInput): string {
  if (typeof prompt === "string") return prompt;
  return (
    prompt
      .filter((p): p is TextPart => p.type === "text")
      .map((p) => p.text)
      .join("\n") || "[multimodal content]"
  );
}

/** Build the multimodal `messages` array shared by generateText/generateObject. */
export function buildMultimodalMessages(prompt: ContentPart[]) {
  return [
    {
      role: "user" as const,
      content: prompt.map((part) =>
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
  ];
}

function tokenCount(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "object" && value !== null) {
    const total = (value as { total?: unknown }).total;
    if (typeof total === "number") return total;
  }
  return 0;
}

/**
 * Token usage carried by a thrown error: the AI SDK's
 * `NoObjectGeneratedError` (and an adapter that throws it) reports the
 * `usage` of the call that produced the unparseable output. Both the AI SDK
 * 7 shape (`inputTokens: number`) and the provider shape
 * (`inputTokens: { total }`) are read; flat `inputTokens`/`outputTokens`
 * on the error itself are accepted for custom adapter errors.
 */
export function usageFromError(error: unknown): {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
  reasoningTokens?: number;
} {
  if (typeof error !== "object" || error === null) {
    return { inputTokens: 0, outputTokens: 0 };
  }
  const source = error as {
    usage?: {
      inputTokens?: unknown;
      outputTokens?: unknown;
      inputTokenDetails?: { cacheReadTokens?: unknown };
      outputTokenDetails?: { reasoningTokens?: unknown };
      cachedInputTokens?: unknown;
      reasoningTokens?: unknown;
      raw?: Record<string, unknown>;
    };
    inputTokens?: unknown;
    outputTokens?: unknown;
    cachedInputTokens?: unknown;
    reasoningTokens?: unknown;
  };
  const usage = source.usage;
  const details = extractUsageDetails(source as ProviderResultLike);
  const cachedInputTokens =
    details.cachedInputTokens ??
    (typeof source.cachedInputTokens === "number" &&
    Number.isFinite(source.cachedInputTokens) &&
    source.cachedInputTokens >= 0
      ? source.cachedInputTokens
      : undefined);
  const reasoningTokens =
    details.reasoningTokens ??
    (typeof source.reasoningTokens === "number" &&
    Number.isFinite(source.reasoningTokens) &&
    source.reasoningTokens >= 0
      ? source.reasoningTokens
      : undefined);

  return {
    inputTokens: tokenCount(usage?.inputTokens ?? source.inputTokens),
    outputTokens: tokenCount(usage?.outputTokens ?? source.outputTokens),
    ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
    ...(reasoningTokens !== undefined ? { reasoningTokens } : {}),
  };
}

export type CallAccounting = CostResolution & {
  inputTokens: number;
  outputTokens: number;
};

function resolveFailureAccounting(
  modelKey: ModelKey,
  error: unknown,
  steps: readonly ProviderResultLike[],
  result?: ProviderResultLike,
): CallAccounting {
  const errorUsage = usageFromError(error);
  const errorResult = error as ProviderResultLike | undefined;
  const observedUsage = result?.usage ?? result?.totalUsage;
  let stepInputTokens = 0;
  let stepOutputTokens = 0;
  for (const step of steps) {
    stepInputTokens += tokenCount(step.usage?.inputTokens);
    stepOutputTokens += tokenCount(step.usage?.outputTokens);
  }
  // Error usage and observed steps can describe the same requests.
  const inputTokens = Math.max(
    errorUsage.inputTokens,
    stepInputTokens,
    tokenCount(observedUsage?.inputTokens),
  );
  const outputTokens = Math.max(
    errorUsage.outputTokens,
    stepOutputTokens,
    tokenCount(observedUsage?.outputTokens),
  );
  const totals = { inputTokens, outputTokens };
  const folded = costResultLikeForSteps({
    usage: {
      ...(steps.length === 1 ? steps[0]?.usage : undefined),
      ...observedUsage,
      ...totals,
    },
    finalStep: steps.at(-1),
    steps,
  });
  const costUsd =
    extractReportedCost(errorResult) ??
    result?.costUsd ??
    (steps.length === 0
      ? extractReportedCost(result)
      : stepInputTokens === inputTokens && stepOutputTokens === outputTokens
        ? extractReportedCost(folded)
        : undefined);
  try {
    return {
      ...totals,
      ...resolveCost(modelKey, inputTokens, outputTokens, {
        costUsd,
        usage: { ...errorUsage, ...folded.usage },
        steps,
      }),
    };
  } catch {
    // Preserve available reporting if the cost catalogue cannot price the failure.
    return {
      ...totals,
      cost: costUsd ?? 0,
      estimatedCostUsd: 0,
      reportedCostUsd: costUsd,
      costSource: costUsd === undefined ? "estimated" : "reported",
      cachedInputTokens: errorUsage.cachedInputTokens,
      reasoningTokens: errorUsage.reasoningTokens,
    };
  }
}

/**
 * Log a failed AI call and return the derived error fields. Use the same
 * accounting as a successful call when the provider already returned its bill.
 */
export function logFailure(
  ctx: AIHelperContext,
  params: {
    topic: string;
    callType: AICallType;
    modelKey: ModelKey;
    modelId: string;
    prompt: string;
    startTime: number;
    error: unknown;
    steps?: readonly ProviderResultLike[];
    result?: ProviderResultLike;
    accounting?: CallAccounting;
    metadata?: Record<string, unknown>;
  },
): { errorMessage: string; durationMs: number } {
  const durationMs = Date.now() - params.startTime;
  const safeError =
    params.error instanceof AICallTimeoutError
      ? `Timed out after ${params.error.timeoutMs}ms`
      : "Provider call failed";
  const errorMessage = safeError;
  const steps = params.steps ?? [];
  // A call that reached the model and failed afterwards still consumed tokens.
  const accounting =
    params.accounting ??
    resolveFailureAccounting(
      params.modelKey,
      originalProviderError(params.error),
      steps,
      params.result,
    );

  const providerHistory = summarizeStepProviders(
    steps.map(extractStepProvider),
  );
  const servedBy = providerHistory.servedBy ?? accounting.servedBy;
  const servedBySteps =
    providerHistory.servedBySteps ?? accounting.servedBySteps;
  ctx.aiCallLogger.logCall({
    topic: params.topic,
    callType: params.callType,
    modelKey: params.modelKey,
    modelId: params.modelId,
    prompt: params.prompt,
    response: "",
    inputTokens: accounting.inputTokens,
    outputTokens: accounting.outputTokens,
    cost: accounting.cost,
    estimatedCost: accounting.estimatedCostUsd,
    ...(accounting.reportedCostUsd !== undefined
      ? { reportedCost: accounting.reportedCostUsd }
      : {}),
    costSource: accounting.costSource,
    ...(servedBy !== undefined ? { servedBy } : {}),
    ...(accounting.cachedInputTokens !== undefined
      ? { cachedInputTokens: accounting.cachedInputTokens }
      : {}),
    ...(accounting.reasoningTokens !== undefined
      ? { reasoningTokens: accounting.reasoningTokens }
      : {}),
    metadata: {
      ...params.metadata,
      ...(servedBySteps !== undefined ? { servedBySteps } : {}),
      durationMs,
      status: "error",
      error: safeError,
    },
  });

  return { errorMessage, durationMs };
}

export async function generateText<TTools extends ToolSet = ToolSet>(
  ctx: AIHelperContext,
  modelKey: ModelKey,
  prompt: TextInput,
  options: TextOptions<TTools> = {} as TextOptions<TTools>,
): Promise<AITextResult> {
  const modelConfig = getModel(modelKey);
  if (ctx.adapter?.generateText)
    assertAdapterProviderPolicy(ctx.routing?.provider);
  const model = ctx.adapter?.generateText
    ? undefined
    : protectProviderWarnings(resolveLanguageModel(ctx, modelConfig));
  const startTime = Date.now();
  const timeout = createCallTimeout(
    options.abortSignal,
    options.timeoutMs ?? ctx.timeout?.perCallMs,
    modelKey,
  );

  // Determine if we have multimodal content
  const isMultimodal = Array.isArray(prompt);
  const hasTools = options.tools !== undefined;
  const hasOutputSchema = options.output !== undefined;

  // Extract text prompt for logging (for multimodal, join text parts)
  const promptForLog = extractPromptForLog(prompt);

  // Debug logging
  if (hasTools || hasOutputSchema) {
    logger.debug(
      `generateText config: hasTools=${hasTools}, hasOutputSchema=${hasOutputSchema}, toolNames=${hasTools ? Object.keys(options.tools || {}).join(", ") : "none"}`,
    );
  }

  const steps: ProviderResultLike[] = [];
  let accounting: CallAccounting | undefined;
  // Capture provider history before tool logging or the caller's callback can fail.
  const wrappedOnStepEnd: TextOptions<TTools>["onStepEnd"] = async (
    stepResult,
  ) => {
    steps.push(stepResult);
    if (hasTools && Array.isArray(stepResult.toolResults)) {
      for (const toolResult of stepResult.toolResults) {
        const result = toolResult as {
          toolName?: string;
          toolCallId?: string;
          input?: unknown;
          output?: unknown;
        };
        if (result.toolName) {
          // Tool-execution records are observability only, not billable
          // events - the step's usage/cost is already logged once via
          // the final call's aggregate usage. Logging it here too would
          // double (or N+1) count cost across tool calls in the step.
          const childTopic = `${ctx.topic}.tool.${result.toolName}`;
          ctx.aiCallLogger.logCall({
            topic: childTopic,
            callType: "text",
            modelKey: modelKey,
            modelId: modelConfig.id,
            prompt: JSON.stringify(result.input ?? {}, null, 2),
            response: JSON.stringify(result.output ?? {}, null, 2),
            inputTokens: 0,
            outputTokens: 0,
            cost: 0,
            metadata: {
              toolName: result.toolName,
              toolCallId: result.toolCallId,
              finishReason: stepResult.finishReason,
            },
          });
        }
      }
    }
    await options.onStepEnd?.(stepResult);
  };

  // Build request based on input type
  const baseOptions = {
    model,
    // Sent only when the caller sets it: providers pick their own default
    // and some endpoints (GPT-5 through OpenRouter with `requireParameters`)
    // reject a temperature they do not support.
    ...(options.temperature !== undefined && {
      temperature: options.temperature,
    }),
    maxOutputTokens: options.maxTokens,
    ...(options.maxRetries !== undefined && {
      maxRetries: options.maxRetries,
    }),
    ...(timeout.signal && { abortSignal: timeout.signal }),
    // Provider-specific options (e.g. reasoning control) passed through.
    // Cast: the public type uses `unknown` values for DX; the consumer is
    // responsible for passing JSON-serializable provider options.
    ...(options.providerOptions && {
      providerOptions: options.providerOptions as SharedV4ProviderOptions,
    }),
    // Tool-related options (only included if tools are provided)
    ...(hasTools && {
      tools: options.tools,
      // Cast to any because TTools generic doesn't match NoInfer<ToolSet> at compile time
      toolChoice: options.toolChoice as Parameters<
        typeof aiGenerateText
      >[0]["toolChoice"],
      stopWhen: options.stopWhen,
    }),
    onStepEnd: wrappedOnStepEnd,
    // Structured output (for tools + schema)
    ...(hasOutputSchema && {
      output: options.output,
    }),
  };

  // Trace log before AI call
  logger.debug(`generateText request`, {
    model: modelKey,
    modelId: modelConfig.id,
    prompt:
      promptForLog.substring(0, 500) + (promptForLog.length > 500 ? "..." : ""),
    temperature: options.temperature,
    maxTokens: options.maxTokens,
    hasTools,
    hasOutputSchema,
    isMultimodal,
  });

  try {
    // Cast to the SDK's own param type (not `any`) to bypass NoInfer<TTools>
    // while still catching a future SDK shape change at compile time.
    // Our TextOptions<TTools> provides proper typing at the interface level.
    const isAdapter = ctx.adapter?.generateText !== undefined;
    const result = isAdapter
      ? await runWithCallTimeout(timeout, (signal) =>
          ctx.adapter!.generateText!({
            model: modelConfig,
            prompt,
            options: {
              ...options,
              abortSignal: signal,
              onStepEnd: wrappedOnStepEnd,
            } as TextOptions<TTools>,
          }),
        )
      : await runWithCallTimeout(timeout, () =>
          isMultimodal
            ? aiGenerateText({
                ...baseOptions,
                messages: buildMultimodalMessages(prompt as ContentPart[]),
              } as Parameters<typeof aiGenerateText>[0])
            : aiGenerateText({
                ...baseOptions,
                prompt,
              } as Parameters<typeof aiGenerateText>[0]),
        );

    const resultAny = result as unknown as {
      text: string;
      inputTokens?: number;
      outputTokens?: number;
      usage?: { inputTokens?: number; outputTokens?: number };
      providerMetadata?: Record<string, unknown>;
      costUsd?: number;
      finishReason?: unknown;
      reasoningText?: string;
      reasoning?: string;
      output?: unknown;
      object?: unknown;
    };
    const inputTokens =
      resultAny.inputTokens ?? resultAny.usage?.inputTokens ?? 0;
    const outputTokens =
      resultAny.outputTokens ?? resultAny.usage?.outputTokens ?? 0;
    accounting = {
      inputTokens,
      outputTokens,
      ...resolveCost(
        modelKey,
        inputTokens,
        outputTokens,
        isAdapter
          ? {
              providerMetadata: resultAny.providerMetadata,
              costUsd: resultAny.costUsd,
            }
          : costResultLikeForSteps(result),
      ),
    };
    const output = hasOutputSchema
      ? isAdapter
        ? resultAny.object
        : resultAny.output
      : undefined;
    if (hasTools || hasOutputSchema) {
      logger.debug(
        `generateText result: stepsCount=${steps.length}, hasOutput=${output !== undefined}, finishReason=${resultAny.finishReason}`,
      );
    }
    const text = resultAny.text;
    const {
      cost,
      estimatedCostUsd,
      reportedCostUsd,
      costSource,
      servedBy,
      servedBySteps,
      cachedInputTokens,
      reasoningTokens,
    } = accounting;
    const durationMs = Date.now() - startTime;
    // Reasoning models emit on a separate channel; surface it so a
    // reasoning-only response isn't seen as empty output.
    const reasoning = resultAny.reasoningText ?? resultAny.reasoning;

    // Log the call (including error cases where finishReason is "error")
    ctx.aiCallLogger.logCall({
      topic: ctx.topic,
      callType: "text",
      modelKey,
      modelId: modelConfig.id,
      prompt: promptForLog,
      response: text,
      inputTokens,
      outputTokens,
      cost,
      estimatedCost: estimatedCostUsd,
      reportedCost: reportedCostUsd,
      costSource,
      servedBy,
      cachedInputTokens,
      reasoningTokens,
      metadata: {
        ...(servedBySteps !== undefined ? { servedBySteps } : {}),
        temperature: options.temperature,
        maxTokens: options.maxTokens,
        finishReason: resultAny.finishReason,
        durationMs,
        isMultimodal,
        ...(reasoning ? { hasReasoning: true } : {}),
        ...(resultAny.finishReason === "error" && { status: "error" }),
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
      response: text.substring(0, 500) + (text.length > 500 ? "..." : ""),
      inputTokens,
      outputTokens,
      cost: cost.toFixed(6),
      durationMs,
      finishReason: resultAny.finishReason,
    });

    return {
      text,
      inputTokens,
      outputTokens,
      cost,
      ...(reportedCostUsd !== undefined ? { reportedCostUsd } : {}),
      costSource,
      ...(reasoning ? { reasoning } : {}),
      // Include structured output if `output` was used
      ...(hasOutputSchema && { output }),
    };
  } catch (error) {
    const { errorMessage, durationMs } = logFailure(ctx, {
      topic: ctx.topic,
      callType: "text",
      modelKey,
      modelId: modelConfig.id,
      prompt: promptForLog,
      startTime,
      error,
      steps,
      accounting,
      metadata: {
        temperature: options.temperature,
        maxTokens: options.maxTokens,
        finishReason: "error",
        isMultimodal,
      },
    });
    logger.error(`generateText error`, {
      model: modelKey,
      error: errorMessage,
      durationMs,
    });
    throw providerError(
      explainRoutingError(error, ctx.routing, modelKey),
      "Provider generation failed",
    );
  } finally {
    timeout.cleanup();
  }
}

export async function generateObject<TSchema extends z.ZodTypeAny>(
  ctx: AIHelperContext,
  modelKey: ModelKey,
  prompt: TextInput,
  schema: TSchema,
  options: ObjectOptions = {},
): Promise<AIObjectResult<z.infer<TSchema>>> {
  const modelConfig = getModel(modelKey);
  if (ctx.adapter?.generateObject)
    assertAdapterProviderPolicy(ctx.routing?.provider);
  const model = ctx.adapter?.generateObject
    ? undefined
    : protectProviderWarnings(resolveLanguageModel(ctx, modelConfig));
  const startTime = Date.now();
  const timeout = createCallTimeout(
    options.abortSignal,
    options.timeoutMs ?? ctx.timeout?.perCallMs,
    modelKey,
  );

  // Determine if we have multimodal content
  const isMultimodal = Array.isArray(prompt);
  const hasTools = options.tools !== undefined;

  // Extract text prompt for logging (for multimodal, join text parts)
  const promptForLog = extractPromptForLog(prompt);

  const steps: ProviderResultLike[] = [];
  let accounting: CallAccounting | undefined;
  const onStepEnd: ObjectOptions["onStepEnd"] = async (step) => {
    steps.push(step);
    await options.onStepEnd?.(step);
  };

  // Build request using AI SDK v6 pattern: generateText with Output.object()
  // This replaces the deprecated generateObject() and has better provider compatibility
  // Same request as `generateText` + `Output.object`; neither sends a
  // default temperature.
  const baseOptions = {
    model,
    output: Output.object({ schema }),
    // Sent only when the caller sets it: providers pick their own default
    // and some endpoints (GPT-5 through OpenRouter with `requireParameters`)
    // reject a temperature they do not support.
    ...(options.temperature !== undefined && {
      temperature: options.temperature,
    }),
    maxOutputTokens: options.maxTokens,
    ...(options.maxRetries !== undefined && {
      maxRetries: options.maxRetries,
    }),
    ...(timeout.signal && { abortSignal: timeout.signal }),
    // Provider-specific options (e.g. reasoning control) passed through.
    // Cast: the public type uses `unknown` values for DX; the consumer is
    // responsible for passing JSON-serializable provider options.
    ...(options.providerOptions && {
      providerOptions: options.providerOptions as SharedV4ProviderOptions,
    }),
    // Tool-related options (only included if tools are provided)
    ...(hasTools && {
      tools: options.tools,
      stopWhen: options.stopWhen,
    }),
    onStepEnd,
  };

  // Trace log before AI call
  logger.debug(`generateObject request`, {
    model: modelKey,
    modelId: modelConfig.id,
    prompt:
      promptForLog.substring(0, 500) + (promptForLog.length > 500 ? "..." : ""),
    temperature: options.temperature,
    maxTokens: options.maxTokens,
    hasTools,
    isMultimodal,
  });

  try {
    const isAdapter = ctx.adapter?.generateObject !== undefined;
    const result = isAdapter
      ? await runWithCallTimeout(timeout, (signal) =>
          ctx.adapter!.generateObject!({
            model: modelConfig,
            prompt,
            schema,
            options: { ...options, abortSignal: signal, onStepEnd },
          }),
        )
      : await runWithCallTimeout(timeout, () =>
          isMultimodal
            ? aiGenerateText({
                ...baseOptions,
                model: model!,
                messages: buildMultimodalMessages(prompt as ContentPart[]),
              })
            : aiGenerateText({
                ...baseOptions,
                model: model!,
                prompt,
              }),
        );

    const resultAny = result as unknown as {
      output: unknown;
      object?: unknown;
      inputTokens?: number;
      outputTokens?: number;
      usage?: { inputTokens?: number; outputTokens?: number };
      providerMetadata?: Record<string, unknown>;
      costUsd?: number;
      finishReason?: unknown;
      reasoningText?: string;
      reasoning?: string;
    };
    const inputTokens =
      resultAny.inputTokens ?? resultAny.usage?.inputTokens ?? 0;
    const outputTokens =
      resultAny.outputTokens ?? resultAny.usage?.outputTokens ?? 0;
    accounting = {
      inputTokens,
      outputTokens,
      ...resolveCost(
        modelKey,
        inputTokens,
        outputTokens,
        isAdapter
          ? {
              providerMetadata: resultAny.providerMetadata,
              costUsd: resultAny.costUsd,
            }
          : costResultLikeForSteps(result),
      ),
    };
    const object = isAdapter ? resultAny.object : resultAny.output;
    const {
      cost,
      estimatedCostUsd,
      reportedCostUsd,
      costSource,
      servedBy,
      servedBySteps,
      cachedInputTokens,
      reasoningTokens,
    } = accounting;
    const durationMs = Date.now() - startTime;

    // Log the call (including error cases where finishReason is "error")
    const reasoning = resultAny.reasoningText ?? resultAny.reasoning;
    ctx.aiCallLogger.logCall({
      topic: ctx.topic,
      callType: "object",
      modelKey,
      modelId: modelConfig.id,
      prompt: promptForLog,
      response: JSON.stringify(object, null, 2),
      inputTokens,
      outputTokens,
      cost,
      estimatedCost: estimatedCostUsd,
      reportedCost: reportedCostUsd,
      costSource,
      servedBy,
      cachedInputTokens,
      reasoningTokens,
      metadata: {
        ...(servedBySteps !== undefined ? { servedBySteps } : {}),
        temperature: options.temperature,
        maxTokens: options.maxTokens,
        finishReason: resultAny.finishReason,
        durationMs,
        isMultimodal,
        ...(resultAny.finishReason === "error" && { status: "error" }),
        ...(reasoning ? { hasReasoning: true } : {}),
        ...(isMultimodal && {
          mediaTypes: (prompt as ContentPart[])
            .filter((p): p is MediaPart => p.type === "file")
            .map((p) => p.mediaType),
        }),
      },
    });

    // Trace log after successful AI call
    const responseStr = JSON.stringify(object);
    logger.debug(`generateObject response`, {
      model: modelKey,
      response:
        responseStr.substring(0, 500) + (responseStr.length > 500 ? "..." : ""),
      inputTokens,
      outputTokens,
      cost: cost.toFixed(6),
      durationMs,
      finishReason: resultAny.finishReason,
    });

    return {
      object: object as z.infer<TSchema>,
      inputTokens,
      outputTokens,
      cost,
      ...(reportedCostUsd !== undefined ? { reportedCostUsd } : {}),
      costSource,
      ...(reasoning ? { reasoning } : {}),
    };
  } catch (error) {
    const { errorMessage, durationMs } = logFailure(ctx, {
      topic: ctx.topic,
      callType: "object",
      modelKey,
      modelId: modelConfig.id,
      prompt: promptForLog,
      startTime,
      error,
      steps,
      accounting,
      metadata: {
        temperature: options.temperature,
        maxTokens: options.maxTokens,
        finishReason: "error",
        isMultimodal,
      },
    });
    logger.error(`generateObject error`, {
      model: modelKey,
      error: errorMessage,
      durationMs,
    });
    throw providerError(
      explainRoutingError(error, ctx.routing, modelKey),
      "Provider structured generation failed",
    );
  } finally {
    timeout.cleanup();
  }
}
