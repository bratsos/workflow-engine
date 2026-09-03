import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineStage } from "../../core/stage-factory.js";
import { isStepControlFlowError } from "../../core/steps.js";
import { WorkflowBuilder } from "../../core/workflow.js";
import { InMemoryStepLedger } from "../../testing/in-memory-step-ledger.js";
import { createTestKernel } from "../utils/index.js";

describe("swallowed durable suspension", () => {
  it("discards a normal return after waitFor requested suspension", async () => {
    let branded = false;
    const stage = defineStage({
      id: "wait",
      name: "Wait",
      schemas: {
        input: z.object({}),
        output: z.object({ value: z.string() }),
        config: z.object({}),
      },
      async execute(ctx) {
        try {
          await ctx.step.waitFor("external", {
            poll: async () => ({ ready: false }),
            ready: (value) => value.ready,
            every: 1_000,
            timeout: 10_000,
          });
        } catch (error) {
          branded = isStepControlFlowError(error);
          ctx.log("WARN", "caught by user code");
          return { output: { value: "garbage" } };
        }
        return { output: { value: "ready" } };
      },
    });
    const workflow = new WorkflowBuilder(
      "swallow",
      "Swallow",
      "test",
      z.object({}),
      z.object({ value: z.string() }),
    )
      .pipe(stage)
      .build();
    const { kernel, persistence } = createTestKernel([workflow], {
      stepLedger: new InMemoryStepLedger(),
    });
    const created = await kernel.dispatch({
      type: "run.create",
      idempotencyKey: "swallow",
      workflowId: workflow.id,
      input: {},
    });
    await kernel.dispatch({ type: "run.claimPending", workerId: "worker" });

    const result = await kernel.dispatch({
      type: "job.execute",
      workflowRunId: created.workflowRunId,
      workflowId: workflow.id,
      stageId: stage.id,
      config: {},
    });

    expect(branded).toBe(true);
    expect(result.outcome).toBe("suspended");
    expect(
      (await persistence.getStage(created.workflowRunId, stage.id))?.status,
    ).toBe("SUSPENDED");
    expect(
      persistence
        .getAllLogs()
        .filter((log) => log.message.includes("return value was discarded")),
    ).toHaveLength(1);
  });
});
