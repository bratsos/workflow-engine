/**
 * Cost resolution: provider-reported vs. locally estimated.
 *
 * Before 0.13 every cost in this library was estimated from a static price
 * table. OpenRouter reports the actual USD cost of a call, so we prefer it
 * when present. The BYOK branch is the subtle part: under BYOK the reported
 * `cost` is only OpenRouter's own fee and the real inference spend arrives
 * separately as `upstream_inference_cost`, so it must be added. Under
 * non-BYOK the reported cost already includes inference, so adding the
 * upstream figure would double-count it.
 */

import { beforeAll, describe, expect, it } from "vitest";
import {
  calculateCost,
  type ModelKey,
  registerModels,
} from "../../ai/model-helper.js";
import {
  calculateCostWithDiscount,
  extractReportedCost,
  resolveCost,
} from "../../ai/shared.js";

// Registry keys stay plain strings so the literals below remain distinct.
// `ModelKey` only narrows to the built-in enum plus whatever a consumer
// augments `ModelRegistry` with, so call sites need the cast.
const MODEL_ID = "cost-test-model";
const LONG_CTX_ID = "cost-test-long-context";
const BATCH_ID = "cost-test-batch";

const MODEL = MODEL_ID as ModelKey;
const LONG_CTX_MODEL = LONG_CTX_ID as ModelKey;
const BATCH_MODEL = BATCH_ID as ModelKey;

beforeAll(() => {
  registerModels({
    [MODEL_ID]: {
      id: "vendor/cost-test",
      name: "Cost Test",
      // $1/M in, $2/M out -> 1M in + 1M out = $3.00
      inputCostPerMillion: 1,
      outputCostPerMillion: 2,
      provider: "openrouter",
    },
    [LONG_CTX_ID]: {
      id: "vendor/long-context",
      name: "Long Context",
      inputCostPerMillion: 3,
      outputCostPerMillion: 15,
      provider: "openrouter",
      longContextTier: {
        minPromptTokens: 200_000,
        inputCostPerMillion: 6,
        outputCostPerMillion: 22.5,
      },
    },
    [BATCH_ID]: {
      id: "vendor/batch-test",
      name: "Batch Test",
      inputCostPerMillion: 10,
      outputCostPerMillion: 20,
      provider: "openrouter",
      supportsAsyncBatch: true,
      batchModelId: "vendor/batch-test:batch",
      // Deliberately NOT half: real catalog data has :batch variants ranging
      // from 0.25x to 4x, so the old flat "50% off" rule was wrong.
      batchInputCostPerMillion: 2.5,
      batchOutputCostPerMillion: 40,
      // Present on purpose: it must be IGNORED in favour of the absolute
      // prices above. Applying both is the triple-discount bug from 0.12.
      batchDiscountPercent: 50,
    },
  });
});

describe("extractReportedCost", () => {
  it("returns undefined when the provider reports nothing", () => {
    expect(extractReportedCost(undefined)).toBeUndefined();
    expect(extractReportedCost(null)).toBeUndefined();
    expect(extractReportedCost({})).toBeUndefined();
    expect(extractReportedCost({ providerMetadata: {} })).toBeUndefined();
  });

  it("reads cost from providerMetadata.openrouter.usage.cost", () => {
    const cost = extractReportedCost({
      providerMetadata: { openrouter: { usage: { cost: 0.00000285 } } },
    } as never);
    expect(cost).toBe(0.00000285);
  });

  it("reads cost off the final step when the top level has none", () => {
    const cost = extractReportedCost({
      finalStep: {
        providerMetadata: { openrouter: { usage: { cost: 0.25 } } },
      },
    } as never);
    expect(cost).toBe(0.25);
  });

  it("does NOT add upstream inference cost for a non-BYOK call", () => {
    // Non-BYOK: `cost` already includes inference. Adding upstream would
    // report roughly double the real spend.
    const cost = extractReportedCost({
      providerMetadata: { openrouter: { usage: { cost: 0.00000285 } } },
      usage: {
        raw: {
          is_byok: false,
          cost_details: { upstream_inference_cost: 0.00000285 },
        },
      },
    } as never);
    expect(cost).toBe(0.00000285);
  });

  it("DOES add upstream inference cost for a BYOK call", () => {
    // BYOK: `cost` is only OpenRouter's fee; inference was billed upstream.
    const cost = extractReportedCost({
      providerMetadata: { openrouter: { usage: { cost: 0 } } },
      usage: {
        raw: {
          is_byok: true,
          cost_details: { upstream_inference_cost: 0.00000285 },
        },
      },
    } as never);
    expect(cost).toBe(0.00000285);
  });

  it("never yields NaN from malformed provider data", () => {
    const cases = [
      { providerMetadata: { openrouter: { usage: { cost: "oops" } } } },
      { providerMetadata: { openrouter: { usage: { cost: Number.NaN } } } },
      {
        providerMetadata: { openrouter: { usage: { cost: 1 } } },
        usage: {
          raw: {
            is_byok: true,
            cost_details: { upstream_inference_cost: "x" },
          },
        },
      },
    ];
    for (const c of cases) {
      const cost = extractReportedCost(c as never);
      expect(cost === undefined || Number.isFinite(cost)).toBe(true);
    }
  });
});

describe("resolveCost", () => {
  it("falls back to the static estimate when nothing is reported", () => {
    const r = resolveCost(MODEL, 1_000_000, 1_000_000, undefined);
    expect(r.costSource).toBe("estimated");
    expect(r.reportedCostUsd).toBeUndefined();
    expect(r.cost).toBeCloseTo(3, 10);
  });

  it("prefers the reported cost over the estimate", () => {
    // The estimate would be $3.00; the provider says $0.42. Trust the provider.
    const r = resolveCost(MODEL, 1_000_000, 1_000_000, {
      providerMetadata: { openrouter: { usage: { cost: 0.42 } } },
    });
    expect(r.costSource).toBe("reported");
    expect(r.reportedCostUsd).toBe(0.42);
    expect(r.cost).toBe(0.42);
  });
});

describe("long-context pricing tier", () => {
  it("bills at base rates below the threshold", () => {
    const { totalCost } = calculateCost(LONG_CTX_MODEL, 199_999, 0);
    expect(totalCost).toBeCloseTo((199_999 / 1_000_000) * 3, 10);
  });

  it("bills at tier rates at and above the threshold", () => {
    // anthropic/claude-sonnet-4.5 really does double above 200k prompt
    // tokens. Missing this is a 2x under-report on long-document workloads.
    const { totalCost } = calculateCost(LONG_CTX_MODEL, 200_000, 0);
    expect(totalCost).toBeCloseTo((200_000 / 1_000_000) * 6, 10);
  });
});

describe("batch pricing", () => {
  it("uses the absolute batch prices and ignores batchDiscountPercent", () => {
    // 1M in @ $2.50 + 1M out @ $40 = $42.50.
    // If batchDiscountPercent were also applied it would come out $21.25.
    const cost = calculateCostWithDiscount(
      BATCH_MODEL,
      1_000_000,
      1_000_000,
      true,
    );
    expect(cost).toBeCloseTo(42.5, 10);
  });

  it("leaves non-batch cost on the base rates", () => {
    const cost = calculateCostWithDiscount(
      BATCH_MODEL,
      1_000_000,
      1_000_000,
      false,
    );
    expect(cost).toBeCloseTo(30, 10);
  });
});
