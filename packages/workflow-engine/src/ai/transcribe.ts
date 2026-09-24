/**
 * AI Helper - Transcription
 *
 * `ai.transcribe()` on top of the AI SDK's `transcribe`: speech to text with
 * OpenAI's or Google's transcription models, or any AI SDK transcription
 * model registered with `registerTranscriptionProvider`. Cost is estimated
 * per minute of audio (`transcriptionCostPerMinute`) where the provider reports
 * a duration, and per token (the registry's input/output prices) where it
 * reports token usage, as Google does.
 */

import { google } from "@ai-sdk/google";
import type { TranscriptionModelV4 } from "@ai-sdk/provider";
import { transcribe as aiTranscribe } from "ai";
import { isMissingPackageError } from "./batch/ai-sdk";
import { logFailure } from "./generate";
import { getModel, type ModelConfig, type ModelKey } from "./model-helper";
import {
  calculateCostWithDiscount,
  extractReportedCost,
  logger,
} from "./shared";
import { createCallTimeout, runWithCallTimeout } from "./timeouts.js";
import type {
  AIHelperContext,
  AITranscribeResult,
  TranscribeOptions,
  TranscriptionAudio,
} from "./types";

// ============================================================================
// Custom Transcription Provider Registry
// ============================================================================

const transcriptionProviderRegistry = new Map<
  string,
  (modelId: string) => TranscriptionModelV4
>();

/**
 * Register a transcription model factory for a registry `provider` name, the
 * way `registerEmbeddingProvider` does for embeddings. The factory receives
 * the model id and returns an AI SDK transcription model.
 *
 * @example
 * ```typescript
 * import { registerTranscriptionProvider } from "@bratsos/workflow-engine";
 * import { groq } from "@ai-sdk/groq";
 *
 * registerTranscriptionProvider("groq", (id) => groq.transcription(id));
 * ```
 */
export function registerTranscriptionProvider(
  providerName: string,
  factory: (modelId: string) => TranscriptionModelV4,
): void {
  transcriptionProviderRegistry.set(providerName, factory);
}

/** @internal Exported for testing only */
export async function getTranscriptionModelProvider(
  modelConfig: ModelConfig,
): Promise<TranscriptionModelV4> {
  const customFactory = transcriptionProviderRegistry.get(modelConfig.provider);
  if (customFactory) {
    return customFactory(modelConfig.id);
  }

  if (modelConfig.provider === "google") {
    // The registry may carry the catalogue slug (`google/...`); the Google
    // API wants the bare model id.
    return google.transcription(modelConfig.id.replace(/^google\//, ""));
  }

  if (modelConfig.provider === "openai") {
    // An optional peer, loaded only when an OpenAI transcription is asked for.
    try {
      const { openai } = await import("@ai-sdk/openai");
      return openai.transcription(modelConfig.id.replace(/^openai\//, ""));
    } catch (error) {
      if (isMissingPackageError(error, "@ai-sdk/openai")) {
        throw new Error(
          `Package "@ai-sdk/openai" is required to transcribe with "${modelConfig.id}". Install @ai-sdk/openai.`,
        );
      }
      throw error;
    }
  }

  throw new Error(
    `Unsupported transcription provider "${modelConfig.provider}" for model "${modelConfig.id}". ` +
      `Register it with registerTranscriptionProvider() or use a built-in provider ("openai", "google").`,
  );
}

// ============================================================================
// transcribe()
// ============================================================================

function tokenCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

/**
 * Token usage a transcription provider reports in its metadata. Some bill by
 * tokens rather than minutes: Google's transcription models report
 * `usage.total_input_tokens` / `total_output_tokens` under
 * `providerMetadata.google`. Any provider namespace with a `usage` object in
 * one of the common spellings is read the same way.
 */
function usageFromMetadata(providerMetadata: unknown): {
  inputTokens: number;
  outputTokens: number;
} {
  if (!providerMetadata || typeof providerMetadata !== "object") {
    return { inputTokens: 0, outputTokens: 0 };
  }
  for (const namespace of Object.values(providerMetadata)) {
    const usage = (namespace as { usage?: Record<string, unknown> } | null)
      ?.usage;
    if (!usage || typeof usage !== "object") continue;
    const inputTokens =
      tokenCount(usage.total_input_tokens) ??
      tokenCount(usage.input_tokens) ??
      tokenCount(usage.inputTokens);
    const outputTokens =
      tokenCount(usage.total_output_tokens) ??
      tokenCount(usage.output_tokens) ??
      tokenCount(usage.outputTokens);
    if (inputTokens !== undefined || outputTokens !== undefined) {
      return { inputTokens: inputTokens ?? 0, outputTokens: outputTokens ?? 0 };
    }
  }
  return { inputTokens: 0, outputTokens: 0 };
}

/** A short description of the audio for the call log; never the bytes. */
function describeAudio(audio: TranscriptionAudio): string {
  if (audio instanceof URL) return `[audio ${audio.href}]`;
  if (typeof audio === "string") {
    return `[audio base64, ~${Math.floor((audio.length * 3) / 4)} bytes]`;
  }
  return `[audio ${audio.byteLength} bytes]`;
}

export async function transcribe(
  ctx: AIHelperContext,
  modelKey: ModelKey,
  audio: TranscriptionAudio,
  options: TranscribeOptions = {},
): Promise<AITranscribeResult> {
  const modelConfig = getModel(modelKey);
  if (!modelConfig.isTranscriptionModel) {
    throw new Error(
      `Model "${modelKey}" is not a transcription model, so it cannot answer ai.transcribe(). ` +
        `Register one with isTranscriptionModel: true (for example OpenAI's "whisper-1" with ` +
        `provider: "openai") and set transcriptionCostPerMinute to track its cost.`,
    );
  }

  const prompt = describeAudio(audio);
  const startTime = Date.now();
  const timeout = createCallTimeout(
    options.abortSignal,
    options.timeoutMs ?? ctx.timeout?.perCallMs,
    modelKey,
  );

  logger.debug(`transcribe request`, {
    model: modelKey,
    modelId: modelConfig.id,
    provider: modelConfig.provider,
    audio: prompt,
  });

  try {
    const model = await getTranscriptionModelProvider(modelConfig);
    const result = await runWithCallTimeout(timeout, (signal) =>
      aiTranscribe({
        model,
        audio,
        abortSignal: signal,
        ...(options.maxRetries !== undefined
          ? { maxRetries: options.maxRetries }
          : {}),
        ...(options.headers !== undefined ? { headers: options.headers } : {}),
        ...(options.providerOptions !== undefined
          ? {
              providerOptions: options.providerOptions as Parameters<
                typeof aiTranscribe
              >[0]["providerOptions"],
            }
          : {}),
      }),
    );

    const durationInSeconds = result.durationInSeconds;
    const { inputTokens, outputTokens } = usageFromMetadata(
      result.providerMetadata,
    );
    // Per minute of audio where the provider reports a duration and the
    // registry has a rate, plus per token where the provider reports tokens
    // (the registry's input/output prices). A model is billed one way or the
    // other, so the unused half is zero.
    const estimatedCost =
      ((durationInSeconds ?? 0) / 60) *
        (modelConfig.transcriptionCostPerMinute ?? 0) +
      (inputTokens > 0 || outputTokens > 0
        ? calculateCostWithDiscount(modelKey, inputTokens, outputTokens, false)
        : 0);
    const reportedCostUsd = extractReportedCost({
      providerMetadata: result.providerMetadata,
    });
    const cost = reportedCostUsd ?? estimatedCost;
    const costSource: "reported" | "estimated" =
      reportedCostUsd !== undefined ? "reported" : "estimated";
    const durationMs = Date.now() - startTime;

    ctx.aiCallLogger.logCall({
      topic: ctx.topic,
      callType: "transcribe",
      modelKey,
      modelId: modelConfig.id,
      prompt,
      response: result.text,
      inputTokens,
      outputTokens,
      cost,
      reportedCost: reportedCostUsd,
      costSource,
      metadata: {
        durationMs,
        segmentCount: result.segments.length,
        ...(durationInSeconds !== undefined ? { durationInSeconds } : {}),
        ...(result.language !== undefined ? { language: result.language } : {}),
      },
    });

    logger.debug(`transcribe response`, {
      model: modelKey,
      durationInSeconds,
      characters: result.text.length,
      cost: cost.toFixed(6),
      durationMs,
    });

    return {
      text: result.text,
      segments: result.segments.map(({ text, startSecond, endSecond }) => ({
        text,
        startSecond,
        endSecond,
      })),
      ...(result.language !== undefined ? { language: result.language } : {}),
      ...(durationInSeconds !== undefined ? { durationInSeconds } : {}),
      cost,
      ...(reportedCostUsd !== undefined ? { reportedCostUsd } : {}),
      costSource,
    };
  } catch (error) {
    const { errorMessage, durationMs } = logFailure(ctx.aiCallLogger, {
      topic: ctx.topic,
      callType: "transcribe",
      modelKey,
      modelId: modelConfig.id,
      prompt,
      startTime,
      error,
    });
    logger.error(`transcribe error`, {
      model: modelKey,
      error: errorMessage,
      durationMs,
    });
    throw error;
  } finally {
    timeout.cleanup();
  }
}
