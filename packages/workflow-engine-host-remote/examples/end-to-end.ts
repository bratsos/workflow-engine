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

  // --- Drive loop ---
  let attempts = 0;
  const maxAttempts = 20;

  while (attempts < maxAttempts) {
    attempts++;

    // Try to dequeue a job (group N is ready when the previous group fully completed).
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
        const t = await orch.kernel.dispatch({ type: "run.transition", workflowRunId });
        if (t.action === "completed") {
          break;
        }
      } else if (result.outcome === "suspended") {
        // Mark the job suspended in the queue; the drive loop will poll for it.
        await orch.jobQueue.suspend(job.jobId, new Date(orch.clock.now().getTime() + 100));
      } else {
        console.error(`[example] Stage ${job.stageId} failed: ${result.error}`);
        break;
      }
    } else {
      // No job ready — check for suspended stages that the worker has completed.
      // First, make any suspended stage with a future nextPollAt resumable by moving time forward.
      const stages = await orch.persistence.getStagesByRun(workflowRunId);
      const suspended = stages.find((s) => s.status === "SUSPENDED");
      if (suspended?.nextPollAt) {
        await orch.persistence.updateStage(suspended.id, {
          nextPollAt: new Date(orch.clock.now().getTime() - 1),
        });
      }

      // Allow the worker a tick to process any pending tasks.
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
