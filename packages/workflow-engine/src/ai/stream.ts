/**
 * AI Helper - streamText
 *
 * Streaming text generation on top of the AI SDK. The returned AsyncIterable
 * is a thin tap over the AI SDK's own `textStream`; usage/text/reasoning are
 * read from the AI SDK's buffered promises independently of iteration.
 */

import type { SharedV3ProviderOptions } from "@ai-sdk/provider";
import { streamText as aiStreamText } from "ai";
import { logFailure } from "./generate";
import { getModel, type ModelKey } from "./model-helper";
import { calculateCostWithDiscount, getModelProvider, logger } from "./shared";
import type {
  AIHelperContext,
  AIStreamResult,
  StreamOptions,
  StreamTextInput,
} from "./types";

export function streamText(
  ctx: AIHelperContext,
  modelKey: ModelKey,
  input: StreamTextInput,
  options: StreamOptions = {},
): AIStreamResult {
  const modelConfig = getModel(modelKey);
  const model =
    ctx.providerResolver?.(modelConfig) ?? getModelProvider(modelConfig);
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

    logFailure(ctx.aiCallLogger, {
      topic: ctx.topic,
      callType: "stream",
      modelKey,
      modelId: modelConfig.id,
      prompt: promptForLog,
      startTime,
      error,
      metadata: {
        temperature: options.temperature,
        maxTokens: options.maxTokens,
        ...(input.system ? { system: input.system } : {}),
      },
    });
  };

  // Trace log before stream starts
  logger.debug(`streamText request`, {
    model: modelKey,
    modelId: modelConfig.id,
    prompt:
      promptForLog.substring(0, 500) + (promptForLog.length > 500 ? "..." : ""),
    temperature: options.temperature ?? 0.7,
    maxTokens: options.maxTokens,
    hasTools,
    hasSystem: !!input.system,
  });

  let fullText = "";
  let chunkCount = 0;
  let usageResolved = false;
  let cachedUsage: {
    inputTokens: number;
    outputTokens: number;
    cost: number;
  } | null = null;

  // Persist the call exactly once, whether triggered by the AI SDK's
  // onFinish callback (so a call is always logged even if the consumer
  // never calls getUsage()) or by an explicit getUsage() call.
  const persistUsage = (
    inputTokens: number,
    outputTokens: number,
    responseText: string,
    reasoning: string | undefined,
  ) => {
    if (usageResolved) return cachedUsage!;

    const cost = calculateCostWithDiscount(modelKey, inputTokens, outputTokens);
    const durationMs = Date.now() - startTime;

    usageResolved = true;
    cachedUsage = { inputTokens, outputTokens, cost };

    logger.debug(`streamText response`, {
      model: modelKey,
      response:
        responseText.substring(0, 500) +
        (responseText.length > 500 ? "..." : ""),
      inputTokens,
      outputTokens,
      cost: cost.toFixed(6),
      durationMs,
      chunkCount,
    });

    ctx.aiCallLogger.logCall({
      topic: ctx.topic,
      callType: "stream",
      modelKey,
      modelId: modelConfig.id,
      prompt: promptForLog,
      response: responseText,
      inputTokens,
      outputTokens,
      cost,
      metadata: {
        temperature: options.temperature,
        maxTokens: options.maxTokens,
        streamChunks: chunkCount,
        durationMs,
        ...(reasoning ? { hasReasoning: true } : {}),
        ...(input.system ? { system: input.system } : {}),
      },
    });

    return cachedUsage;
  };

  // Build the streamText params based on input type
  const baseParams = {
    model,
    temperature: options.temperature ?? 0.7,
    maxOutputTokens: options.maxTokens,
    ...(options.maxRetries !== undefined && {
      maxRetries: options.maxRetries,
    }),
    ...(options.abortSignal && { abortSignal: options.abortSignal }),
    ...(input.system ? { system: input.system } : {}),
    // Provider-specific options (e.g. reasoning control) passed through.
    // Cast: the public type uses `unknown` values for DX; the consumer is
    // responsible for passing JSON-serializable provider options.
    ...(options.providerOptions && {
      providerOptions: options.providerOptions as SharedV3ProviderOptions,
    }),
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
    // Ensure the call is always logged once the stream finishes, even if
    // the consumer never calls getUsage(). Dedup'd against getUsage() via
    // the usageResolved flag in persistUsage.
    onFinish: (event: {
      totalUsage?: { inputTokens?: number; outputTokens?: number };
      text?: string;
      reasoningText?: string;
    }) => {
      const inputTokens = event.totalUsage?.inputTokens ?? 0;
      const outputTokens = event.totalUsage?.outputTokens ?? 0;
      persistUsage(
        inputTokens,
        outputTokens,
        event.text || fullText,
        event.reasoningText,
      );
    },
  };

  const result =
    "messages" in input && input.messages
      ? aiStreamText({ ...baseParams, messages: input.messages })
      : aiStreamText({
          ...baseParams,
          prompt: (input as { prompt: string }).prompt,
        });

  // Create async iterable that collects text and calls onChunk. This is a
  // thin tap over the AI SDK's own textStream - getUsage/getText/getReasoning
  // (below) reconcile against the buffered result independently.
  const streamIterable: AsyncIterable<string> = {
    [Symbol.asyncIterator]: () => {
      const reader = result.textStream[Symbol.asyncIterator]();
      return {
        async next() {
          try {
            const { done, value } = await reader.next();
            if (done) {
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

  // getUsage / getText / getReasoning read the AI SDK's own buffered promises
  // (result.usage / result.text / result.reasoningText). These resolve
  // independently of — and concurrently with — iterating `.stream`, so they
  // never open a second reader on result.textStream (which would throw a
  // ReadableStream lock error).

  // Create usage getter that waits for stream completion and persists
  // (or reuses the persistence already done by onFinish).
  const getUsage = async () => {
    const usage = await result.usage;
    const reasoning = await result.reasoningText;
    const responseText = (await result.text) || fullText;
    const inputTokens = usage?.inputTokens ?? 0;
    const outputTokens = usage?.outputTokens ?? 0;

    return persistUsage(inputTokens, outputTokens, responseText, reasoning);
  };

  // Full answer text, reconciled with the buffered result (handles models
  // that don't stream text incrementally). Empty for reasoning-only output.
  const getText = async () => (await result.text) || fullText;

  // Reasoning/thinking text, when the model emitted any (separate channel
  // from the answer). Undefined otherwise.
  const getReasoning = async () => await result.reasoningText;

  return {
    stream: streamIterable,
    getUsage,
    getText,
    getReasoning,
    rawResult: result,
  };
}
