/**
 * The step seq ordinal must be identical on every replay of a stage that
 * runs a `ctx.step.ai.map`: items answered from the ledger still consume
 * their seq, and the seq an item gets never depends on how fast the ledger
 * answers, so a step after the map is never reported as out of order.
 */

import { describe, expect, it } from "vitest";
import { z } from "zod";
import { registerModels } from "../../ai/model-helper.js";
import { defineWorkflow } from "../../core/workflow.js";
import type { StepLedger } from "../../kernel/ports.js";
import { FakeClock } from "../../kernel/testing/fake-clock.js";
import { InMemoryStepLedger } from "../../testing/in-memory-step-ledger.js";
import { createTestHarness } from "../../testing/index.js";
import { crashOnClaim } from "./ai-map-harness.js";

const MODEL = "ai-map-seq-model";
registerModels({
  [MODEL]: {
    id: "openai/gpt-4o-mini",
    name: "AI Map Seq Model",
    inputCostPerMillion: 1,
    outputCostPerMillion: 2,
    provider: "openrouter",
    supportsAsyncBatch: false,
  },
});

const In = z.object({ items: z.array(z.string()) });
const Out = z.object({ after: z.string() });

function mapThenRunWorkflow(id: string, concurrency: number) {
  return defineWorkflow(id, { input: In })
    .stage("map", {
      schemas: { input: In, output: Out, config: z.object({}) },
      async execute(ctx) {
        await ctx.step.ai.map("items", ctx.input.items, {
          model: MODEL,
          policy: "realtime",
          prompt: (item) => `process ${item}`,
          realtime: { concurrency, retries: 0 },
        });
        const after = await ctx.step.run("after", async () => "done");
        return { output: { after } };
      },
    })
    .build();
}

/** Delay `get` for chosen steps so the ledger answers out of item order. */
function slowGet(
  inner: StepLedger,
  getDelayMs: (stepId: string) => number,
): StepLedger {
  return {
    claim: (record) => inner.claim(record),
    get: async (stageRecordId, stepId) => {
      const delay = getDelayMs(stepId);
      if (delay > 0) {
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
      return inner.get(stageRecordId, stepId);
    },
    update: (stageRecordId, id, patch) =>
      inner.update(stageRecordId, id, patch),
    compareAndSet: (stageRecordId, id, expected, patch) =>
      inner.compareAndSet(stageRecordId, id, expected, patch),
    list: (stageRecordId) => inner.list(stageRecordId),
    clear: (stageRecordId) => inner.clear(stageRecordId),
  };
}

describe("step.ai.map seq stability across replays", () => {
  it("keeps every seq stable when the stage crashes mid-map and replays", async () => {
    const clock = new FakeClock();
    const inner = new InMemoryStepLedger({ now: () => clock.now() });
    // The worker dies after two items completed, while claiming the third.
    const ledger = crashOnClaim(inner, "items:2", () => clock.now());
    const workflow = mapThenRunWorkflow("map-seq-crash", 1);
    const harness = createTestHarness({
      workflows: [workflow],
      clock,
      stepLedger: ledger,
    });
    harness.mockAi.setTextResponse("process", { text: "ok" });

    const result = await harness.run("map-seq-crash", {
      items: ["a", "b", "c"],
    });

    expect(result.status).toBe("COMPLETED");
    // First execution suspended on the crash; the replay ran under
    // `stage.pollSuspended` and completed.
    expect(result.reports[0]?.outcomes).toEqual([
      { stageId: "map", outcome: "suspended" },
    ]);
    expect(result.reports.some((r) => r.suspendedChecked > 0)).toBe(true);
    const warns = harness.persistence
      .getAllLogs()
      .filter((l) => l.level === "WARN")
      .map((l) => l.message);
    expect(warns.filter((m) => m.includes("non-deterministic"))).toEqual([]);

    const stage = await harness.persistence.getStage(
      result.workflowRunId,
      "map",
    );
    const rows = (await inner.list(stage!.id)).sort((a, b) => a.seq - b.seq);
    expect(rows.map((r) => [r.stepId, r.seq])).toEqual([
      ["items:0", 1],
      ["items:1", 2],
      ["items:2", 3],
      ["after", 4],
    ]);
    expect(new Set(rows.map((r) => r.seq)).size).toBe(rows.length);
    expect(rows.filter((r) => r.stepId === "after")).toHaveLength(1);
    expect(harness.mockAi.getCalls()).toHaveLength(3);
  });

  it("assigns item seqs by item order, not by ledger response order", async () => {
    const clock = new FakeClock();
    const inner = new InMemoryStepLedger({ now: () => clock.now() });
    // A slow lookup for the first item must not let the second item take
    // seq 1.
    const ledger = slowGet(inner, (stepId) => (stepId === "items:0" ? 20 : 0));
    const workflow = mapThenRunWorkflow("map-seq-order", 5);
    const harness = createTestHarness({
      workflows: [workflow],
      clock,
      stepLedger: ledger,
    });
    harness.mockAi.setTextResponse("process", { text: "ok" });

    const result = await harness.run("map-seq-order", {
      items: ["a", "b", "c"],
    });

    expect(result.status).toBe("COMPLETED");
    const stage = await harness.persistence.getStage(
      result.workflowRunId,
      "map",
    );
    const rows = (await inner.list(stage!.id)).sort((a, b) => a.seq - b.seq);
    expect(rows.map((r) => [r.stepId, r.seq])).toEqual([
      ["items:0", 1],
      ["items:1", 2],
      ["items:2", 3],
      ["after", 4],
    ]);
  });
});
