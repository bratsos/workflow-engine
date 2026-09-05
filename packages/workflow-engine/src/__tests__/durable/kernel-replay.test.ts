import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  defineAsyncBatchStage,
  defineStage,
} from "../../core/stage-factory.js";
import { WorkflowBuilder } from "../../core/workflow.js";
import { InMemoryStepLedger } from "../../testing/in-memory-step-ledger.js";
import { createTestKernel } from "../utils/index.js";

const inputSchema = z.object({ value: z.string() });
const outputSchema = z.object({ value: z.string(), status: z.string() });

async function createAndClaim(
  kernel: ReturnType<typeof createTestKernel>["kernel"],
  workflowId: string,
) {
  const created = await kernel.dispatch({
    type: "run.create",
    idempotencyKey: `${workflowId}-run`,
    workflowId,
    input: { value: "input" },
  });
  await kernel.dispatch({ type: "run.claimPending", workerId: "test-worker" });
  return created.workflowRunId;
}

describe("kernel durable replay", () => {
  it("replays waits without repeating completed side effects", async () => {
    const ledger = new InMemoryStepLedger();
    const clock = new (
      await import("../../kernel/testing/fake-clock.js")
    ).FakeClock();
    let reserveCalls = 0;
    let finishCalls = 0;
    let polls = 0;
    const stage = defineStage({
      id: "durable-stage",
      name: "Durable Stage",
      schemas: {
        input: inputSchema,
        output: outputSchema,
        config: z.object({}),
      },
      async execute(ctx) {
        const reservation = await ctx.step.run("reserve", async () => {
          reserveCalls++;
          return { id: "reservation-1" };
        });
        const job = await ctx.step.waitFor("job", {
          poll: async () => ({ done: polls++ >= 2 }),
          ready: (value) => value.done,
          every: 1000,
          timeout: "5m",
        });
        const finished = await ctx.step.run("finish", async () => {
          finishCalls++;
          return "finished";
        });
        return {
          output: { value: `${reservation.id}:${job.done}`, status: finished },
        };
      },
    });
    const workflow = new WorkflowBuilder(
      "durable-replay",
      "Durable Replay",
      "test",
      inputSchema,
      outputSchema,
    )
      .pipe(stage)
      .build();
    const { kernel, persistence } = createTestKernel([workflow], {
      clock,
      stepLedger: ledger,
    });
    const workflowRunId = await createAndClaim(kernel, "durable-replay");

    const first = await kernel.dispatch({
      type: "job.execute",
      workflowRunId,
      workflowId: "durable-replay",
      stageId: "durable-stage",
      config: {},
    });
    expect(first.outcome).toBe("suspended");
    expect(
      (await persistence.getStage(workflowRunId, "durable-stage"))?.status,
    ).toBe("SUSPENDED");

    for (let i = 0; i < 5; i++) {
      clock.advance(1000);
      await kernel.dispatch({ type: "stage.pollSuspended" });
    }

    expect(reserveCalls).toBe(1);
    expect(polls).toBe(3);
    expect(finishCalls).toBe(1);
    expect(
      (await persistence.getStage(workflowRunId, "durable-stage"))?.status,
    ).toBe("COMPLETED");

    const transition = await kernel.dispatch({
      type: "run.transition",
      workflowRunId,
    });
    expect(transition.action).toBe("completed");
    expect((await persistence.getRun(workflowRunId))?.status).toBe("COMPLETED");
  });

  it("resumes a signal wait after step.signal nudges the suspended stage", async () => {
    const ledger = new InMemoryStepLedger();
    const stage = defineStage({
      id: "approval-stage",
      name: "Approval Stage",
      schemas: {
        input: inputSchema,
        output: z.object({ approved: z.boolean() }),
        config: z.object({}),
      },
      async execute(ctx) {
        const signal = await ctx.step.waitForSignal<{ approved: boolean }>(
          "approval",
          {
            timeout: "5m",
          },
        );
        return { output: signal };
      },
    });
    const workflow = new WorkflowBuilder(
      "signal-replay",
      "Signal Replay",
      "test",
      inputSchema,
      z.object({ approved: z.boolean() }),
    )
      .pipe(stage)
      .build();
    const { kernel, persistence, clock, eventSink } = createTestKernel(
      [workflow],
      {
        stepLedger: ledger,
      },
    );
    const workflowRunId = await createAndClaim(kernel, "signal-replay");

    await expect(
      kernel.dispatch({
        type: "job.execute",
        workflowRunId,
        workflowId: "signal-replay",
        stageId: "approval-stage",
        config: {},
      }),
    ).resolves.toMatchObject({ outcome: "suspended" });
    const signalled = await kernel.dispatch({
      type: "step.signal",
      workflowRunId,
      stageId: "approval-stage",
      stepId: "approval",
      payload: { approved: true },
    });
    expect(signalled.signalled).toBe(true);
    await kernel.dispatch({ type: "stage.pollSuspended" });

    expect(
      (await persistence.getStage(workflowRunId, "approval-stage"))?.status,
    ).toBe("COMPLETED");
    expect(
      eventSink.events.some((event) => event.type === "step:signalled"),
    ).toBe(false);
    await kernel.dispatch({ type: "outbox.flush" });
    expect(
      eventSink.events.some((event) => event.type === "step:signalled"),
    ).toBe(true);
    expect(clock.now()).toEqual(new Date("2025-01-01T00:00:00.000Z"));
  });

  it("preserves ordinary sync stages and legacy async-batch checkCompletion", async () => {
    const clock = new (
      await import("../../kernel/testing/fake-clock.js")
    ).FakeClock();
    let checks = 0;
    const plain = defineStage({
      id: "plain",
      name: "Plain",
      schemas: {
        input: inputSchema,
        output: inputSchema,
        config: z.object({}),
      },
      async execute(ctx) {
        return { output: ctx.input };
      },
    });
    const batch = defineAsyncBatchStage({
      id: "batch",
      name: "Batch",
      mode: "async-batch",
      schemas: {
        input: inputSchema,
        output: inputSchema,
        config: z.object({}),
      },
      async execute() {
        return {
          suspended: true,
          state: { batchId: "batch-1" },
          pollConfig: {
            pollInterval: 1000,
            maxWaitTime: 60000,
            nextPollAt: new Date(clock.now().getTime() + 1000),
          },
        };
      },
      async checkCompletion() {
        checks++;
        return { ready: true, output: { value: "batch" } };
      },
    });
    const workflow = new WorkflowBuilder(
      "regression",
      "Regression",
      "test",
      inputSchema,
      inputSchema,
    )
      .pipe(plain)
      .pipe(batch)
      .build();
    const { kernel, persistence } = createTestKernel([workflow], { clock });
    const workflowRunId = await createAndClaim(kernel, "regression");
    await expect(
      kernel.dispatch({
        type: "job.execute",
        workflowRunId,
        workflowId: "regression",
        stageId: "plain",
        config: {},
      }),
    ).resolves.toMatchObject({ outcome: "completed" });
    await kernel.dispatch({ type: "run.transition", workflowRunId });
    await kernel.dispatch({
      type: "job.execute",
      workflowRunId,
      workflowId: "regression",
      stageId: "batch",
      config: {},
    });
    clock.advance(1000);
    await kernel.dispatch({ type: "stage.pollSuspended" });
    expect(checks).toBe(1);
    expect((await persistence.getStage(workflowRunId, "batch"))?.status).toBe(
      "COMPLETED",
    );
  });
});
