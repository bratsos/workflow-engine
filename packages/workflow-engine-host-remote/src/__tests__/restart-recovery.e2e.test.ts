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
 * These tests exercise no-table restart durability: the orchestrator's
 * in-memory broker is wiped (simulating a process restart) and the proxy
 * stage must recover by re-registering the task from a claim-checked payload
 * blob, preserving the original absolute deadline and refusing to resume
 * across an incompatible stage-code-version deploy.
 */
function setup(opts: { stageCodeVersion?: string } = {}) {
  const stageCodeVersion = opts.stageCodeVersion ?? "v1";
  const clock = new FakeClock(new Date(0));
  const os = new InMemoryObjectStore(clock);
  const brokerStore = new InMemoryBrokerStore();
  let broker = new Broker({
    store: brokerStore,
    presigner: os,
    clock,
    stageCodeVersion,
    staleLeaseMs: 60_000,
  });

  // A swappable transport: delegates to whatever broker is current, so a test
  // can replace the broker (e.g. a redeploy with a new code version) after a
  // simulated restart while the orchestrator keeps the same transport wiring.
  const oTransport: OrchestratorTransport = {
    submit: (req) => broker.submit(req),
    poll: (taskId) => broker.poll(taskId),
  };
  const { worker: wTransport } = createInProcessTransport(broker, os);

  const orch = buildOrchestrator(oTransport, os, clock);
  const worker = createActivityWorker({
    registry: new Map([["heavy", heavyStage]]),
    transport: wTransport,
    workerId: "w1",
    stageIds: ["heavy"],
    stageCodeVersion,
  });

  return {
    orch,
    worker,
    get broker() {
      return broker;
    },
    brokerStore,
    os,
    clock,
    /** Simulate a redeploy: swap in a new broker (new code version) sharing the store/os. */
    redeploy(newVersion: string) {
      broker = new Broker({
        store: brokerStore,
        presigner: os,
        clock,
        stageCodeVersion: newVersion,
        staleLeaseMs: 60_000,
      });
    },
  };
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

/** Run create→claim→dequeue→execute→suspend, returning the suspended job + ids. */
async function runToSuspend(
  s: ReturnType<typeof setup>,
  idempotencyKey: string,
  seed: number,
): Promise<{ workflowRunId: string }> {
  const { orch } = s;
  const { workflowRunId } = await orch.kernel.dispatch({
    type: "run.create",
    idempotencyKey,
    workflowId: orch.workflowId,
    input: { seed },
  });
  await orch.kernel.dispatch({ type: "run.claimPending", workerId: "orch" });

  const job = await orch.jobQueue.dequeue();
  expect(job).not.toBeNull();

  const r1 = await orch.kernel.dispatch({
    type: "job.execute",
    workflowRunId,
    workflowId: orch.workflowId,
    stageId: job!.stageId,
    config: {},
  });
  expect(r1.outcome).toBe("suspended");
  await orch.jobQueue.suspend(
    job!.jobId,
    new Date(orch.clock.now().getTime() + 100),
  );
  return { workflowRunId };
}

async function getSuspendedMetadata(
  orch: Orchestrator,
  runId: string,
): Promise<Record<string, unknown>> {
  const stages = await orch.persistence.getStagesByRun(runId);
  const suspended = stages.find((st) => st.status === "SUSPENDED");
  const state = suspended?.suspendedState as
    | { batchId: string; metadata?: Record<string, unknown> }
    | undefined;
  if (!state) throw new Error("no suspended stage found");
  return { batchId: state.batchId, ...(state.metadata ?? {}) };
}

describe("remote activity workers — restart recovery (no-table durability)", () => {
  it("Test 1: recovers from a broker restart by re-registering from the payload blob", async () => {
    const s = setup();
    const { orch, worker, brokerStore, os } = s;

    const { workflowRunId } = await runToSuspend(s, "k-recover", 3);

    // Revision 6: the claim-checked payload blob exists BEFORE the restart.
    const meta = await getSuspendedMetadata(orch, workflowRunId);
    const payloadKey = meta.payloadKey as string;
    expect(payloadKey).toBeTruthy();
    expect(await os.has(payloadKey)).toBe(true);

    // Capture the original artifactPrefix from the broker before the restart.
    const taskId = meta.taskId as string;
    const originalTask = await brokerStore.get(taskId);
    const originalArtifactPrefix = originalTask?.artifactPrefix;
    expect(originalArtifactPrefix).toBeTruthy();

    // Simulate orchestrator restart: the in-memory broker loses all tasks.
    brokerStore.clear();

    // First poll after restart: checkCompletion sees "unknown", re-registers,
    // and keeps the stage SUSPENDED (not ready, not failed).
    await makeStageResumable(orch, workflowRunId);
    const poll1 = await orch.kernel.dispatch({ type: "stage.pollSuspended" });
    expect(poll1.failed).toBe(0);
    expect(poll1.resumed).toBe(0);

    // The re-registered task now exists in the broker again.
    expect(await brokerStore.get(taskId)).not.toBeNull();

    // Revision 5: the re-registered task must carry the ORIGINAL artifactPrefix
    // so artifacts written after recovery land under the same prefix.
    const reregisteredTask = await brokerStore.get(taskId);
    expect(reregisteredTask?.artifactPrefix).toBe(originalArtifactPrefix);

    // Worker picks up the re-registered task and completes it.
    expect(await worker.processOne()).toBe(true);

    // Second poll: reported → ready → stage resumes.
    await makeStageResumable(orch, workflowRunId);
    const poll2 = await orch.kernel.dispatch({ type: "stage.pollSuspended" });
    expect(poll2.resumed).toBe(1);

    // Advance to the core stage and finish the run.
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

  it("Test 2: preserves the absolute deadline across a restart (re-register does not reset it)", async () => {
    const s = setup();
    const { orch, brokerStore } = s;

    const { workflowRunId } = await runToSuspend(s, "k-deadline", 2);

    const meta = await getSuspendedMetadata(orch, workflowRunId);
    const taskId = meta.taskId as string;
    const originalDeadlineAt = meta.deadlineAt as number;
    expect(typeof originalDeadlineAt).toBe("number");

    // Advance the clock well past the original submit time but still before the
    // deadline — a naive re-register would compute now + maxWaitTime here.
    s.clock.advance(30_000);

    brokerStore.clear();
    await makeStageResumable(orch, workflowRunId);
    const poll1 = await orch.kernel.dispatch({ type: "stage.pollSuspended" });
    expect(poll1.failed).toBe(0);
    expect(poll1.resumed).toBe(0);

    // The re-registered task must carry the ORIGINAL absolute deadline.
    const task = await brokerStore.get(taskId);
    expect(task).not.toBeNull();
    expect(task!.deadline).toBe(originalDeadlineAt);
  });

  it("Test 2b: an expired deadline fails the run instead of re-registering forever", async () => {
    const s = setup();
    const { orch, brokerStore } = s;

    const { workflowRunId } = await runToSuspend(s, "k-expired", 2);

    // Push the clock past the original absolute deadline (submittedAt + maxWaitMs).
    // 60_001 > maxWaitMs (60_000) defined in the fixture's heavyStage / buildOrchestrator.
    s.clock.advance(60_001);

    brokerStore.clear();

    // B1: With the deadline pre-check, the first poll immediately fails the run
    // (no re-registration round-trip needed — the proxy detects the expired
    // deadline before any I/O and returns the terminal error directly).
    await makeStageResumable(orch, workflowRunId);
    const poll1 = await orch.kernel.dispatch({ type: "stage.pollSuspended" });
    expect(poll1.resumed).toBe(0);
    expect(poll1.failed).toBe(1);

    const run = await orch.persistence.getRun(workflowRunId);
    expect(run?.status).toBe("FAILED");
    const stages = await orch.persistence.getStagesByRun(workflowRunId);
    const failed = stages.find((st) => st.status === "FAILED");
    expect(failed?.errorMessage).toMatch(/deadline exceeded/i);
  });

  it("Test 1b: missing payload blob fails the run with a clear error (Fix 1)", async () => {
    const s = setup();
    const { orch, brokerStore, os } = s;

    const { workflowRunId } = await runToSuspend(s, "k-missing-payload", 2);

    const meta = await getSuspendedMetadata(orch, workflowRunId);
    const payloadKey = meta.payloadKey as string;

    // Wipe the broker AND the payload blob — unrecoverable state.
    brokerStore.clear();
    await os.delete(payloadKey);

    // The first poll should fail the run cleanly (not hang/stay suspended).
    await makeStageResumable(orch, workflowRunId);
    const poll1 = await orch.kernel.dispatch({ type: "stage.pollSuspended" });
    expect(poll1.failed).toBe(1);
    expect(poll1.resumed).toBe(0);

    const run = await orch.persistence.getRun(workflowRunId);
    expect(run?.status).toBe("FAILED");
    const stages = await orch.persistence.getStagesByRun(workflowRunId);
    const failed = stages.find((st) => st.status === "FAILED");
    expect(failed?.errorMessage).toMatch(/payload missing/i);
  });

  it("Test 3: a stage-code-version change during suspension fails the run", async () => {
    const s = setup({ stageCodeVersion: "v1" });
    const { orch, brokerStore } = s;

    const { workflowRunId } = await runToSuspend(s, "k-version", 2);

    const meta = await getSuspendedMetadata(orch, workflowRunId);
    expect(meta.stageCodeVersion).toBe("v1");

    // Simulate a redeploy with a new code version, then restart (empty broker).
    brokerStore.clear();
    s.redeploy("v2");

    // checkCompletion re-registers with pinnedVersion "v1" against a broker on
    // "v2" → the broker creates the task in FAILED state.
    await makeStageResumable(orch, workflowRunId);
    const poll1 = await orch.kernel.dispatch({ type: "stage.pollSuspended" });
    // The re-register itself does not fail the run; the next poll observes FAILED.
    expect(poll1.resumed).toBe(0);

    await makeStageResumable(orch, workflowRunId);
    const poll2 = await orch.kernel.dispatch({ type: "stage.pollSuspended" });
    expect(poll2.failed).toBe(1);

    const run = await orch.persistence.getRun(workflowRunId);
    expect(run?.status).toBe("FAILED");
    const stages = await orch.persistence.getStagesByRun(workflowRunId);
    const failed = stages.find((st) => st.status === "FAILED");
    expect(failed?.errorMessage).toMatch(/version changed/i);
  });
});
