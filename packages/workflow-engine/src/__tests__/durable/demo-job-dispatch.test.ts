import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineStage } from "../../core/stage-factory.js";
import { WorkflowBuilder } from "../../core/workflow.js";
import { FakeClock } from "../../kernel/testing/fake-clock.js";
import { InMemoryStepLedger } from "../../testing/in-memory-step-ledger.js";
import { createTestKernel } from "../utils/index.js";

describe("durable job dispatch demo", () => {
  it("reserves and starts a remote job exactly once across replay", async () => {
    const clock = new FakeClock();
    const ledger = new InMemoryStepLedger({ now: clock.now.bind(clock) });
    let startCalls = 0;
    let polls = 0;
    const client = {
      async reserve(key: string) {
        return { key, id: "reservation-1" };
      },
      async startRun(id: string) {
        startCalls++;
        return { id: `remote-${id}` };
      },
      async status() {
        return { done: polls++ >= 4, value: "result" };
      },
    };
    const stage = defineStage({
      id: "dispatch",
      name: "Dispatch",
      schemas: {
        input: z.object({ request: z.string() }),
        output: z.object({ remoteId: z.string(), value: z.string() }),
        config: z.object({}),
      },
      async execute(ctx) {
        const reservation = await ctx.step.run("reserve", () =>
          client.reserve(ctx.input.request),
        );
        const remote = await ctx.step.run("dispatch", () =>
          client.startRun(reservation.id),
        );
        const status = await ctx.step.waitFor("job", {
          poll: () => client.status(),
          ready: (value) => value.done,
          every: "1s",
          timeout: "1h",
        });
        return { output: { remoteId: remote.id, value: status.value } };
      },
    });
    const workflow = new WorkflowBuilder(
      "dispatch-demo",
      "Dispatch Demo",
      "test",
      z.object({ request: z.string() }),
      z.object({ remoteId: z.string(), value: z.string() }),
    )
      .pipe(stage)
      .build();
    const { kernel, persistence } = createTestKernel([workflow], {
      clock,
      stepLedger: ledger,
    });
    const run = await kernel.dispatch({
      type: "run.create",
      idempotencyKey: "dispatch-run",
      workflowId: "dispatch-demo",
      input: { request: "request-key" },
    });
    await kernel.dispatch({
      type: "run.claimPending",
      workerId: "test-worker",
    });
    await kernel.dispatch({
      type: "job.execute",
      workflowRunId: run.workflowRunId,
      workflowId: "dispatch-demo",
      stageId: "dispatch",
      config: {},
    });
    for (let i = 0; i < 5; i++) {
      clock.advance(1000);
      await kernel.dispatch({ type: "stage.pollSuspended" });
    }
    expect(startCalls).toBe(1);
    expect(polls).toBe(5);
    expect(
      (await persistence.getStage(run.workflowRunId, "dispatch"))?.status,
    ).toBe("COMPLETED");
  });
});
