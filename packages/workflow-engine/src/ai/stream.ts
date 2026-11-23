/**
 * AI Helper - streamText
 *
 * Streaming text generation on top of the AI SDK. The returned AsyncIterable
 * is a thin tap over the AI SDK's own `textStream`; usage/text/reasoning are
 * read from the AI SDK's buffered promises independently of iteration.
 */

import type { SharedV4ProviderOptions } from "@ai-sdk/provider";
import type { GenerateTextEndEvent, TextStreamPart, ToolSet } from "ai";
import { streamText as aiStreamText, NoOutputGeneratedError } from "ai";
import { type CallAccounting, logFailure } from "./generate";
import { getModel, type ModelKey } from "./model-helper";
import {
  assertAdapterProviderPolicy,
  logger,
  type ProviderResultLike,
  resolveCost,
  resolveLanguageModel,
} from "./shared";
import { costResultLikeForSteps } from "./step-cost";
import {
  createCallTimeout,
  runWithCallTimeout,
  timeoutErrorIfExpired,
} from "./timeouts.js";
import type {
  AdapterStreamResponse,
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
  if (ctx.adapter?.streamText)
    assertAdapterProviderPolicy(ctx.routing?.provider);
  const model = ctx.adapter?.streamText
    ? undefined
    : resolveLanguageModel(ctx, modelConfig);
  const startTime = Date.now();
  const timeout = createCallTimeout(
    options.abortSignal,
    options.timeoutMs ?? ctx.timeout?.perCallMs,
    modelKey,
  );
  const hasTools = options.tools !== undefined;

  // For logging, extract prompt string
  const promptForLog =
    typeof input.prompt === "string"
      ? input.prompt
      : (JSON.stringify(input.messages) ?? "");

  // Each piece of work that can write this call's row is pending from its
  // start until it settles: the SDK request until its row is written or it
  // ends without one, and every reader below. A paused consumer keeps it open.
  const track = ctx.track ?? (<T>(work: Promise<T>) => work);
  let closeStream: (() => void) | undefined;
  // Both SDK callbacks and consumer accessors can observe the same failure.
  let errorLogged = false;
  let streamError: { error: unknown } | undefined;
  const steps: ProviderResultLike[] = [];
  const onStepEnd: StreamOptions["onStepEnd"] = async (step) => {
    steps.push(step);
    // The SDK path calls the caller's callback only with tools; an adapter gets it as given.
    if (hasTools || ctx.adapter?.streamText) await options.onStepEnd?.(step);
  };

  // Error handler that logs the error to DB
  const logError = (
    error: unknown,
    accounting?: CallAccounting,
    observed?: ProviderResultLike,
  ) => {
    if (errorLogged || usageResolved) return;
    errorLogged = true;
    const callError = timeoutErrorIfExpired(timeout, error);

    logFailure(ctx, {
      topic: ctx.topic,
      callType: "stream",
      modelKey,
      modelId: modelConfig.id,
      prompt: promptForLog,
      startTime,
      error: callError,
      steps,
      accounting,
      result:
        observed ??
        (adapterResponse && {
          usage: {
            inputTokens: adapterResponse.inputTokens,
            outputTokens: adapterResponse.outputTokens,
          },
          providerMetadata: adapterResponse.providerMetadata,
          costUsd: adapterResponse.costUsd,
        }),
      metadata: {
        temperature: options.temperature,
        maxTokens: options.maxTokens,
        ...(input.instructions ? { instructions: input.instructions } : {}),
      },
    });
    timeout.cleanup();
  };

  const recordStreamError = (error: unknown) => {
    if (streamError || usageResolved) return;
    streamError = { error };
    if (!result) {
      logError(error);
      return;
    }
    // Reading usage keeps the SDK draining when a consumer stops at an error.
    // onEnd or getUsage will persist the bill once the SDK has reported it.
    void track(Promise.resolve().then(() => getUsage())).catch(() => {});
  };

  // Trace log before stream starts
  logger.debug(`streamText request`, {
    model: modelKey,
    modelId: modelConfig.id,
    prompt:
      promptForLog.substring(0, 500) + (promptForLog.length > 500 ? "..." : ""),
    temperature: options.temperature,
    maxTokens: options.maxTokens,
    hasTools,
    hasInstructions: !!input.instructions,
  });

  let fullText = "";
  let chunkCount = 0;
  let usageResolved = false;
  let cachedUsage: {
    inputTokens: number;
    outputTokens: number;
    cost: number;
    reportedCostUsd?: number;
    costSource?: "reported" | "estimated";
  } | null = null;

  // Persist the call exactly once, whether triggered by the AI SDK's
  // onEnd callback (so a call is always logged even if the consumer
  // never calls getUsage()) or by an explicit getUsage() call.
  const persistUsage = (
    inputTokens: number,
    outputTokens: number,
    responseText: string,
    reasoning: string | undefined,
    resultLike?: ProviderResultLike,
  ) => {
    if (usageResolved) return cachedUsage!;

    const accounting: CallAccounting = {
      inputTokens,
      outputTokens,
      ...resolveCost(
        modelKey,
        inputTokens,
        outputTokens,
        costResultLikeForSteps(resultLike),
      ),
    };
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

    if (streamError) {
      const usage = resultLike?.usage ?? resultLike?.totalUsage;
      // A transport failure can leave finalized steps without an SDK aggregate.
      const hasTotals =
        usage?.inputTokens != null && usage?.outputTokens != null;
      logError(
        streamError.error,
        hasTotals ? accounting : undefined,
        resultLike,
      );
    }
    usageResolved = true;
    cachedUsage = {
      inputTokens,
      outputTokens,
      cost,
      ...(reportedCostUsd !== undefined ? { reportedCostUsd } : {}),
      costSource,
    };

    // The SDK can finish with buffered step usage after emitting an error.
    if (errorLogged) {
      closeStream?.();
      return cachedUsage;
    }

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
        streamChunks: chunkCount,
        durationMs,
        ...(reasoning ? { hasReasoning: true } : {}),
        ...(input.instructions ? { instructions: input.instructions } : {}),
      },
    });

    closeStream?.();
    timeout.cleanup();

    return cachedUsage;
  };

  // The adapter path persists from stream completion or getUsage(),
  // whichever comes first; both must hand cost resolution the same inputs
  // so the recorded cost does not depend on consumption order.
  const persistAdapterUsage = (response: AdapterStreamResponse) =>
    persistUsage(
      response.inputTokens ?? 0,
      response.outputTokens ?? 0,
      response.text ?? fullText,
      response.reasoning,
      {
        providerMetadata: response.providerMetadata,
        costUsd: response.costUsd,
      },
    );

  // Build the streamText params based on input type
  const baseParams = {
    model,
    // Sent only when the caller sets it (see generate.ts).
    ...(options.temperature !== undefined && {
      temperature: options.temperature,
    }),
    maxOutputTokens: options.maxTokens,
    ...(options.maxRetries !== undefined && {
      maxRetries: options.maxRetries,
    }),
    ...(timeout.signal && { abortSignal: timeout.signal }),
    ...(input.instructions ? { instructions: input.instructions } : {}),
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
    onError: ({ error }: { error: unknown }) => recordStreamError(error),
    onAbort: () => closeStream?.(),
    // Sees the request's parts before the SDK's own end handling. An error
    // part can precede a billable finish, so the end decides: the SDK calls
    // onEnd (and writes the row) only for a finished step and no
    // NoOutputGeneratedError. A provider, tool or transport failure errors
    // the stream and cancels this transform.
    experimental_transform: () => {
      let finishedStep = false;
      let noOutput = false;
      return new TransformStream<
        TextStreamPart<ToolSet>,
        TextStreamPart<ToolSet>
      >({
        transform(part, controller) {
          if (part.type === "finish-step") finishedStep = true;
          if (
            part.type === "error" &&
            NoOutputGeneratedError.isInstance(part.error)
          )
            noOutput = true;
          controller.enqueue(part);
        },
        flush() {
          if (!finishedStep || noOutput) closeStream?.();
        },
        cancel() {
          closeStream?.();
        },
      });
    },
    // Ensure the call is always logged once the stream finishes, even if
    // the consumer never calls getUsage(). Dedup'd against getUsage() via
    // the usageResolved flag in persistUsage.
    onEnd: (event: GenerateTextEndEvent<ToolSet>) => {
      const inputTokens =
        event.usage?.inputTokens ?? event.totalUsage?.inputTokens ?? 0;
      const outputTokens =
        event.usage?.outputTokens ?? event.totalUsage?.outputTokens ?? 0;
      persistUsage(
        inputTokens,
        outputTokens,
        event.text || fullText,
        event.reasoningText,
        event,
      );
    },
  };

  let adapterResponse: AdapterStreamResponse | undefined;
  let result: ReturnType<typeof aiStreamText> | undefined;
  try {
    const request = Promise.withResolvers<void>();
    void track(request.promise);
    closeStream = () => request.resolve();
    if (ctx.adapter?.streamText) {
      adapterResponse = ctx.adapter.streamText({
        model: modelConfig,
        ...("messages" in input && input.messages
          ? { messages: input.messages }
          : { prompt: (input as { prompt: string }).prompt }),
        ...(input.instructions ? { instructions: input.instructions } : {}),
        options: { ...options, abortSignal: timeout.signal, onStepEnd },
      });
    } else {
      result =
        "messages" in input && input.messages
          ? aiStreamText({
              ...baseParams,
              model: model!,
              messages: input.messages,
            })
          : aiStreamText({
              ...baseParams,
              model: model!,
              prompt: (input as { prompt: string }).prompt,
            });
    }
  } catch (error) {
    logError(error);
    closeStream?.();
    throw timeoutErrorIfExpired(timeout, error);
  }

  // Create async iterable that collects text and calls onChunk. This is a
  // thin tap over the AI SDK's own textStream - getUsage/getText/getReasoning
  // (below) reconcile against the buffered result independently.
  const streamIterable: AsyncIterable<string> = {
    [Symbol.asyncIterator]: () => {
      let reader: AsyncIterator<string>;
      try {
        reader = adapterResponse
          ? adapterResponse.stream[Symbol.asyncIterator]()
          : result!.textStream[Symbol.asyncIterator]();
      } catch (error) {
        logError(error);
        if (adapterResponse) closeStream?.();
        throw error;
      }
      const iterator: AsyncIterator<string> = {
        async next() {
          try {
            const { done, value } = await runWithCallTimeout(timeout, () =>
              reader.next(),
            ).catch((error: unknown) => {
              // An adapter's stream has ended; the SDK reports its own end.
              if (adapterResponse) closeStream?.();
              throw error;
            });
            if (done) {
              if (adapterResponse) persistAdapterUsage(adapterResponse);
              return { done: true, value: undefined };
            }
            fullText += value;
            chunkCount++;
            options.onChunk?.(value);
            return { done: false, value };
          } catch (error) {
            recordStreamError(error);
            throw timeoutErrorIfExpired(timeout, error);
          }
        },
      };
      return { next: () => track(iterator.next()) };
    },
  };

  // getUsage / getText / getReasoning read the AI SDK's own buffered promises
  // (result.usage / result.text / result.reasoningText). These resolve
  // independently of — and concurrently with — iterating `.stream`, so they
  // never open a second reader on result.textStream (which would throw a
  // ReadableStream lock error).

  // Create usage getter that waits for stream completion and persists
  // (or reuses the persistence already done by onEnd).
  const getUsage = async () => {
    try {
      if (timeout.timedOut() && timeout.error) throw timeout.error;
      if (adapterResponse) return persistAdapterUsage(adapterResponse);
      const sdkResult = result!;
      const [usage, steps] = await runWithCallTimeout(timeout, () =>
        Promise.all([sdkResult.usage, sdkResult.steps]),
      );
      const finalStep = steps.at(-1);
      return persistUsage(
        usage?.inputTokens ?? 0,
        usage?.outputTokens ?? 0,
        finalStep?.text || fullText,
        finalStep?.reasoningText,
        { usage, finalStep, steps },
      );
    } catch (error) {
      logError(streamError ? streamError.error : error);
      throw timeoutErrorIfExpired(timeout, error);
    }
  };

  // Full answer text, reconciled with the buffered result (handles models
  // that don't stream text incrementally). Empty for reasoning-only output.
  const getText = async () => {
    try {
      if (timeout.timedOut() && timeout.error) throw timeout.error;
      return adapterResponse
        ? (adapterResponse.text ?? fullText)
        : (await runWithCallTimeout(timeout, () => result!.text)) || fullText;
    } catch (error) {
      recordStreamError(error);
      throw timeoutErrorIfExpired(timeout, error);
    }
  };

  // Reasoning/thinking text, when the model emitted any (separate channel
  // from the answer). `finalStep.reasoningText` is the canonical v7 source;
  // the top-level (deprecated) field is a fallback for safety. Undefined
  // otherwise.
  const getReasoning = async () => {
    try {
      if (timeout.timedOut() && timeout.error) throw timeout.error;
      if (adapterResponse) return adapterResponse.reasoning;
      const finalStep = await runWithCallTimeout(
        timeout,
        () => result!.finalStep,
      );
      return (
        finalStep?.reasoningText ??
        (await runWithCallTimeout(timeout, () => result!.reasoningText))
      );
    } catch (error) {
      recordStreamError(error);
      throw timeoutErrorIfExpired(timeout, error);
    }
  };

  return {
    stream: streamIterable,
    getUsage: () => track(getUsage()),
    getText: () => track(getText()),
    getReasoning: () => track(getReasoning()),
    rawResult: result,
  };
}
