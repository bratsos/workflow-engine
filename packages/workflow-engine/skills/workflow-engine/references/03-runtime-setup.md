# Kernel & Host Setup

Complete guide for configuring the command kernel and choosing a host.

## Creating a Kernel

The kernel is the core command dispatcher. It's environment-agnostic -- no timers, no signals, no global state.

```typescript
import { createKernel } from "@bratsos/workflow-engine/kernel";
import type {
  Kernel,
  KernelConfig,
  Persistence,
  BlobStore,
  JobTransport,
  EventSink,
  Clock,
} from "@bratsos/workflow-engine/kernel";
import {
  createPrismaWorkflowPersistence,
  createPrismaJobQueue,
} from "@bratsos/workflow-engine/persistence/prisma";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const kernel = createKernel({
  // Required: metadata storage (runs, stages, logs, outbox, idempotency)
  persistence: createPrismaWorkflowPersistence(prisma),

  // Required: large payload storage
  blobStore: myBlobStore,

  // Required: job queue
  jobTransport: createPrismaJobQueue(prisma),

  // Required: async event publishing
  eventSink: myEventSink,

  // Required: injectable time source
  clock: { now: () => new Date() },

  // Required: workflow definition lookup
  registry: {
    getWorkflow: (id) => workflowMap.get(id),
  },

  // Optional: `Scheduler` port -- @deprecated and unused by the kernel today
  // (zero schedule()/cancel() call sites). Omit it; the kernel supplies its
  // own internal no-op. Will be removed at 1.0.
  // scheduler: myScheduler,

  // Optional (v0.11+): how long an idempotency key may sit `in_progress`
  // before a subsequent dispatch can reclaim it (guards against a crashed
  // dispatcher leaving a key stuck forever). Default: 10 minutes.
  // Set to `Infinity` to disable reclaiming.
  idempotencyStaleInProgressMs: 10 * 60 * 1000,
});
```

## Port Interfaces

| Port | Interface | Purpose |
|------|-----------|---------|
| `persistence` | `Persistence` | CRUD for runs, stages, logs, outbox events, idempotency keys |
| `blobStore` | `BlobStore` | `put(key, data)`, `get(key)`, `has(key)`, `delete(key)`, `list(prefix)` |
| `jobTransport` | `JobTransport` | `enqueue` (deprecated, use `enqueueParallel`), `enqueueParallel`, `dequeue`, `complete`, `suspend`, `fail`, `cancelByRun`, `touchJob` (v0.11+, lease heartbeat), `getJobsByWorkflowRun` (v0.11+) |
| `eventSink` | `EventSink` | `emit(event)` - async event publishing |
| `clock` | `Clock` | `now()` - returns `Date` |
| `scheduler` (optional) | `Scheduler` | `schedule(type, payload, runAt)`, `cancel(type, correlationId)` -- **@deprecated**, unused by the kernel (zero call sites); omit it, the kernel supplies its own no-op. Removal at 1.0 |

## Node Host

For long-running worker processes (Node.js, Docker containers, etc.).

```typescript
import { createNodeHost } from "@bratsos/workflow-engine-host-node";

const host = createNodeHost({
  kernel,
  jobTransport: createPrismaJobQueue(prisma),
  workerId: "worker-1",

  // Optional tuning
  orchestrationIntervalMs: 10_000,    // Claim pending, poll suspended, reap stale, flush outbox
  jobPollIntervalMs: 1_000,           // Dequeue and execute jobs
  staleLeaseThresholdMs: 300_000,     // Release stale job leases (default 300_000 as of v0.11, was 60_000)
  jobHeartbeatIntervalMs: 60_000,     // v0.11+: heartbeat a job's lease while it executes
  maxClaimsPerTick: 10,               // Max pending runs to claim per tick
  maxSuspendedChecksPerTick: 10,      // Max suspended stages to poll per tick
  maxOutboxFlushPerTick: 100,         // Max outbox events to flush per tick
});

// Start polling loops and register SIGTERM/SIGINT handlers
await host.start();

// Graceful shutdown
await host.stop();

// Runtime stats
const stats = host.getStats();
// { workerId, jobsProcessed, orchestrationTicks, isRunning, uptimeMs }
```

### Worker Process Pattern

```typescript
// worker.ts
import { host } from "./setup";

process.on("SIGTERM", () => host.stop());
process.on("SIGINT", () => host.stop());

console.log("Starting workflow worker...");
await host.start();
```

## Serverless Host

For stateless environments (Cloudflare Workers, AWS Lambda, Vercel Edge, Deno Deploy).

```typescript
import { createServerlessHost } from "@bratsos/workflow-engine-host-serverless";

const host = createServerlessHost({
  kernel,
  jobTransport,
  workerId: "my-worker",

  // Optional tuning (same as Node host)
  staleLeaseThresholdMs: 300_000,     // default as of v0.11 (was 60_000)
  jobHeartbeatIntervalMs: 60_000,     // v0.11+
  maxClaimsPerTick: 10,
  maxSuspendedChecksPerTick: 10,
  maxOutboxFlushPerTick: 100,
});
```

### Handle a Single Job

When a queue message arrives (Cloudflare Queue, SQS, etc.):

```typescript
const result = await host.handleJob({
  jobId: msg.id,
  workflowRunId: msg.body.workflowRunId,
  workflowId: msg.body.workflowId,
  stageId: msg.body.stageId,
  attempt: msg.body.attempt,
  maxAttempts: msg.body.maxAttempts,
  payload: msg.body.payload,
});

if (result.outcome === "completed") msg.ack();
else if (result.outcome === "suspended") msg.ack();
else msg.retry();
```

### Dequeue and Process Jobs

For environments that poll rather than receive:

```typescript
const result = await host.processAvailableJobs({ maxJobs: 5 });
// { processed, succeeded, failed }
```

### Maintenance Tick

Run from a cron trigger (Cloudflare Cron, EventBridge, etc.):

```typescript
const tick = await host.runMaintenanceTick();
// { claimed, suspendedChecked, staleReleased, eventsFlushed, stuckReaped }
// Resumed suspended stages are automatically followed by run.transition.
```

Each maintenance step runs in its own error boundary — if one step fails, the others still execute. See [09-troubleshooting.md](09-troubleshooting.md) for details.

## Building a Custom Host

The Node and Serverless hosts are both thin process-model wrappers (polling loop vs. single stateless invocation) around the *same* command-dispatch sequences. That shared logic is exported directly from `@bratsos/workflow-engine/kernel` so a third host (a different queue product, a different runtime) doesn't have to hand-duplicate it:

```typescript
import {
  executeJobWithHeartbeat,
  runMaintenanceTick,
  HOST_DEFAULTS,
  toErrorMessage,
} from "@bratsos/workflow-engine/kernel";
```

| Export | Purpose |
|--------|---------|
| `executeJobWithHeartbeat(kernel, options)` | Dispatches `job.execute` for one job, holding a lease heartbeat (`jobTransport.touchJob`) for its duration, then routes the outcome through the job transport (`complete`/`suspend`/`fail`) and `run.transition` when terminal. |
| `runMaintenanceTick(kernel, options)` | Runs one bounded maintenance pass -- `run.claimPending`, `stage.pollSuspended` (transitioning any resumed runs), `lease.reapStale`, `outbox.flush`, `run.reapStuck`. Each command's error is caught and logged independently so one failure doesn't block the rest of the tick. |
| `HOST_DEFAULTS` | The shared tuning defaults (`staleLeaseThresholdMs`, `maxClaimsPerTick`, `jobHeartbeatIntervalMs`, etc.) both built-in hosts fall back to. |
| `toErrorMessage(error)` | Normalizes a caught `unknown` into a display-safe string (`Error#message`, or `String(error)`). |

Both take an options bag (`ExecuteJobWithHeartbeatOptions` / `RunMaintenanceTickOptions`, also exported from `@bratsos/workflow-engine/kernel`) covering the job transport, tuning knobs, and a `logPrefix` for diagnostics. Read `packages/workflow-engine-host-node/src/host.ts` or `packages/workflow-engine-host-serverless/src/host.ts` for a complete reference implementation before writing your own -- both call these same two functions rather than reimplementing the dispatch sequence.

Also exported from `@bratsos/workflow-engine/kernel` for host/plugin authors: `normalizeAnnotateArgs` (the same argument-normalization `ctx.annotate(...)` uses internally, for code building its own annotation-writing surface) and the `AnnotationCreatedEvent` type (the outbox event shape emitted when an annotation's `emitEvent: true` is set -- see [10-annotations.md](10-annotations.md)).

## Multi-Worker Setup

Multiple workers can share the same database. Each worker needs a unique `workerId`:

```typescript
// Worker 1
createNodeHost({ kernel, jobTransport, workerId: "worker-1" });

// Worker 2
createNodeHost({ kernel, jobTransport, workerId: "worker-2" });
```

The `claimPendingRun` operation uses `FOR UPDATE SKIP LOCKED` in PostgreSQL to prevent race conditions.
