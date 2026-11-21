# Kernel & Host Setup

Complete guide for configuring the command kernel and choosing a host.

## Creating a Kernel

The kernel is the core command dispatcher. It's environment-agnostic -- no timers, no signals, no global state.

```typescript
import { createKernel, createWorkflowRegistry } from "@bratsos/workflow-engine/kernel";
import type {
  Kernel,
  KernelConfig,
  Persistence,
  BlobStore,
  JobTransport,
  EventSink,
  Clock,
  StepLedger,
  KernelServices,
} from "@bratsos/workflow-engine/kernel";
import {
  createPrismaWorkflowPersistence,
  createPrismaJobQueue,
  createPrismaStepLedger,
  createPrismaAICallLogger,
} from "@bratsos/workflow-engine/persistence/prisma";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

// Prisma 7. Prisma 6: `new PrismaClient()`. Prisma 8: `const prisma = fromPrisma8(db)` (05-persistence-setup.md, "Prisma 8").
const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) });

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

  // Required: workflow definition lookup. `createWorkflowRegistry` implements the
  // optional `listWorkflows()` the definition-version filter derives from; a
  // hand-written `{ getWorkflow: (id) => ... }` still works but cannot enumerate,
  // so claiming stays unfiltered (see 13-definition-versioning.md).
  registry: createWorkflowRegistry(workflows),

  // Optional: durable step storage. Required for any stage that calls
  // `ctx.step.*`; without it those calls throw `StepLedgerNotConfiguredError`.
  stepLedger: createPrismaStepLedger(prisma),

  // Optional: services exposed lazily through `ctx.ai` / `ctx.aiLogger` and
  // used for the run's cost roll-up. `ai` defaults to `createAIHelper`;
  // without `aiLogger`, touching `ctx.ai` throws `AIServicesNotConfiguredError`.
  services: { aiLogger: createPrismaAICallLogger(prisma) },

  // Optional: `ActivityExecutor` port -- defaults to in-process; see
  // 11-remote-activity-workers.md.
  // executor: createRoutingExecutor({ ... }),

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
| `persistence` | `Persistence` | CRUD for runs, stages, logs, outbox events, idempotency keys; optional `getActiveWorkStats(now)` (read by `engine.stats`) |
| `blobStore` | `BlobStore` | `put(key, data)`, `get(key)`, `has(key)`, `delete(key)`, `list(prefix)` |
| `jobTransport` | `JobTransport` | `enqueueParallel` (idempotent on `(workflowRunId, stageId)`; the legacy `enqueue` left the port at 1.0), `deleteByRunAndStages` (used by `run.redrive` / `run.rerunFrom`), `dequeue(options?)` (`options.serves` filters by definition version; returns `startedAt`), `complete`, `suspend(jobId, nextPollAt, fence?)`, `fail(jobId, error, shouldRetry?, fence?)` (all three take an optional `JobAckFence` and return `"acknowledged" \| "superseded"`), `defer` (optional: decline a job without spending an attempt), `releaseStaleJobs`, `expireRunawayJobs` (optional, absolute lease tier), `cancelByRun`, `touchJob` (lease heartbeat), `getJobsByWorkflowRun`, `adoptWorkerId` (optional), `fairnessGroupBy` (optional readonly property, read by `createSpillingJobTransport`) |
| `eventSink` | `EventSink` | `emit(event)` - async event publishing |
| `clock` | `Clock` | `now()` - returns `Date` |
| `registry` | `WorkflowRegistry` | `getWorkflow(id)`, plus optional `listWorkflows()` (implemented by `createWorkflowRegistry`) that enables definition-version filtering |
| `stepLedger` (optional) | `StepLedger` | `claim`, `get`, `update`, `compareAndSet`, `list`, `clear`, optional `clearExcept` -- durable step rows; `InMemoryStepLedger` / `createPrismaStepLedger`. `createKernel` wraps it with the step-result spill (15-large-payloads.md) |
| `services` (optional) | `KernelServices` | `{ aiLogger?: AICallLogger, ai?: AIHelperFactory }` -- backs `ctx.ai` / `ctx.aiLogger` |
| `executor` (optional) | `ActivityExecutor` | Where a stage body runs; defaults to `createLocalExecutor()` |

The `Scheduler` port and `KernelConfig.scheduler` were removed at 1.0 (the type is still exported; the kernel never called it).

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
  shutdownTimeoutMs: 10_000,          // 1.0: bound on stop() waiting for the in-flight tick / onTick call, the job, and the final flush
  flushOutboxOnStop: true,            // 1.0: run a final outbox.flush in stop() so this process publishes its own workflow:completed
  // retention: { olderThanMs: 30 * 24 * 60 * 60 * 1000, statuses?, limit? }, // Opt-in: run.purge on every tick (see 09-troubleshooting.md, "Run Retention")
  // onTick: async (counts) => { ... }, // 1.0.0-alpha.21: called after every tick with its MaintenanceTickCounts (see "Exporting gauges")
  // serves: "all",                   // 1.0: turn definition-version filtering off.
                                      // Omitted, the kernel derives it from the
                                      // registry (claim, poll and dequeue alike).
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

`jobHeartbeatIntervalMs` is also what feeds `ctx.abortSignal`: each beat dispatches `job.heartbeat`, which renews the lease and reports the run's status and whether this worker still holds the job, and the host aborts the executing body with a `StageAbortedError` whose `reason` is `"cancelled"` or `"lease-lost"` (see 12-durable-steps.md, "Cancellation").

`staleLeaseThresholdMs` is how long a killed worker's *job* stays unavailable. A killed worker's in-flight **durable step** is a separate dial: `StepRunOptions.lease`, default five minutes, is how long a resumed stage waits before it re-runs that step (see 12-durable-steps.md, "Leases, retries and deadlines"). Both bound how fast a crash recovers; neither is set by the other.

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

### Exporting gauges

`onTick` (both hosts) is called after every maintenance tick with a copy of that tick's `MaintenanceTickCounts` (mutating it changes nothing else); the `engine.stats` command adds queue depth and age. The engine takes no metrics dependency: `metrics` below is your own client.

```typescript
const host = createNodeHost({
  kernel, jobTransport, workerId: "worker-1",
  onTick: async (counts) => {
    metrics.increment("workflow_events_flushed", counts.eventsFlushed);
    const stats = await kernel.dispatch({ type: "engine.stats" });
    if (stats.jobs.available) {
      metrics.gauge("workflow_jobs_pending", stats.jobs.byStatus.PENDING);
      metrics.gauge("workflow_jobs_oldest_pending_age_ms", stats.jobs.oldestPendingAgeMs ?? 0);
    }
    if (stats.outbox.available) metrics.gauge("workflow_outbox_dead_lettered", stats.outbox.deadLettered);
  },
});
```

- A hook that throws or rejects is caught and logged (`<prefix> onTick hook error:`); it never stops the loop and never fails a tick.
- Node host: the hook runs outside the tick, so ticks never wait for what it awaits (a never-settling hook: 16 ticks in 155 ms against 15 without one), but its synchronous code runs on the host's thread and holds every tick while it runs (40 ms of computation per call at a 10 ms interval: five calls in 202 ms); claiming, polling, lease reaping, the outbox flush and `run.reapStuck` go on whatever it does. At most one call is in flight: a tick that finds the previous call still running skips the hook and logs one warning (`[NodeHost] onTick hook is still running after <n> ms ...`) at the first skip; it is not repeated while the hook stays slower than the interval, and a call that finishes without a tick skipping it ends the episode. A hook that never settles is called once, warned about once, and its gauges stop updating until it settles: bound what it waits on. `stop()` waits for a running hook, with the in-flight tick, for at most `shutdownTimeoutMs`, and no hook starts once it began. A hook must not `await host.stop()`: `stop()` waits for the hook that is waiting for it until `shutdownTimeoutMs` elapses (use `void host.stop()`, or stop from outside).
- `onTick` must be a function (a `TypeError` from the host constructor otherwise). `createNodeHost(...).start()` first calls the job transport's optional `verifyStorage()` and rejects with its error (a SQLite file another Prisma major wrote: `SqliteDateStorageError`) before it starts anything (a `stop()` during that check cancels the start; a check that cannot run rejects with `SqliteDateStorageUnverifiedError`); the serverless host's `handleJob`, `processAvailableJobs` and `runMaintenanceTick` check on every call and throw it instead of logging it per command. If an invalid `onTick` or timer value cannot be formatted, the constructor keeps its `TypeError` or `RangeError` and describes the value as `Unprintable error`.
- Serverless host: the hook is awaited for at most `onTickTimeoutMs` (default 5000, the same as `outboxFlushTimeoutMs`; a number from 1 to 2147483647, anything else throws a `RangeError` from `createServerlessHost`, and nothing switches the bound off). Every option that reaches a timer follows that rule and is checked at construction (`assertTimerMs`, exported from `@bratsos/workflow-engine/kernel`): Node `orchestrationIntervalMs`, `jobPollIntervalMs`, `postJobYieldMs` (0 allowed: off), `jobHeartbeatIntervalMs`, `shutdownTimeoutMs`, and `runAndWait`'s `pollIntervalMs`; serverless `outboxFlushTimeoutMs`, `onTickTimeoutMs`, `jobHeartbeatIntervalMs`, and `runToCompletion`'s `jobHeartbeatIntervalMs`; then `runMaintenanceTick()` returns the counts, logs `[ServerlessHost] onTick hook did not settle within <n> ms; ...` and leaves the hook running. The bound covers a hook that yields (a never-settling hook with a 25 ms bound: returned after 28 ms); synchronous code in the hook cannot be bounded (a 60 ms body delayed the return by 60 ms).
- `engine.stats` returns `{ at, runs, stages, jobs, outbox }`. Each section is `{ available: true, ... }` or `{ available: false }` when the port behind it has no `getActiveWorkStats` (runs, stages, outbox) or `getJobStats` (jobs). It counts PENDING, RUNNING and SUSPENDED rows only, never terminal ones, and writes nothing. Ages are milliseconds on the kernel clock; `null` means nothing is waiting.

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
  flushOutboxAfterJob: true,          // 1.0: publish outbox events right after handleJob settles (no process lifecycle to hook)
  outboxFlushTimeoutMs: 5_000,        // 1.0: bound on that post-job flush
  // retention: { olderThanMs: 30 * 24 * 60 * 60 * 1000 }, // Opt-in: run.purge on every tick
  // onTick: async (counts) => { ... }, // 1.0.0-alpha.21: called at the end of every runMaintenanceTick() (see "Exporting gauges")
  // onTickTimeoutMs: 5_000,          // 1.0.0-alpha.21: runMaintenanceTick() waits for onTick at most this long, then returns the counts and logs a warning
  // serves: "all",                   // 1.0: turn definition-version filtering off
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

// `JobResult` carries the retry contract: `willRetry`, `attempt`, `maxAttempts`,
// `retryDelayMs` (2^attempt seconds) and `dead` (orphan or malformed message,
// failed and acknowledged). The built-in transports re-enqueue a retry from
// `fail(jobId, error, true)` themselves, so the message can always be acked;
// a push transport whose fail() cannot re-enqueue retries the message itself.
if (result.willRetry) msg.retry({ delaySeconds: (result.retryDelayMs ?? 0) / 1000 });
else msg.ack();
```

A message whose payload was spilled by `createSpillingJobTransport` and delivered through your own push queue must be resolved first: `createPayloadSpill({ blobStore }).unpack(msg.payload)` (see 15-large-payloads.md).

### Dequeue and Process Jobs

For environments that poll rather than receive:

```typescript
const result = await host.processAvailableJobs({ maxJobs: 5 });
// { processed, succeeded, failed }
```

### Run a workflow inside one request

`runToCompletion` is the drain loop callers used to hand-roll — create the
run, claim it, dequeue and execute jobs until none remain — exported once:

```typescript
import { runToCompletion } from "@bratsos/workflow-engine-host-serverless";

const result = await runToCompletion({
  kernel,
  jobTransport,
  persistence,
  command: {
    type: "run.create",
    idempotencyKey: `checkout:${orderId}`,
    workflowId: "checkout",
    input: { orderId },
  },
});
// { workflowRunId, status, outcome, output?, reason?, jobsProcessed,
//   foreignJobsProcessed, suspendedStageId? }
```

`outcome` is `"completed" | "failed" | "cancelled"` when the run finished,
and `"suspended" | "incomplete"` when it did not — neither is an error, both
mean the run is alive and something else has to carry it.

Three caveats, all of them structural:

- **It shares the queue, so it can execute another caller's job.**
  `run.claimPending` claims whichever runs are pending and `dequeue()`
  returns whichever job is next; neither narrows to one run. Other callers'
  work lands inside this request's latency budget, and
  `foreignJobsProcessed` counts it. Give the call its own `jobTransport` if
  that is unacceptable.
- **It cannot complete a workflow that suspends.** A durable sleep, wait or
  signal resumes on a later poll, not in this request, so the call returns
  `outcome: "suspended"` and names the stage instead of spinning. Use it for
  workflows with no durable waits.
- **It is bounded.** `maxJobs` (default 50) and `maxClaimRounds` (default 5)
  cap it; hitting either returns `outcome: "incomplete"` with a `reason`
  rather than throwing or looping. It does not poll suspended stages or reap
  leases — that is `runMaintenanceTick()`'s job, and doing it here is what
  would make it spin.

### Maintenance Tick

Run from a cron trigger (Cloudflare Cron, EventBridge, etc.):

```typescript
const tick = await host.runMaintenanceTick();
// { claimed, suspendedChecked, staleReleased, staleExpired, eventsFlushed,
//   stuckReaped, purged, eventsFailed, eventsDeadLettered, eventSinkStatus, eventSinkError? }
// `purged` stays 0 unless the host was given `retention`.
// Resumed suspended stages are automatically followed by run.transition.
```

The serverless host has no process to carry health across invocations, so it
reports `eventSinkStatus` per tick and you alert on a run of them. See
"Degraded event sink" below.

Each maintenance step runs in its own error boundary — if one step fails, the others still execute. See [09-troubleshooting.md](09-troubleshooting.md) for details.

## Degraded event sink

The outbox is the durable record. Events are delivered at least once while retries remain. Delivery can duplicate whenever the sink effect happens without a durable acknowledgement. Examples include a crash or write error after acceptance, an emit in flight at expiry, a sink that commits and then rejects, and partial plugin success. Deduplicate using the outbox `eventId` supplied to the sink or plugin. `workflowRunId` and `sequence` order events within a run, but are not a permanent identity: after an operator deletes the newest outbox rows, the Prisma store can reuse a sequence. Failures exhaust the retry budget and move the event to the DLQ; `plugin.replayDLQ` makes it eligible again. The engine’s progress never depends on the sink. `publishedAt` is written only after the sink resolves. The default 60-second lease starts before the claim query. The flush checks its clock again after awaiting the claim, immediately before each emit. It warns and reports degraded if a claim expires before delivery. A timeout stops further claims and emits. An emit already in flight can settle under its owner fence. Maintenance ticks and `runToCompletion` wait at most `outboxFlushTimeoutMs` (default 5,000 ms) for a flush, so a hanging sink cannot block run progress. The serverless post-job claim lasts `outboxFlushTimeoutMs + 60_000` ms and Node shutdown uses the remaining shutdown wait plus 60,000 ms ms, both capped at 2,147,483,647 ms. A batch shares its claim deadline, so a slow sink can leave later events for a future flush. Synchronize host clocks.

Order is decided at claim time. A replayed dead letter is delivered after later events of its run already claimed or published before replay. After replay, later unclaimed events wait behind it. Different runs in a page can reach the sink concurrently. The Prisma cursor follows the recorded outbox ranks across fresh host instances. The Prisma store walks run IDs in database order and wraps after the last run claimed by that persistence instance. A retrying run cannot hold the first slot on every flush while another run is ready. Old index entries that a PostgreSQL snapshot prevents vacuum from removing can add work to a head lookup. The sink and plugin handlers receive optional delivery metadata with `eventId`, `workflowRunId`, `sequence` and `attempt`. The attempt is recorded failures plus one, so crashes or overlaps may repeat it. Claimed events count as unpublished in `engine.stats` and the console shows a live claim as claimed.

An alpha.20 flusher ignores new claims and can lose an event by stamping before emit. Stop all alpha.20 flushers before relying on the new guarantee. A legacy stamp without a claim means published to the new code; an event already lost by an old flusher cannot be recovered.

Nothing in the engine deletes outbox rows; `run.purge` leaves them. For a purged run, a flush skips a live claim until it completes or expires, skips published rows, and skips dead letters until replay; only an operator removes rows with SQL. If a persistence write fails, `kernel.dispatch` rejects without logging; host maintenance logs `outbox.flush error` and reports degraded delivery. A later flush recovers still-claimed rows after expiry; if the write committed before the error, its recorded outcome applies.

When
publishing fails, `outbox.flush` releases the failed event so the next
flush retries it, and reports `eventSinkStatus: "degraded"` with
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
| `executeJobWithHeartbeat(kernel, options)` | Dispatches `job.execute` for one job (passing the job's `attempt`/`maxAttempts` and an `abortSignal`), dispatching `job.heartbeat` on `jobHeartbeatIntervalMs` for its duration (renews the lease, aborts the body on cancel or a lost lease), then routes the outcome through the job transport (`complete`/`suspend`/`fail`/`defer`, fenced with the job's `startedAt`) and `run.transition` when terminal. Returns an `ExecuteJobOutcome` (`outcome`, `error?`, `dead?`, `willRetry?`, `attempt?`, `maxAttempts?`, `retryDelayMs?`, `deferred?`). |
| `runMaintenanceTick(kernel, options)` | Runs one bounded maintenance pass -- `run.claimPending`, `stage.pollSuspended` (transitioning any resumed runs), `lease.reapStale` (both lease tiers), `outbox.flush`, `run.reapStuck`, and `run.purge` when `retention` is set. Each command's error is caught and logged independently so one failure doesn't block the rest of the tick. |
| `HOST_DEFAULTS` | The shared tuning defaults (`workerId`, `logPrefix`, `staleLeaseThresholdMs` 300s, `jobAbsoluteTimeoutMs` 1h, `maxClaimsPerTick` 10, `maxSuspendedChecksPerTick` 10, `maxOutboxFlushPerTick` 100, `jobHeartbeatIntervalMs` 60s, `maxAttempts` 3, `versionDeferMs` 30s, `computeStuckThresholdMs()`) both built-in hosts fall back to. Every field of both option bags is optional, so `runMaintenanceTick(kernel)` and `executeJobWithHeartbeat(kernel, { jobTransport, job })` work as-is. |
| `runTickHook(hook, counts, logPrefix, timeoutMs?)` / `MaintenanceTickHook` | What both hosts use to call `onTick`: passes the hook a copy of `counts` and logs, rather than throws, whatever it throws. With `timeoutMs` it stops waiting after that long, logs one warning and leaves the hook running (the serverless host); without it, it settles when the hook does (the Node host calls it without awaiting). For a custom loop. |
| `createEventSinkMonitor()` / `EventSinkHealth` | The degraded-sink state machine the Node host uses, for a custom loop (see "Degraded event sink"). |
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

The `claimNextPendingRun` operation uses `FOR UPDATE SKIP LOCKED` in PostgreSQL to prevent race conditions. Its enqueue of the first-stage job is deferred to the kernel's post-commit step, so a fast job loop can never dequeue a job whose run is still `PENDING` elsewhere; a job that still arrives early is reported as `ghostReason: "race"` and re-delivered.

`start()` also hands the host's `workerId` to the job transport (`JobTransport.adoptWorkerId`, optional on the port), so `job_queue.workerId` names the same worker `run.claimPending` does. Build the transport without a `workerId` of its own — `createPrismaJobQueue(prisma)` — and it adopts the host's; pass one explicitly and the transport keeps it while the host logs a one-line `workerId mismatch` warning naming both. See 05-persistence-setup.md.

### Spreading one run across workers (`postJobYieldMs`)

The host that completes a job is also the one that dispatches `run.transition`, so it enqueues the next execution group from its own process. Before host-node 0.4.4 it then went straight back to `dequeue()` while every other worker was still parked in its `jobPollIntervalMs` timer, and won the stage it had just created essentially every time: a sequential pipeline ran end-to-end on a single worker no matter how many were alive (correct, but "add more workers" did not shorten one pipeline).

The job loop now pauses for a uniform draw over `[0, postJobYieldMs)` after a **completed** job, which gives this worker the same phase every other worker has. Only completed jobs pause: a retry re-queues itself with backoff, a suspension waits on a poll deadline, and a terminal failure enqueues nothing.

- **Default** is `jobPollIntervalMs`, so the pause matches the window competitors wake up in.
- **The pause is skipped while the loop is draining a backlog** — as soon as `dequeue()` hands it a job from a run other than the one it just completed, it stops pausing until the queue next comes back empty. A worker chewing through unrelated queued work pays at most one pause.
- **`postJobYieldMs: 0`** disables it: lowest latency for a single-worker deployment, and multi-worker deployments go back to pinning each run to one worker.
- Suspended/async-batch stages are unaffected — they resume through `stage.pollSuspended` on the orchestration tick, which any worker may run.
