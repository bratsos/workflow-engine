/**
 * `WorkflowRun.totalCost` / `totalTokens` are rolled up from the AI call
 * logger under `workflow.<runId>` when the run completes.
 */

import { describe, expect, it } from "vitest";
import { z } from "zod";
import { registerModels } from "../../ai/model-helper.js";
import { defineWorkflow } from "../../core/workflow.js";
import { createTestHarness } from "../../testing/index.js";

const MODEL = "run-totals-model";
registerModels({
  [MODEL]: {
    id: "openai/gpt-4o-mini",
    name: "Run Totals Model",
    inputCostPerMillion: 1,
    outputCostPerMillion: 2,
    provider: "openrouter",
    supportsAsyncBatch: false,
  },
});

const In = z.object({ topic: z.string() });

describe("run cost and token totals", () => {
  it("writes the logger's roll-up onto the completed run", async () => {
    const workflow = defineWorkflow("run-totals", { input: In })
      .stage("write", {
        schemas: {
          input: In,
          output: z.object({ text: z.string() }),
          config: z.object({}),
        },
        async execute(ctx) {
          const a = await ctx.step.ai.generateText("a", MODEL, "draft");
          const b = await ctx.step.ai.generateText("b", MODEL, "polish");
          return { output: { text: a.text + b.text } };
        },
      })
      .build();
    const harness = createTestHarness({ workflows: [workflow] });
    harness.mockAi.setTextResponse("draft", {
      text: "d",
      inputTokens: 100,
      outputTokens: 50,
      cost: 0.25,
    });
    harness.mockAi.setTextResponse("polish", {
      text: "p",
      inputTokens: 10,
      outputTokens: 5,
      cost: 0.05,
    });

    const result = await harness.run("run-totals", { topic: "x" });

    expect(result.status).toBe("COMPLETED");
    expect(result.run.totalCost).toBeCloseTo(0.3, 9);
    expect(result.run.totalTokens).toBe(165);
  });
});
