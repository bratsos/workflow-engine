/**
 * AI Helper - generateText / generateObject
 *
 * Text and structured-object generation on top of the AI SDK, plus the
 * multimodal message building, prompt-for-log extraction, and failure
 * logging shared with embeddings.ts and stream.ts.
 */

import type { SharedV4ProviderOptions } from "@ai-sdk/provider";
import type { StepResult, ToolSet } from "ai";
import { generateText as aiGenerateText, Output } from "ai";
import type { z } from "zod";
import type { AICallLogger } from "../persistence";
import { calculateCost, getModel, type ModelKey } from "./model-helper";
import {
  explainRoutingError,
  getModelProvider,
  logger,
  resolveCost,
} from "./shared";
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
} {
  if (typeof error !== "object" || error === null) {
    return { inputTokens: 0, outputTokens: 0 };
  }
  const source = error as {
    usage?: { inputTokens?: unknown; outputTokens?: unknown };
    inputTokens?: unknown;
    outputTokens?: unknown;
  };
  const usage = source.usage;
  return {
    inputTokens: tokenCount(usage?.inputTokens ?? source.inputTokens),
    outputTokens: tokenCount(usage?.outputTokens ?? source.outputTokens),
  };
}

/**
 * Log a failed AI call (fire-and-forget persistence write) and return the
 * derived error fields. Shared by the catch blocks in generateText,
 * generateObject, and embed (which also trace-log via `logger.error` and
 * rethrow), and by streamText's error path (which only logs - see stream.ts).
 */
export function logFailure(
  aiCallLogger: AICallLogger,
  params: {
    topic: string;
    callType: AICallType;
    modelKey: ModelKey;
    modelId: string;
    prompt: string;
    startTime: number;
    error: unknown;
    metadata?: Record<string, unknown>;
  },
): { errorMessage: string; durationMs: number } {
  const durationMs = Date.now() - params.startTime;
  const errorMessage =
    params.error instanceof Error ? params.error.message : String(params.error);
  // A call that reached the model and failed afterwards (`NoObjectGeneratedError`
  // and the like) still consumed tokens; the error carries the usage.
  const { inputTokens, outputTokens } = usageFromError(params.error);
  let cost = 0;
  if (inputTokens > 0 || outputTokens > 0) {
    try {
      cost = calculateCost(
        params.modelKey,
        inputTokens,
        outputTokens,
      ).totalCost;
    } catch {
      cost = 0;
    }
  }

  aiCallLogger.logCall({
    topic: params.topic,
    callType: params.callType,
    modelKey: params.modelKey,
    modelId: params.modelId,
    prompt: params.prompt,
    response: "",
    inputTokens,
    outputTokens,
    cost,
    metadata: {
      ...params.metadata,
      durationMs,
      status: "error",
      error: errorMessage,
    },
  });

  return { errorMessage, durationMs };
}

/** Default sampling temperature shared by every text and object call. */
const DEFAULT_TEMPERATURE = 0.7;

export async function generateText<TTools extends ToolSet = ToolSet>(
  ctx: AIHelperContext,
  modelKey: ModelKey,
  prompt: TextInput,
  options: TextOptions<TTools> = {} as TextOptions<TTools>,
): Promise<AITextResult> {
  const modelConfig = getModel(modelKey);
  const model = ctx.adapter?.generateText
    ? undefined
    : (ctx.providerResolver?.(modelConfig) ??
      getModelProvider(modelConfig, ctx.routing));
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

  // Logs tool usage, then calls the user's callback if they supplied one.
  //
  // This is attached whenever tools are in play, NOT only when the caller
  // passes `onStepEnd`. It used to be conditional on the user's callback,
  // which silently skipped all per-tool observability records for anyone who
  // used tools without also wanting a step callback.
  const wrappedOnStepEnd = hasTools
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
        // Call user's callback
        await options.onStepEnd?.(stepResult);
      }
    : undefined;

  // Build request based on input type
  const baseOptions = {
    model,
    temperature: options.temperature ?? DEFAULT_TEMPERATURE,
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
      onStepEnd: wrappedOnStepEnd as Parameters<
        typeof aiGenerateText
      >[0]["onStepEnd"],
    }),
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
    temperature: options.temperature ?? DEFAULT_TEMPERATURE,
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
              ...(hasTools
                ? {
                    onStepEnd:
                      wrappedOnStepEnd as TextOptions<TTools>["onStepEnd"],
                  }
                : {}),
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

    // Debug logging for result
    if (hasTools || hasOutputSchema) {
      const resultAny = result as {
        steps?: unknown[];
        output?: unknown;
        object?: unknown;
      };
      // `.output` is a getter that throws AI_NoOutputGeneratedError unless
      // `output` was configured - only probe it when relevant. An adapter
      // response carries the structured output as `object`.
      let hasOutput = false;
      if (hasOutputSchema) {
        try {
          hasOutput =
            (isAdapter ? resultAny.object : resultAny.output) !== undefined;
        } catch {
          hasOutput = false;
        }
      }
      logger.debug(
        `generateText result: stepsCount=${resultAny.steps?.length ?? 0}, hasOutput=${hasOutput}, finishReason=${(result as { finishReason?: unknown }).finishReason}`,
      );
    }

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
    const { cost, reportedCostUsd, costSource } = resolveCost(
      modelKey,
      inputTokens,
      outputTokens,
      isAdapter
        ? {
            providerMetadata: resultAny.providerMetadata,
            costUsd: resultAny.costUsd,
          }
        : result,
    );
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
      response: resultAny.text,
      inputTokens,
      outputTokens,
      cost,
      reportedCost: reportedCostUsd,
      costSource,
      metadata: {
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
      response:
        resultAny.text.substring(0, 500) +
        (resultAny.text.length > 500 ? "..." : ""),
      inputTokens,
      outputTokens,
      cost: cost.toFixed(6),
      durationMs,
      finishReason: resultAny.finishReason,
    });

    return {
      text: resultAny.text,
      inputTokens,
      outputTokens,
      cost,
      ...(reportedCostUsd !== undefined ? { reportedCostUsd } : {}),
      costSource,
      ...(reasoning ? { reasoning } : {}),
      // Include structured output if `output` was used
      ...(hasOutputSchema && {
        output: isAdapter ? resultAny.object : resultAny.output,
      }),
    };
  } catch (error) {
    const { errorMessage, durationMs } = logFailure(ctx.aiCallLogger, {
      topic: ctx.topic,
      callType: "text",
      modelKey,
      modelId: modelConfig.id,
      prompt: promptForLog,
      startTime,
      error,
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
    throw explainRoutingError(error, ctx.routing, modelKey);
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
  const model = ctx.adapter?.generateObject
    ? undefined
    : (ctx.providerResolver?.(modelConfig) ??
      getModelProvider(modelConfig, ctx.routing));
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

  // Build request using AI SDK v6 pattern: generateText with Output.object()
  // This replaces the deprecated generateObject() and has better provider compatibility
  // Same request as `generateText` + `Output.object`: the only field that
  // differed was the default temperature (0 here, 0.7 there), which is the
  // one difference a consumer saw between the two routes on the same model.
  const baseOptions = {
    model,
    output: Output.object({ schema }),
    temperature: options.temperature ?? DEFAULT_TEMPERATURE,
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
      onStepEnd: options.onStepEnd,
    }),
  };

  // Trace log before AI call
  logger.debug(`generateObject request`, {
    model: modelKey,
    modelId: modelConfig.id,
    prompt:
      promptForLog.substring(0, 500) + (promptForLog.length > 500 ? "..." : ""),
    temperature: options.temperature ?? DEFAULT_TEMPERATURE,
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
            options: { ...options, abortSignal: signal },
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
    // The AI SDK exposes the structured result as `output`; an
    // AdapterObjectResponse carries it as `object`. Resolve once, use everywhere.
    const object = isAdapter ? resultAny.object : resultAny.output;

    const inputTokens =
      resultAny.inputTokens ?? resultAny.usage?.inputTokens ?? 0;
    const outputTokens =
      resultAny.outputTokens ?? resultAny.usage?.outputTokens ?? 0;
    const { cost, reportedCostUsd, costSource } = resolveCost(
      modelKey,
      inputTokens,
      outputTokens,
      isAdapter
        ? {
            providerMetadata: resultAny.providerMetadata,
            costUsd: resultAny.costUsd,
          }
        : result,
    );
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
      reportedCost: reportedCostUsd,
      costSource,
      metadata: {
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
    const { errorMessage, durationMs } = logFailure(ctx.aiCallLogger, {
      topic: ctx.topic,
      callType: "object",
      modelKey,
      modelId: modelConfig.id,
      prompt: promptForLog,
      startTime,
      error,
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
    throw explainRoutingError(error, ctx.routing, modelKey);
  } finally {
    timeout.cleanup();
  }
}
