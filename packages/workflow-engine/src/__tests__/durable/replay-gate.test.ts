import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineAsyncBatchStage } from "../../core/stage-factory.js";
import { type Workflow, WorkflowBuilder } from "../../core/workflow.js";
import { InMemoryStepLedger } from "../../testing/in-memory-step-ledger.js";
import { createTestKernel } from "../utils/index.js";

async function start(
  workflow: Workflow<any, any>,
  kernel: ReturnType<typeof createTestKernel>["kernel"],
) {
  const created = await kernel.dispatch({
    type: "run.create",
    idempotencyKey: workflow.id,
    workflowId: workflow.id,
    input: {},
  });
  await kernel.dispatch({ type: "run.claimPending", workerId: "worker" });
  await kernel.dispatch({
    type: "job.execute",
    workflowRunId: created.workflowRunId,
    workflowId: workflow.id,
    stageId: workflow.getStageIds()[0],
    config: {},
  });
  return created.workflowRunId;
}

describe("suspended stage replay gate", () => {
  it("uses execute replay for durable metadata even when checkCompletion exists", async () => {
    let ready = false;
    let checks = 0;
    const stage = defineAsyncBatchStage({
      id: "both",
      name: "Both",
      mode: "async-batch",
      schemas: {
        input: z.object({}),
        output: z.object({ route: z.string() }),
        config: z.object({}),
      },
      async execute(ctx) {
        await ctx.step.waitFor("durable", {
          poll: async () => ({ ready }),
          ready: (value) => value.ready,
          every: 1_000,
          timeout: 10_000,
        });
        return { output: { route: "replay" } };
      },
      async checkCompletion() {
        checks++;
        return { ready: true, output: { route: "check" } };
      },
    });
    const workflow = new WorkflowBuilder(
      "durable-gate",
      "Durable Gate",
      "test",
      z.object({}),
      z.object({ route: z.string() }),
    )
      .pipe(stage)
      .build();
    const { kernel, persistence, clock, blobStore } = createTestKernel(
      [workflow],
      { stepLedger: new InMemoryStepLedger() },
    );
    const runId = await start(workflow, kernel);

    ready = true;
    clock.advance(1_000);
    await kernel.dispatch({ type: "stage.pollSuspended" });

    expect(checks).toBe(0);
    const record = await persistence.getStage(runId, stage.id);
    expect(record?.status).toBe("COMPLETED");
    expect(
      await blobStore.get((record?.outputData as any)._artifactKey),
    ).toEqual({ route: "replay" });
  });

  it("uses checkCompletion for ordinary suspended metadata", async () => {
    let checks = 0;
    const stage = defineAsyncBatchStage({
      id: "batch",
      name: "Batch",
      mode: "async-batch",
      schemas: {
        input: z.object({}),
        output: z.object({ route: z.string() }),
        config: z.object({}),
      },
      async execute() {
        return {
          suspended: true,
          state: { batchId: "batch" },
          pollConfig: {
            pollInterval: 1_000,
            maxWaitTime: 10_000,
            nextPollAt: new Date("2025-01-01T00:00:01.000Z"),
          },
        };
      },
      async checkCompletion() {
        checks++;
        return { ready: true, output: { route: "check" } };
      },
    });
    const workflow = new WorkflowBuilder(
      "batch-gate",
      "Batch Gate",
      "test",
      z.object({}),
      z.object({ route: z.string() }),
    )
      .pipe(stage)
      .build();
    const { kernel, persistence, clock } = createTestKernel([workflow]);
    const runId = await start(workflow, kernel);

    clock.advance(1_000);
    await kernel.dispatch({ type: "stage.pollSuspended" });
    expect(checks).toBe(1);
    expect((await persistence.getStage(runId, stage.id))?.status).toBe(
      "COMPLETED",
    );
  });
});
