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
