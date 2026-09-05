import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineStage } from "../../core/stage-factory.js";
import { WorkflowBuilder } from "../../core/workflow.js";
import { InMemoryStepLedger } from "../../testing/in-memory-step-ledger.js";
import { createTestKernel } from "../utils/index.js";

describe("step.signal idempotency", () => {
  it("does not overwrite a completed signal and rejects a failed signal", async () => {
    const ledger = new InMemoryStepLedger();
    const stage = defineStage({
      id: "approval",
      name: "Approval",
      schemas: {
        input: z.object({}),
        output: z.object({ approved: z.boolean() }),
        config: z.object({}),
      },
      async execute(ctx) {
        return {
          output: await ctx.step.waitForSignal<{ approved: boolean }>(
            "decision",
            { timeout: 10_000 },
          ),
        };
      },
    });
    const workflow = new WorkflowBuilder(
      "signal-idempotent",
      "Signal Idempotent",
      "test",
      z.object({}),
      z.object({ approved: z.boolean() }),
    )
      .pipe(stage)
      .build();
    const { kernel, persistence } = createTestKernel([workflow], {
      stepLedger: ledger,
    });
    const created = await kernel.dispatch({
      type: "run.create",
      idempotencyKey: "signal-idempotent",
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

    const first = await kernel.dispatch({
      type: "step.signal",
      workflowRunId: created.workflowRunId,
      stageId: stage.id,
      stepId: "decision",
      payload: { approved: true },
    });
    const second = await kernel.dispatch({
      type: "step.signal",
      workflowRunId: created.workflowRunId,
      stageId: stage.id,
      stepId: "decision",
      payload: { approved: false },
    });
    expect(first).toMatchObject({ ok: true, alreadyCompleted: false });
    expect(second).toMatchObject({ ok: true, alreadyCompleted: true });
    expect((await ledger.get(stageRecord!.id, "decision"))?.result).toEqual({
      approved: true,
    });

    await ledger.claim({
      stageRecordId: stageRecord!.id,
      stepId: "timed-out",
      seq: 2,
      kind: "signal",
      status: "failed",
      attempt: 1,
      leaseExpiresAt: null,
      deadlineAt: new Date(),
      error: "timed out",
    });
    await expect(
      kernel.dispatch({
        type: "step.signal",
        workflowRunId: created.workflowRunId,
        stageId: stage.id,
        stepId: "timed-out",
        payload: true,
      }),
    ).rejects.toThrow(/failed and cannot receive/);
  });
});
