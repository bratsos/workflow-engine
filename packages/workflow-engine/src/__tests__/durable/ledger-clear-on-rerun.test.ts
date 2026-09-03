import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineStage } from "../../core/stage-factory.js";
import { WorkflowBuilder } from "../../core/workflow.js";
import { InMemoryStepLedger } from "../../testing/in-memory-step-ledger.js";
import { createTestKernel } from "../utils/index.js";

describe("durable ledger reset", () => {
  it("clears old step records when run.rerunFrom starts from scratch", async () => {
    let calls = 0;
    const ledger = new InMemoryStepLedger();
    const stage = defineStage({
      id: "side-effect",
      name: "Side Effect",
      schemas: {
        input: z.object({}),
        output: z.object({ calls: z.number() }),
        config: z.object({}),
      },
      async execute(ctx) {
        const value = await ctx.step.run("once", async () => ++calls);
        return { output: { calls: value } };
      },
    });
    const workflow = new WorkflowBuilder(
      "rerun-clear",
      "Rerun Clear",
      "test",
      z.object({}),
      z.object({ calls: z.number() }),
    )
      .pipe(stage)
      .build();
    const { kernel, persistence } = createTestKernel([workflow], {
      stepLedger: ledger,
    });
    const created = await kernel.dispatch({
      type: "run.create",
      idempotencyKey: "rerun-clear",
      workflowId: workflow.id,
      input: {},
    });
    await kernel.dispatch({ type: "run.claimPending", workerId: "worker" });
    await kernel.dispatch({
      type: "job.execute",
      workflowRunId: created.workflowRunId,
      workflowId: workflow.id,
      stageId: stage.id,
      config: {},
    });
    await kernel.dispatch({
      type: "run.transition",
      workflowRunId: created.workflowRunId,
    });
    const oldStage = await persistence.getStage(
      created.workflowRunId,
      stage.id,
    );
    expect(await ledger.list(oldStage!.id)).toHaveLength(1);

    await kernel.dispatch({
      type: "run.rerunFrom",
      idempotencyKey: "rerun-clear-again",
      workflowRunId: created.workflowRunId,
      fromStageId: stage.id,
    });

    expect(await ledger.list(oldStage!.id)).toEqual([]);
    const newStage = await persistence.getStage(
      created.workflowRunId,
      stage.id,
    );
    expect(newStage?.id).not.toBe(oldStage?.id);
  });
});
