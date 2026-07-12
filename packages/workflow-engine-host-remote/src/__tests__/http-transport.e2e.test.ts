/**
 * Headline e2e: a REAL broker HTTP server on an ephemeral loopback port,
 * a worker whose transport is createHttpWorkerTransport (all lease/report/
 * presign/blob-PUT cross genuine TCP sockets with real JSON serialization),
 * and an orchestrator using the IN-PROCESS broker (same broker instance the
 * server wraps).
 *
 * Proves that a worker on a separate process/machine can talk to the
 * orchestrator's broker over a genuine network boundary.
 */
import type { AddressInfo } from "node:net";
import { FakeClock } from "@bratsos/workflow-engine/kernel/testing";
import { afterEach, describe, expect, it } from "vitest";
import { Broker } from "../broker/broker.js";
import { InMemoryBrokerStore } from "../broker/store.js";
import { InMemoryObjectStore } from "../object-store.js";
import { createBrokerHttpServer } from "../transport/http/broker-server.js";
import { createHttpWorkerTransport } from "../transport/http/worker-client.js";
import { createInProcessTransport } from "../transport.js";
import { createActivityWorker } from "../worker/worker.js";
import type { Orchestrator } from "./fixtures.js";
import { buildOrchestrator, heavyStage } from "./fixtures.js";

const AUTH_TOKEN = "test-secret-token";

interface TestSetup {
  orch: Orchestrator;
  worker: ReturnType<typeof createActivityWorker>;
  os: InMemoryObjectStore;
  serverClose: () => Promise<void>;
}

function setup(opts: { useAuth?: boolean } = {}): TestSetup {
  const clock = new FakeClock(new Date(0));
  const os = new InMemoryObjectStore(clock);
  const broker = new Broker({
    store: new InMemoryBrokerStore(),
    presigner: os,
    clock,
    stageCodeVersion: "v1",
    staleLeaseMs: 60_000,
  });

  // Orchestrator uses the in-process broker (no HTTP for orchestrator side).
  const { orchestrator: oTransport } = createInProcessTransport(broker, os);
  const orch = buildOrchestrator(oTransport, os, clock);

  const authToken = opts.useAuth ? AUTH_TOKEN : undefined;

  // Start a REAL HTTP server wrapping the same broker + objectStore.
  const server = createBrokerHttpServer({
    broker,
    objectStore: os,
    authToken,
  });

  // Listen on an ephemeral loopback port (OS picks the port, guaranteed unique).
  server.listen(0);
  const { port } = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${port}`;

  // Worker transport communicates with the broker over real HTTP/TCP.
  const wTransport = createHttpWorkerTransport({ baseUrl, authToken });
  const worker = createActivityWorker({
    registry: new Map([["heavy", heavyStage]]),
    transport: wTransport,
    workerId: "http-worker-1",
    stageIds: ["heavy"],
    stageCodeVersion: "v1",
  });

  const serverClose = () =>
    new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });

  return { orch, worker, os, serverClose };
}

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

describe("HTTP transport — broker server + worker client (real network)", () => {
  let teardowns: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const close of teardowns) {
      await close().catch(() => {});
    }
    teardowns = [];
  });

  it("drives a workflow to COMPLETED over a real TCP connection: doubled === 6", {
    timeout: 10_000,
  }, async () => {
    const { orch, worker, os, serverClose } = setup();
    teardowns.push(serverClose);

    // 1. Create + claim the workflow run.
    const { workflowRunId } = await orch.kernel.dispatch({
      type: "run.create",
      idempotencyKey: "http-e2e-k1",
      workflowId: orch.workflowId,
      input: { seed: 3 },
    });
    await orch.kernel.dispatch({
      type: "run.claimPending",
      workerId: "orch",
    });

    // 2. Group 0: the remote (proxy) heavy stage — suspends until worker picks it up.
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

    // 3. Worker executes heavy stage over HTTP — lease + run + report + presign + blob PUT
    //    all cross genuine TCP sockets with real JSON serialization.
    const processed = await worker.processOne();
    expect(processed).toBe(true);

    // 4. Make the stage poll-eligible and poll.
    await makeStageResumable(orch, workflowRunId);
    const poll = await orch.kernel.dispatch({ type: "stage.pollSuspended" });
    expect(poll.resumed).toBe(1);

    // 5. Advance to group 1.
    await orch.kernel.dispatch({ type: "run.transition", workflowRunId });

    // 6. Group 1: in-process core stage reads the artifact the worker wrote via HTTP.
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

    // 7. Final assertions: run COMPLETED, output doubled === 6.
    const run = await orch.persistence.getRun(workflowRunId);
    expect(run?.status).toBe("COMPLETED");
    expect((run?.output as { doubled: number }).doubled).toBe(6);

    // 8. Prove the artifact written by the worker over HTTP is readable by the
    //    orchestrator's blobStore (same InMemoryObjectStore instance).
    //    The heavy stage writes via ctx.storage (scoped storage backed by the
    //    object store). We scan to find the blob the worker wrote over HTTP.
    const allKeys = await os.list("workflow-v2/");
    const blobKey = allKeys.find((k) => k.endsWith("blob.json"));
    expect(blobKey).toBeDefined();
    const blob = await os.get(blobKey!);
    expect(blob).toEqual({ data: ["x", "x", "x"] });
  });

  it("rejects unauthenticated workers when auth is configured", {
    timeout: 5_000,
  }, async () => {
    // Spin up a server with a real token; connect with the wrong token.
    const clock2 = new FakeClock(new Date(0));
    const os2 = new InMemoryObjectStore(clock2);
    const broker2 = new Broker({
      store: new InMemoryBrokerStore(),
      presigner: os2,
      clock: clock2,
      stageCodeVersion: "v1",
    });
    const srv = createBrokerHttpServer({
      broker: broker2,
      objectStore: os2,
      authToken: "real-token",
    });
    srv.listen(0);
    const p = (srv.address() as AddressInfo).port;
    teardowns.push(
      () =>
        new Promise<void>((res, rej) => srv.close((e) => (e ? rej(e) : res()))),
    );

    const badTransport = createHttpWorkerTransport({
      baseUrl: `http://127.0.0.1:${p}`,
      authToken: "wrong-token",
    });

    // A lease attempt with a bad token must throw (server returns 401 → client throws).
    await expect(
      badTransport.lease({
        workerId: "x",
        stageIds: ["heavy"],
        stageCodeVersion: "v1",
      }),
    ).rejects.toThrow();
  });

  it("uses bearer auth when configured and succeeds end-to-end", {
    timeout: 10_000,
  }, async () => {
    const { orch, worker, serverClose } = setup({ useAuth: true });
    teardowns.push(serverClose);

    const { workflowRunId } = await orch.kernel.dispatch({
      type: "run.create",
      idempotencyKey: "http-e2e-auth-k1",
      workflowId: orch.workflowId,
      input: { seed: 2 },
    });
    await orch.kernel.dispatch({
      type: "run.claimPending",
      workerId: "orch",
    });

    const job = await orch.jobQueue.dequeue();
    expect(job).not.toBeNull();
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

    // Worker with correct bearer token succeeds.
    expect(await worker.processOne()).toBe(true);

    await makeStageResumable(orch, workflowRunId);
    await orch.kernel.dispatch({ type: "stage.pollSuspended" });
    await orch.kernel.dispatch({ type: "run.transition", workflowRunId });

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
    // seed 2 → array of 2 items → doubled = 4
    expect((run?.output as { doubled: number }).doubled).toBe(4);
  });
});
