# @bratsos/workflow-engine-host-remote

Credential-free remote activity workers for `@bratsos/workflow-engine`.

Run any stage's `execute()` on a **separate, credential-free machine** — no database connection, no root object-store credentials. The orchestrator (the existing kernel + Postgres) owns all state; a remote worker leases tasks, runs the real stage code, writes large outputs directly to object storage by reference, and reports back. The engine drives the whole thing through its existing suspend/resume machinery.

## What this package does

A "heavy" stage (CPU-intensive transcoding, LLM inference, batch embedding, etc.) normally runs inside the orchestrator process, holding a database lease while it works. This package lets you move that stage to a disposable remote worker:

1. **Orchestrator side**: wrap the real stage with `defineRemoteStage` (or wire `createRemoteExecutor` into the kernel's `ActivityExecutor` port). The proxy submits work to a broker and returns `{suspended}` immediately.
2. **Worker side**: run `createActivityWorker` with `createHttpWorkerTransport`. It polls for leases, runs the real stage code in a sandboxed context (no kernel / no Prisma), writes large artifacts via presigned URLs, and calls `report()`.
3. **Artifacts**: worker writes blobs to S3/R2/MinIO via presigned PUT. The orchestrator reads them via its own `BlobStore`. For local development, `InMemoryObjectStore` acts as both.

## Installation

```bash
npm install @bratsos/workflow-engine-host-remote
```

## Quickstart — in-process model (dev / tests)

Both orchestrator and worker live in the same process. Use `createInProcessTransport` to wire them directly to a shared `Broker`.

```typescript
import { Broker, InMemoryBrokerStore, InMemoryObjectStore,
         defineRemoteStage, createActivityWorker,
         createInProcessTransport } from "@bratsos/workflow-engine-host-remote";
import { createKernel } from "@bratsos/workflow-engine/kernel";
import { FakeClock } from "@bratsos/workflow-engine/kernel/testing";
import { defineWorkflow } from "@bratsos/workflow-engine";

const clock = new FakeClock(new Date(0));
const objectStore = new InMemoryObjectStore(clock);
const broker = new Broker({
  store: new InMemoryBrokerStore(),
  presigner: objectStore,
  clock,
  stageCodeVersion: "v1",
  staleLeaseMs: 60_000,
});

const { orchestrator: oTransport, worker: wTransport } =
  createInProcessTransport(broker, objectStore);

// On the orchestrator: wrap the real stage in a proxy
const workflow = defineWorkflow({ ... })
  .pipe(defineRemoteStage(myHeavyStage, oTransport))
  .build();

const kernel = createKernel({ ..., blobStore: objectStore, ... });

// On the worker (same process here, separate process in production):
const worker = createActivityWorker({
  registry: new Map([["heavy", myHeavyStage]]),
  transport: wTransport,
  workerId: "w1",
  stageIds: ["heavy"],
  stageCodeVersion: "v1",
});
worker.start();
```

See `examples/end-to-end.ts` for the full running example.

## Quickstart — cross-machine model (production)

### Orchestrator

Start a broker HTTP server. Workers connect to it over the network.

```typescript
import { Broker, InMemoryBrokerStore, InMemoryObjectStore,
         createBrokerHttpServer, createInProcessTransport,
         defineRemoteStage } from "@bratsos/workflow-engine-host-remote";

const objectStore = new InMemoryObjectStore(); // swap for S3BlobStore in prod
const broker = new Broker({
  store: new InMemoryBrokerStore(),
  presigner: objectStore,        // swap for createS3Presigner() in prod
  clock: { now: () => new Date() },
  stageCodeVersion: "v1",
});

const { orchestrator: oTransport } = createInProcessTransport(broker, objectStore);
const server = createBrokerHttpServer({
  broker,
  objectStore,
  authToken: process.env.BROKER_TOKEN, // bearer auth; omit only for local dev
});
server.listen(3000);

// Workflow uses the proxy stage — heavy work runs on remote workers
const workflow = defineWorkflow({ ... })
  .pipe(defineRemoteStage(heavyStage, oTransport, { maxWaitMs: 300_000 }))
  .pipe(coreStage)
  .build();
```

### Remote worker (separate process / machine)

```typescript
import { createActivityWorker, createHttpWorkerTransport }
  from "@bratsos/workflow-engine-host-remote";

const transport = createHttpWorkerTransport({
  baseUrl: "https://orchestrator.example.com",
  authToken: process.env.BROKER_TOKEN,
});

const worker = createActivityWorker({
  registry: new Map([["heavy", heavyStage]]), // real stage — no kernel, no Prisma
  transport,
  workerId: "worker-1",
  stageIds: ["heavy"],
  stageCodeVersion: "v1",
});

worker.start();
```

The worker holds **zero standing credentials** — it receives a presigned URL from the broker for each artifact PUT/GET.

### Real S3/R2/MinIO artifacts

```typescript
import { createS3Presigner, createS3BlobStore }
  from "@bratsos/workflow-engine-host-remote";

// On the orchestrator — use as BlobStore and as broker's presigner
const presigner = createS3Presigner({
  bucket: "my-bucket",
  region: "us-east-1",
  // credentials via standard AWS env vars / instance role
});
const blobStore = createS3BlobStore({
  bucket: "my-bucket",
  region: "us-east-1",
});

const broker = new Broker({ ..., presigner, ... });
const kernel = createKernel({ ..., blobStore, ... });
```

The worker PUTs blobs directly to S3/R2 via the presigned URL — the broker server is never a data-plane proxy for real deployments.

## Executor options

Two patterns for wiring remote execution:

### 1. Proxy stage (recommended for long/suspend-wired stages)

`defineRemoteStage(realStage, orchestratorTransport)` returns a stage that suspends immediately and resumes when the worker reports. The kernel's lease is released while the worker runs. This is the right model for stages that take minutes or hours.

```typescript
workflow.pipe(defineRemoteStage(myHeavyStage, oTransport, {
  pollIntervalMs: 5_000,
  maxWaitMs: 3_600_000,
  // Set the SAME stageCodeVersion you configure on the broker and workers.
  // This enables deploy safety: after a deploy bumps the version, a task
  // suspended under the old version is failed (not resumed from a stale
  // durable report). Omit it to disable version pinning.
  stageCodeVersion: "v1",
}))
```

### 2. ActivityExecutor port (for short stages or the in-core routing model)

Wire `createRemoteExecutor` into the kernel's `ActivityExecutor` port. The kernel holds the job lease while the remote executor blocks waiting for the worker to report. Use `createRoutingExecutor` to send only specific stages remotely.

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

## Cross-process example

`examples/cross-process/orchestrator.ts` is a runnable demo that spawns `worker.ts` as a real child process:

```bash
# From the package directory:
pnpm dlx tsx examples/cross-process/orchestrator.ts
```

The orchestrator spawns the worker via `spawn("pnpm", ["dlx", "tsx", "worker.ts", url, token])`. The worker connects over TCP, leases the "heavy" task, writes its artifact via a presigned `/blob` PUT to the broker's HTTP endpoint, and reports. The orchestrator reads the artifact from the shared `InMemoryObjectStore` and runs the downstream core stage in-process. Output: `doubled=8` (seed 4 → artifact of 4 items → doubled).

## Hosting on other platforms

`createBrokerHttpServer` is a thin `node:http` wrapper around `handleBrokerRequest`, the **platform-agnostic** handler underneath it — same `/lease`, `/report`, `/heartbeat`, `/presign`, `/blob` routing, no `node:http` dependency. To host the broker anywhere else — a Cloudflare Worker, Deno, Bun, an AWS Lambda function URL, or any `Request`/`Response` framework (Express, Fastify, Hono) — call `handleBrokerRequest` directly: adapt the platform's request into an `IncomingRequest`, and adapt the returned `HandlerResponse` back into the platform's response.

For example, wiring it into a Cloudflare Worker `fetch` handler (reusing the `broker` and `objectStore` from the example above):

```typescript
import { handleBrokerRequest, type BrokerServerDeps } from "@bratsos/workflow-engine-host-remote";

const deps: BrokerServerDeps = { broker, objectStore, authToken: process.env.BROKER_TOKEN };

export default {
  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const result = await handleBrokerRequest(deps, {
      method: req.method,
      path: url.pathname + url.search,
      headers: Object.fromEntries(req.headers),
      body: await req.json().catch(() => null), // binary /blob PUTs: populate rawBody instead
    });
    const body = result.binary ?? (result.status === 204 ? null : JSON.stringify(result.json ?? null));
    return new Response(body, { status: result.status });
  },
};
```

## API Reference

| Export | Description |
|--------|-------------|
| `createBrokerHttpServer(deps)` | HTTP server wrapping a broker; exposes `/lease`, `/report`, `/heartbeat`, `/presign`, `/blob` |
| `createHttpWorkerTransport(cfg)` | Worker transport over HTTP; authenticates with bearer token |
| `createInProcessTransport(broker, objectStore)` | In-process transport for dev/tests |
| `defineRemoteStage(real, transport, opts?)` | Proxy stage that suspends and resumes through the broker |
| `createActivityWorker(cfg)` | Worker loop: lease → run → report |
| `createRemoteExecutor(transport, opts?)` | Blocking `ActivityExecutor` port implementation |
| `createRoutingExecutor(opts)` | Routes specific stage IDs to a remote executor |
| `createS3Presigner(cfg)` | Presigner backed by S3/R2/MinIO |
| `createS3BlobStore(cfg)` | `BlobStore` backed by S3/R2/MinIO |
| `Broker` | Activity scheduler (in-memory or injectable store) |
| `InMemoryBrokerStore` | In-memory task table for the broker |
| `InMemoryObjectStore` | In-memory presigner + BlobStore for dev/tests |

## Supported / Limitations

### Supported

- **HTTP transport + bearer auth**: broker server (`createBrokerHttpServer`) and worker client (`createHttpWorkerTransport`) communicate over plain HTTP with optional `Authorization: Bearer <token>`.
- **S3/R2/MinIO artifacts by reference**: `createS3Presigner` / `createS3BlobStore` let workers PUT blobs directly to object storage without touching the orchestrator's data plane. The worker holds zero standing credentials.
- **No-migration restart durability**: the broker is in-memory but the engine's `SUSPENDED` `WorkflowStage` row is the source of truth. After an orchestrator restart the broker rebuilds from the durable suspended state; if the worker already finished its durable report (`<prefix>/report.json`) is recovered without re-running the activity.
- **Lease renewal / heartbeat**: workers send heartbeats while running; the broker stale-lease sweep re-leases tasks from crashed workers for another worker to pick up.
- **Durable reports**: the worker writes its outcome to a deterministic blob key before calling `report()`. On broker restart the proxy recovers the outcome from object storage — no double execution.
- **Per-stage routing**: `createRoutingExecutor` routes specific stage IDs to the remote executor; all others fall through to the local executor.

### Limitations

- **No mid-activity cancellation**: if a run is cancelled while the worker is executing, the worker's in-flight activity finishes; its `report()` is fenced by the broker (stale-token rejection) and the stage outcome is not persisted. The run terminates correctly but the worker cannot be interrupted mid-run.
- **Single-part PUT only**: artifact writes use a single presigned PUT. Objects larger than 5 GB require multipart upload — not yet implemented.
- **Single-orchestrator HA**: the in-memory broker is per-process. Running multiple orchestrator instances requires a shared broker store (a small Prisma table, Redis, or DB-backed `claimNext`). Multi-instance HA is deferred.
- **Real-S3 integration tests**: the S3 presigner path (`createS3Presigner`) is unit-tested with a mock signer. A full round-trip integration test against a real MinIO / LocalStack endpoint is not included and should be added before relying on it in production.

## Security

`ctx.storage` on the worker is prefix-sandboxed to the task's artifact grant. However, object-storage keys embedded inside a worker's `output` are **not** prefix-validated by the proxy — the trust gate (`outputSchema.safeParse`) validates output shape, not values. Downstream trusted stages that dereference worker-supplied keys via the orchestrator's root `BlobStore` must re-scope or validate them, or restrict orchestrator credentials. A prefix-checked artifact-ref channel is deferred to Phase 2.
