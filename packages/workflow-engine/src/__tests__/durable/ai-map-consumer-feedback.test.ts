/**
 * `ctx.step.ai.map` surfaces the consumer migration asked for: `errorName` on
 * failed items, per-slot pacing (`realtime.minDelayMs`), streamed items
 * (`stream: true`), and one-shot failure scripting through the real kernel.
 */

import { describe, expect, it } from "vitest";
import { z } from "zod";
import { registerModels } from "../../ai/model-helper.js";
import type { AiMapResult } from "../../core/step-ai.js";
import { defineWorkflow } from "../../core/workflow.js";
import { createTestHarness } from "../../testing/index.js";

const MODEL = "ai-map-feedback-model";

registerModels({
  [MODEL]: {
    id: "openai/gpt-4o-mini",
    name: "AI Map Feedback Model",
    inputCostPerMillion: 1,
    outputCostPerMillion: 2,
    provider: "openrouter",
    supportsAsyncBatch: false,
  },
});

class SubscriptionLimitError extends Error {
  constructor() {
    super("subscription limit reached");
    this.name = "SubscriptionLimitError";
  }
}

const In = z.object({ items: z.array(z.string()) });
const Out = z.object({ results: z.array(z.any()) });

/** One-stage workflow whose only job is to run a map and return its results. */
function mapWorkflow(
  id: string,
  spec: Partial<Parameters<typeof buildSpec>[0]> = {},
) {
  return defineWorkflow(id, { input: In })
    .stage("map", {
      schemas: { input: In, output: Out, config: z.object({}) },
      async execute(ctx) {
        const results = await ctx.step.ai.map("items", ctx.input.items, {
          model: MODEL,
          policy: "realtime",
          prompt: (item) => `process ${item}`,
          itemId: (item) => item,
          ...buildSpec(spec),
        });
        return { output: { results } };
      },
    })
    .build();
}

function buildSpec(spec: Record<string, unknown>) {
  return spec;
}

function results(output: unknown): AiMapResult<unknown>[] {
  return (output as { results: AiMapResult<unknown>[] }).results;
}

describe("ctx.step.ai.map — consumer feedback surfaces", () => {
  it("carries errorName on a failed item and keeps it across replays", async () => {
    const workflow = mapWorkflow("map-error-name", {
      realtime: { retries: 0, concurrency: 1 },
    });
    const harness = createTestHarness({ workflows: [workflow] });
    harness.mockAi.failOnce("process b", new SubscriptionLimitError());

    const result = await harness.run("map-error-name", {
      items: ["a", "b", "c"],
    });

    expect(result.status).toBe("COMPLETED");
    const [a, b, c] = results(result.output);
    expect(a?.status).toBe("succeeded");
    expect(c?.status).toBe("succeeded");
    expect(b).toMatchObject({
      status: "failed",
      errorName: "SubscriptionLimitError",
      error: "subscription limit reached",
    });
    // JSON-only: no `cause` on the stored result.
    expect(b && "cause" in b).toBe(false);
  });

  it("retries a scripted one-shot failure and succeeds on replay", async () => {
    const workflow = mapWorkflow("map-fail-once", {
      realtime: { retries: 1, concurrency: 2 },
    });
    const harness = createTestHarness({ workflows: [workflow] });
    harness.mockAi.setTextResponse("process", { text: "processed" });
    harness.mockAi.failOnce("process b", new Error("one bad call"));

    const result = await harness.run("map-fail-once", {
      items: ["a", "b", "c"],
    });

    expect(result.status).toBe("COMPLETED");
    expect(results(result.output).map((r) => r.status)).toEqual([
      "succeeded",
      "succeeded",
      "succeeded",
    ]);
    // The failed attempt suspended the stage (and replayed) rather than
    // failing the item.
    expect(result.reports[0]?.outcomes[0]?.outcome).toBe("suspended");
    expect(result.reports[0]?.suspendedChecked).toBeGreaterThan(0);
  });

  it("paces each concurrency slot with realtime.minDelayMs", async () => {
    const workflow = mapWorkflow("map-min-delay", {
      realtime: { concurrency: 1, minDelayMs: 40, retries: 0 },
    });
    const harness = createTestHarness({ workflows: [workflow] });

    const started = Date.now();
    const result = await harness.run("map-min-delay", {
      items: ["a", "b", "c"],
    });
    const elapsed = Date.now() - started;

    expect(result.status).toBe("COMPLETED");
    // Two gaps between three items on one slot; none after the last.
    expect(elapsed).toBeGreaterThanOrEqual(70);
  });

  it("streams realtime items and still validates the collected text", async () => {
    const ItemSchema = z.object({ value: z.string() });
    const workflow = defineWorkflow("map-stream", { input: In })
      .stage("map", {
        schemas: { input: In, output: Out, config: z.object({}) },
        async execute(ctx) {
          const mapped = await ctx.step.ai.map("items", ctx.input.items, {
            model: MODEL,
            policy: "realtime",
            stream: true,
            schema: ItemSchema,
            prompt: (item) => `process ${item}`,
            itemId: (item) => item,
            realtime: { retries: 0, concurrency: 2 },
          });
          return { output: { results: mapped } };
        },
      })
      .build();

    const harness = createTestHarness({ workflows: [workflow] });
    harness.mockAi.setTextResponse("process", {
      text: JSON.stringify({ value: "streamed" }),
    });

    const result = await harness.run("map-stream", { items: ["a", "b"] });

    expect(result.status).toBe("COMPLETED");
    expect(results(result.output)).toMatchObject([
      { status: "succeeded", validated: true, result: { value: "streamed" } },
      { status: "succeeded", validated: true, result: { value: "streamed" } },
    ]);
    // Every model call went through the streaming path.
    const calls = harness.mockAi.helper.getAllCallsRecursive();
    expect(calls.every((c) => c.type === "stream")).toBe(true);
    expect(calls).toHaveLength(2);
  });
});
