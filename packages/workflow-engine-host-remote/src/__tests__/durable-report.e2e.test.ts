import { defineStage } from "@bratsos/workflow-engine";
import { WorkflowBuilder } from "@bratsos/workflow-engine";
import { createKernel } from "@bratsos/workflow-engine/kernel";
import { FakeClock } from "@bratsos/workflow-engine/kernel/testing";
import {
  CollectingEventSink,
  NoopScheduler,
} from "@bratsos/workflow-engine/kernel/testing";
import {
  InMemoryJobQueue,
  InMemoryWorkflowPersistence,
} from "@bratsos/workflow-engine/testing";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { Broker } from "../broker/broker.js";
import { InMemoryBrokerStore } from "../broker/store.js";
import { InMemoryObjectStore } from "../object-store.js";
import { defineRemoteStage } from "../orchestrator/define-remote-stage.js";
import type { OrchestratorTransport } from "../transport.js";
import { createInProcessTransport } from "../transport.js";
import { createActivityWorker } from "../worker/worker.js";
import { buildOrchestrator, makeCoreStage } from "./fixtures.js";

/**
 * Durable-report recovery: a completed activity's outcome survives an
 * orchestrator restart WITHOUT re-running the expensive work.
 *
 * Sequence:
 *  1. run → suspend (broker registers task; SUSPENDED stage saved)
 *  2. worker.processOne() — heavy stage runs ONCE, writes durable report to
 *     object storage, then calls broker.report()
 *  3. Simulate restart: brokerStore.clear() wipes all in-memory broker state
 *     (the REPORTED task is gone) — NO additional worker invocation
 *  4. poll → checkCompletion finds the durable report in object storage →
 *     stage resumes from it
 *  5. Run reaches COMPLETED with doubled === 6, heavy stage ran exactly ONCE
 */
describe("durable reports — completed work survives an orchestrator restart", () => {
  it("checkCompletion recovers the durable report; heavy stage runs exactly once", async () => {
    let heavyRunCount = 0;

    // A counted heavy stage — we assert it runs exactly once.
    const countedHeavyStage = defineStage({
      id: "heavy",
      name: "Heavy",
      schemas: {
        input: z.object({ seed: z.number() }),
        output: z.object({ artifactKey: z.string(), size: z.number() }),
        config: z.object({}),
      },
      async execute(ctx) {
        heavyRunCount++;
        const key = ctx.storage.getStageKey("heavy", "blob.json");
        const payload = { data: new Array(ctx.input.seed).fill("x") };
        await ctx.storage.save(key, payload);
        return { output: { artifactKey: key, size: payload.data.length } };
      },
    });

    const clock = new FakeClock(new Date(0));
    const os = new InMemoryObjectStore(clock);
    const brokerStore = new InMemoryBrokerStore();
    let broker = new Broker({
      store: brokerStore,
      presigner: os,
      clock,
      staleLeaseMs: 60_000,
    });

    const oTransport: OrchestratorTransport = {
      submit: (req) => broker.submit(req),
      poll: (taskId) => broker.poll(taskId),
    };
    const { worker: wTransport } = createInProcessTransport(broker, os);

    // Build an orchestrator with our counted heavy stage.
    const persistence = new InMemoryWorkflowPersistence();
    const jobQueue = new InMemoryJobQueue();
    const coreStage = makeCoreStage(os);
    const remoteHeavy = defineRemoteStage(countedHeavyStage, oTransport, {
      pollIntervalMs: 100,
      maxWaitMs: 60_000,
      _clock: () => clock.now().getTime(),
    });
    const workflow = new WorkflowBuilder(
      "media",
      "Media",
      "remote heavy + core",
      z.object({ seed: z.number() }),
      z.object({ doubled: z.number() }),
    )
      .pipe(remoteHeavy)
      .pipe(coreStage)
      .build();

    const kernel = createKernel({
      persistence,
      blobStore: os,
      jobTransport: jobQueue,
      eventSink: new CollectingEventSink(),
      scheduler: new NoopScheduler(),
      clock,
      registry: {
        getWorkflow: (id: string) => (id === "media" ? workflow : undefined),
      },
    });

    // ── Step 1: run → suspend ──────────────────────────────────────────────
    const { workflowRunId } = await kernel.dispatch({
      type: "run.create",
      idempotencyKey: "k-durable-report",
      workflowId: "media",
      input: { seed: 3 },
    });
    await kernel.dispatch({ type: "run.claimPending", workerId: "orch" });
    const job1 = await jobQueue.dequeue();
    expect(job1).not.toBeNull();
    const r1 = await kernel.dispatch({
      type: "job.execute",
      workflowRunId,
      workflowId: "media",
      stageId: job1!.stageId,
      config: {},
    });
    expect(r1.outcome).toBe("suspended");
    await jobQueue.suspend(job1!.jobId, new Date(clock.now().getTime() + 100));

    // Heavy stage has not run yet (it runs in the worker, not the orchestrator).
    expect(heavyRunCount).toBe(0);

    // ── Step 2: worker runs the heavy stage ONCE ───────────────────────────
    const worker = createActivityWorker({
      registry: new Map([["heavy", countedHeavyStage]]),
      transport: wTransport,
      workerId: "w1",
      stageIds: ["heavy"],
      stageCodeVersion: "v1",
    });

    const didWork = await worker.processOne();
    expect(didWork).toBe(true);
    expect(heavyRunCount).toBe(1);

    // The durable report must now be in object storage.
    // Derive the key the same way the worker does:
    //   grant.prefix = <artifactPrefix>/<taskId>/
    //   durable report key = <grant.prefix>report.json
    // We can verify by checking the broker — the task is now REPORTED.
    // But to confirm the durable key exists, we look at the brokerStore task
    // to get the artifactPrefix and taskId.
    const allStages = await persistence.getStagesByRun(workflowRunId);
    const suspendedStage = allStages.find((s) => s.status === "SUSPENDED");
    const suspendedMeta = suspendedStage?.suspendedState as
      | {
          batchId: string;
          metadata?: { taskId?: string };
        }
      | undefined;
    const taskId = suspendedMeta?.metadata?.taskId ?? suspendedMeta?.batchId;
    expect(taskId).toBeTruthy();

    const taskRecord = await brokerStore.get(taskId!);
    expect(taskRecord?.status).toBe("REPORTED");
    const artifactPrefix = taskRecord?.artifactPrefix;
    expect(artifactPrefix).toBeTruthy();

    const durableReportKey = `${artifactPrefix}/${taskId}/report.json`;
    expect(await os.has(durableReportKey)).toBe(true);

    // ── Step 3: simulate restart — wipe broker state (REPORTED task gone) ──
    brokerStore.clear();
    // Confirm the task is now unknown.
    const pollAfterClear = await broker.poll(taskId!);
    expect(pollAfterClear.state).toBe("unknown");

    // ── Step 4: poll → checkCompletion finds the durable report ───────────
    // Make the stage resumable (move nextPollAt into the past).
    const stages = await persistence.getStagesByRun(workflowRunId);
    const suspended = stages.find((s) => s.status === "SUSPENDED");
    expect(suspended).not.toBeUndefined();
    await persistence.updateStage(suspended!.id, {
      nextPollAt: new Date(clock.now().getTime() - 1),
    });

    // No worker invocation here — checkCompletion should find the durable report.
    const poll1 = await kernel.dispatch({ type: "stage.pollSuspended" });

    // With durable report: the stage resumes immediately (not re-registered).
    expect(poll1.resumed).toBe(1);
    expect(poll1.failed).toBe(0);

    // ── Assert: heavy stage ran exactly once ──────────────────────────────
    expect(heavyRunCount).toBe(1);

    // ── Step 5: finish the run ────────────────────────────────────────────
    await kernel.dispatch({ type: "run.transition", workflowRunId });
    const job2 = await jobQueue.dequeue();
    expect(job2).not.toBeNull();
    const r2 = await kernel.dispatch({
      type: "job.execute",
      workflowRunId,
      workflowId: "media",
      stageId: job2!.stageId,
      config: {},
    });
    expect(r2.outcome).toBe("completed");
    await jobQueue.complete(job2!.jobId);
    await kernel.dispatch({ type: "run.transition", workflowRunId });

    const run = await persistence.getRun(workflowRunId);
    expect(run?.status).toBe("COMPLETED");
    expect((run?.output as { doubled: number }).doubled).toBe(6);

    // Final confirmation: heavy stage still ran only once.
    expect(heavyRunCount).toBe(1);
  });

  it("falls back to re-register when no durable report exists (worker crashed before writing)", async () => {
    let heavyRunCount = 0;

    const countedHeavyStage = defineStage({
      id: "heavy",
      name: "Heavy",
      schemas: {
        input: z.object({ seed: z.number() }),
        output: z.object({ artifactKey: z.string(), size: z.number() }),
        config: z.object({}),
      },
      async execute(ctx) {
        heavyRunCount++;
        const key = ctx.storage.getStageKey("heavy", "blob.json");
        const payload = { data: new Array(ctx.input.seed).fill("x") };
        await ctx.storage.save(key, payload);
        return { output: { artifactKey: key, size: payload.data.length } };
      },
    });

    const clock = new FakeClock(new Date(0));
    const os = new InMemoryObjectStore(clock);
    const brokerStore = new InMemoryBrokerStore();
    const broker = new Broker({
      store: brokerStore,
      presigner: os,
      clock,
      staleLeaseMs: 60_000,
    });

    const oTransport: OrchestratorTransport = {
      submit: (req) => broker.submit(req),
      poll: (taskId) => broker.poll(taskId),
    };
    const { worker: wTransport } = createInProcessTransport(broker, os);
    const orch = buildOrchestrator(oTransport, os, clock);

    // Step 1: run → suspend.
    const { workflowRunId } = await orch.kernel.dispatch({
      type: "run.create",
      idempotencyKey: "k-no-durable-report",
      workflowId: orch.workflowId,
      input: { seed: 3 },
    });
    await orch.kernel.dispatch({ type: "run.claimPending", workerId: "orch" });
    const job1 = await orch.jobQueue.dequeue();
    expect(job1).not.toBeNull();
    const r1 = await orch.kernel.dispatch({
      type: "job.execute",
      workflowRunId,
      workflowId: orch.workflowId,
      stageId: job1!.stageId,
      config: {},
    });
    expect(r1.outcome).toBe("suspended");
    await orch.jobQueue.suspend(
      job1!.jobId,
      new Date(clock.now().getTime() + 100),
    );

    // Simulate a crashed worker: broker has the task PENDING (worker never ran).
    // We just clear the broker to simulate restart without the worker ever reporting.
    brokerStore.clear();

    // Make stage resumable.
    const stages = await orch.persistence.getStagesByRun(workflowRunId);
    const suspended = stages.find((s) => s.status === "SUSPENDED");
    await orch.persistence.updateStage(suspended!.id, {
      nextPollAt: new Date(clock.now().getTime() - 1),
    });

    // poll → unknown → no durable report → re-register (not resumed, not failed).
    const poll1 = await orch.kernel.dispatch({ type: "stage.pollSuspended" });
    expect(poll1.resumed).toBe(0);
    expect(poll1.failed).toBe(0);

    // The task was re-registered.
    const allStages2 = await orch.persistence.getStagesByRun(workflowRunId);
    const suspendedMeta = allStages2.find((s) => s.status === "SUSPENDED")
      ?.suspendedState as
      | { batchId: string; metadata?: { taskId?: string } }
      | undefined;
    const taskId = suspendedMeta?.metadata?.taskId ?? suspendedMeta?.batchId;
    expect(await brokerStore.get(taskId!)).not.toBeNull();

    // Now a worker can pick it up and run the heavy stage (second run is allowed
    // in this fallback path — the durable-report shortcut wasn't available).
    const worker = createActivityWorker({
      registry: new Map([["heavy", countedHeavyStage]]),
      transport: wTransport,
      workerId: "w1",
      stageIds: ["heavy"],
      stageCodeVersion: "v1",
    });
    const did = await worker.processOne();
    expect(did).toBe(true);
    expect(heavyRunCount).toBe(1); // ran once in this scenario (fresh start)

    // Resume and complete.
    await orch.persistence.updateStage(suspended!.id, {
      nextPollAt: new Date(clock.now().getTime() - 1),
    });
    const poll2 = await orch.kernel.dispatch({ type: "stage.pollSuspended" });
    expect(poll2.resumed).toBe(1);
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

  it("corrupt durable report blob falls back to re-register (not complete, not hang)", async () => {
    let heavyRunCount = 0;

    const countedHeavyStage = defineStage({
      id: "heavy",
      name: "Heavy",
      schemas: {
        input: z.object({ seed: z.number() }),
        output: z.object({ artifactKey: z.string(), size: z.number() }),
        config: z.object({}),
      },
      async execute(ctx) {
        heavyRunCount++;
        const key = ctx.storage.getStageKey("heavy", "blob.json");
        const payload = { data: new Array(ctx.input.seed).fill("x") };
        await ctx.storage.save(key, payload);
        return { output: { artifactKey: key, size: payload.data.length } };
      },
    });

    const clock = new FakeClock(new Date(0));
    const os = new InMemoryObjectStore(clock);
    const brokerStore = new InMemoryBrokerStore();
    const broker = new Broker({
      store: brokerStore,
      presigner: os,
      clock,
      staleLeaseMs: 60_000,
    });

    const oTransport: OrchestratorTransport = {
      submit: (req) => broker.submit(req),
      poll: (taskId) => broker.poll(taskId),
    };
    const { worker: wTransport } = createInProcessTransport(broker, os);

    // Build an orchestrator with our counted heavy stage.
    const persistence = new InMemoryWorkflowPersistence();
    const jobQueue = new InMemoryJobQueue();
    const coreStage = makeCoreStage(os);
    const remoteHeavy = defineRemoteStage(countedHeavyStage, oTransport, {
      pollIntervalMs: 100,
      maxWaitMs: 60_000,
      _clock: () => clock.now().getTime(),
    });
    const workflow = new WorkflowBuilder(
      "media-corrupt",
      "Media",
      "remote heavy + core",
      z.object({ seed: z.number() }),
      z.object({ doubled: z.number() }),
    )
      .pipe(remoteHeavy)
      .pipe(coreStage)
      .build();

    const kernel = createKernel({
      persistence,
      blobStore: os,
      jobTransport: jobQueue,
      eventSink: new CollectingEventSink(),
      scheduler: new NoopScheduler(),
      clock,
      registry: {
        getWorkflow: (id: string) =>
          id === "media-corrupt" ? workflow : undefined,
      },
    });

    // Step 1: run → suspend.
    const { workflowRunId } = await kernel.dispatch({
      type: "run.create",
      idempotencyKey: "k-corrupt-durable-report",
      workflowId: "media-corrupt",
      input: { seed: 3 },
    });
    await kernel.dispatch({ type: "run.claimPending", workerId: "orch" });
    const job1 = await jobQueue.dequeue();
    expect(job1).not.toBeNull();
    const r1 = await kernel.dispatch({
      type: "job.execute",
      workflowRunId,
      workflowId: "media-corrupt",
      stageId: job1!.stageId,
      config: {},
    });
    expect(r1.outcome).toBe("suspended");
    await jobQueue.suspend(job1!.jobId, new Date(clock.now().getTime() + 100));

    // Step 2: worker runs heavy stage (writes durable report + calls broker.report).
    const worker = createActivityWorker({
      registry: new Map([["heavy", countedHeavyStage]]),
      transport: wTransport,
      workerId: "w1",
      stageIds: ["heavy"],
      stageCodeVersion: "v1",
    });

    const didWork = await worker.processOne();
    expect(didWork).toBe(true);
    expect(heavyRunCount).toBe(1);

    // Get the durable report key.
    const allStages = await persistence.getStagesByRun(workflowRunId);
    const suspendedStage = allStages.find((s) => s.status === "SUSPENDED");
    const suspendedMeta = suspendedStage?.suspendedState as
      | { batchId: string; metadata?: { taskId?: string } }
      | undefined;
    const taskId = suspendedMeta?.metadata?.taskId ?? suspendedMeta?.batchId;
    expect(taskId).toBeTruthy();

    const taskRecord = await brokerStore.get(taskId!);
    expect(taskRecord?.status).toBe("REPORTED");
    const artifactPrefix = taskRecord?.artifactPrefix;
    expect(artifactPrefix).toBeTruthy();

    const durableReportKey = `${artifactPrefix}/${taskId}/report.json`;

    // Overwrite the durable report with garbage BEFORE clearing broker state.
    await os.put(durableReportKey, { garbage: true });

    // Step 3: simulate restart — wipe broker state.
    brokerStore.clear();
    const pollAfterClear = await broker.poll(taskId!);
    expect(pollAfterClear.state).toBe("unknown");

    // Make stage resumable.
    const stages = await persistence.getStagesByRun(workflowRunId);
    const suspended = stages.find((s) => s.status === "SUSPENDED");
    await persistence.updateStage(suspended!.id, {
      nextPollAt: new Date(clock.now().getTime() - 1),
    });

    // poll → unknown → corrupt durable report → fall back to re-register.
    const poll1 = await kernel.dispatch({ type: "stage.pollSuspended" });

    // Should NOT have resumed (corrupt blob), should NOT have failed (terminal).
    // Should have fallen back to re-register.
    expect(poll1.resumed).toBe(0);
    expect(poll1.failed).toBe(0);

    // The task should now be re-registered in the broker store.
    const taskAfterFallback = await brokerStore.get(taskId!);
    expect(taskAfterFallback).not.toBeNull();
  });
});
