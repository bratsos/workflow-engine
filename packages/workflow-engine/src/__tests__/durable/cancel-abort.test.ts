/**
 * Cancellation reaches a running body.
 *
 * `ctx.abortSignal` (and `step.abortSignal` inside `run`) is aborted from
 * the host's job lease heartbeat when the run is cancelled or the job lease
 * is lost, so a long body can stop instead of running to completion and
 * having its outcome rejected afterwards.
 */

import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  StageAbortedError,
  type StageAbortReason,
  stageAbortReason,
} from "../../core/steps.js";
import { defineWorkflow } from "../../core/workflow.js";
import { createStepApi } from "../../kernel/helpers/step-api.js";
import { FakeClock } from "../../kernel/testing/fake-clock.js";
import { InMemoryStepLedger } from "../../testing/in-memory-step-ledger.js";
import { createTestHarness } from "../../testing/index.js";

const In = z.object({});
const Out = z.object({ done: z.boolean() });

function abortEvent(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

describe("cancellation reaches running bodies", () => {
  it("a run body sees ctx.abortSignal abort with reason cancelled", async () => {
    let observed: StageAbortReason | undefined;
    let sameSignal = false;
    const workflow = defineWorkflow("cancel-abort", { input: In })
      .stage("slow", {
        schemas: { input: In, output: Out, config: z.object({}) },
        async execute(ctx) {
          await ctx.step.run("work", async (step) => {
            sameSignal = step.abortSignal === ctx.abortSignal;
            await harness.cancel(ctx.workflowRunId, "operator");
            await abortEvent(step.abortSignal);
            observed = stageAbortReason(step.abortSignal);
            return "finished anyway";
          });
          return { output: { done: true } };
        },
      })
      .build();
    const harness = createTestHarness({ workflows: [workflow] });

    const { workflowRunId } = await harness.start("cancel-abort", {});
    const report = await harness.tick([workflowRunId]);

    expect(sameSignal).toBe(true);
    expect(observed).toBe("cancelled");
    expect(report.outcomes).toEqual([
      expect.objectContaining({ stageId: "slow", outcome: "failed" }),
    ]);
    const run = await harness.persistence.getRun(workflowRunId);
    expect(run?.status).toBe("CANCELLED");
  });

  it("does not record a completed outcome for a body that finished after a cancel", async () => {
    const clock = new FakeClock();
    const ledger = new InMemoryStepLedger({ now: clock.now.bind(clock) });
    const abort = new AbortController();
    const api = createStepApi({
      stageRecordId: "stage",
      stepLedger: ledger,
      clock,
      abortSignal: abort.signal,
    });

    const outcome = await api
      .run(
        "work",
        async () => {
          abort.abort(new StageAbortedError("cancelled", "run-1"));
          return "finished anyway";
        },
        { retries: 2 },
      )
      .catch((error: unknown) => error);

    // The cancellation is the error, not a retry suspension: no replay is
    // coming, so no retry is spent on it.
    expect(outcome).toBeInstanceOf(StageAbortedError);
    expect((outcome as StageAbortedError).reason).toBe("cancelled");
    expect(await ledger.get("stage", "work")).toMatchObject({
      status: "failed",
      attempt: 1,
      result: null,
      error: "Run run-1 was cancelled while the stage was executing",
    });
  });

  it("waitFor checks the signal before polling", async () => {
    const clock = new FakeClock();
    const ledger = new InMemoryStepLedger({ now: clock.now.bind(clock) });
    const abort = new AbortController();
    abort.abort(new StageAbortedError("cancelled", "run-1"));
    const api = createStepApi({
      stageRecordId: "stage",
      stepLedger: ledger,
      clock,
      abortSignal: abort.signal,
    });
    let polls = 0;

    await expect(
      api.waitFor("poll", {
        poll: async () => ++polls,
        ready: () => true,
        every: "1s",
        timeout: "1m",
      }),
    ).rejects.toBeInstanceOf(StageAbortedError);
    expect(polls).toBe(0);
    // The wait row is left open for whoever replays the stage next.
    expect((await ledger.get("stage", "poll"))?.status).toBe("pending");
  });

  it("a lost job lease aborts with reason lease-lost", async () => {
    let observed: StageAbortReason | undefined;
    const workflow = defineWorkflow("lease-lost-abort", { input: In })
      .stage("slow", {
        schemas: { input: In, output: Out, config: z.object({}) },
        async execute(ctx) {
          await ctx.step.run("work", async (step) => {
            // Another host's stale-lease reap: the job goes back to PENDING
            // under this worker's feet. (The in-memory queue stamps
            // `lockedAt` from the wall clock, so the release is modelled
            // directly rather than through a threshold the heartbeat's own
            // touch would race.)
            const [job] = await harness.jobQueue.getJobsByWorkflowRun(
              ctx.workflowRunId,
            );
            await harness.jobQueue.fail(
              job!.id,
              "LEASE_HEARTBEAT_LOST: released for another worker",
              true,
            );
            await abortEvent(step.abortSignal);
            observed = stageAbortReason(step.abortSignal);
            return "finished";
          });
          return { output: { done: true } };
        },
      })
      .build();
    const harness = createTestHarness({ workflows: [workflow] });

    const { workflowRunId } = await harness.start("lease-lost-abort", {});
    await harness.tick([workflowRunId]);

    expect(observed).toBe("lease-lost");
  });

  it("a stage executed without a host loop gets a signal that never fires", async () => {
    let aborted: boolean | undefined;
    const workflow = defineWorkflow("no-host-abort", { input: In })
      .stage("plain", {
        schemas: { input: In, output: Out, config: z.object({}) },
        async execute(ctx) {
          aborted = ctx.abortSignal.aborted;
          return { output: { done: true } };
        },
      })
      .build();
    const harness = createTestHarness({ workflows: [workflow] });
    const { workflowRunId } = await harness.start("no-host-abort", {});
    await harness.kernel.dispatch({ type: "run.claimPending", workerId: "w" });
    const job = await harness.jobQueue.dequeue();

    const result = await harness.kernel.dispatch({
      type: "job.execute",
      workflowRunId,
      workflowId: "no-host-abort",
      stageId: "plain",
      config: {},
      attempt: job!.attempt,
    });

    expect(result.outcome).toBe("completed");
    expect(aborted).toBe(false);
  });
});
