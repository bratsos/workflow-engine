/**
 * `generateObject` and `generateText` + `Output.object` send the same
 * request: same messages, same response format (JSON + schema) and the same
 * default temperature. A consumer saw the two routes behave differently on
 * one model; the only field that differed was the default temperature.
 */

import type { LanguageModelV4CallOptions } from "@ai-sdk/provider";
import { Output } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createAIHelper } from "../../ai/ai-helper.js";
import { registerModels } from "../../ai/model-helper.js";
import type { ProviderResolver } from "../../ai/types.js";
import { InMemoryAICallLogger } from "../../testing/in-memory-ai-logger.js";

const MODEL = "route-parity-model";
registerModels({
  [MODEL]: {
    id: "parity/model",
    name: "Parity",
    provider: "parity",
    inputCostPerMillion: 1,
    outputCostPerMillion: 1,
  },
});

function capturingModel(captured: LanguageModelV4CallOptions[]) {
  return new MockLanguageModelV4({
    doGenerate: async (options) => {
      captured.push(options);
      return {
        content: [{ type: "text", text: '{"answer":1}' }],
        finishReason: { unified: "stop", raw: "stop" },
        usage: {
          inputTokens: { total: 1 },
          outputTokens: { total: 1 },
        },
        warnings: [],
      } as never;
    },
  });
}

describe("structured output route parity", () => {
  it("generateObject and generateText+Output.object issue identical requests", async () => {
    const captured: LanguageModelV4CallOptions[] = [];
    const resolver: ProviderResolver = () => capturingModel(captured) as never;
    const ai = createAIHelper(
      "parity",
      new InMemoryAICallLogger(),
      undefined,
      resolver,
    );
    const schema = z.object({ answer: z.number() });

    const viaObject = await ai.generateObject(MODEL, "question", schema);
    const viaText = await ai.generateText(MODEL, "question", {
      output: Output.object({ schema }),
    });

    expect(viaObject.object).toEqual({ answer: 1 });
    expect(viaText.output).toEqual({ answer: 1 });
    expect(captured).toHaveLength(2);
    const [a, b] = captured as [
      LanguageModelV4CallOptions,
      LanguageModelV4CallOptions,
    ];
    expect(a.prompt).toEqual(b.prompt);
    expect(a.temperature).toBe(b.temperature);
    expect(a.maxOutputTokens).toBe(b.maxOutputTokens);
    expect(a.responseFormat).toEqual(b.responseFormat);
    expect(a.responseFormat?.type).toBe("json");
    expect(a.providerOptions).toEqual(b.providerOptions);
  });
});
