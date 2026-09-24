/**
 * AI Helper - Multi-step reported cost
 *
 * A tool-calling `generateText` / `streamText` call runs several model
 * steps, and the AI SDK's top-level `usage` is the total across them. The
 * provider-reported cost, however, is per response: the top-level
 * `providerMetadata` (and `finalStep`) carry only the LAST step's figure.
 * Reading it as the call's cost under-reports every tool-calling call.
 *
 * This module folds the per-step figures into one call-level number.
 * Not part of the public API.
 */

import {
  extractReportedCost,
  extractServedBy,
  extractUsageDetails,
  logger,
  type ProviderResultLike,
  type UsageDetails,
} from "./shared";

interface StepUsageLike {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  raw?: Record<string, unknown>;
}

interface StepLike {
  providerMetadata?: Record<string, unknown>;
  usage?: StepUsageLike;
}

interface MultiStepResultLike {
  steps?: readonly unknown[];
  /** The AI SDK's total usage across steps (generateText / onEnd). */
  usage?: StepUsageLike & Record<string, unknown>;
  /** streamText's onEnd event names the total `totalUsage`. */
  totalUsage?: StepUsageLike & Record<string, unknown>;
}

function stepProducedUsage(step: StepLike): boolean {
  const usage = step.usage;
  if (!usage) return false;
  return (
    (usage.inputTokens ?? 0) > 0 ||
    (usage.outputTokens ?? 0) > 0 ||
    (usage.totalTokens ?? 0) > 0
  );
}

/**
 * Sum the provider-reported cost across a multi-step result's steps.
 *
 * Rule: every step that produced usage must have reported a cost (each
 * read with the same BYOK handling as `extractReportedCost`); their sum is
 * the call's reported cost. A step that produced usage but reported no cost
 * makes the whole sum unusable — returning `undefined` so the caller falls
 * back to the estimate for the entire call rather than recording a partial
 * bill as if it were complete. Steps without usage contribute their cost
 * when they have one and are ignored otherwise.
 *
 * Returns `undefined` when `steps` is missing or has fewer than two entries;
 * a single-step result is the provider's own figure and needs no folding.
 */
export function sumReportedCostAcrossSteps(
  steps: readonly unknown[] | undefined,
): number | undefined {
  if (!Array.isArray(steps) || steps.length < 2) return undefined;

  let total = 0;
  let reportedSteps = 0;
  for (let index = 0; index < steps.length; index++) {
    const step = steps[index];
    if (!step || typeof step !== "object") continue;
    const cost = extractReportedCost(step as ProviderResultLike);
    if (cost !== undefined) {
      total += cost;
      reportedSteps++;
      continue;
    }
    if (stepProducedUsage(step as StepLike)) {
      logger.debug(
        `Step ${index + 1}/${steps.length} produced usage but reported no cost; the call's cost falls back to the estimate.`,
      );
      return undefined;
    }
  }

  return reportedSteps > 0 ? total : undefined;
}

function finiteCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

/**
 * Cached-input and reasoning counts for the whole call: the SDK's own
 * aggregate details when it carries them, else the per-step figures summed
 * (a step's OpenRouter metadata reports its own breakdown). Undefined when
 * no source reports a count.
 */
function usageDetailsAcrossSteps(
  aggregate: StepUsageLike | undefined,
  steps: readonly unknown[],
): UsageDetails {
  const fromAggregate = extractUsageDetails(
    aggregate ? { usage: { ...aggregate, raw: undefined } } : undefined,
  );
  let cached: number | undefined;
  let reasoning: number | undefined;
  for (const step of steps) {
    if (!step || typeof step !== "object") continue;
    const details = extractUsageDetails(step as ProviderResultLike);
    if (details.cachedInputTokens !== undefined) {
      cached = (cached ?? 0) + details.cachedInputTokens;
    }
    if (details.reasoningTokens !== undefined) {
      reasoning = (reasoning ?? 0) + details.reasoningTokens;
    }
  }
  const cachedInputTokens = fromAggregate.cachedInputTokens ?? cached;
  const reasoningTokens = fromAggregate.reasoningTokens ?? reasoning;
  return {
    ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
    ...(reasoningTokens !== undefined ? { reasoningTokens } : {}),
  };
}

/**
 * The endpoint that served the call. Kept only when every step that names
 * one names the same endpoint; a call whose steps were routed to different
 * endpoints has no single `servedBy` and the field is omitted.
 */
function servedByAcrossSteps(steps: readonly unknown[]): string | undefined {
  let servedBy: string | undefined;
  for (const step of steps) {
    if (!step || typeof step !== "object") continue;
    const stepServedBy = extractServedBy(step as ProviderResultLike);
    if (stepServedBy === undefined) continue;
    if (servedBy === undefined) {
      servedBy = stepServedBy;
    } else if (servedBy !== stepServedBy) {
      return undefined;
    }
  }
  return servedBy;
}

/**
 * The value to hand `resolveCost` for an AI SDK result.
 *
 * A single-step result is returned as-is (its own `providerMetadata` is the
 * whole bill). A multi-step result becomes a `ProviderResultLike` that keeps
 * the call's aggregate usage (token totals plus the cached-input and
 * reasoning breakdowns, so the estimate prices cached input at the cached
 * rate) and the serving endpoint (when all steps agree), and replaces only
 * the reported-cost decision: the summed cost as `costUsd`, or no cost at
 * all when the sum is unusable. Neither the top-level `providerMetadata`
 * nor `finalStep` is carried, so `resolveCost` cannot rediscover the last
 * step's figure and estimates the whole call instead.
 */
export function costResultLikeForSteps<T>(result: T): T | ProviderResultLike {
  const multi = result as MultiStepResultLike | undefined;
  const steps = multi?.steps;
  if (!Array.isArray(steps) || steps.length < 2) return result;

  const aggregate = multi?.usage ?? multi?.totalUsage;
  const costUsd = sumReportedCostAcrossSteps(steps);
  const servedBy = servedByAcrossSteps(steps);
  const usage = {
    ...(finiteCount(aggregate?.inputTokens) !== undefined
      ? { inputTokens: aggregate!.inputTokens }
      : {}),
    ...(finiteCount(aggregate?.outputTokens) !== undefined
      ? { outputTokens: aggregate!.outputTokens }
      : {}),
    ...(finiteCount(aggregate?.totalTokens) !== undefined
      ? { totalTokens: aggregate!.totalTokens }
      : {}),
    ...usageDetailsAcrossSteps(aggregate, steps),
  };

  return {
    usage,
    ...(costUsd !== undefined ? { costUsd } : {}),
    ...(servedBy !== undefined
      ? { providerMetadata: { openrouter: { provider: servedBy } } }
      : {}),
  };
}
