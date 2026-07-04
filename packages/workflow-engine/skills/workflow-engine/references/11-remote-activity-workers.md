# Remote Activity Workers

Run a stage's `execute()` on a **separate, credential-free machine** — no database connection, no root object-store credentials. The orchestrator (kernel + Postgres) owns all state; a remote worker leases tasks, runs the real stage code, writes large outputs directly to object storage **by reference**, and reports back. Provided by the **`@bratsos/workflow-engine-host-remote`** package (driven entirely by the engine's existing suspend/resume machinery — no new DB table).

## When to use this

- A "heavy" stage (video transcoding, ffmpeg/yt-dlp, LLM inference, batch embedding) should run on disposable worker boxes, not in the orchestrator process.
- Workers must hold no standing credentials (untrusted / disposable machines).
- Large binary artifacts must move by reference (object storage), not through the database or the orchestrator's data plane.

Topology: a single trusted orchestrator + a fleet of disposable workers.

## Two wiring models

### 1. Proxy stage (recommended for long stages)

`defineRemoteStage(realStage, orchestratorTransport, opts?)` wraps a stage so it **suspends** immediately (releasing the kernel job lease) and **resumes** when the worker reports. Right for stages that take minutes to hours.

```typescript
import { defineRemoteStage } from "@bratsos/workflow-engine-host-remote";

const workflow = new WorkflowBuilder(...)
  .pipe(defineRemoteStage(heavyStage, oTransport, {
    pollIntervalMs: 5_000,
    maxWaitMs: 3_600_000,
    stageCodeVersion: "v1",   // deploy-safety: match broker + workers
  }))
  .pipe(coreStage)
  .build();
```

### 2. ActivityExecutor port (short stages / in-core routing)

Wire `createRemoteExecutor` into the kernel's `ActivityExecutor` port. The kernel holds the job lease while the executor blocks waiting for the worker. Use `createRoutingExecutor` to send only specific stage IDs remotely; all others run locally.

```typescript
import { createRemoteExecutor } from "@bratsos/workflow-engine-host-remote";
import { createRoutingExecutor } from "@bratsos/workflow-engine/kernel";

const kernel = createKernel({
  ...,
  executor: createRoutingExecutor({
    remote: createRemoteExecutor(oTransport),
    remoteStageIds: ["heavy"],
  }),
});
```

The core `ActivityExecutor` port is backward-compatible: the default `createLocalExecutor()` replicates in-process behavior byte-for-byte, so existing kernels that don't set `executor` are unchanged.

## The worker (separate process / machine)

```typescript
import { createActivityWorker, createHttpWorkerTransport }
  from "@bratsos/workflow-engine-host-remote";

const transport = createHttpWorkerTransport({
  baseUrl: "https://orchestrator.example.com",
  authToken: process.env.BROKER_TOKEN,
});

const worker = createActivityWorker({
  registry: new Map([["heavy", heavyStage]]),  // the REAL stage code — no kernel, no Prisma
  transport,
  workerId: "worker-1",
  stageIds: ["heavy"],
  stageCodeVersion: "v1",

  // Optional (v0.11+):
  onError: (error, { consecutiveFailures }) => {
    // Called whenever processOne() throws (e.g. a permanent lease/version
    // mismatch). Defaults to console.error so failures are never silently
    // swallowed.
    logger.error("activity worker error", { error, consecutiveFailures });
  },
  maxBackoffMs: 30_000, // caps the exponential backoff applied between consecutive failures (default 30_000)
});
worker.start();
```

The worker holds **zero standing credentials** — it receives a presigned URL from the broker for each artifact PUT/GET.

**Cancellation (v0.11+):** the worker's heartbeat loop watches the broker's heartbeat response for a cancel signal (lease fenced/reaped). If it's set, the worker still lets the in-flight activity finish, but skips the presign/report round-trip afterward instead of attempting a doomed report against a lease that's gone.

## The orchestrator side

```typescript
import { Broker, InMemoryBrokerStore, InMemoryObjectStore,
         createBrokerHttpServer, createInProcessTransport } from "@bratsos/workflow-engine-host-remote";

const objectStore = new InMemoryObjectStore();  // swap for createS3BlobStore() in prod
const broker = new Broker({
  store: new InMemoryBrokerStore(),
  presigner: objectStore,           // swap for createS3Presigner() in prod
  clock: { now: () => new Date() },
  stageCodeVersion: "v1",
});

const { orchestrator: oTransport } = createInProcessTransport(broker, objectStore);
const server = createBrokerHttpServer({ broker, objectStore, authToken: process.env.BROKER_TOKEN });
server.listen(3000);
```

## Real S3 / R2 / MinIO artifacts

```typescript
import { createS3Presigner, createS3BlobStore } from "@bratsos/workflow-engine-host-remote";

const presigner = createS3Presigner({ bucket: "my-bucket", region: "us-east-1" });
const blobStore = createS3BlobStore({ bucket: "my-bucket", region: "us-east-1" });

const broker = new Broker({ ..., presigner });
const kernel = createKernel({ ..., blobStore });
```

Workers PUT blobs directly to S3/R2 via the presigned URL — the broker server is never a data-plane proxy. Binary artifacts (video/audio) round-trip byte-for-byte. The broker bearer token is never sent to the object store.

## Durability & safety

- **No new DB table / no migration**: the engine's `SUSPENDED` `WorkflowStage` row + a claim-checked payload are the durable anchor; the in-memory broker rehydrates on poll, with the absolute deadline preserved across restarts.
- **Durable reports**: the worker writes its outcome to a deterministic blob key before calling `report()`; on orchestrator restart the proxy recovers the outcome without re-running the activity.
- **Lease renewal / heartbeat**: workers heartbeat while running; the broker's stale-lease sweep re-leases tasks from crashed workers.
- **Deploy safety**: set the same `stageCodeVersion` on `defineRemoteStage`, the broker, and the workers. After a deploy bumps the version, a task suspended under the old version is failed rather than resumed from a stale report.
- **Output-key boundary**: worker-supplied artifact keys are prefix-validated (confused-deputy prevention).

## Key API

| Export | Package | Purpose |
|--------|---------|---------|
| `defineRemoteStage(real, transport, opts?)` | host-remote | Proxy stage: suspends and resumes through the broker |
| `createActivityWorker(cfg)` | host-remote | Worker loop: lease → run → report. `cfg.onError` (v0.11+) observes loop errors; `cfg.maxBackoffMs` (v0.11+, default 30s) caps retry backoff |
| `createBrokerHttpServer(deps)` | host-remote | HTTP broker server (`/lease`, `/report`, `/heartbeat`, `/presign`, `/blob`) |
| `createHttpWorkerTransport(cfg)` | host-remote | Worker transport over HTTP (bearer auth) |
| `createInProcessTransport(broker, objectStore)` | host-remote | In-process transport for dev/tests |
| `createRemoteExecutor(transport, opts?)` | host-remote | Blocking `ActivityExecutor` implementation |
| `createS3Presigner(cfg)` / `createS3BlobStore(cfg)` | host-remote | S3/R2/MinIO presigner + `BlobStore` |
| `Broker`, `InMemoryBrokerStore`, `InMemoryObjectStore` | host-remote | Scheduler + in-memory stores |
| `ActivityExecutor` (type), `createLocalExecutor`, `createRoutingExecutor` | `@bratsos/workflow-engine/kernel` | Kernel executor port + default + per-stage router |

## Limitations

- No mid-activity cancellation — `execute()` itself is never interrupted; a fenced/reaped lease is only detected between heartbeats, so the worker finishes the activity and (as of v0.11) skips the doomed report rather than sending one, but it does not abort the run in progress.
- Single-part PUT only — objects >5 GB need multipart.
- Single-orchestrator — multi-instance HA needs a shared broker store (Prisma/Redis).
- The S3 path is unit-tested against a permissive fake signer; add a real MinIO/LocalStack round-trip integration test before heavy production use.

See the package README for the full quickstart and API reference, and the cross-process example (`examples/cross-process/`) for a runnable two-process demo (worker in a separate OS process over HTTP).
