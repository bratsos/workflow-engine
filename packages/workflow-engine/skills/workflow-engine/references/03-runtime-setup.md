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

  // Optional (1.0): soft threshold, in bytes of serialised JSON, above which
  // a durable step result is written to `blobStore` and the ledger row keeps
  // only a reference. Default `DEFAULT_SPILL_THRESHOLD_BYTES` (64 KiB).
  // There is no hard ceiling above it -- a larger payload is spilled, never
  // rejected -- and reads resolve the reference before the value reaches the
  // stage. `Number.POSITIVE_INFINITY` keeps every result inline; values
  // already spilled still resolve. Job payloads use the same mechanism but
  // are opt-in at wiring time (`createSpillingJobTransport`).
  // See 15-large-payloads.md.
  // spillThresholdBytes: 65_536,
});
```

## Port Interfaces

| Port | Interface | Purpose |
|------|-----------|---------|
| `persistence` | `Persistence` | CRUD for runs, stages, logs, outbox events, idempotency keys |
| `blobStore` | `BlobStore` | `put(key, data)`, `get(key)`, `has(key)`, `delete(key)`, `list(prefix)` |
| `jobTransport` | `JobTransport` | `enqueue` (deprecated, use `enqueueParallel`), `enqueueParallel` (idempotent on `(workflowRunId, stageId)`), `deleteByRunAndStages` (1.0.0-alpha.7+, used by `run.rerunFrom`), `dequeue`, `complete`, `suspend`, `fail` (all three take an optional acknowledgement fence, 1.0.0-alpha.9+), `releaseStaleJobs`, `expireRunawayJobs` (optional, 1.0.0-alpha.9+, absolute lease tier), `cancelByRun`, `touchJob` (v0.11+, lease heartbeat), `getJobsByWorkflowRun` (v0.11+), `adoptWorkerId` (optional, 1.0.0-alpha.7+) |
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
  postJobYieldMs: 1_000,              // v0.4.4+: randomised pause after a completed job (default: jobPollIntervalMs)
  staleLeaseThresholdMs: 300_000,     // Release stale job leases (default 300_000 as of v0.11, was 60_000)
  jobAbsoluteTimeoutMs: 3_600_000,    // 1.0.0-alpha.9+: absolute cap on one claim, fires even while heartbeating (0 disables)
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
// { workerId, jobsProcessed, orchestrationTicks, isRunning, uptimeMs, eventSink }
```

`stats.eventSink` is an `EventSinkHealth` as of this host's last outbox flush:
`{ status: "healthy" | "degraded", since: number | null, consecutiveFailures:
number, deadLettered: number, lastError: string | null }`. See "Degraded event
sink" below.

`staleLeaseThresholdMs` is how long a killed worker's *job* stays unavailable. A killed worker's in-flight **durable step** is a separate dial: `StepRunOptions.leaseMs`, default five minutes, is how long a resumed stage waits before it re-runs that step (see 12-durable-steps.md, "Leases, retries and deadlines"). Both bound how fast a crash recovers; neither is set by the other.

**Two tiers of job-lease expiry.** `staleLeaseThresholdMs` is the fine-grained
tier: it is measured from `lockedAt`, which `touchJob` refreshes on every
heartbeat, so it detects a worker that *stopped*. It cannot detect a worker that
is alive but wedged — a hung HTTP call with no timeout, an infinite loop in a
stage — because such a worker keeps heartbeating and holds the job forever.
Shipping only a heartbeat is the configuration pg-boss's design treats as
dangerous, so there is a second, coarse tier: `jobAbsoluteTimeoutMs` (default
**one hour**, twelve times the default stale threshold) is measured from
`startedAt`, which is stamped once per claim and which no heartbeat refreshes,
so it always fires. Set it to `0` to disable it and get the pre-1.0.0-alpha.9
heartbeat-only behaviour; raise it above the longest stage you legitimately run.

The two outcomes are told apart by the `lastError` the sweep writes, prefixed
with an exported constant so an operator (or an alert) can match on it:

| Tier | Measured from | Outcome | `lastError` prefix |
| --- | --- | --- | --- |
| `staleLeaseThresholdMs` | `lockedAt` (heartbeat refreshes it) | requeued `PENDING` for another worker | `LEASE_HEARTBEAT_LOST` |
| `jobAbsoluteTimeoutMs` | `startedAt` (never refreshed) | `FAILED` — dead-lettered | `LEASE_ABSOLUTE_CAP` |

The heartbeat tier sweeps first, so a *dead* worker's job is retried rather than
dead-lettered; only a job whose worker is still heartbeating reaches the cap.
The absolute tier is deliberately terminal — a job that hung for a whole hour
will hang again — and the run it belonged to is resolved by `run.reapStuck` on a
later pass. `lease.reapStale` returns both counts (`{ released, expired }`), and
`runMaintenanceTick` surfaces them as `staleReleased` / `staleExpired`. A custom
`JobTransport` that does not implement the optional `expireRunawayJobs` simply
has no absolute tier.

**The job lease runs on the database clock (Postgres).** `PrismaJobQueue` stamps
`lockedAt`/`startedAt` with `now() AT TIME ZONE 'UTC'` at claim time, renews it
the same way from `touchJob`, and `releaseStaleJobs` derives the deadline in the
same statement (`"lockedAt" < now() AT TIME ZONE 'UTC' - <threshold> * interval
'1 millisecond'`). No expiry is computed in application code and none is stored,
which is the shape pg-boss, Graphile Worker, River and Oban all use: a host whose
system clock drifts can neither shorten nor extend a lease, and two hosts can
never disagree about when one expires. `staleLeaseThresholdMs` is therefore a
*duration*, measured by the database, not a deadline your process computes. On
SQLite the comparison stays in application code -- one process, one clock.

An interval firing that lands while the previous tick is still running is skipped (`orchestrationTicks` counts ticks that ran), and `stop()` waits for an in-flight tick, bounded by `shutdownTimeoutMs`, before its final outbox flush. Several hosts may run against one database: suspended stages are claimed per poll, so a stage body runs once across processes (see 08-common-patterns.md, "Suspended-Stage Claims").

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
  jobAbsoluteTimeoutMs: 3_600_000,    // 1.0.0-alpha.9+ (0 disables the absolute tier)
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
// { claimed, suspendedChecked, staleReleased, staleExpired, eventsFlushed,
//   stuckReaped, eventsFailed, eventsDeadLettered, eventSinkStatus, eventSinkError? }
// Resumed suspended stages are automatically followed by run.transition.
```

The serverless host has no process to carry health across invocations, so it
reports `eventSinkStatus` per tick and you alert on a run of them. See
"Degraded event sink" below.

Each maintenance step runs in its own error boundary — if one step fails, the others still execute. See [09-troubleshooting.md](09-troubleshooting.md) for details.

## Degraded event sink

The outbox is the durable record; the `EventSink` is a delivery attempt. When
publishing fails, `outbox.flush` releases the events it had claimed so the next
flush retries them, and reports `eventSinkStatus: "degraded"` with
`eventSinkError` set to the first failure of that flush. Nothing about a run
stalls: the poller advances runs, not the sink. `OutboxFlushResult` carries
`published`, `failed`, `deadLettered`, `eventSinkStatus` and `eventSinkError?`,
and the same fields reach `MaintenanceTickCounts`.

An event that exhausts its retry budget moves to the dead-letter queue and
counts in `deadLettered`. Those stop retrying on their own — replay them with
the `plugin.replayDLQ` command.

The Node host holds the state across flushes through `createEventSinkMonitor`
and logs only on a transition (into degraded, and again on recovery), so a sink
that is down for an hour does not produce an hour of log lines; it logs
unconditionally when `deadLettered > 0`, because that one needs an operator.
`host.getStats().eventSink` is the same state as a value:

```typescript
const { status, since, consecutiveFailures, deadLettered, lastError } =
  host.getStats().eventSink;

if (status === "degraded" && Date.now() - (since ?? 0) > 5 * 60_000) {
  alert(`workflow event sink degraded for 5m: ${lastError}`);
}
```

The serverless host has no process to hold that state, so it reports
`eventSinkStatus` on each `runMaintenanceTick()` result and the caller alerts
on a run of degraded ticks.

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
| `runMaintenanceTick(kernel, options)` | Runs one bounded maintenance pass -- `run.claimPending`, `stage.pollSuspended` (transitioning any resumed runs), `lease.reapStale` (both lease tiers), `outbox.flush`, `run.reapStuck`. Each command's error is caught and logged independently so one failure doesn't block the rest of the tick. |
| `HOST_DEFAULTS` | The shared tuning defaults (`staleLeaseThresholdMs`, `jobAbsoluteTimeoutMs`, `maxClaimsPerTick`, `jobHeartbeatIntervalMs`, etc.) both built-in hosts fall back to. |
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

`start()` also hands the host's `workerId` to the job transport (`JobTransport.adoptWorkerId`, optional on the port), so `job_queue.workerId` names the same worker `run.claimPending` does. Build the transport without a `workerId` of its own — `createPrismaJobQueue(prisma)` — and it adopts the host's; pass one explicitly and the transport keeps it while the host logs a one-line `workerId mismatch` warning naming both. See 05-persistence-setup.md.

### Spreading one run across workers (`postJobYieldMs`)

The host that completes a job is also the one that dispatches `run.transition`, so it enqueues the next execution group from its own process. Before host-node 0.4.4 it then went straight back to `dequeue()` while every other worker was still parked in its `jobPollIntervalMs` timer, and won the stage it had just created essentially every time: a sequential pipeline ran end-to-end on a single worker no matter how many were alive (correct, but "add more workers" did not shorten one pipeline).

The job loop now pauses for a uniform draw over `[0, postJobYieldMs)` after a **completed** job, which gives this worker the same phase every other worker has. Only completed jobs pause: a retry re-queues itself with backoff, a suspension waits on a poll deadline, and a terminal failure enqueues nothing.

- **Default** is `jobPollIntervalMs`, so the pause matches the window competitors wake up in.
- **The pause is skipped while the loop is draining a backlog** — as soon as `dequeue()` hands it a job from a run other than the one it just completed, it stops pausing until the queue next comes back empty. A worker chewing through unrelated queued work pays at most one pause.
- **`postJobYieldMs: 0`** disables it: lowest latency for a single-worker deployment, and multi-worker deployments go back to pinning each run to one worker.
- Suspended/async-batch stages are unaffected — they resume through `stage.pollSuspended` on the orchestration tick, which any worker may run.
