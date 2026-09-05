import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineStage } from "../../core/stage-factory.js";
import { WorkflowBuilder } from "../../core/workflow.js";
import { InMemoryStepLedger } from "../../testing/in-memory-step-ledger.js";
import { createTestKernel } from "../utils/index.js";

describe("durable wait deadline", () => {
  it("keeps the first deadline across replays and fails at expiry", async () => {
    const ledger = new InMemoryStepLedger();
    const stage = defineStage({
      id: "wait",
      name: "Wait",
      schemas: {
        input: z.object({}),
        output: z.object({ done: z.boolean() }),
        config: z.object({}),
      },
      async execute(ctx) {
        const value = await ctx.step.waitFor("external", {
          poll: async () => ({ done: false }),
          ready: (result) => result.done,
          every: 1_000,
          timeout: 2_500,
        });
        return { output: value };
      },
    });
    const workflow = new WorkflowBuilder(
      "deadline",
      "Deadline",
      "test",
      z.object({}),
      z.object({ done: z.boolean() }),
    )
      .pipe(stage)
      .build();
    const { kernel, persistence, clock } = createTestKernel([workflow], {
      stepLedger: ledger,
    });
    const created = await kernel.dispatch({
      type: "run.create",
      idempotencyKey: "deadline",
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
    const stageRecord = await persistence.getStage(
      created.workflowRunId,
      stage.id,
    );
    const firstDeadline = (await ledger.get(stageRecord!.id, "external"))
      ?.deadlineAt;

    clock.advance(1_000);
    await kernel.dispatch({ type: "stage.pollSuspended" });
    clock.advance(1_000);
    await kernel.dispatch({ type: "stage.pollSuspended" });
    expect((await ledger.get(stageRecord!.id, "external"))?.deadlineAt).toEqual(
      firstDeadline,
    );

    clock.advance(500);
    const thirdReplay = await kernel.dispatch({
      type: "stage.pollSuspended",
    });
    expect(thirdReplay.failed).toBe(1);
    expect(await ledger.get(stageRecord!.id, "external")).toMatchObject({
      status: "failed",
      error: expect.stringContaining("exceeded its timeout"),
    });
    expect(
      (await persistence.getStage(created.workflowRunId, stage.id))?.status,
    ).toBe("FAILED");
  });
});
