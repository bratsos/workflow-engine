/**
 * remote-executor.e2e.test.ts
 *
 * Proves that RemoteExecutor (ActivityExecutor port) enables remote stage
 * execution WITHOUT a proxy stage. The kernel uses the real heavyStage
 * definition directly, but the executor ships it to the worker via the broker.
 *
 * Both stages run via RemoteExecutor (the kernel's injected executor). The
 * worker is registered for both "heavy" and "core" stages. This proves the
 * port end-to-end: the kernel dispatches stage execution through the
 * ActivityExecutor port, which routes to the worker via the broker.
 */
import { WorkflowBuilder } from "@bratsos/workflow-engine";
import { createKernel } from "@bratsos/workflow-engine/kernel";
import {
  CollectingEventSink,
  FakeClock,
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
import { createRemoteExecutor } from "../orchestrator/remote-executor.js";
import { createInProcessTransport } from "../transport.js";
import { type RemoteStage } from "../worker/run-activity.js";
import { createActivityWorker } from "../worker/worker.js";
import { heavyStage, makeCoreStage } from "./fixtures.js";

describe("remote-executor e2e — ActivityExecutor port (no proxy stage)", () => {
  it("runs heavyStage on remote worker via port, coreStage in-process, run completes with doubled=6", async () => {
    // ------------------------------------------------------------------ setup
    const clock = new FakeClock(new Date(0));
    const objectStore = new InMemoryObjectStore(clock);

    const broker = new Broker({
      store: new InMemoryBrokerStore(),
      presigner: objectStore,
      clock,
      stageCodeVersion: "v1",
      staleLeaseMs: 60_000,
    });

    const { orchestrator: orchestratorTransport, worker: workerTransport } =
      createInProcessTransport(broker, objectStore);

    // coreStage captures objectStore; runs on worker side using the same instance
    const coreStage = makeCoreStage(objectStore);

    // Worker: both stages registered. heavyStage writes artifacts via scoped
    // storage; coreStage reads from the shared objectStore via its closure.
    const workerId = "remote-worker-1";
    const worker = createActivityWorker({
      registry: new Map<string, RemoteStage>([
        ["heavy", heavyStage],
        ["core", coreStage],
      ]),
      transport: workerTransport,
      workerId,
      stageIds: ["heavy", "core"],
      stageCodeVersion: "v1",
      idleDelayMs: 5,
    });
    worker.start();

    // Kernel: RemoteExecutor injected as the ActivityExecutor port.
    // All stages are dispatched through the port to the worker.
    const persistence = new InMemoryWorkflowPersistence();
    const jobQueue = new InMemoryJobQueue();

    const workflow = new WorkflowBuilder(
      "media-port",
      "Media",
      "",
      z.object({ seed: z.number() }),
      z.object({ doubled: z.number() }),
    )
      .pipe(heavyStage)
      .pipe(coreStage)
      .build();

    const executor = createRemoteExecutor(orchestratorTransport, {
      pollIntervalMs: 100,
      maxWaitMs: 60_000,
      pollEveryMs: 5,
    });

    const kernel = createKernel({
      persistence,
      blobStore: objectStore,
      jobTransport: jobQueue,
      eventSink: new CollectingEventSink(),
      scheduler: new NoopScheduler(),
      clock,
      registry: {
        getWorkflow: (id: string) =>
          id === "media-port" ? workflow : undefined,
      },
      executor,
    });

    // ----------------------------------------------------------------- drive
    const { workflowRunId } = await kernel.dispatch({
      type: "run.create",
      idempotencyKey: "port-e2e-k1",
      workflowId: "media-port",
      input: { seed: 3 },
    });

    await kernel.dispatch({ type: "run.claimPending", workerId: "orch" });

    // --- Group 0: heavyStage — runs remotely via RemoteExecutor (blocking) ---
    const job1 = await jobQueue.dequeue();
    expect(job1).not.toBeNull();
    expect(job1!.stageId).toBe("heavy");

    const r1 = await kernel.dispatch({
      type: "job.execute",
      workflowRunId,
      workflowId: "media-port",
      stageId: job1!.stageId,
      config: {},
    });
    // RemoteExecutor blocks until the worker reports → comes back completed
    expect(r1.outcome).toBe("completed");
    await jobQueue.complete(job1!.jobId);

    await kernel.dispatch({ type: "run.transition", workflowRunId });

    // --- Group 1: coreStage — also runs via RemoteExecutor (blocking) ---
    const job2 = await jobQueue.dequeue();
    expect(job2).not.toBeNull();
    expect(job2!.stageId).toBe("core");

    const r2 = await kernel.dispatch({
      type: "job.execute",
      workflowRunId,
      workflowId: "media-port",
      stageId: job2!.stageId,
      config: {},
    });
    expect(r2.outcome).toBe("completed");
    await jobQueue.complete(job2!.jobId);

    const t = await kernel.dispatch({ type: "run.transition", workflowRunId });
    expect(t.action).toBe("completed");

    // ---------------------------------------------------------------- assert
    const run = await persistence.getRun(workflowRunId);
    expect(run?.status).toBe("COMPLETED");
    // seed 3 → array of 3 items → doubled = 6
    expect((run?.output as { doubled: number }).doubled).toBe(6);

    // The heavy stage's artifact was written by the WORKER to the shared objectStore.
    // The worker stores blobs under: remote-activity/{runId}/heavy/{taskId}/blob.json
    // Verify that the remote artifact blob exists in the objectStore.
    const remoteArtifactKeys = await objectStore.list(
      `remote-activity/${workflowRunId}/heavy/`,
    );
    expect(remoteArtifactKeys.length).toBeGreaterThan(0);
    // Load the blob and verify its contents
    const blob = await objectStore.get(remoteArtifactKeys[0]!);
    expect(blob).toBeDefined();
    expect((blob as { data: unknown[] }).data).toHaveLength(3);

    worker.stop();
  }, 30_000); // blocking RemoteExecutor polls via real setTimeout — allow generous time
});
