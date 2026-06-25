/**
 * Cross-process orchestrator — main entrypoint.
 *
 * Proves that a worker on a SEPARATE OS process can talk to the orchestrator
 * over HTTP. The orchestrator:
 *   1. Starts an in-memory broker + BlobStore + HTTP broker server.
 *   2. Spawns worker.ts as a child process via tsx.
 *   3. Drives the workflow to COMPLETED through the standard kernel drive loop.
 *   4. Logs `doubled=...` and exits (kills the worker child first).
 *
 * Run:
 *   pnpm dlx tsx examples/cross-process/orchestrator.ts
 *   # or from the package root:
 *   tsx examples/cross-process/orchestrator.ts
 *
 * The worker process is spawned automatically — no separate terminal needed.
 */

import { spawn } from "node:child_process";
import * as http from "node:http";
import { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
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
import { z } from "zod";
import { Broker } from "../../src/broker/broker.js";
import { InMemoryBrokerStore } from "../../src/broker/store.js";
import { InMemoryObjectStore } from "../../src/object-store.js";
import { defineRemoteStage } from "../../src/orchestrator/define-remote-stage.js";
import { createInProcessTransport } from "../../src/transport.js";
import { createBrokerHttpServer } from "../../src/transport/http/broker-server.js";
import { makeCoreStage, heavyStage } from "./shared-stages.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const AUTH_TOKEN = "cross-process-secret";
const WORKFLOW_ID = "cross-process-demo";
const SEED = 4;

async function main(): Promise<void> {
  // --- 1. In-memory infrastructure ---
  const clock = new FakeClock(new Date(0));
  const objectStore = new InMemoryObjectStore(clock);
  const broker = new Broker({
    store: new InMemoryBrokerStore(),
    presigner: objectStore,
    clock,
    stageCodeVersion: "v1",
    staleLeaseMs: 60_000,
  });

  // Orchestrator uses in-process transport (no HTTP hop for the orchestrator side).
  const { orchestrator: oTransport } = createInProcessTransport(broker, objectStore);

  // Core stage reads the artifact the worker wrote over HTTP.
  const coreStage = makeCoreStage(objectStore);

  const workflow = new WorkflowBuilder(
    WORKFLOW_ID,
    "Cross-Process Demo",
    "Heavy stage on worker + core stage on orchestrator",
    z.object({ seed: z.number() }),
    z.object({ doubled: z.number() }),
  )
    .pipe(
      defineRemoteStage(heavyStage, oTransport, {
        pollIntervalMs: 200,
        maxWaitMs: 30_000,
        // Match the broker + worker stageCodeVersion. This enables the
        // deploy-safety gate: after a deploy that bumps the version, a
        // suspended task's durable report from the old version is NOT
        // completed — the run fails rather than running stale output.
        stageCodeVersion: "v1",
      }),
    )
    .pipe(coreStage)
    .build();

  const persistence = new InMemoryWorkflowPersistence();
  const jobQueue = new InMemoryJobQueue();

  const kernel = createKernel({
    persistence,
    blobStore: objectStore,
    jobTransport: jobQueue,
    eventSink: new CollectingEventSink(),
    scheduler: new NoopScheduler(),
    clock,
    registry: {
      getWorkflow: (id: string) => (id === WORKFLOW_ID ? workflow : undefined),
    },
  });

  // --- 2. HTTP broker server (the worker connects to this) ---
  const server: http.Server = createBrokerHttpServer({
    broker,
    objectStore,
    authToken: AUTH_TOKEN,
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const brokerUrl = `http://127.0.0.1:${port}`;
  console.log(`[orchestrator] HTTP broker listening at ${brokerUrl}`);

  // --- 3. Spawn worker.ts in a separate OS process ---
  const workerPath = join(__dirname, "worker.ts");
  const child = spawn(
    "pnpm",
    ["dlx", "tsx", workerPath, brokerUrl, AUTH_TOKEN, "cross-worker-1"],
    {
      stdio: "inherit",
      shell: false,
    },
  );
  child.on("error", (err) => {
    console.error("[orchestrator] Failed to spawn worker:", err.message);
  });
  console.log(`[orchestrator] Worker spawned (pid=${child.pid})`);

  // Give the worker a moment to connect before we start dispatching work.
  await new Promise<void>((resolve) => setTimeout(resolve, 300));

  // --- 4. Drive the workflow ---
  const { workflowRunId } = await kernel.dispatch({
    type: "run.create",
    idempotencyKey: `cross-process-${Date.now()}`,
    workflowId: WORKFLOW_ID,
    input: { seed: SEED },
  });
  console.log(`[orchestrator] Run created: ${workflowRunId}`);

  await kernel.dispatch({ type: "run.claimPending", workerId: "orch" });

  const isTerminal = (s?: string): boolean =>
    s === "COMPLETED" || s === "FAILED" || s === "CANCELLED";
  const deadline = Date.now() + 30_000;

  while (Date.now() < deadline) {
    const current = await persistence.getRun(workflowRunId);
    if (isTerminal(current?.status)) break;

    const job = await jobQueue.dequeue();

    if (job) {
      console.log(`[orchestrator] Executing stage: ${job.stageId}`);
      const result = await kernel.dispatch({
        type: "job.execute",
        workflowRunId,
        workflowId: WORKFLOW_ID,
        stageId: job.stageId,
        config: {},
      });

      if (result.outcome === "completed") {
        await jobQueue.complete(job.jobId);
        await kernel.dispatch({ type: "run.transition", workflowRunId });
      } else if (result.outcome === "suspended") {
        // The proxy (heavy) stage is suspended; the worker picks it up over HTTP.
        console.log(`[orchestrator] Stage ${job.stageId} suspended — waiting for worker...`);
        await jobQueue.suspend(
          job.jobId,
          new Date(clock.now().getTime() + 200),
        );
      } else {
        console.error(`[orchestrator] Stage ${job.stageId} failed: ${result.error}`);
        break;
      }
    } else {
      // No job ready — suspended stage is waiting for the worker to report.
      // Back-date nextPollAt so stage.pollSuspended picks it up.
      const stages = await persistence.getStagesByRun(workflowRunId);
      const suspended = stages.find((s) => s.status === "SUSPENDED");
      if (suspended) {
        await persistence.updateStage(suspended.id, {
          nextPollAt: new Date(clock.now().getTime() - 1),
        });
      }

      await new Promise<void>((resolve) => setTimeout(resolve, 50));

      const poll = await kernel.dispatch({ type: "stage.pollSuspended" });
      if (poll.resumed > 0) {
        console.log(`[orchestrator] Suspended stage resumed (resumed=${poll.resumed})`);
        await kernel.dispatch({ type: "run.transition", workflowRunId });
      }
    }
  }

  // --- 5. Shut down worker and server ---
  child.kill("SIGTERM");
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });

  // --- 6. Print result ---
  const run = await persistence.getRun(workflowRunId);
  if (run?.status === "COMPLETED") {
    const output = run.output as { doubled: number };
    console.log(
      `[orchestrator] Run COMPLETED. seed=${SEED} → doubled=${output.doubled}`,
    );
    // doubled should be seed * 2 = 8 for seed=4
  } else {
    console.error(`[orchestrator] Run did not complete. status=${run?.status}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
