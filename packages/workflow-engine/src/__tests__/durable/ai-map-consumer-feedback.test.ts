/**
 * `ctx.step.ai.map` surfaces the consumer migration asked for: `errorName` on
 * failed items, per-slot pacing (`realtime.minDelayMs`), streamed items
 * (`stream: true`), and one-shot failure scripting through the real kernel.
 */

import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { registerModels } from "../../ai/model-helper.js";
import type { AiMapResult } from "../../core/step-ai.js";
import { NonRetryableError } from "../../core/steps.js";
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

const BATCH_MODEL = "ai-map-feedback-batch-model";

registerModels({
  [BATCH_MODEL]: {
    id: "openai/gpt-4o-mini",
    name: "AI Map Feedback Batch Model",
    inputCostPerMillion: 1,
    outputCostPerMillion: 2,
    provider: "openrouter",
    supportsAsyncBatch: true,
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

  it("keeps routing realtime when choosing a batch provider throws a decoded error with no text", async () => {
    const batch = {};
    Object.defineProperty(batch, "provider", {
      get() {
        throw { name: "ProviderUnavailable", message: "" };
      },
    });
    const workflow = mapWorkflow("map-provider-error", {
      model: BATCH_MODEL,
      policy: "auto",
      auto: { batchAbove: 1 },
      batch,
    });
    const harness = createTestHarness({ workflows: [workflow] });
    harness.mockAi.setTextResponse("process", { text: "processed" });

    const result = await harness.run("map-provider-error", { items: ["a"] });

    // Main's text for the error is not empty, so the map stays realtime.
    expect(result.status).toBe("COMPLETED");
    expect(results(result.output)[0]?.status).toBe("succeeded");
    expect(harness.mockAi.getCalls()).toHaveLength(1);
  });

  it("fails the stage without a model call when choosing a batch provider throws a value with no string form", async () => {
    const batch = {};
    Object.defineProperty(batch, "provider", {
      get() {
        throw Object.assign(Object.create(null), { code: "unavailable" });
      },
    });
    const workflow = mapWorkflow("map-provider-unprintable", {
      model: BATCH_MODEL,
      policy: "auto",
      auto: { batchAbove: 1 },
      batch,
    });
    const harness = createTestHarness({ workflows: [workflow] });
    harness.mockAi.setTextResponse("process", { text: "processed" });

    const result = await harness.run("map-provider-unprintable", {
      items: ["a"],
    });

    // Main could not format the error, so it propagated: no realtime call.
    expect(result.status).not.toBe("COMPLETED");
    expect(harness.mockAi.getCalls()).toHaveLength(0);
  });

  it("stores the text of another realm's Error from the one read main makes", async () => {
    const workflow = mapWorkflow("map-foreign-error", {
      realtime: { retries: 0, concurrency: 1 },
    });
    const harness = createTestHarness({ workflows: [workflow] });
    harness.mockAi.setTextResponse("process", { text: "processed" });
    let reads = 0;
    const foreign = runInNewContext('new Error("initial")') as Error;
    Object.defineProperty(foreign, "message", {
      get: () => (++reads === 1 ? "original message" : "replacement message"),
    });
    harness.mockAi.failOnce("process a", foreign);

    const result = await harness.run("map-foreign-error", { items: ["a"] });

    expect(results(result.output)[0]).toMatchObject({
      status: "failed",
      error: "Error: original message",
    });
  });

  describe("reads a thrown model error as main does", () => {
    const run = async (id: string, error: unknown) => {
      const workflow = mapWorkflow(id, {
        realtime: { retries: 0, concurrency: 1 },
        repair: { attempts: 1 },
      });
      const harness = createTestHarness({ workflows: [workflow] });
      harness.mockAi.setTextResponse("process", { text: "processed" });
      harness.mockAi.failOnce("process a", error as Error);
      const result = await harness.run(id, { items: ["a"] });
      return { item: results(result.output)[0], harness };
    };

    it("routes by the name its cause leaves, read after the cause", async () => {
      const error = { name: "AI_NoObjectGeneratedError", message: "lazy" };
      Object.defineProperty(error, "cause", {
        get() {
          error.name = "TransportError";
          return undefined;
        },
      });
      const { item, harness } = await run("map-lazy-cause", error);
      expect(item).toMatchObject({
        status: "failed",
        error: "[object Object]",
        attempts: 1,
      });
      // One failed call, no repair: the repair call would have succeeded.
      expect(harness.mockAi.getCalls()).toHaveLength(0);
    });

    it("reads an aliased text the way main does", async () => {
      let reads = 0;
      const error: Record<string, unknown> = {
        name: "TransportError",
        message: "transport failure",
      };
      error.cause = error;
      Object.defineProperty(error, "text", {
        get: () => (++reads === 2 ? "raw content" : undefined),
      });
      const { item, harness } = await run("map-self-cause", error);
      expect(item).toMatchObject({ status: "failed", attempts: 1 });
      expect(harness.mockAi.getCalls()).toHaveLength(0);
    });

    it("stores one string conversion of a foreign Error", async () => {
      let reads = 0;
      const foreign = runInNewContext("new Error()") as Error;
      foreign.name = "";
      Object.defineProperty(foreign, "message", {
        get: () => (++reads === 1 ? "[object Object]" : "replacement text"),
      });
      const { item } = await run("map-foreign-placeholder", foreign);
      expect(item).toMatchObject({
        status: "failed",
        error: "[object Object]",
      });
      expect(reads).toBe(1);
    });
  });

  it("retries a thrown item call in-process and completes in one execution", async () => {
    const workflow = mapWorkflow("map-fail-twice", {
      realtime: { retries: 2, concurrency: 2 },
    });
    const harness = createTestHarness({ workflows: [workflow] });
    harness.mockAi.setTextResponse("process", { text: "processed" });
    harness.mockAi.failOnce("process b", new Error("first bad call"));
    harness.mockAi.failOnce("process b", new Error("second bad call"));

    const result = await harness.run("map-fail-twice", {
      items: ["a", "b", "c"],
    });

    expect(result.status).toBe("COMPLETED");
    expect(results(result.output).map((r) => r.status)).toEqual([
      "succeeded",
      "succeeded",
      "succeeded",
    ]);
    // No suspension: the stage completed on its first execution.
    const executions = result.reports.flatMap((r) => r.outcomes);
    expect(executions).toEqual([{ stageId: "map", outcome: "completed" }]);
    // The mock records only calls that answered; the two scripted throws
    // happened inside the same execution.
    expect(harness.mockAi.getCalls()).toHaveLength(3);
    expect(result.reports.every((r) => r.suspendedChecked === 0)).toBe(true);
    const stage = await harness.persistence.getStage(
      result.workflowRunId,
      "map",
    );
    const row = await harness.stepLedger.get(stage!.id, "items:b");
    expect(row).toMatchObject({ status: "completed", attempt: 3 });
    const b = results(result.output)[1];
    expect(b?.status === "succeeded" && b.attempts).toBe(3);
  });

  it("repairs when the adapter throws an error carrying the model's text", async () => {
    const workflow = mapWorkflow("map-repair-text-error", {
      schema: z.object({ value: z.string() }),
      realtime: { retries: 0, concurrency: 1 },
      repair: { attempts: 1 },
    });
    const harness = createTestHarness({ workflows: [workflow] });
    harness.mockAi.setObjectResponse("process", { object: { value: "ok" } });
    const bad = new Error("could not parse the response") as Error & {
      text: string;
    };
    bad.name = "AdapterParseError";
    bad.text = "```json\n{ value: oops }\n```";
    harness.mockAi.failOnce("process a", bad);

    const result = await harness.run("map-repair-text-error", {
      items: ["a"],
    });

    expect(result.status).toBe("COMPLETED");
    const [a] = results(result.output);
    expect(a).toMatchObject({ status: "succeeded", attempts: 2 });
    // The repair prompt quoted the bad output back to the model.
    const repairCall = harness.mockAi.getCalls().at(-1);
    expect(String(repairCall?.prompt)).toContain("{ value: oops }");
    expect(String(repairCall?.prompt)).toContain(
      "could not parse the response",
    );
  });

  it("treats a thrown ZodError as repairable output", async () => {
    const workflow = mapWorkflow("map-repair-zod-error", {
      schema: z.object({ value: z.string() }),
      realtime: { retries: 0, concurrency: 1 },
      repair: { attempts: 1 },
    });
    const harness = createTestHarness({ workflows: [workflow] });
    harness.mockAi.setObjectResponse("process", { object: { value: "ok" } });
    const zodError = z.object({ value: z.string() }).safeParse({ value: 1 });
    harness.mockAi.failOnce(
      "process a",
      zodError.success ? new Error("unreachable") : zodError.error,
    );

    const result = await harness.run("map-repair-zod-error", { items: ["a"] });

    expect(result.status).toBe("COMPLETED");
    expect(results(result.output)[0]).toMatchObject({
      status: "succeeded",
      attempts: 2,
    });
    expect(String(harness.mockAi.getCalls().at(-1)?.prompt)).toContain(
      "value:",
    );
  });

  it("fails the item, not the stage, when in-process retries are exhausted", async () => {
    const workflow = mapWorkflow("map-retries-exhausted", {
      realtime: { retries: 1, concurrency: 1 },
    });
    const harness = createTestHarness({ workflows: [workflow] });
    harness.mockAi.setTextResponse("process", { text: "processed" });
    harness.mockAi.failOnce("process a", new SubscriptionLimitError());
    harness.mockAi.failOnce("process a", new SubscriptionLimitError());

    const result = await harness.run("map-retries-exhausted", {
      items: ["a", "b"],
    });

    expect(result.status).toBe("COMPLETED");
    const [a, b] = results(result.output);
    expect(a).toMatchObject({
      status: "failed",
      errorName: "SubscriptionLimitError",
      attempts: 2,
    });
    expect(b?.status).toBe("succeeded");
    expect(result.reports.flatMap((r) => r.outcomes)).toEqual([
      { stageId: "map", outcome: "completed" },
    ]);
  });
  it("gives an item its failed verdict at once when the model call throws NonRetryableError", async () => {
    const workflow = mapWorkflow("map-non-retryable", {
      realtime: { retries: 3, concurrency: 1 },
    });
    const harness = createTestHarness({ workflows: [workflow] });
    harness.mockAi.setTextResponse("process", { text: "processed" });
    harness.mockAi.failOnce("process a", new NonRetryableError("key revoked"));

    const result = await harness.run("map-non-retryable", {
      items: ["a", "b"],
    });

    // Three in-process retries were available and none was spent.
    expect(result.status).toBe("COMPLETED");
    const [a, b] = results(result.output);
    expect(a).toMatchObject({
      status: "failed",
      error: "key revoked",
      errorName: "NonRetryableError",
      attempts: 1,
    });
    expect(b?.status).toBe("succeeded");
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
