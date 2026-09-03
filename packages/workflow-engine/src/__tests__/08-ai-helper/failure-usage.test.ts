/**
 * A failed object call that reached the model still consumed tokens: the
 * thrown `NoObjectGeneratedError` carries `usage`, which lands on the
 * accounting row (with the cost) instead of 0/0.
 */

import { NoObjectGeneratedError } from "ai";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createAIHelper } from "../../ai/ai-helper.js";
import { usageFromError } from "../../ai/generate.js";
import { registerModels } from "../../ai/model-helper.js";
import type { AIAdapter } from "../../ai/types.js";
import { InMemoryAICallLogger } from "../../testing/in-memory-ai-logger.js";

const MODEL = "failure-usage-model";
registerModels({
  [MODEL]: {
    id: "failure-usage/model",
    name: "Failure Usage Model",
    provider: "failure-usage",
    inputCostPerMillion: 1_000_000,
    outputCostPerMillion: 2_000_000,
  },
});

describe("usageFromError", () => {
  it("reads the AI SDK 7 shape, the provider shape and flat fields", () => {
    expect(
      usageFromError({ usage: { inputTokens: 12, outputTokens: 3 } }),
    ).toEqual({ inputTokens: 12, outputTokens: 3 });
    expect(
      usageFromError({
        usage: { inputTokens: { total: 7 }, outputTokens: { total: 1 } },
      }),
    ).toEqual({ inputTokens: 7, outputTokens: 1 });
    expect(usageFromError({ inputTokens: 4, outputTokens: 2 })).toEqual({
      inputTokens: 4,
      outputTokens: 2,
    });
    expect(usageFromError(new Error("plain"))).toEqual({
      inputTokens: 0,
      outputTokens: 0,
    });
  });
});

describe("generateObject failure accounting", () => {
  it("logs the tokens and cost carried by an adapter-thrown NoObjectGeneratedError", async () => {
    const adapter: AIAdapter = {
      generateObject: async () => {
        throw new NoObjectGeneratedError({
          message: "not JSON",
          text: "### nope",
          response: { id: "r", timestamp: new Date(), modelId: "m" },
          usage: {
            inputTokens: 30,
            outputTokens: 5,
            totalTokens: 35,
          } as never,
          finishReason: "stop",
        });
      },
    };
    const aiLogger = new InMemoryAICallLogger();
    const ai = createAIHelper("t", aiLogger, undefined, undefined, { adapter });

    await expect(
      ai.generateObject(MODEL, "extract", z.object({ a: z.string() })),
    ).rejects.toThrow("not JSON");

    const [row] = aiLogger.getCallsByTopic("t");
    expect(row).toMatchObject({
      callType: "object",
      inputTokens: 30,
      outputTokens: 5,
      cost: 30 + 10,
      metadata: expect.objectContaining({ status: "error" }),
    });
  });
});
