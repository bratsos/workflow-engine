import { FakeClock } from "@bratsos/workflow-engine/kernel/testing";
import { describe, expect, it } from "vitest";
import { Broker } from "../broker/broker.js";
import { InMemoryBrokerStore } from "../broker/store.js";
import { InMemoryObjectStore } from "../object-store.js";
import type { OrchestratorTransport } from "../transport.js";
import { createInProcessTransport } from "../transport.js";
import { createActivityWorker } from "../worker/worker.js";
import type { Orchestrator } from "./fixtures.js";
import { buildOrchestrator, heavyStage } from "./fixtures.js";

/**
 * Lease renewal via heartbeat.
 *
 * Proves:
 * 1. While a worker heartbeats, a second worker's lease() returns null (the
 *    task is NOT reaped / re-leasable) even after staleLeaseMs has elapsed
 *    since the initial lease — because each heartbeat resets leasedAt.
 * 2. A heartbeat does NOT extend the absolute deadline (deadlineAt).
 * 3. The run completes on the first (and only) worker — the second worker never
 *    gets to process the task.
 *
 * We use a very small staleLeaseMs (50 ms) so the test stays fast while still
 * being deterministic: we advance a FakeClock past the stale threshold *between*
 * heartbeats to confirm that a heartbeat that fired just before the advance
 * refreshed leasedAt and prevented the false-reap.
 */

/** Move the SUSPENDED stage's nextPollAt into the past. */
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

async function runToSuspend(
  orch: Orchestrator,
  kernel: Orchestrator["kernel"],
  jobQueue: Orchestrator["jobQueue"],
  idempotencyKey: string,
  seed: number,
): Promise<{ workflowRunId: string }> {
  const { workflowRunId } = await kernel.dispatch({
    type: "run.create",
    idempotencyKey,
    workflowId: orch.workflowId,
    input: { seed },
  });
  await kernel.dispatch({ type: "run.claimPending", workerId: "orch" });
  const job = await jobQueue.dequeue();
  expect(job).not.toBeNull();
  const r = await kernel.dispatch({
    type: "job.execute",
    workflowRunId,
    workflowId: orch.workflowId,
    stageId: job!.stageId,
    config: {},
  });
  expect(r.outcome).toBe("suspended");
  await jobQueue.suspend(
    job!.jobId,
    new Date(orch.clock.now().getTime() + 100),
  );
  return { workflowRunId };
}

describe("lease renewal via heartbeat", () => {
  it("a heartbeating worker is NOT reaped: second worker's lease() returns null", async () => {
    // Use a very small staleLeaseMs so we can fast-forward the clock in-test.
    const staleLeaseMs = 50;
    const clock = new FakeClock(new Date(0));
    const os = new InMemoryObjectStore(clock);
    const brokerStore = new InMemoryBrokerStore();
    const broker = new Broker({
      store: brokerStore,
      presigner: os,
      clock,
      staleLeaseMs,
    });

    const oTransport: OrchestratorTransport = {
      submit: (req) => broker.submit(req),
      poll: (taskId) => broker.poll(taskId),
    };
    const { worker: wTransport } = createInProcessTransport(broker, os);
    const orch = buildOrchestrator(oTransport, os, clock);

    // Run to SUSPEND — submits the remote task to the broker (PENDING).
    const { workflowRunId } = await runToSuspend(
      orch,
      orch.kernel,
      orch.jobQueue,
      "k-lease-hb",
      3,
    );

    // Worker 1 leases the task; the task is now ASSIGNED with leasedAt = 0.
    const task1 = await wTransport.lease({
      workerId: "w1",
      stageIds: ["heavy"],
      stageCodeVersion: "v1",
    });
    expect(task1).not.toBeNull();
    const taskId = task1!.taskId;

    // Confirm staleLeaseMs relationship: heartbeatMs default (5000) is well
    // above our tiny staleLeaseMs (50), so we drive the heartbeat manually.

    // Advance clock past staleLeaseMs without heartbeating — confirms the task
    // WOULD be reaped if we checked poll() now.
    clock.advance(staleLeaseMs + 1);
    // At this point leasedAt is still 0 (the initial lease time). poll() would
    // reap it. But instead, fire a heartbeat first — simulating what the worker
    // does mid-stage.
    const hb = await wTransport.heartbeat({
      taskId,
      leaseToken: task1!.leaseToken,
    });
    expect(hb.ok).toBe(true);
    expect(hb.cancel).toBe(false);

    // Now the leasedAt has been refreshed to clock.now() (staleLeaseMs + 1).
    // Advance the clock by only half a staleLeaseMs window — still within the
    // renewed lease window.
    clock.advance(staleLeaseMs / 2);

    // A second worker attempts to lease — must get null (task still held by w1).
    const task2 = await wTransport.lease({
      workerId: "w2",
      stageIds: ["heavy"],
      stageCodeVersion: "v1",
    });
    expect(task2).toBeNull();

    // Confirm poll() also doesn't reap: it should see ASSIGNED (not pending).
    const pollResult = await broker.poll(taskId);
    expect(pollResult.state).toBe("assigned");

    // Let the first worker complete the task normally.
    const worker = createActivityWorker({
      registry: new Map([["heavy", heavyStage]]),
      transport: wTransport,
      workerId: "w1",
      stageIds: ["heavy"],
      stageCodeVersion: "v1",
    });

    // The task is already ASSIGNED to task1's lease; the worker needs to report
    // it directly. Use the internal report path by running the stage manually.
    const { runActivity } = await import("../worker/run-activity.js");
    const stage = heavyStage;
    const report = await runActivity(task1!, stage, wTransport);
    await wTransport.report(report);

    // Poll should now be "reported".
    const pollFinal = await broker.poll(taskId);
    expect(pollFinal.state).toBe("reported");
    expect(pollFinal.outcome?.kind).toBe("completed");

    // Resume the stage via the orchestrator.
    await makeStageResumable(orch, workflowRunId);
    const poll1 = await orch.kernel.dispatch({ type: "stage.pollSuspended" });
    expect(poll1.resumed).toBe(1);

    // Finish the run.
    await orch.kernel.dispatch({ type: "run.transition", workflowRunId });
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
    await orch.kernel.dispatch({ type: "run.transition", workflowRunId });

    const run = await orch.persistence.getRun(workflowRunId);
    expect(run?.status).toBe("COMPLETED");
    expect((run?.output as { doubled: number }).doubled).toBe(6);
  });

  it("heartbeat does NOT extend the absolute deadline", async () => {
    const staleLeaseMs = 50;
    const clock = new FakeClock(new Date(0));
    const os = new InMemoryObjectStore(clock);
    const brokerStore = new InMemoryBrokerStore();
    const broker = new Broker({
      store: brokerStore,
      presigner: os,
      clock,
      staleLeaseMs,
    });
    const { worker: wTransport } = createInProcessTransport(broker, os);
    const oTransport: OrchestratorTransport = {
      submit: (req) => broker.submit(req),
      poll: (taskId) => broker.poll(taskId),
    };
    const orch = buildOrchestrator(oTransport, os, clock);

    await runToSuspend(orch, orch.kernel, orch.jobQueue, "k-deadline-hb", 2);

    // Get the task before leasing so we know the original deadline.
    const tasks = (await brokerStore["tasks" as never]) as Map<
      string,
      { deadline: number }
    >;
    const [firstTask] = [
      ...(
        tasks as unknown as Map<string, { deadline: number; taskId: string }>
      ).values(),
    ];
    const originalDeadline = firstTask.deadline;

    const task = await wTransport.lease({
      workerId: "w1",
      stageIds: ["heavy"],
      stageCodeVersion: "v1",
    });
    expect(task).not.toBeNull();

    // Fire multiple heartbeats with clock advances.
    for (let i = 0; i < 5; i++) {
      clock.advance(staleLeaseMs - 5);
      await wTransport.heartbeat({
        taskId: task!.taskId,
        leaseToken: task!.leaseToken,
      });
    }

    // The deadline in the store must be unchanged.
    const record = await brokerStore.get(task!.taskId);
    expect(record?.deadline).toBe(originalDeadline);
  });

  it("lease IS released after staleLeaseMs if worker stops heartbeating", async () => {
    const staleLeaseMs = 50;
    const clock = new FakeClock(new Date(0));
    const os = new InMemoryObjectStore(clock);
    const brokerStore = new InMemoryBrokerStore();
    const broker = new Broker({
      store: brokerStore,
      presigner: os,
      clock,
      staleLeaseMs,
    });
    const oTransport: OrchestratorTransport = {
      submit: (req) => broker.submit(req),
      poll: (taskId) => broker.poll(taskId),
    };
    const { worker: wTransport } = createInProcessTransport(broker, os);
    const orch = buildOrchestrator(oTransport, os, clock);

    await runToSuspend(orch, orch.kernel, orch.jobQueue, "k-reap", 2);

    const task = await wTransport.lease({
      workerId: "w1",
      stageIds: ["heavy"],
      stageCodeVersion: "v1",
    });
    expect(task).not.toBeNull();

    // NO heartbeat — advance past staleLeaseMs.
    clock.advance(staleLeaseMs + 1);

    // poll() should now reap the stale lease → state becomes "pending".
    const p = await broker.poll(task!.taskId);
    expect(p.state).toBe("pending");

    // A second worker can now lease the reaped task.
    const task2 = await wTransport.lease({
      workerId: "w2",
      stageIds: ["heavy"],
      stageCodeVersion: "v1",
    });
    expect(task2).not.toBeNull();
    expect(task2!.taskId).toBe(task!.taskId);
  });
});
