/**
 * End-to-end coverage of the AI adapter seam under the real kernel: a real
 * `createAIHelper` factory over a fake `AIAdapter` (not the mock helper, which
 * bypasses the seam) drives every `ctx.step.ai.*` surface through
 * `createTestHarness`.
 */

import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createAIHelper } from "../../ai/ai-helper.js";
import { registerModels } from "../../ai/model-helper.js";
import type { AIAdapter } from "../../ai/types.js";
import type { AiMapResult } from "../../core/step-ai.js";
import { defineWorkflow } from "../../core/workflow.js";
import type { AIHelperFactory } from "../../kernel/ports.js";
import { createTestHarness } from "../../testing/index.js";

const MODEL = "adapter-seam-model";
registerModels({
  [MODEL]: {
    id: "adapter-seam/model",
    name: "Adapter Seam Model",
    provider: "adapter-seam",
    inputCostPerMillion: 1,
    outputCostPerMillion: 2,
  },
});

const In = z.object({ items: z.array(z.string()) });
const itemSchema = z.object({ item: z.string() });

function promptText(prompt: unknown): string {
  return typeof prompt === "string" ? prompt : JSON.stringify(prompt);
}

/** An adapter that derives every answer from the prompt it received. */
function makeAdapter(overrides: Partial<AIAdapter> = {}) {
  const calls: { kind: string; prompt: string }[] = [];
  const adapter: AIAdapter = {
    generateText: async ({ prompt }) => {
      calls.push({ kind: "text", prompt: promptText(prompt) });
      return {
        text: `text:${promptText(prompt)}`,
        inputTokens: 1,
        outputTokens: 1,
      };
    },
    generateObject: async ({ prompt }) => {
      calls.push({ kind: "object", prompt: promptText(prompt) });
      const item = promptText(prompt).replace(/^item /, "");
      return { object: { item }, inputTokens: 1, outputTokens: 1 };
    },
    streamText: ({ prompt }) => {
      calls.push({ kind: "stream", prompt: promptText(prompt) });
      return {
        stream: (async function* () {
          yield "str";
          yield "eam";
        })(),
        inputTokens: 1,
        outputTokens: 1,
      };
    },
    ...overrides,
  };
  return { adapter, calls };
}

function realFactory(adapter: AIAdapter): AIHelperFactory {
  return (topic, logger, logContext, providerResolver, options) =>
    createAIHelper(topic, logger, logContext, providerResolver, {
      ...options,
      adapter,
    });
}

describe("ctx.step.ai over a real AIHelper and a fake adapter", () => {
  it("map with a schema returns every adapter object and records them in the ledger", async () => {
    const { adapter, calls } = makeAdapter();
    let captured: AiMapResult<{ item: string }>[] = [];
    const workflow = defineWorkflow("adapter-seam-map", { input: In })
      .stage("extract", {
        schemas: {
          input: In,
          output: z.object({ count: z.number() }),
          config: z.object({}),
        },
        async execute(ctx) {
          captured = await ctx.step.ai.map("items", ctx.input.items, {
            model: MODEL,
            policy: "realtime",
            schema: itemSchema,
            prompt: (item) => `item ${item}`,
          });
          return { output: { count: captured.length } };
        },
      })
      .build();

    const harness = createTestHarness({
      workflows: [workflow],
      services: { ai: realFactory(adapter) },
    });
    const result = await harness.run("adapter-seam-map", {
      items: ["a", "b", "c"],
    });

    expect(result.status).toBe("COMPLETED");
    expect(result.output).toEqual({ count: 3 });
    expect(calls.filter((c) => c.kind === "object")).toHaveLength(3);
    expect(captured.map((r) => r.status)).toEqual([
      "succeeded",
      "succeeded",
      "succeeded",
    ]);
    expect(
      captured.map((r) => (r.status === "succeeded" ? r.result : null)),
    ).toEqual([{ item: "a" }, { item: "b" }, { item: "c" }]);

    const stage = await harness.persistence.getStage(
      result.workflowRunId,
      "extract",
    );
    const rows = await harness.stepLedger.list(stage!.id);
    const itemRows = rows
      .filter((r) => /^items:\d+$/.test(r.stepId))
      .sort((a, b) => a.seq - b.seq);
    expect(itemRows).toHaveLength(3);
    expect(itemRows.every((r) => r.status === "completed")).toBe(true);
    expect(
      itemRows.map((r) => (r.result as { result?: unknown }).result),
    ).toEqual([{ item: "a" }, { item: "b" }, { item: "c" }]);

    const logged = harness.aiLogger.getCallsByTopicPrefix(
      `workflow.${result.workflowRunId}`,
    );
    expect(logged.filter((c) => c.callType === "object")).toHaveLength(3);
    for (const call of logged) {
      expect(call.response).not.toBe("");
      expect(call.response).not.toBe("undefined");
    }
  });

  it("generateText, generateObject and streamText all reach the adapter", async () => {
    const { adapter, calls } = makeAdapter();
    const workflow = defineWorkflow("adapter-seam-single", { input: In })
      .stage("all", {
        schemas: {
          input: In,
          output: z.object({
            text: z.string(),
            object: itemSchema,
            streamed: z.string(),
          }),
          config: z.object({}),
        },
        async execute(ctx) {
          const text = await ctx.step.ai.generateText("t", MODEL, "hello");
          const object = await ctx.step.ai.generateObject(
            "o",
            MODEL,
            "item x",
            itemSchema,
          );
          const streamed = await ctx.step.ai.streamText("s", MODEL, "go");
          return {
            output: {
              text: text.text,
              object: object.object,
              streamed: streamed.text,
            },
          };
        },
      })
      .build();

    const harness = createTestHarness({
      workflows: [workflow],
      services: { ai: realFactory(adapter) },
    });
    const result = await harness.run("adapter-seam-single", { items: [] });

    expect(result.status).toBe("COMPLETED");
    expect(result.output).toEqual({
      text: "text:hello",
      object: { item: "x" },
      streamed: "stream",
    });
    expect(calls.map((c) => c.kind)).toEqual(["text", "object", "stream"]);
  });

  it("map repair re-prompts through the adapter when validation fails", async () => {
    let objectCalls = 0;
    const { adapter } = makeAdapter({
      generateObject: async ({ prompt }) => {
        objectCalls += 1;
        const text = promptText(prompt);
        // First answer for "b" is wrong-shaped; the repair prompt quotes the
        // validation problems, so answer correctly on that pass.
        if (text.startsWith("item b") && !/Problems:/.test(text)) {
          return { object: { item: 7 }, inputTokens: 1, outputTokens: 1 };
        }
        const item = text.match(/^item (\w+)/)?.[1] ?? "?";
        return { object: { item }, inputTokens: 1, outputTokens: 1 };
      },
    });
    let captured: AiMapResult<{ item: string }>[] = [];
    const workflow = defineWorkflow("adapter-seam-repair", { input: In })
      .stage("extract", {
        schemas: {
          input: In,
          output: z.object({ count: z.number() }),
          config: z.object({}),
        },
        async execute(ctx) {
          captured = await ctx.step.ai.map("items", ctx.input.items, {
            model: MODEL,
            policy: "realtime",
            schema: itemSchema,
            prompt: (item) => `item ${item}`,
            repair: { attempts: 1 },
          });
          return { output: { count: captured.length } };
        },
      })
      .build();

    const harness = createTestHarness({
      workflows: [workflow],
      services: { ai: realFactory(adapter) },
    });
    const result = await harness.run("adapter-seam-repair", {
      items: ["a", "b"],
    });

    expect(result.status).toBe("COMPLETED");
    expect(objectCalls).toBe(3);
    expect(
      captured.map((r) => (r.status === "succeeded" ? r.result : r.status)),
    ).toEqual([{ item: "a" }, { item: "b" }]);
    const b = captured[1];
    expect(b.status === "succeeded" && b.attempts).toBe(2);
  });
});
