/**
 * End-to-end example: orchestrator + remote activity worker.
 *
 * Builds an in-process setup where the "heavy" stage runs on a separate worker
 * (simulated in-process here), the output is persisted by reference in the
 * object store, and a downstream core stage reads and doubles the result.
 *
 * Run:
 *   tsx examples/end-to-end.ts
 */

import { FakeClock } from "@bratsos/workflow-engine/kernel/testing";
import { Broker } from "../src/broker/broker.js";
import { InMemoryBrokerStore } from "../src/broker/store.js";
import { InMemoryObjectStore } from "../src/object-store.js";
import { createInProcessTransport } from "../src/transport.js";
import { createActivityWorker } from "../src/worker/worker.js";
import { buildOrchestrator, heavyStage } from "../src/__tests__/fixtures.js";

async function main(): Promise<void> {
  // --- Setup ---
  // All three components share ONE FakeClock so time-based operations are deterministic.
  const clock = new FakeClock(new Date(0));
  const objectStore = new InMemoryObjectStore(clock);
  const broker = new Broker({
    store: new InMemoryBrokerStore(),
    presigner: objectStore,
    clock,
    stageCodeVersion: "v1",
    staleLeaseMs: 60_000,
  });
  const { orchestrator: oTransport, worker: wTransport } = createInProcessTransport(broker, objectStore);
  const orch = buildOrchestrator(oTransport, objectStore, clock);

  // Worker runs the real heavy stage on a separate "process" (here: same process, different object).
  const worker = createActivityWorker({
    registry: new Map([["heavy", heavyStage]]),
    transport: wTransport,
    workerId: "w1",
    stageIds: ["heavy"],
    stageCodeVersion: "v1",
    // Poll frequently so the worker leases the heavy task promptly in this demo.
    idleDelayMs: 5,
  });

  worker.start();

  // --- Dispatch a run ---
  const seed = 3;
  const { workflowRunId } = await orch.kernel.dispatch({
    type: "run.create",
    idempotencyKey: `example-${Date.now()}`,
    workflowId: orch.workflowId,
    input: { seed },
  });
  console.log(`[example] Run created: ${workflowRunId}`);

  // Claim pending → enqueues group 0 jobs.
  await orch.kernel.dispatch({ type: "run.claimPending", workerId: "orch" });

  // --- Drive loop: run until the run reaches a terminal state (or a safety timeout) ---
  // The worker polls and runs the heavy stage independently (worker.start above); the
  // orchestrator here dequeues jobs, suspends the remote stage, and polls for its
  // completion. We loop on the actual run status rather than a fixed attempt count so
  // the worker has time to lease + report regardless of timing.
  const isTerminal = (s?: string): boolean =>
    s === "COMPLETED" || s === "FAILED" || s === "CANCELLED";
  const deadline = Date.now() + 10_000; // wall-clock safety net

  while (Date.now() < deadline) {
    const current = await orch.persistence.getRun(workflowRunId);
    if (isTerminal(current?.status)) break;

    const job = await orch.jobQueue.dequeue();

    if (job) {
      console.log(`[example] Executing stage: ${job.stageId}`);
      const result = await orch.kernel.dispatch({
        type: "job.execute",
        workflowRunId,
        workflowId: orch.workflowId,
        stageId: job.stageId,
        config: {},
      });

      if (result.outcome === "completed") {
        await orch.jobQueue.complete(job.jobId);
        await orch.kernel.dispatch({ type: "run.transition", workflowRunId });
      } else if (result.outcome === "suspended") {
        // The remote (heavy) stage suspended; the worker will run it. Poll for it below.
        await orch.jobQueue.suspend(
          job.jobId,
          new Date(orch.clock.now().getTime() + 100),
        );
      } else {
        console.error(`[example] Stage ${job.stageId} failed: ${result.error}`);
        break;
      }
    } else {
      // No job ready — the remote stage is suspended while the worker runs it.
      // Make it pollable, give the worker a tick to lease + report, then poll.
      const stages = await orch.persistence.getStagesByRun(workflowRunId);
      const suspended = stages.find((s) => s.status === "SUSPENDED");
      if (suspended) {
        await orch.persistence.updateStage(suspended.id, {
          nextPollAt: new Date(orch.clock.now().getTime() - 1),
        });
      }

      await new Promise<void>((resolve) => setTimeout(resolve, 10));

      const poll = await orch.kernel.dispatch({ type: "stage.pollSuspended" });
      if (poll.resumed > 0) {
        console.log(`[example] Suspended stage resumed (resumed=${poll.resumed})`);
        await orch.kernel.dispatch({ type: "run.transition", workflowRunId });
      }
    }
  }

  worker.stop();

  // --- Read and log output ---
  const run = await orch.persistence.getRun(workflowRunId);
  if (run?.status === "COMPLETED") {
    const output = run.output as { doubled: number };
    console.log(`[example] Run COMPLETED. seed=${seed} → doubled=${output.doubled}`);
  } else {
    console.error(`[example] Run did not complete. status=${run?.status}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
