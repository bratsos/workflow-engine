import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineStage } from "../../core/stage-factory.js";
import { WorkflowBuilder } from "../../core/workflow.js";
import { InMemoryStepLedger } from "../../testing/in-memory-step-ledger.js";
import { createTestKernel } from "../utils/index.js";

describe("durable replay artifacts", () => {
  it("persists result artifacts produced by a successful replay", async () => {
    let ready = false;
    const stage = defineStage({
      id: "artifacts",
      name: "Artifacts",
      schemas: {
        input: z.object({}),
        output: z.object({ done: z.boolean() }),
        config: z.object({}),
      },
      async execute(ctx) {
        await ctx.step.waitFor("ready", {
          poll: async () => ({ ready }),
          ready: (value) => value.ready,
          every: 1_000,
          timeout: 10_000,
        });
        return {
          output: { done: true },
          artifacts: { audit: { source: "replay" } },
        };
      },
    });
    const workflow = new WorkflowBuilder(
      "artifact-replay",
      "Artifact Replay",
      "test",
      z.object({}),
      z.object({ done: z.boolean() }),
    )
      .pipe(stage)
      .build();
    const { kernel, persistence, clock, blobStore } = createTestKernel(
      [workflow],
      { stepLedger: new InMemoryStepLedger() },
    );
    const created = await kernel.dispatch({
      type: "run.create",
      idempotencyKey: "artifact-replay",
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

    ready = true;
    clock.advance(1_000);
    await kernel.dispatch({ type: "stage.pollSuspended" });

    const record = await persistence.getStage(created.workflowRunId, stage.id);
    const artifactKey = (record?.outputData as any)._artifactKeys.audit;
    expect(await blobStore.get(artifactKey)).toEqual({ source: "replay" });
  });
});
