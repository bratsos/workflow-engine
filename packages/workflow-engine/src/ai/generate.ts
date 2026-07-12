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
import { getModel, type ModelKey } from "./model-helper";
import {
  buildCommonCallOptions,
  buildUsageDetailMetadata,
  calculateCostWithDiscount,
  getModelProvider,
  logger,
} from "./shared";
import type {
  AICallType,
  AIHelperContext,
  AIObjectResult,
  AITextResult,
  ContentPart,
  MediaPart,
  MessagesInput,
  ObjectOptions,
  TextInput,
  TextOptions,
  TextPart,
} from "./types";

/** True when `prompt` is the `{ messages }` alternative to a string/multimodal prompt. */
export function isMessagesInput(prompt: TextInput): prompt is MessagesInput {
  return (
    typeof prompt === "object" && prompt !== null && !Array.isArray(prompt)
  );
}

/** Extract a loggable prompt string, joining multimodal text parts. */
export function extractPromptForLog(prompt: TextInput): string {
  if (typeof prompt === "string") return prompt;
  if (isMessagesInput(prompt)) return JSON.stringify(prompt.messages);
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

  aiCallLogger.logCall({
    topic: params.topic,
    callType: params.callType,
    modelKey: params.modelKey,
    modelId: params.modelId,
    prompt: params.prompt,
    response: "",
    inputTokens: 0,
    outputTokens: 0,
    cost: 0,
    metadata: {
      ...params.metadata,
      durationMs,
      status: "error",
      error: errorMessage,
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
  const model =
    ctx.providerResolver?.(modelConfig) ?? getModelProvider(modelConfig);
  const startTime = Date.now();

  // Determine if we have multimodal content or a `{ messages }` input
  const isMultimodal = Array.isArray(prompt);
  const isMessages = isMessagesInput(prompt);
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

  // Create internal wrapper that logs tool usage and then calls user's callback
  const wrappedOnStepEnd = options.onStepEnd
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
    temperature: options.temperature ?? 0.7,
    maxOutputTokens: options.maxTokens,
    ...(options.maxRetries !== undefined && {
      maxRetries: options.maxRetries,
    }),
    ...(options.abortSignal && { abortSignal: options.abortSignal }),
    // Sampling params, headers, reasoning, telemetry, activeTools, prepareStep -
    // all typed as passthroughs off Parameters<typeof generateText>[0] in TextOptions.
    ...buildCommonCallOptions(options),
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
    temperature: options.temperature ?? 0.7,
    maxTokens: options.maxTokens,
    hasTools,
    hasOutputSchema,
    isMultimodal,
  });

  try {
    // Cast to the SDK's own param type (not `any`) to bypass NoInfer<TTools>
    // while still catching a future SDK shape change at compile time.
    // Our TextOptions<TTools> provides proper typing at the interface level.
    const result = isMultimodal
      ? await aiGenerateText({
          ...baseOptions,
          messages: buildMultimodalMessages(prompt as ContentPart[]),
        } as Parameters<typeof aiGenerateText>[0])
      : isMessages
        ? await aiGenerateText({
            ...baseOptions,
            messages: (prompt as MessagesInput).messages,
          } as Parameters<typeof aiGenerateText>[0])
        : await aiGenerateText({
            ...baseOptions,
            prompt,
          } as Parameters<typeof aiGenerateText>[0]);

    // Debug logging for result
    if (hasTools || hasOutputSchema) {
      const resultAny = result as { steps?: unknown[]; output?: unknown };
      // `.output` is a getter that throws AI_NoOutputGeneratedError unless
      // `output` was configured - only probe it when relevant.
      let hasOutput = false;
      if (hasOutputSchema) {
        try {
          hasOutput = resultAny.output !== undefined;
        } catch {
          hasOutput = false;
        }
      }
      logger.debug(
        `generateText result: stepsCount=${resultAny.steps?.length ?? 0}, hasOutput=${hasOutput}, finishReason=${result.finishReason}`,
      );
    }

    const inputTokens = result.usage?.inputTokens ?? 0;
    const outputTokens = result.usage?.outputTokens ?? 0;
    const totalTokens = result.usage?.totalTokens;
    const cachedInputTokens = result.usage?.inputTokenDetails?.cacheReadTokens;
    const reasoningTokens = result.usage?.outputTokenDetails?.reasoningTokens;
    const cost = calculateCostWithDiscount(
      modelKey,
      inputTokens,
      outputTokens,
      false,
      { cachedInputTokens, reasoningTokens },
    );
    const durationMs = Date.now() - startTime;
    // Reasoning models emit on a separate channel; surface it so a
    // reasoning-only response isn't seen as empty output.
    const reasoning = (result as { reasoningText?: string }).reasoningText;
    const usageDetailMetadata = buildUsageDetailMetadata({
      totalTokens,
      cachedInputTokens,
      reasoningTokens,
    });

    // Log the call (including error cases where finishReason is "error")
    ctx.aiCallLogger.logCall({
      topic: ctx.topic,
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
        ...(reasoning ? { hasReasoning: true } : {}),
        ...(result.finishReason === "error" && { status: "error" }),
        ...(isMultimodal && {
          mediaTypes: (prompt as ContentPart[])
            .filter((p): p is MediaPart => p.type === "file")
            .map((p) => p.mediaType),
        }),
        ...usageDetailMetadata,
      },
    });

    // Trace log after successful AI call
    logger.debug(`generateText response`, {
      model: modelKey,
      response:
        result.text.substring(0, 500) + (result.text.length > 500 ? "..." : ""),
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
      ...(reasoning ? { reasoning } : {}),
      ...(totalTokens !== undefined && { totalTokens }),
      ...(cachedInputTokens !== undefined && { cachedInputTokens }),
      ...(reasoningTokens !== undefined && { reasoningTokens }),
      finishReason: result.finishReason,
      warnings: result.warnings,
      toolCalls: result.toolCalls,
      toolResults: result.toolResults,
      steps: result.steps,
      // Include structured output if `output` was used
      ...(hasOutputSchema && {
        output: (result as { output?: unknown }).output,
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
    throw error;
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
  const model =
    ctx.providerResolver?.(modelConfig) ?? getModelProvider(modelConfig);
  const startTime = Date.now();

  // Determine if we have multimodal content or a `{ messages }` input
  const isMultimodal = Array.isArray(prompt);
  const isMessages = isMessagesInput(prompt);
  const hasTools = options.tools !== undefined;

  // Extract text prompt for logging (for multimodal, join text parts)
  const promptForLog = extractPromptForLog(prompt);

  // Build request using AI SDK v6 pattern: generateText with Output.object()
  // This replaces the deprecated generateObject() and has better provider compatibility
  const baseOptions = {
    model,
    output: Output.object({ schema }),
    temperature: options.temperature ?? 0,
    maxOutputTokens: options.maxTokens,
    ...(options.maxRetries !== undefined && {
      maxRetries: options.maxRetries,
    }),
    ...(options.abortSignal && { abortSignal: options.abortSignal }),
    // Sampling params, headers, reasoning, telemetry, activeTools, prepareStep -
    // all typed as passthroughs off Parameters<typeof generateText>[0] in ObjectOptions.
    ...buildCommonCallOptions(options),
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
    temperature: options.temperature ?? 0,
    maxTokens: options.maxTokens,
    hasTools,
    isMultimodal,
  });

  try {
    const result = isMultimodal
      ? await aiGenerateText({
          ...baseOptions,
          messages: buildMultimodalMessages(prompt as ContentPart[]),
        })
      : isMessages
        ? await aiGenerateText({
            ...baseOptions,
            messages: (prompt as MessagesInput).messages,
          } as Parameters<typeof aiGenerateText>[0])
        : await aiGenerateText({
            ...baseOptions,
            prompt,
          });

    const inputTokens = result.usage?.inputTokens ?? 0;
    const outputTokens = result.usage?.outputTokens ?? 0;
    const totalTokens = result.usage?.totalTokens;
    const cachedInputTokens = result.usage?.inputTokenDetails?.cacheReadTokens;
    const reasoningTokens = result.usage?.outputTokenDetails?.reasoningTokens;
    const cost = calculateCostWithDiscount(
      modelKey,
      inputTokens,
      outputTokens,
      false,
      { cachedInputTokens, reasoningTokens },
    );
    const durationMs = Date.now() - startTime;
    const usageDetailMetadata = buildUsageDetailMetadata({
      totalTokens,
      cachedInputTokens,
      reasoningTokens,
    });

    // Log the call (including error cases where finishReason is "error")
    ctx.aiCallLogger.logCall({
      topic: ctx.topic,
      callType: "object",
      modelKey,
      modelId: modelConfig.id,
      prompt: promptForLog,
      response: JSON.stringify(result.output, null, 2),
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
        ...usageDetailMetadata,
      },
    });

    // Trace log after successful AI call
    const responseStr = JSON.stringify(result.output);
    logger.debug(`generateObject response`, {
      model: modelKey,
      response:
        responseStr.substring(0, 500) + (responseStr.length > 500 ? "..." : ""),
      inputTokens,
      outputTokens,
      cost: cost.toFixed(6),
      durationMs,
      finishReason: result.finishReason,
    });

    return {
      object: result.output as z.infer<TSchema>,
      inputTokens,
      outputTokens,
      cost,
      ...(totalTokens !== undefined && { totalTokens }),
      ...(cachedInputTokens !== undefined && { cachedInputTokens }),
      ...(reasoningTokens !== undefined && { reasoningTokens }),
      finishReason: result.finishReason,
      warnings: result.warnings,
      toolCalls: result.toolCalls,
      toolResults: result.toolResults,
      steps: result.steps,
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
    throw error;
  }
}
