/**
 * Multi-step reported cost.
 *
 * A tool-calling call runs several model steps. The AI SDK's top-level
 * `usage` is the total across them, but `providerMetadata` (and
 * `finalStep`) carry only the last step's reported cost, so reading it as
 * the call's cost under-reports every tool-calling call. The rule: sum the
 * per-step figures when every step that produced usage reported one;
 * otherwise estimate the whole call.
 */

import { beforeAll, describe, expect, it } from "vitest";
import { registerModels } from "../../ai/model-helper.js";
import { resolveCost } from "../../ai/shared.js";
import {
  costResultLikeForSteps,
  sumReportedCostAcrossSteps,
} from "../../ai/step-cost.js";

const MODEL = "step-cost-test-model";
const CACHED_MODEL = "step-cost-cached-model";

beforeAll(() => {
  registerModels({
    [MODEL]: {
      id: "vendor/step-cost-test",
      name: "Step Cost Test",
      // $1/M in, $2/M out -> 1M in + 1M out = $3.00
      inputCostPerMillion: 1,
      outputCostPerMillion: 2,
      provider: "openrouter",
    },
    [CACHED_MODEL]: {
      id: "vendor/step-cost-cached",
      name: "Step Cost Cached",
      // $1/M in, $0.10/M cached in, $2/M out.
      inputCostPerMillion: 1,
      cachedInputCostPerMillion: 0.1,
      outputCostPerMillion: 2,
      provider: "openrouter",
    },
  });
});

function step(
  cost: number | undefined,
  tokens = 10,
  extra: { provider?: string; cachedTokens?: number } = {},
) {
  return {
    usage: { inputTokens: tokens, outputTokens: tokens },
    providerMetadata: {
      ...(cost === undefined && extra.provider === undefined
        ? {}
        : {
            openrouter: {
              ...(cost === undefined
                ? {}
                : {
                    usage: {
                      cost,
                      ...(extra.cachedTokens !== undefined
                        ? {
                            promptTokensDetails: {
                              cachedTokens: extra.cachedTokens,
                            },
                          }
                        : {}),
                    },
                  }),
              ...(extra.provider !== undefined
                ? { provider: extra.provider }
                : {}),
            },
          }),
    },
  };
}

describe("sumReportedCostAcrossSteps", () => {
  it("sums the reported cost of every step", () => {
    expect(sumReportedCostAcrossSteps([step(0.1), step(0.2), step(0.3)])).toBe(
      0.1 + 0.2 + 0.3,
    );
  });

  it("applies the BYOK upstream rule per step", () => {
    const byok = {
      usage: {
        inputTokens: 5,
        outputTokens: 5,
        raw: { is_byok: true, cost_details: { upstream_inference_cost: 0.5 } },
      },
      providerMetadata: { openrouter: { usage: { cost: 0.01 } } },
    };
    expect(sumReportedCostAcrossSteps([byok, step(0.2)])).toBeCloseTo(0.71, 10);
  });

  it("is unusable when a step that produced usage reported no cost", () => {
    expect(
      sumReportedCostAcrossSteps([step(0.1), step(undefined), step(0.3)]),
    ).toBeUndefined();
  });

  it("ignores a step that neither used tokens nor reported a cost", () => {
    expect(
      sumReportedCostAcrossSteps([step(0.1), step(undefined, 0), step(0.3)]),
    ).toBeCloseTo(0.4, 10);
  });

  it("treats unknown step usage without a reported cost as making the aggregate unavailable", () => {
    expect(
      sumReportedCostAcrossSteps([step(0.1), { providerMetadata: {} }]),
    ).toBeUndefined();
    expect(
      sumReportedCostAcrossSteps([step(0.1), { usage: {} }]),
    ).toBeUndefined();
    expect(
      sumReportedCostAcrossSteps([
        step(0.1),
        { usage: { inputTokens: 0, outputTokens: undefined } },
      ]),
    ).toBeUndefined();
  });

  it("includes a reported charge even when its step's token usage is zero", () => {
    expect(
      sumReportedCostAcrossSteps([step(0.1), step(0.05, 0), step(0.3)]),
    ).toBeCloseTo(0.45, 10);
  });

  it("does not fold a single-step or step-less result", () => {
    expect(sumReportedCostAcrossSteps([step(0.1)])).toBeUndefined();
    expect(sumReportedCostAcrossSteps(undefined)).toBeUndefined();
  });
});

describe("resolveCost over a multi-step result", () => {
  it("bills a three-step tool-calling call as the sum of its steps", () => {
    // The final step alone says $0.30; the call really cost $0.60.
    const result = {
      usage: { inputTokens: 1_000_000, outputTokens: 1_000_000 },
      providerMetadata: { openrouter: { usage: { cost: 0.3 } } },
      steps: [step(0.1), step(0.2), step(0.3)],
    };
    const r = resolveCost(
      MODEL,
      1_000_000,
      1_000_000,
      costResultLikeForSteps(result),
    );
    expect(r.costSource).toBe("reported");
    expect(r.cost).toBeCloseTo(0.6, 10);
    expect(r.reportedCostUsd).toBeCloseTo(0.6, 10);
  });

  it("estimates the whole call when one step lacks a reported cost", () => {
    // Neither the partial sum ($0.40) nor the final step ($0.30) is the
    // bill; the registry estimate ($3.00) is the honest number. The final
    // step's figure is reachable through both the top-level metadata and
    // `finalStep`; neither may leak into the fallback.
    const result = {
      usage: { inputTokens: 1_000_000, outputTokens: 1_000_000 },
      providerMetadata: { openrouter: { usage: { cost: 0.3 } } },
      finalStep: step(0.3),
      steps: [step(0.1), step(undefined), step(0.3)],
    };
    const r = resolveCost(
      MODEL,
      1_000_000,
      1_000_000,
      costResultLikeForSteps(result),
    );
    expect(r.costSource).toBe("estimated");
    expect(r.reportedCostUsd).toBeUndefined();
    expect(r.cost).toBeCloseTo(3, 10);
  });

  it("leaves a single-step result on its own reported figure", () => {
    const result = {
      usage: { inputTokens: 1_000_000, outputTokens: 1_000_000 },
      providerMetadata: { openrouter: { usage: { cost: 0.42 } } },
      steps: [step(0.42)],
    };
    expect(costResultLikeForSteps(result)).toBe(result);
    const r = resolveCost(
      MODEL,
      1_000_000,
      1_000_000,
      costResultLikeForSteps(result),
    );
    expect(r.costSource).toBe("reported");
    expect(r.cost).toBe(0.42);
  });
});

describe("costResultLikeForSteps accounting details", () => {
  it("keeps the aggregate token breakdown and the agreed serving endpoint", () => {
    // Half the input was a cache read: the estimate must price it at the
    // cached rate, and the row must keep the breakdown and the endpoint.
    const result = {
      usage: {
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
        inputTokenDetails: { cacheReadTokens: 500_000 },
        outputTokenDetails: { reasoningTokens: 100 },
      },
      steps: [
        step(0.1, 10, { provider: "Google" }),
        step(undefined, 10, { provider: "Google" }),
      ],
    };
    const r = resolveCost(
      CACHED_MODEL,
      1_000_000,
      1_000_000,
      costResultLikeForSteps(result),
    );
    expect(r.costSource).toBe("estimated");
    // 500k @ $1 + 500k @ $0.10 + 1M @ $2
    expect(r.cost).toBeCloseTo(0.5 + 0.05 + 2, 10);
    expect(r.servedBy).toBe("Google");
    expect(r.cachedInputTokens).toBe(500_000);
    expect(r.reasoningTokens).toBe(100);
  });

  it("sums per-step breakdowns when the aggregate carries none", () => {
    const result = {
      usage: { inputTokens: 1_000_000, outputTokens: 0 },
      steps: [
        step(0.1, 10, { cachedTokens: 200_000 }),
        step(0.2, 10, { cachedTokens: 300_000 }),
      ],
    };
    const r = resolveCost(
      CACHED_MODEL,
      1_000_000,
      0,
      costResultLikeForSteps(result),
    );
    expect(r.costSource).toBe("reported");
    expect(r.cachedInputTokens).toBe(500_000);
    expect(r.estimatedCostUsd).toBeCloseTo(0.5 + 0.05, 10);
  });

  it("omits servedBy when the steps were routed to different endpoints", () => {
    const result = {
      usage: { inputTokens: 20, outputTokens: 20 },
      steps: [
        step(0.1, 10, { provider: "Google" }),
        step(0.2, 10, { provider: "DeepInfra" }),
      ],
    };
    const r = resolveCost(MODEL, 20, 20, costResultLikeForSteps(result));
    expect(r.costSource).toBe("reported");
    expect(r.cost).toBeCloseTo(0.3, 10);
    expect(r.servedBy).toBeUndefined();
  });
});
