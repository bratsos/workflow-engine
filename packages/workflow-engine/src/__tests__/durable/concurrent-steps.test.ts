/**
 * Steps fired concurrently under `Promise.all`: when one suspends, the
 * siblings must finish and record before the stage suspends, so the replay
 * finds completed rows instead of live leases (`StepInFlight`).
 */

import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineWorkflow } from "../../core/workflow.js";
import { createTestHarness } from "../../testing/index.js";

const In = z.object({ value: z.number() });

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("concurrent durable steps", () => {
  it("settles in-flight siblings before a suspension is persisted", async () => {
    let polls = 0;
    let firstRuns = 0;
    let thirdRuns = 0;

    const workflow = defineWorkflow("concurrent-steps", { input: In })
      .stage("fanout", {
        schemas: {
          input: In,
          output: z.object({ first: z.number(), third: z.number() }),
          config: z.object({}),
        },
        async execute(ctx) {
          const [first, , third] = await Promise.all([
            ctx.step.run("first", async () => {
              await delay(20);
              firstRuns++;
              return 1;
            }),
            ctx.step.waitFor("gate", {
              poll: async () => ++polls,
              ready: (n) => n >= 2,
              every: "10s",
              timeout: "1h",
            }),
            ctx.step.run("third", async () => {
              await delay(30);
              thirdRuns++;
              return 3;
            }),
          ]);
          return { output: { first, third } };
        },
      })
      .build();

    const harness = createTestHarness({ workflows: [workflow] });

    // First round only: the gate is not ready, so the stage suspends.
    await harness.kernel.dispatch({
      type: "run.create",
      idempotencyKey: "concurrent-1",
      workflowId: "concurrent-steps",
      input: { value: 1 },
    });
    await harness.kernel.dispatch({
      type: "run.claimPending",
      workerId: "test-worker",
    });
    const job = await harness.jobQueue.dequeue();
    const first = await harness.kernel.dispatch({
      type: "job.execute",
      workflowRunId: job!.workflowRunId,
      workflowId: job!.workflowId,
      stageId: job!.stageId,
      config: {},
    });
    expect(first.outcome).toBe("suspended");

    // The suspension is persisted; both sibling runs already recorded.
    const stage = (
      await harness.persistence.getStagesByRun(job!.workflowRunId)
    )[0]!;
    expect(stage.status).toBe("SUSPENDED");
    const rows = await harness.stepLedger.list(stage.id);
    const byId = new Map(rows.map((r) => [r.stepId, r]));
    expect(byId.get("first")?.status).toBe("completed");
    expect(byId.get("third")?.status).toBe("completed");
    expect(byId.get("first")?.leaseExpiresAt).toBeNull();
    expect(byId.get("third")?.leaseExpiresAt).toBeNull();

    // The replay answers both from the ledger — no StepInFlight, no re-run.
    harness.clock.advance(11_000);
    const replayed = await harness.kernel.dispatch({
      type: "stage.pollSuspended",
    });
    expect(replayed.checked).toBe(1);
    expect(firstRuns).toBe(1);
    expect(thirdRuns).toBe(1);

    const after = (
      await harness.persistence.getStagesByRun(job!.workflowRunId)
    )[0]!;
    expect(after.status).toBe("COMPLETED");
  });
});
