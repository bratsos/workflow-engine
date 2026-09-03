/**
 * A job retry of a thrown stage keeps the stage's ledger rows (the retry
 * replays them instead of calling the model again) and a completed retry
 * clears the earlier attempt's `errorMessage`. Only `run.rerunFrom` clears
 * a stage's ledger.
 */

import { describe, expect, it } from "vitest";
import { z } from "zod";
import { registerModels } from "../../ai/model-helper.js";
import { defineWorkflow } from "../../core/workflow.js";
import { createTestHarness } from "../../testing/index.js";

const MODEL = "job-retry-ledger-model";
registerModels({
  [MODEL]: {
    id: "openai/gpt-4o-mini",
    name: "Job Retry Ledger Model",
    inputCostPerMillion: 1,
    outputCostPerMillion: 2,
    provider: "openrouter",
    supportsAsyncBatch: false,
  },
});

const In = z.object({ items: z.array(z.string()) });

describe("ledger rows across a job retry", () => {
  it("replays completed map items on the retry and clears the stale error", async () => {
    let executions = 0;
    const workflow = defineWorkflow("job-retry-ledger", { input: In })
      .stage("extract", {
        schemas: {
          input: In,
          output: z.object({ count: z.number() }),
          config: z.object({}),
        },
        async execute(ctx) {
          const results = await ctx.step.ai.map("items", ctx.input.items, {
            model: MODEL,
            policy: "realtime",
            prompt: (item) => `process ${item}`,
          });
          executions++;
          if (executions === 1) throw new Error("v1 trial: crash after map");
          return { output: { count: results.length } };
        },
      })
      .build();
    const harness = createTestHarness({ workflows: [workflow] });
    harness.mockAi.setTextResponse("process", { text: "ok" });

    const result = await harness.run("job-retry-ledger", {
      items: ["a", "b", "c"],
    });

    expect(result.status).toBe("COMPLETED");
    expect(result.output).toEqual({ count: 3 });
    expect(executions).toBe(2);
    // Zero additional model calls on the retry: the items replayed.
    expect(harness.mockAi.getCalls()).toHaveLength(3);

    const stage = await harness.persistence.getStage(
      result.workflowRunId,
      "extract",
    );
    expect(stage).toMatchObject({ status: "COMPLETED", errorMessage: null });
    const rows = await harness.stepLedger.list(stage!.id);
    expect(rows.filter((r) => r.stepId.startsWith("items:"))).toHaveLength(3);
    expect(rows.every((r) => r.status === "completed")).toBe(true);
  });
});

describe("failed steps across a job retry", () => {
  it("re-executes a failed step.run on the next job attempt and bumps the stage attempt", async () => {
    let submits = 0;
    const workflow = defineWorkflow("job-retry-failed-run", { input: In })
      .stage("extract", {
        schemas: {
          input: In,
          output: z.object({ batchId: z.string() }),
          config: z.object({}),
        },
        async execute(ctx) {
          const batchId = await ctx.step.run("extract:submit", async () => {
            submits++;
            if (submits === 1) throw new Error("503 Service Unavailable");
            return `batch-${submits}`;
          });
          return { output: { batchId } };
        },
      })
      .build();
    const harness = createTestHarness({ workflows: [workflow] });

    const result = await harness.run("job-retry-failed-run", { items: [] });

    expect(result.status).toBe("COMPLETED");
    expect(result.output).toEqual({ batchId: "batch-2" });
    // The retry re-executed the step instead of replaying the stored 503.
    expect(submits).toBe(2);
    const stage = await harness.persistence.getStage(
      result.workflowRunId,
      "extract",
    );
    expect(stage).toMatchObject({ status: "COMPLETED", attempt: 1 });
    const rows = await harness.stepLedger.list(stage!.id);
    expect(rows).toMatchObject([
      { stepId: "extract:submit", status: "completed", attempt: 1 },
    ]);
  });

  it("re-prompts a map item that exhausted its repair budget on the next job attempt, but not on a replay of the same attempt", async () => {
    let executions = 0;
    let captured: Array<{ status: string; attempts: number }> = [];
    const workflow = defineWorkflow("job-retry-failed-item", { input: In })
      .stage("extract", {
        schemas: {
          input: In,
          output: z.object({ failed: z.number() }),
          config: z.object({}),
        },
        async execute(ctx) {
          const results = await ctx.step.ai.map("items", ctx.input.items, {
            model: MODEL,
            policy: "realtime",
            schema: z.object({ value: z.number() }),
            prompt: (item) => `process ${item}`,
            repair: { attempts: 0 },
            realtime: { retries: 0 },
          });
          captured = results.map((r) => ({
            status: r.status,
            attempts: r.attempts,
          }));
          executions++;
          // Attempt 1 fails after the map so the job retries the stage.
          if (executions === 1) throw new Error("v1 trial: crash after map");
          return {
            output: {
              failed: results.filter((r) => r.status === "failed").length,
            },
          };
        },
      })
      .build();
    const harness = createTestHarness({ workflows: [workflow] });
    harness.mockAi.setObjectResponse("process", { object: { value: 1 } });
    // "a" throws a non-repairable error on its first call: with no retries
    // and no repair budget the item is a failed verdict on attempt 1.
    harness.mockAi.failOnce("process a", new Error("adapter down"));

    const result = await harness.run("job-retry-failed-item", {
      items: ["a", "b"],
    });

    expect(result.status).toBe("COMPLETED");
    expect(executions).toBe(2);
    // Attempt 2 re-prompted "a" (which then validated) and replayed "b".
    expect(result.output).toEqual({ failed: 0 });
    expect(captured).toEqual([
      { status: "succeeded", attempts: 1 },
      { status: "succeeded", attempts: 1 },
    ]);
    // The armed failure is not a recorded call: b on attempt 1, then a
    // again on attempt 2 (a fresh model call, not a ledger replay).
    expect(harness.mockAi.getCalls().map((c) => String(c.prompt))).toEqual([
      "process b",
      "process a",
    ]);
    const stage = await harness.persistence.getStage(
      result.workflowRunId,
      "extract",
    );
    const rows = await harness.stepLedger.list(stage!.id);
    expect(rows.map((r) => [r.stepId, r.status])).toEqual([
      ["items:0", "completed"],
      ["items:1", "completed"],
    ]);
  });
});
