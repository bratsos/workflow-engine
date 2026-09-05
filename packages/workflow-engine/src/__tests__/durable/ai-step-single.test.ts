import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { AIHelper, AITextResult } from "../../ai/types.js";
import { defineStage } from "../../core/stage-factory.js";
import type { AIHelperFactory } from "../../kernel/ports.js";
import { createMockAIHelperFactory } from "../utils/index.js";
import { createAiMapHarness, REALTIME_MODEL } from "./ai-map-harness.js";

const inputSchema = z.object({});
const outputSchema = z.object({ value: z.string() });
const schema = z.object({ value: z.string() });

describe("step.ai single calls", () => {
  it("memoizes generateObject across replays", async () => {
    const mock = createMockAIHelperFactory();
    mock.setObjectResponse("hello", { object: { value: "world" } });
    let polls = 0;
    const stage = defineStage({
      id: "single-object",
      name: "Single Object",
      schemas: {
        input: inputSchema,
        output: outputSchema,
        config: z.object({}),
      },
      async execute(ctx) {
        const result = await ctx.step.ai.generateObject(
          "extract",
          REALTIME_MODEL,
          "hello",
          schema,
        );
        await ctx.step.waitFor("gate", {
          poll: async () => ({ ready: polls++ >= 1 }),
          ready: (v) => v.ready,
          every: 1_000,
          timeout: "1h",
        });
        return { output: { value: result.object.value } };
      },
    });
    const h = await createAiMapHarness({
      stage,
      inputSchema,
      outputSchema,
      input: {},
      mock,
    });

    await expect(h.execute()).resolves.toMatchObject({ outcome: "suspended" });
    await h.tick(1_000);
    expect((await h.stage())?.status).toBe("COMPLETED");
    expect(mock.getCalls()).toHaveLength(1);
    expect(polls).toBe(2);
  });

  it("strips non-serializable fields before storing the result", async () => {
    const mock = createMockAIHelperFactory();
    mock.setTextResponse("hello", { text: "world", cost: 0.5 });
    const leaky: AIHelperFactory = (...args) => {
      const helper = mock(...args);
      return new Proxy(helper, {
        get(target, prop, receiver) {
          if (prop === "generateText") {
            return async (
              ...callArgs: Parameters<AIHelper["generateText"]>
            ) => {
              const result = await target.generateText(...callArgs);
              return {
                ...result,
                rawResult: { toJSON: () => "raw" },
                helper: () => "not serializable",
              } as AITextResult;
            };
          }
          const value = Reflect.get(target, prop, receiver);
          return typeof value === "function" ? value.bind(target) : value;
        },
      }) as AIHelper;
    };
    let returned: AITextResult | undefined;
    const stage = defineStage({
      id: "single-text",
      name: "Single Text",
      schemas: {
        input: inputSchema,
        output: outputSchema,
        config: z.object({}),
      },
      async execute(ctx) {
        returned = await ctx.step.ai.generateText(
          "text",
          REALTIME_MODEL,
          "hello",
        );
        return { output: { value: returned.text } };
      },
    });
    const h = await createAiMapHarness({
      stage,
      inputSchema,
      outputSchema,
      input: {},
      mock,
      aiFactory: leaky,
    });

    await expect(h.execute()).resolves.toMatchObject({ outcome: "completed" });
    expect(returned).toEqual({
      text: "world",
      inputTokens: 10,
      outputTokens: 20,
      cost: 0.5,
    });
    const stageRecord = await h.stage();
    const stored = await h.ledger.get(stageRecord!.id, "text");
    expect(stored?.result).toEqual(returned);
  });
});
