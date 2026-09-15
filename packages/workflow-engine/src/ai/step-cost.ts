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

import { extractReportedCost, logger, type ProviderResultLike } from "./shared";

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

/**
 * The value to hand `resolveCost` for an AI SDK result.
 *
 * A single-step result is returned as-is (its own `providerMetadata` is the
 * whole bill). A multi-step result becomes a `ProviderResultLike` carrying
 * the summed cost as `costUsd` — or, when the sum is unusable, an empty one
 * so `resolveCost` estimates the whole call instead of silently taking the
 * final step's figure.
 */
export function costResultLikeForSteps<T>(result: T): T | ProviderResultLike {
  const steps = (result as MultiStepResultLike | undefined)?.steps;
  if (!Array.isArray(steps) || steps.length < 2) return result;
  const costUsd = sumReportedCostAcrossSteps(steps);
  return costUsd === undefined ? {} : { costUsd };
}
