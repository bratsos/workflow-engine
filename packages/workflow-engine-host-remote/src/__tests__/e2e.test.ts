import { FakeClock } from "@bratsos/workflow-engine/kernel/testing";
import { describe, expect, it } from "vitest";
import { Broker } from "../broker/broker.js";
import { InMemoryBrokerStore } from "../broker/store.js";
import { InMemoryObjectStore } from "../object-store.js";
import { createInProcessTransport } from "../transport.js";
import { createActivityWorker } from "../worker/worker.js";
import type { Orchestrator } from "./fixtures.js";
import { buildOrchestrator, heavyStage } from "./fixtures.js";

function setup(opts: { staleLeaseMs?: number } = {}) {
  // All three components share ONE FakeClock so advancing time affects all of them.
  const clock = new FakeClock(new Date(0));
  const os = new InMemoryObjectStore(clock);
  const broker = new Broker({
    store: new InMemoryBrokerStore(),
    presigner: os,
    clock,
    stageCodeVersion: "v1",
    staleLeaseMs: opts.staleLeaseMs ?? 60_000,
  });
  const { orchestrator: oTransport, worker: wTransport } =
    createInProcessTransport(broker, os);
  const orch = buildOrchestrator(oTransport, os, clock);
  const worker = createActivityWorker({
    registry: new Map([["heavy", heavyStage]]),
    transport: wTransport,
    workerId: "w1",
    stageIds: ["heavy"],
    stageCodeVersion: "v1",
  });
  return { orch, worker, broker, os };
}

/** Move the SUSPENDED stage's nextPollAt into the past so stage.pollSuspended picks it up. */
async function makeStageResumable(
  orch: Orchestrator,
  runId: string,
): Promise<void> {
  const stages = await orch.persistence.getStagesByRun(runId);
  const suspended = stages.find((s) => s.status === "SUSPENDED");
  if (suspended) {
    await orch.persistence.updateStage(suspended.id, {
      nextPollAt: new Date(orch.clock.now().getTime() - 1),
    });
  }
}

describe("remote activity workers — e2e", () => {
  it("A: runs a remote heavy stage, persists output by reference, core stage reads it, run completes", async () => {
    const { orch, worker } = setup();

    // Create + claim
    const { workflowRunId } = await orch.kernel.dispatch({
      type: "run.create",
      idempotencyKey: "k1",
      workflowId: orch.workflowId,
      input: { seed: 3 },
    });
    await orch.kernel.dispatch({ type: "run.claimPending", workerId: "orch" });

    // --- Group 0: the remote (proxy) heavy stage ---
    const job = await orch.jobQueue.dequeue();
    expect(job).not.toBeNull();

    const r1 = await orch.kernel.dispatch({
      type: "job.execute",
      workflowRunId,
      workflowId: orch.workflowId,
      stageId: job!.stageId,
      config: {},
    });
    // C assertion (inherent): proxy suspends
    expect(r1.outcome).toBe("suspended");
    await orch.jobQueue.suspend(
      job!.jobId,
      new Date(orch.clock.now().getTime() + 100),
    );

    // Worker executes the real heavy stage (writes artifact to object store)
    expect(await worker.processOne()).toBe(true);

    // Make the SUSPENDED stage record pollable
    await makeStageResumable(orch, workflowRunId);

    // C assertion (inherent): pollSuspended resumes the stage
    const poll = await orch.kernel.dispatch({ type: "stage.pollSuspended" });
    expect(poll.resumed).toBe(1);

    // Advance to group 1
    await orch.kernel.dispatch({ type: "run.transition", workflowRunId });

    // --- Group 1: the in-process core stage ---
    const job2 = await orch.jobQueue.dequeue();
    expect(job2).not.toBeNull();

    const r2 = await orch.kernel.dispatch({
      type: "job.execute",
      workflowRunId,
      workflowId: orch.workflowId,
      stageId: job2!.stageId,
      config: {},
    });
    expect(r2.outcome).toBe("completed");
    await orch.jobQueue.complete(job2!.jobId);

    const t = await orch.kernel.dispatch({
      type: "run.transition",
      workflowRunId,
    });
    expect(t.action).toBe("completed");

    const run = await orch.persistence.getRun(workflowRunId);
    expect(run?.status).toBe("COMPLETED");
    // seed 3 → array of 3 items → doubled = 6
    expect((run?.output as { doubled: number }).doubled).toBe(6);
  });

  it("B: recovers from a worker crash via broker re-lease (no engine failure)", async () => {
    const staleLeaseMs = 1_000;
    const { orch, worker, broker } = setup({ staleLeaseMs });

    const { workflowRunId } = await orch.kernel.dispatch({
      type: "run.create",
      idempotencyKey: "k2",
      workflowId: orch.workflowId,
      input: { seed: 2 },
    });
    await orch.kernel.dispatch({ type: "run.claimPending", workerId: "orch" });

    const job = await orch.jobQueue.dequeue();
    await orch.kernel.dispatch({
      type: "job.execute",
      workflowRunId,
      workflowId: orch.workflowId,
      stageId: job!.stageId,
      config: {},
    });
    await orch.jobQueue.suspend(
      job!.jobId,
      new Date(orch.clock.now().getTime() + 100),
    );

    // Worker A leases but "crashes" — simulate by leasing directly and never reporting.
    await broker.lease({
      workerId: "A",
      stageIds: ["heavy"],
      stageCodeVersion: "v1",
    });
    orch.clock.advance(2_000); // exceed staleLeaseMs — stale lease is now detectable

    // First poll: broker detects stale lease and re-queues the task (returns state: "pending").
    // stage.pollSuspended calls checkCompletion which calls transport.poll which sees pending.
    // The stage stays SUSPENDED but not ready yet, so resumed===0, failed===0.
    await makeStageResumable(orch, workflowRunId);
    let poll = await orch.kernel.dispatch({ type: "stage.pollSuspended" });
    expect(poll.failed).toBe(0);
    expect(poll.resumed).toBe(0); // not ready yet (task re-queued to PENDING)

    // Worker B picks it up and completes it.
    expect(await worker.processOne()).toBe(true);
    await makeStageResumable(orch, workflowRunId);
    poll = await orch.kernel.dispatch({ type: "stage.pollSuspended" });
    expect(poll.resumed).toBe(1);
    await orch.kernel.dispatch({ type: "run.transition", workflowRunId });

    // Group 1: core stage
    const job2 = await orch.jobQueue.dequeue();
    expect(job2).not.toBeNull();
    await orch.kernel.dispatch({
      type: "job.execute",
      workflowRunId,
      workflowId: orch.workflowId,
      stageId: job2!.stageId,
      config: {},
    });
    await orch.jobQueue.complete(job2!.jobId);
    await orch.kernel.dispatch({ type: "run.transition", workflowRunId });

    const run = await orch.persistence.getRun(workflowRunId);
    expect(run?.status).toBe("COMPLETED");
  });

  it("D: idempotent job.execute replays without invoking the worker twice", async () => {
    const { orch, worker } = setup();

    const { workflowRunId } = await orch.kernel.dispatch({
      type: "run.create",
      idempotencyKey: "k3",
      workflowId: orch.workflowId,
      input: { seed: 1 },
    });
    await orch.kernel.dispatch({ type: "run.claimPending", workerId: "orch" });
    const job = await orch.jobQueue.dequeue();
    expect(job).not.toBeNull();

    const cmd = {
      type: "job.execute" as const,
      idempotencyKey: `job:${job!.jobId}:attempt:${job!.attempt}`,
      workflowRunId,
      workflowId: orch.workflowId,
      stageId: job!.stageId,
      config: {},
    };

    const first = await orch.kernel.dispatch(cmd);
    const second = await orch.kernel.dispatch(cmd); // replay — idempotent

    expect(first.outcome).toBe("suspended");
    expect(second.outcome).toBe("suspended");
    // Only one submit to the broker (idempotent replay returns the same suspended result).
    expect(await worker.processOne()).toBe(true);  // leases + runs the single submitted task
    expect(await worker.processOne()).toBe(false); // no second task — idempotency prevented a duplicate submit
  });
});
