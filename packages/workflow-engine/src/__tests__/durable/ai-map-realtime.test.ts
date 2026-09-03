import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineStage } from "../../core/stage-factory.js";
import type { AiMapResult } from "../../core/step-ai.js";
import { createMockAIHelperFactory } from "../utils/index.js";
import {
  crashOnClaim,
  createAiMapHarness,
  REALTIME_MODEL,
  withCallHook,
} from "./ai-map-harness.js";

const inputSchema = z.object({ count: z.number() });
const outputSchema = z.object({ done: z.number() });
const itemSchema = z.object({ value: z.string() });

function makeStage(
  id: string,
  spec: {
    concurrency?: number;
    budget?: number;
    capture: (results: AiMapResult<{ value: string }>[]) => void;
  },
) {
  return defineStage({
    id,
    name: id,
    schemas: { input: inputSchema, output: outputSchema, config: z.object({}) },
    async execute(ctx) {
      const items = Array.from({ length: ctx.input.count }, (_, i) => i);
      const results = await ctx.step.ai.map("extract", items, {
        model: REALTIME_MODEL,
        policy: "realtime",
        schema: itemSchema,
        prompt: (item) => `Extract <<${item}>>`,
        realtime: { concurrency: spec.concurrency, budget: spec.budget },
      });
      spec.capture(results);
      return { output: { done: results.length } };
    },
  });
}

function seedValidResponses(
  mock: ReturnType<typeof createMockAIHelperFactory>,
  count: number,
) {
  for (let i = 0; i < count; i++) {
    mock.setObjectResponse(`<<${i}>>`, { object: { value: `v${i}` } });
  }
}

describe("step.ai.map realtime policy", () => {
  it("calls the model once per item and returns results in input order", async () => {
    const mock = createMockAIHelperFactory();
    seedValidResponses(mock, 5);
    let captured: AiMapResult<{ value: string }>[] = [];
    const stage = makeStage("rt-order", {
      concurrency: 2,
      capture: (r) => {
        captured = r;
      },
    });
    const h = await createAiMapHarness({
      stage,
      inputSchema,
      outputSchema,
      input: { count: 5 },
      mock,
    });

    await expect(h.execute()).resolves.toMatchObject({ outcome: "completed" });
    expect(mock.getCalls()).toHaveLength(5);
    expect(captured.map((r) => r.index)).toEqual([0, 1, 2, 3, 4]);
    expect(captured.map((r) => r.id)).toEqual(["0", "1", "2", "3", "4"]);
    for (const r of captured) {
      expect(r.status).toBe("succeeded");
      if (r.status === "succeeded") {
        expect(r.result).toEqual({ value: `v${r.index}` });
        expect(r.validated).toBe(true);
        expect(r.attempts).toBe(1);
      }
    }
  });

  it("replays after a crash and only calls the model for the remaining items", async () => {
    const mock = createMockAIHelperFactory();
    seedValidResponses(mock, 5);
    let captured: AiMapResult<{ value: string }>[] = [];
    const stage = makeStage("rt-crash", {
      concurrency: 1,
      capture: (r) => {
        captured = r;
      },
    });
    const h = await createAiMapHarness({
      stage,
      inputSchema,
      outputSchema,
      input: { count: 5 },
      mock,
      wrapLedger: (ledger, now) => crashOnClaim(ledger, "extract:3", now),
    });

    await expect(h.execute()).resolves.toMatchObject({ outcome: "suspended" });
    expect(mock.getCalls()).toHaveLength(3);
    expect((await h.stage())?.status).toBe("SUSPENDED");

    await h.tick(5_000);
    expect((await h.stage())?.status).toBe("COMPLETED");
    // Three before the crash, two on replay; completed items came from the ledger.
    expect(mock.getCalls()).toHaveLength(5);
    expect(captured.every((r) => r.status === "succeeded")).toBe(true);
  });

  it("throws AiMapBudgetExceededError when the call count would exceed the budget", async () => {
    const mock = createMockAIHelperFactory();
    seedValidResponses(mock, 5);
    const stage = makeStage("rt-budget", {
      concurrency: 1,
      budget: 3,
      capture: () => {},
    });
    const h = await createAiMapHarness({
      stage,
      inputSchema,
      outputSchema,
      input: { count: 5 },
      mock,
    });

    const result = await h.execute();
    expect(result.outcome).toBe("failed");
    expect(String((result as { error?: string }).error)).toMatch(
      /exceeded its realtime budget of 3/,
    );
    expect(mock.getCalls()).toHaveLength(3);
  });

  it("repairs a schema failure and reports the recorded cost per item", async () => {
    const mock = createMockAIHelperFactory();
    // Repair prompts carry the "Problems:" marker; register it first so it wins.
    mock.setObjectResponse("Problems:", {
      object: { value: "fixed" },
      cost: 0.002,
    });
    mock.setObjectResponse("<<0>>", { object: { value: 123 }, cost: 0.001 });
    mock.setObjectResponse("<<1>>", { object: { value: "ok" }, cost: 0.005 });
    let captured: AiMapResult<{ value: string }>[] = [];
    const stage = makeStage("rt-repair", {
      capture: (r) => {
        captured = r;
      },
    });
    const h = await createAiMapHarness({
      stage,
      inputSchema,
      outputSchema,
      input: { count: 2 },
      mock,
    });

    await expect(h.execute()).resolves.toMatchObject({ outcome: "completed" });
    const [first, second] = captured;
    expect(first).toMatchObject({
      status: "succeeded",
      result: { value: "fixed" },
      validated: true,
      attempts: 2,
    });
    expect(second).toMatchObject({ status: "succeeded", attempts: 1 });
    expect(first!.cost).toBeCloseTo(0.003, 9);
    expect(second!.cost).toBeCloseTo(0.005, 9);

    const recorded = h.aiLogger
      .getCallsByTopic(h.topic)
      .reduce((sum, call) => sum + call.cost, 0);
    expect(captured.reduce((sum, r) => sum + r.cost, 0)).toBeCloseTo(
      recorded,
      9,
    );
    // The repair prompt fed the previous output and the Zod issues back.
    const repairCall = mock
      .getCalls()
      .find((c) => c.prompt.includes("Problems:"));
    expect(repairCall?.prompt).toContain('{"value":123}');
    expect(repairCall?.prompt).toMatch(/value: /);
  });
});
