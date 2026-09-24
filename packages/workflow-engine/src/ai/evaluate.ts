/**
 * AI Helper - Evaluation
 *
 * `ai.evaluate()` on top of the AI SDK's evaluation seam: typed questions
 * about one shared state, answered by a decision model (TypeSafe's Jev
 * through OpenRouter's Decisions API). The engine owns its own question and
 * answer types (see types.ts) so its API does not move when the AI SDK
 * reshapes the experimental types underneath.
 */

import type { Experimental_EvaluationModelV4 as EvaluationModelV4 } from "@ai-sdk/provider";
import { openrouter } from "@openrouter/ai-sdk-provider";
import { experimental_evaluate as aiEvaluate } from "ai";
import { logFailure } from "./generate";
import { getModel, type ModelConfig, type ModelKey } from "./model-helper";
import {
  buildOpenRouterRoutingProvider,
  logger,
  type OpenRouterRoutingOptions,
  resolveCost,
} from "./shared";
import { createCallTimeout, runWithCallTimeout } from "./timeouts.js";
import type {
  AIEvaluateResult,
  AIHelperContext,
  EvaluateOptions,
  EvaluationQuestions,
  EvaluationSpec,
} from "./types";

// ============================================================================
// Custom Evaluation Provider Registry
// ============================================================================

const evaluationProviderRegistry = new Map<
  string,
  (modelId: string) => EvaluationModelV4
>();

/**
 * Register an evaluation model factory for a registry `provider` name, the
 * way `registerEmbeddingProvider` does for embeddings. The factory receives
 * the model id and returns an AI SDK evaluation model.
 *
 * @example
 * ```typescript
 * import { registerEvaluationProvider } from "@bratsos/workflow-engine";
 * import { createOpenRouter } from "@openrouter/ai-sdk-provider";
 *
 * const openrouterEu = createOpenRouter({ baseURL: "https://eu.openrouter.ai/api/v1" });
 * registerEvaluationProvider("openrouter-eu", (id) => openrouterEu.evaluationModel(id));
 * ```
 */
export function registerEvaluationProvider(
  providerName: string,
  factory: (modelId: string) => EvaluationModelV4,
): void {
  evaluationProviderRegistry.set(providerName, factory);
}

/** @internal Exported for testing only */
export function getEvaluationModelProvider(
  modelConfig: ModelConfig,
  routing?: OpenRouterRoutingOptions,
): EvaluationModelV4 {
  const customFactory = evaluationProviderRegistry.get(modelConfig.provider);
  if (customFactory) {
    return customFactory(modelConfig.id);
  }

  if (modelConfig.provider === "openrouter") {
    return openrouter.evaluationModel(modelConfig.id, {
      // The same routing guard every other OpenRouter call carries: a
      // `max_price` ceiling at the registry price times `priceHeadroom`.
      extraBody: {
        provider: buildOpenRouterRoutingProvider(modelConfig, routing),
      },
    });
  }

  throw new Error(
    `Unsupported evaluation provider "${modelConfig.provider}" for model "${modelConfig.id}". ` +
      `Register it with registerEvaluationProvider() or use the built-in "openrouter" provider.`,
  );
}

// ============================================================================
// evaluate()
// ============================================================================

/** Per-answer extras OpenRouter returns in `providerMetadata.openrouter.answers`. */
function answerExtras(
  providerMetadata: unknown,
  id: string,
): { confidence?: number; legend?: Record<string, string> } {
  const answers = (
    providerMetadata as
      | { openrouter?: { answers?: Record<string, unknown> } }
      | undefined
  )?.openrouter?.answers;
  const extra = answers?.[id] as
    | { confidence?: unknown; legend?: unknown }
    | undefined;
  if (!extra) return {};
  return {
    ...(typeof extra.confidence === "number"
      ? { confidence: extra.confidence }
      : {}),
    ...(extra.legend !== null && typeof extra.legend === "object"
      ? { legend: extra.legend as Record<string, string> }
      : {}),
  };
}

function describeCall(spec: EvaluationSpec<EvaluationQuestions>): string {
  return JSON.stringify({ state: spec.state, questions: spec.questions });
}

export async function evaluate<const Q extends EvaluationQuestions>(
  ctx: AIHelperContext,
  modelKey: ModelKey,
  spec: EvaluationSpec<Q>,
  options: EvaluateOptions = {},
): Promise<AIEvaluateResult<Q>> {
  const modelConfig = getModel(modelKey);
  if (!modelConfig.isEvaluationModel) {
    throw new Error(
      `Model "${modelKey}" is not a decision model, so it cannot answer ai.evaluate(). ` +
        `Use a model whose registry entry has isEvaluationModel: true (for example ` +
        `"typesafe/jev-1.13"); re-run workflow-engine-sync if a decision model is missing the flag.`,
    );
  }

  const questionIds = Object.keys(spec.questions);
  const prompt = describeCall(spec);
  const startTime = Date.now();
  const timeout = createCallTimeout(
    options.abortSignal,
    options.timeoutMs ?? ctx.timeout?.perCallMs,
    modelKey,
  );

  logger.debug(`evaluate request`, {
    model: modelKey,
    modelId: modelConfig.id,
    provider: modelConfig.provider,
    questions: questionIds,
  });

  try {
    const model = getEvaluationModelProvider(modelConfig, ctx.routing);
    const result = await runWithCallTimeout(timeout, (signal) =>
      aiEvaluate({
        model,
        state: spec.state,
        // The engine's question type is structurally the AI SDK's; the cast
        // only bridges the two declarations.
        questions: spec.questions as Parameters<
          typeof aiEvaluate
        >[0]["questions"],
        abortSignal: signal,
        ...(options.maxRetries !== undefined
          ? { maxRetries: options.maxRetries }
          : {}),
        ...(options.headers !== undefined ? { headers: options.headers } : {}),
        ...(options.providerOptions !== undefined
          ? {
              providerOptions: options.providerOptions as Parameters<
                typeof aiEvaluate
              >[0]["providerOptions"],
            }
          : {}),
      }),
    );

    const answers = Object.fromEntries(
      questionIds.map((id) => [
        id,
        {
          ...(result.answers as Record<string, object>)[id],
          ...answerExtras(result.providerMetadata, id),
        },
      ]),
    ) as AIEvaluateResult<Q>["answers"];

    const inputTokens = result.usage.inputTokens ?? 0;
    const outputTokens = result.usage.outputTokens ?? 0;
    const { cost, estimatedCostUsd, reportedCostUsd, costSource, servedBy } =
      resolveCost(modelKey, inputTokens, outputTokens, {
        providerMetadata: result.providerMetadata,
      });
    const durationMs = Date.now() - startTime;

    ctx.aiCallLogger.logCall({
      topic: ctx.topic,
      callType: "evaluate",
      modelKey,
      modelId: modelConfig.id,
      prompt,
      response: JSON.stringify(answers),
      inputTokens,
      outputTokens,
      cost,
      estimatedCost: estimatedCostUsd,
      reportedCost: reportedCostUsd,
      costSource,
      ...(servedBy !== undefined ? { servedBy } : {}),
      metadata: {
        questionCount: questionIds.length,
        durationMs,
        ...(result.response.id ? { responseId: result.response.id } : {}),
      },
    });

    logger.debug(`evaluate response`, {
      model: modelKey,
      inputTokens,
      cost: cost.toFixed(6),
      durationMs,
    });

    return {
      answers,
      inputTokens,
      outputTokens,
      cost,
      ...(reportedCostUsd !== undefined ? { reportedCostUsd } : {}),
      costSource,
    };
  } catch (error) {
    const { errorMessage, durationMs } = logFailure(ctx.aiCallLogger, {
      topic: ctx.topic,
      callType: "evaluate",
      modelKey,
      modelId: modelConfig.id,
      prompt,
      startTime,
      error,
      metadata: { questionCount: questionIds.length },
    });
    logger.error(`evaluate error`, {
      model: modelKey,
      error: errorMessage,
      durationMs,
    });
    throw error;
  } finally {
    timeout.cleanup();
  }
}
