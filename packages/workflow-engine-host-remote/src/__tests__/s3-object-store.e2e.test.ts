/**
 * E2E test: S3-compatible object store with a fake in-process S3 server.
 *
 * The fake-S3 server stores PUT bodies keyed by URL path, serves GET/HEAD,
 * handles list-type=2 XML responses, and DELETE — IGNORING the SigV4 signature
 * (permissive). Signature correctness is covered by the unit test in
 * s3-presigner.test.ts and by aws4fetch itself.
 *
 * This test proves:
 *   1. createS3BlobStore round-trip: put → get → has → list → delete
 *   2. Full workflow (proxy heavyStage → core stage) drives to COMPLETED with
 *      doubled === 6 and the artifact lives in fake-S3 at the expected key
 *      (NOT in the in-memory double-hop /blob route).
 *
 * What it does NOT prove (needs a real S3/R2/MinIO integration test):
 *   - Actual SigV4 signature acceptance by a real store
 *   - Streaming / large-object limits
 *   - Content-Type enforcement by a real store
 *   - Session-token / IAM-role flows
 */
import * as http from "node:http";
import type { AddressInfo } from "node:net";
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
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { Broker } from "../broker/broker.js";
import { InMemoryBrokerStore } from "../broker/store.js";
import { createS3BlobStore } from "../object-store/s3/s3-blob-store.js";
import { createS3Presigner } from "../object-store/s3/s3-presigner.js";
import { defineRemoteStage } from "../orchestrator/define-remote-stage.js";
import { createBrokerHttpServer } from "../transport/http/broker-server.js";
import { createHttpWorkerTransport } from "../transport/http/worker-client.js";
import type { OrchestratorTransport } from "../transport.js";
import { createActivityWorker } from "../worker/worker.js";
import type { Orchestrator } from "./fixtures.js";
import { heavyStage, makeCoreStage } from "./fixtures.js";

// ---------------------------------------------------------------------------
// Fake-S3 server (permissive — ignores signatures)
// ---------------------------------------------------------------------------

interface FakeS3Server {
  baseUrl: string;
  bucket: string;
  getObject(path: string): Buffer | undefined;
  hasObject(path: string): boolean;
  allKeys(prefix?: string): string[];
  close(): Promise<void>;
}

function startFakeS3(bucket: string): Promise<FakeS3Server> {
  const store = new Map<string, Buffer>();

  const server = http.createServer((req, res) => {
    const rawUrl = req.url ?? "/";

    // Strip query string for path extraction; preserve for list detection.
    const qIdx = rawUrl.indexOf("?");
    const rawPath = qIdx === -1 ? rawUrl : rawUrl.slice(0, qIdx);
    const qs = qIdx === -1 ? "" : rawUrl.slice(qIdx + 1);
    const params = new URLSearchParams(qs);

    // LIST: GET /bucket?list-type=2&prefix=...
    if (
      req.method === "GET" &&
      rawPath === `/${bucket}` &&
      params.get("list-type") === "2"
    ) {
      const prefix = params.get("prefix") ?? "";
      const keys = [...store.keys()].filter((k) => k.startsWith(prefix));
      const keyXml = keys
        .map((k) => `<Contents><Key>${k}</Key></Contents>`)
        .join("");
      const xml = `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>${bucket}</Name><Prefix>${prefix}</Prefix><IsTruncated>false</IsTruncated>${keyXml}</ListBucketResult>`;
      res.writeHead(200, { "Content-Type": "application/xml" });
      res.end(xml);
      return;
    }

    // Object path: /bucket/key (strip leading /bucket/)
    const bucketPrefix = `/${bucket}/`;
    if (!rawPath.startsWith(bucketPrefix)) {
      res.writeHead(404);
      res.end();
      return;
    }
    const objectKey = rawPath.slice(bucketPrefix.length);

    if (req.method === "PUT") {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        store.set(objectKey, Buffer.concat(chunks));
        res.writeHead(200);
        res.end();
      });
      return;
    }

    if (req.method === "GET") {
      const data = store.get(objectKey);
      if (!data) {
        res.writeHead(404);
        res.end();
        return;
      }
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Content-Length": String(data.length),
      });
      res.end(data);
      return;
    }

    if (req.method === "HEAD") {
      if (!store.has(objectKey)) {
        res.writeHead(404);
        res.end();
        return;
      }
      res.writeHead(200);
      res.end();
      return;
    }

    if (req.method === "DELETE") {
      store.delete(objectKey);
      res.writeHead(204);
      res.end();
      return;
    }

    res.writeHead(405);
    res.end();
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      const baseUrl = `http://127.0.0.1:${port}`;
      resolve({
        baseUrl,
        bucket,
        getObject: (key) => store.get(key),
        hasObject: (key) => store.has(key),
        allKeys: (prefix = "") =>
          [...store.keys()].filter((k) => k.startsWith(prefix)),
        close: () =>
          new Promise<void>((res, rej) =>
            server.close((e) => (e ? rej(e) : res())),
          ),
      });
    });
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeS3Config(fakeS3: FakeS3Server) {
  return {
    endpoint: fakeS3.baseUrl,
    region: "us-east-1",
    bucket: fakeS3.bucket,
    accessKeyId: "fakeaccesskey",
    secretAccessKey: "fakesecretkey",
    pathStyle: true,
  };
}

// Move the SUSPENDED stage's nextPollAt into the past.
async function makeStageResumable(
  orch: { persistence: InMemoryWorkflowPersistence; clock: FakeClock },
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

// ---------------------------------------------------------------------------
// S3BlobStore round-trip unit test (against fake-S3)
// ---------------------------------------------------------------------------

describe("createS3BlobStore round-trip (fake-S3)", () => {
  let fakeS3: FakeS3Server | null = null;

  afterEach(async () => {
    await fakeS3?.close();
    fakeS3 = null;
  });

  it("put → get → has → list → delete", { timeout: 10_000 }, async () => {
    fakeS3 = await startFakeS3("my-bucket");
    const store = createS3BlobStore(makeS3Config(fakeS3));

    // put
    await store.put("folder/key1.json", { hello: "world" });
    await store.put("folder/key2.json", [1, 2, 3]);

    // get
    expect(await store.get("folder/key1.json")).toEqual({ hello: "world" });
    expect(await store.get("folder/key2.json")).toEqual([1, 2, 3]);
    expect(await store.get("nonexistent.json")).toBeUndefined();

    // has
    expect(await store.has("folder/key1.json")).toBe(true);
    expect(await store.has("nonexistent.json")).toBe(false);

    // list
    const keys = await store.list("folder/");
    expect(keys).toContain("folder/key1.json");
    expect(keys).toContain("folder/key2.json");
    expect(keys).toHaveLength(2);

    // delete
    await store.delete("folder/key1.json");
    expect(await store.has("folder/key1.json")).toBe(false);
    expect(await store.list("folder/")).toEqual(["folder/key2.json"]);
  });
});

// ---------------------------------------------------------------------------
// Full workflow e2e: worker writes DIRECTLY to fake-S3 via presigned URL
// ---------------------------------------------------------------------------

describe("S3 object store — full workflow e2e (worker direct-to-bucket)", () => {
  const teardowns: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const t of teardowns) {
      await t().catch(() => {});
    }
    teardowns.length = 0;
  });

  it(
    "drives workflow to COMPLETED (doubled === 6) with artifact stored in fake-S3",
    { timeout: 15_000 },
    async () => {
      // 1. Start fake-S3 server.
      const fakeS3 = await startFakeS3("workflow-bucket");
      teardowns.push(() => fakeS3.close());

      const s3Cfg = makeS3Config(fakeS3);
      const clock = new FakeClock(new Date(0));

      // 2. Build S3 presigner + blob store.
      const s3Presigner = createS3Presigner(s3Cfg);
      const s3BlobStore = createS3BlobStore(s3Cfg);

      // 3. Broker uses the S3 presigner (returns real http:// URLs → worker hits fake-S3 directly).
      const broker = new Broker({
        store: new InMemoryBrokerStore(),
        presigner: s3Presigner,
        clock,
        stageCodeVersion: "v1",
        staleLeaseMs: 60_000,
      });

      // 4. Orchestrator transport (in-process, broker.submit/poll only).
      //    We do NOT use the in-process worker path — the worker hits real HTTP.
      const oTransport: OrchestratorTransport = {
        submit: (req) => broker.submit(req),
        poll: (taskId) => broker.poll(taskId),
      };

      // 5. Build orchestrator kernel using s3BlobStore.
      const persistence = new InMemoryWorkflowPersistence();
      const jobQueue = new InMemoryJobQueue();
      const coreStage = makeCoreStage(s3BlobStore);

      const workflow = new WorkflowBuilder(
        "media-s3",
        "Media S3",
        "remote heavy + core via S3",
        z.object({ seed: z.number() }),
        z.object({ doubled: z.number() }),
      )
        .pipe(
          defineRemoteStage(heavyStage, oTransport, {
            pollIntervalMs: 100,
            maxWaitMs: 60_000,
          }),
        )
        .pipe(coreStage)
        .build();

      const kernel = createKernel({
        persistence,
        blobStore: s3BlobStore,
        jobTransport: jobQueue,
        eventSink: new CollectingEventSink(),
        scheduler: new NoopScheduler(),
        clock,
        registry: {
          getWorkflow: (id: string) =>
            id === "media-s3" ? workflow : undefined,
        },
      });

      const orch: Orchestrator = {
        kernel,
        persistence,
        jobQueue,
        clock,
        workflowId: "media-s3",
      };

      // 6. Start a REAL broker HTTP server wrapping the broker.
      //    The /blob shim is never invoked for S3 presigned URLs (absolute http://
      //    URLs bypass the shim entirely). We provide a no-op InMemoryObjectStore
      //    stub to satisfy the type while the presigner returns real S3 URLs.
      const { InMemoryObjectStore: IOS } = await import("../object-store.js");
      const noopObjectStore = new IOS(clock);
      const brokerServer = createBrokerHttpServer({
        broker,
        objectStore: noopObjectStore,
      });
      await new Promise<void>((res) =>
        brokerServer.listen(0, "127.0.0.1", res),
      );
      const brokerPort = (brokerServer.address() as AddressInfo).port;
      const brokerBaseUrl = `http://127.0.0.1:${brokerPort}`;
      teardowns.push(
        () =>
          new Promise<void>((res, rej) =>
            brokerServer.close((e) => (e ? rej(e) : res())),
          ),
      );

      // 7. Worker transport connects to the broker via HTTP; blob writes go to fake-S3.
      const wTransport = createHttpWorkerTransport({ baseUrl: brokerBaseUrl });
      const worker = createActivityWorker({
        registry: new Map([["heavy", heavyStage]]),
        transport: wTransport,
        workerId: "s3-worker-1",
        stageIds: ["heavy"],
        stageCodeVersion: "v1",
      });

      // 8. Create + claim the workflow run.
      const { workflowRunId } = await kernel.dispatch({
        type: "run.create",
        idempotencyKey: "s3-e2e-k1",
        workflowId: "media-s3",
        input: { seed: 3 },
      });
      await kernel.dispatch({ type: "run.claimPending", workerId: "orch" });

      // 9. Group 0: proxy heavy stage — suspends.
      const job1 = await jobQueue.dequeue();
      expect(job1).not.toBeNull();

      const r1 = await kernel.dispatch({
        type: "job.execute",
        workflowRunId,
        workflowId: "media-s3",
        stageId: job1!.stageId,
        config: {},
      });
      expect(r1.outcome).toBe("suspended");
      await jobQueue.suspend(
        job1!.jobId,
        new Date(clock.now().getTime() + 100),
      );

      // 10. Worker leases + executes heavy stage — the /presign route returns a real
      //     http://127.0.0.1:<fakeS3port>/... URL (not /blob), so the worker
      //     PUTs the artifact DIRECTLY to fake-S3.
      const processed = await worker.processOne();
      expect(processed).toBe(true);

      // 11. Artifact must now be in fake-S3 (not the in-memory double-hop).
      const fakeKeys = fakeS3.allKeys();
      const artifactKey = fakeKeys.find((k) => k.endsWith("blob.json"));
      expect(artifactKey).toBeDefined();
      const rawBuf = fakeS3.getObject(artifactKey!);
      expect(rawBuf).toBeDefined();
      expect(JSON.parse(rawBuf!.toString())).toEqual({ data: ["x", "x", "x"] });

      // 12. Poll + transition.
      await makeStageResumable(orch, workflowRunId);
      const poll = await kernel.dispatch({ type: "stage.pollSuspended" });
      expect(poll.resumed).toBe(1);
      await kernel.dispatch({ type: "run.transition", workflowRunId });

      // 13. Group 1: core stage reads the artifact from S3 via s3BlobStore.get().
      const job2 = await jobQueue.dequeue();
      expect(job2).not.toBeNull();

      const r2 = await kernel.dispatch({
        type: "job.execute",
        workflowRunId,
        workflowId: "media-s3",
        stageId: job2!.stageId,
        config: {},
      });
      expect(r2.outcome).toBe("completed");
      await jobQueue.complete(job2!.jobId);

      const t = await kernel.dispatch({
        type: "run.transition",
        workflowRunId,
      });
      expect(t.action).toBe("completed");

      // 14. Run COMPLETED, output doubled === 6.
      const run = await persistence.getRun(workflowRunId);
      expect(run?.status).toBe("COMPLETED");
      expect((run?.output as { doubled: number }).doubled).toBe(6);
    },
  );
});
