/**
 * `ai.evaluate` and `ctx.step.ai.evaluate`: typed questions about one state,
 * answered by a decision model (TypeSafe's Jev through OpenRouter's Decisions
 * API).
 *
 * The helper tests run the real AI SDK `experimental_evaluate` against a fake
 * evaluation model registered with `registerEvaluationProvider`, so the AI
 * SDK's own answer validation is exercised rather than mocked away.
 */

import type { Experimental_EvaluationModelV4 as EvaluationModelV4 } from "@ai-sdk/provider";
import { describe, expect, expectTypeOf, it, vi } from "vitest";
import { z } from "zod";
import {
  createAIHelper,
  getEvaluationModelProvider,
  registerEvaluationProvider,
} from "../../ai/ai-helper.js";
import { registerModels } from "../../ai/model-helper.js";
import { defineWorkflow } from "../../core/workflow.js";
import { createTestHarness } from "../../testing/index.js";

const DECIDER = "evaluate-test/decider";
const TEXT_MODEL = "evaluate-test/text";

registerModels({
  [DECIDER]: {
    id: "typesafe/jev-1.13",
    name: "Decider",
    inputCostPerMillion: 0.042,
    outputCostPerMillion: 0,
    provider: "evaluate-test",
    isEvaluationModel: true,
  },
  [TEXT_MODEL]: {
    id: "openai/gpt-4o-mini",
    name: "Text",
    inputCostPerMillion: 1,
    outputCostPerMillion: 2,
    provider: "evaluate-test",
  },
});

const QUESTIONS = {
  route: {
    type: "choice",
    instructions: "Which team should handle `ticket`?",
    criteria: {
      billing: "Charges, refunds and invoices.",
      technical: "Bugs and outages.",
    },
  },
  urgent: {
    type: "boolean",
    instructions: "Does `ticket` report an outage affecting customers?",
  },
  severity: {
    type: "score",
    instructions: "How severe is `ticket`?",
    criteria: ["Cosmetic.", "Degraded.", "Down."],
  },
} as const;

/** The answers a Decisions call returns for QUESTIONS, in the AI SDK shape. */
function fakeModel(options: {
  reportCost?: number;
  onCall?: () => void;
}): EvaluationModelV4 {
  return {
    specificationVersion: "v4",
    provider: "evaluate-test",
    modelId: "typesafe/jev-1.13",
    supportedQuestionTypes: ["choice", "score", "boolean"],
    async doEvaluate() {
      options.onCall?.();
      return {
        answers: {
          route: {
            type: "choice",
            choice: "technical",
            probabilities: { billing: 0.1, technical: 0.9 },
          },
          urgent: { type: "boolean", probability: 0.8 },
          severity: {
            type: "score",
            score: 1.5,
            probabilities: { "0": 0, "1": 0.5, "2": 0.5 },
          },
        },
        usage: { inputTokens: 400, outputTokens: 12 },
        warnings: [],
        providerMetadata: {
          openrouter: {
            provider: "TypeSafe",
            answers: {
              route: { confidence: 0.9 },
              urgent: {},
              severity: {
                confidence: 0.5,
                legend: { "0": "Cosmetic.", "1": "Degraded.", "2": "Down." },
              },
            },
            ...(options.reportCost !== undefined
              ? { usage: { cost: options.reportCost } }
              : {}),
          },
        },
        response: { id: "gen-dec-1", modelId: "typesafe/jev-1.13-20260917" },
      };
    },
  };
}

function makeLogger() {
  return {
    logCall: vi.fn(),
    getStats: vi.fn(),
    isRecorded: vi.fn().mockResolvedValue(false),
    logBatchResults: vi.fn().mockResolvedValue(undefined),
  };
}

describe("ai.evaluate", () => {
  it("answers every question typed from the question and logs the provider's reported cost", async () => {
    registerEvaluationProvider("evaluate-test", () =>
      fakeModel({ reportCost: 0.0000168 }),
    );
    const logger = makeLogger();
    const ai = createAIHelper("evaluate.test", logger);

    const result = await ai.evaluate(DECIDER, {
      state: { ticket: "Checkout returns 500 for every customer." },
      questions: QUESTIONS,
    });

    expect(result.answers.route).toEqual({
      type: "choice",
      choice: "technical",
      probabilities: { billing: 0.1, technical: 0.9 },
      confidence: 0.9,
    });
    expect(result.answers.urgent).toEqual({
      type: "boolean",
      probability: 0.8,
    });
    expect(result.answers.severity).toMatchObject({
      type: "score",
      score: 1.5,
      confidence: 0.5,
      legend: { "1": "Degraded." },
    });
    expect(result).toMatchObject({
      inputTokens: 400,
      outputTokens: 12,
      cost: 0.0000168,
      reportedCostUsd: 0.0000168,
      costSource: "reported",
    });

    expect(logger.logCall).toHaveBeenCalledTimes(1);
    expect(logger.logCall.mock.calls[0]![0]).toMatchObject({
      topic: "evaluate.test",
      callType: "evaluate",
      modelKey: DECIDER,
      inputTokens: 400,
      cost: 0.0000168,
      costSource: "reported",
      metadata: { questionCount: 3, responseId: "gen-dec-1" },
    });
  });

  it("estimates from input tokens alone when the provider reports no cost", async () => {
    registerEvaluationProvider("evaluate-test", () => fakeModel({}));
    const ai = createAIHelper("evaluate.test", makeLogger());

    const result = await ai.evaluate(DECIDER, {
      state: "Checkout is down.",
      questions: QUESTIONS,
    });

    // 400 input tokens at $0.042 per million; output is free.
    expect(result.cost).toBeCloseTo((400 * 0.042) / 1_000_000, 12);
    expect(result.costSource).toBe("estimated");
  });

  it("refuses a model that is not a decision model before calling any provider", async () => {
    const onCall = vi.fn();
    registerEvaluationProvider("evaluate-test", () => fakeModel({ onCall }));
    const logger = makeLogger();
    const ai = createAIHelper("evaluate.test", logger);

    await expect(
      ai.evaluate(TEXT_MODEL, { state: "x", questions: QUESTIONS }),
    ).rejects.toThrow(/not a decision model/);
    expect(onCall).not.toHaveBeenCalled();
    expect(logger.logCall).not.toHaveBeenCalled();
  });

  it("types each answer from its own question, without `as const`", () => {
    const ai = createAIHelper("evaluate.test", makeLogger());
    // Never called: the functions exist only so their result types can be read.
    const withConst = () =>
      ai.evaluate(DECIDER, { state: "x", questions: QUESTIONS });
    const inline = () =>
      ai.evaluate(DECIDER, {
        state: "x",
        questions: {
          lane: {
            type: "choice",
            instructions: "Which lane?",
            criteria: { fast: "Fast.", slow: "Slow." },
          },
          flagged: { type: "boolean", instructions: "Is it flagged?" },
        },
      });

    type Declared = Awaited<ReturnType<typeof withConst>>["answers"];
    expectTypeOf<Declared["route"]["choice"]>().toEqualTypeOf<
      "billing" | "technical"
    >();
    expectTypeOf<Declared["urgent"]["probability"]>().toEqualTypeOf<number>();
    expectTypeOf<Declared["severity"]["score"]>().toEqualTypeOf<number>();

    type Inline = Awaited<ReturnType<typeof inline>>["answers"];
    expectTypeOf<Inline["lane"]["choice"]>().toEqualTypeOf<"fast" | "slow">();
    expectTypeOf<Inline["flagged"]["probability"]>().toEqualTypeOf<number>();
  });

  it("routes OpenRouter decision models through the evaluation model with the price guard", () => {
    const model = getEvaluationModelProvider(
      {
        id: "typesafe/jev-1.13",
        name: "Jev",
        inputCostPerMillion: 0.042,
        outputCostPerMillion: 0,
        provider: "openrouter",
        isEvaluationModel: true,
      },
      { priceHeadroom: 2 },
    ) as EvaluationModelV4 & {
      settings: { extraBody?: { provider?: { max_price?: unknown } } };
    };

    expect(model.modelId).toBe("typesafe/jev-1.13");
    expect(model.settings.extraBody?.provider?.max_price).toEqual({
      prompt: 0.084,
      completion: 0,
    });
  });
});

describe("ctx.step.ai.evaluate", () => {
  it("memoises the decision so a replay after a suspension takes the same branch", async () => {
    const In = z.object({ ticket: z.string() });
    const workflow = defineWorkflow("step-ai-evaluate", { input: In })
      .stage("triage", {
        schemas: {
          input: In,
          output: z.object({ team: z.string() }),
          config: z.object({}),
        },
        async execute(ctx) {
          const decision = await ctx.step.ai.evaluate("route", DECIDER, {
            state: { ticket: ctx.input.ticket },
            questions: { team: QUESTIONS.route },
          });
          // Suspends once, so execute() runs again on the next tick.
          await ctx.step.sleep("cool-off", "1m");
          return { output: { team: decision.answers.team.choice } };
        },
      })
      .build();

    const harness = createTestHarness({ workflows: [workflow] });
    harness.mockAi.setEvaluateAnswer("team", {
      type: "choice",
      choice: "billing",
    });

    const result = await harness.run("step-ai-evaluate", {
      ticket: "I was charged twice.",
    });

    expect(result.status).toBe("COMPLETED");
    expect(result.output).toEqual({ team: "billing" });
    const evaluateCalls = harness.mockAi.helper
      .getAllCallsRecursive()
      .filter((call) => call.type === "evaluate");
    expect(evaluateCalls).toHaveLength(1);
  });
});
