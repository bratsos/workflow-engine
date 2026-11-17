---
sidebar_position: 1
title: Node.js Host
---

# Node.js Host

The **Node.js Host** (`@bratsos/workflow-engine-host-node`) is a long-running daemon worker designed to poll for jobs, execute them, and run orchestration ticks in a continuous loop. It is recommended for production environments like Docker containers, VM instances, or persistent cloud hosting.

---

## Basic Configuration

The Node host requires a compiled **Kernel** and a **JobTransport** adapter.

```typescript
import { createKernel } from "@bratsos/workflow-engine/kernel";
import { createNodeHost } from "@bratsos/workflow-engine-host-node";
import { createPrismaJobQueue } from "@bratsos/workflow-engine/persistence/prisma";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) }); // Prisma 8: fromPrisma8(db)
const jobTransport = createPrismaJobQueue(prisma);

const kernel = createKernel({
  persistence: createPrismaWorkflowPersistence(prisma),
  blobStore: myBlobStore,
  jobTransport,
  eventSink: myEventSink,
  clock: { now: () => new Date() },
  registry: myRegistry,
});

// Create the host daemon
const host = createNodeHost({
  kernel,
  jobTransport,
  workerId: "worker-prod-1", // Unique ID for this host process
});

// Start executing loops
await host.start();
```

---

## Host Configuration Options

You can tune the host's polling frequency, lease times, and execution limits:

| Option | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| **`kernel`** | `Kernel` | *Required* | The command kernel instance. |
| **`jobTransport`** | `JobTransport` | *Required* | The job queue database adapter. |
| **`workerId`** | `string` | *Required* | Unique name identifying this host worker in execution logs. |
| **`orchestrationIntervalMs`**| `number` | `10000` (10s) | How often to run orchestration tasks (claim pending, poll suspended, reap leases, flush outbox). |
| **`jobPollIntervalMs`** | `number` | `1000` (1s) | How often to poll the job queue for new execution jobs. |
| **`postJobYieldMs`** | `number` | `jobPollIntervalMs` | Upper bound on the randomised pause this worker takes after *completing* a job before asking for the next one, so a multi-stage run is not pinned to the worker that advanced it. Skipped while draining a backlog; `0` disables it. |
| **`staleLeaseThresholdMs`** | `number` | `300000` (5m) | How long a job lease may go without a heartbeat before `lease.reapStale` releases it for retry (measured on the database clock on PostgreSQL). |
| **`jobAbsoluteTimeoutMs`** | `number` | `3600000` (1h) | Absolute cap on one job claim, measured from `startedAt`, which no heartbeat refreshes. A job past it is failed terminally (`LEASE_ABSOLUTE_CAP`); a stage that legitimately runs longer must raise it. `0` disables the tier. |
| **`jobHeartbeatIntervalMs`**| `number` | `60000` (60s) | How often to dispatch `job.heartbeat` while executing a job: renews the lease and aborts `ctx.abortSignal` when the run was cancelled or the lease lost. |
| **`maxClaimsPerTick`** | `number` | `10` | Maximum number of pending workflow runs to claim in a single orchestration tick. |
| **`maxSuspendedChecksPerTick`**| `number` | `10` | Maximum number of suspended stage completion checks to perform in a single tick. |
| **`maxOutboxFlushPerTick`** | `number` | `100` | Maximum number of outbox events to publish in a single tick. |
| **`outboxFlushTimeoutMs`** | `number` | `5000` | Maximum time a maintenance tick waits for the sink. An in-flight emit can continue after the timeout. |
| **`retention`** | `{ olderThanMs, statuses?, limit? }` | off | Delete terminal runs older than `olderThanMs` (with their stages, logs, artifacts, annotations, step ledger, job rows and blobs) through `run.purge` at the end of every tick. Nothing is deleted unless set. See [Run Retention](../troubleshooting/overview.md#run-retention). |
| **`onTick`** | `(counts: MaintenanceTickCounts) => void \| Promise<void>` | none | Called after every orchestration tick with a copy of the counts that tick computed. Must be a function: anything else throws a `TypeError` from `createNodeHost`. It runs outside the tick, so ticks never wait for what it awaits (its synchronous code runs on the host's thread): at most one call is in flight, and a tick that finds the previous call still running skips the hook and logs one warning at the first skip. A hook that throws or rejects is caught and logged. A hook must not await `host.stop()`. See [Exporting gauges with `onTick`](#exporting-gauges-with-ontick). |
| **`serves`** | `ServedDefinition[] \| "all"` | derived from the registry | Which definition versions this host may claim, poll and dequeue. Left unset, the kernel derives it from the registry, which is what makes a rolling deploy safe. `"all"` turns version filtering off entirely — the pre-1.0 behaviour. See [Definition versioning](../core-concepts/definition-versioning.md). |
| **`shutdownTimeoutMs`** | `number` | `10000` (10s) | Upper bound on `stop()`: how long to wait for the in-flight orchestration tick and `onTick` call, then for the in-flight job to finish, and separately for the final outbox flush. |
| **`flushOutboxOnStop`** | `boolean` | `true` | Attempt a final `outbox.flush` in `stop()`; events not delivered before the timeout remain available to a later flush. |

Every option that reaches a timer (`orchestrationIntervalMs`, `jobPollIntervalMs`, `postJobYieldMs`, `jobHeartbeatIntervalMs`, `shutdownTimeoutMs`) must be a number of milliseconds from `1` to `2147483647` (the longest delay a timer honours, about 24.8 days); `postJobYieldMs` may also be `0`, which turns the pause off. Anything else (`Infinity`, `NaN`, zero, a negative number) makes `createNodeHost` throw a `RangeError` that names the option, because a timer fires after 1 ms on such a value: an interval becomes a busy loop and a bound meant as "no limit" becomes the tightest one. Nothing switches `shutdownTimeoutMs` off; pass `2147483647` to wait for practically anything. `runAndWait` applies the same rule to `pollIntervalMs`, before it creates the run.

`start()` first calls the job transport's optional `verifyStorage()` and rejects with its error, before it starts a timer, a loop or a signal handler, when the storage may not be used: with the Prisma SQLite adapters that is a file another Prisma major wrote (`SqliteDateStorageError`, see [A SQLite file belongs to the Prisma major that created it](../persistence/prisma-setup.md#a-sqlite-file-belongs-to-the-prisma-major-that-created-it)). Without it the host would run and log the same error on every tick. A check that cannot run rejects `start()` with `SqliteDateStorageUnverifiedError`; call `start()` again to retry. A `stop()` that returns while the check is still pending cancels the start: nothing is installed when the check settles.

`workerId` also reaches `job_queue.workerId`: a `createPrismaJobQueue(prisma)` built without a `workerId` of its own adopts the host's on `start()`, so the job row says which worker ran the stage.

---

## Process Management & Signal Handling

The Node.js host automatically hooks into the Node process handlers. Calling `await host.start()` registers listeners for `SIGTERM` and `SIGINT` to perform a **graceful shutdown**.

### Graceful Shutdown
During a graceful shutdown (when `SIGTERM` is received, or `host.stop()` is called):
1. The host stops accepting new jobs from the queue and skips further orchestration ticks.
2. The job currently running, and any orchestration tick in flight, are allowed to finish (bounded by `shutdownTimeoutMs`).
3. A final `outbox.flush` publishes the events this process committed (unless `flushOutboxOnStop: false`).
4. The `host.start()` promise resolves. Errors during shutdown are logged, never thrown.

If your process manager (e.g. PM2, Kubernetes) manages process lifecycles, you can manually trigger a stop:

```typescript
// worker.ts
import { host } from "./host-setup";

process.on("SIGTERM", async () => {
  console.log("SIGTERM received, shutting down gracefully...");
  await host.stop();
  process.exit(0);
});

await host.start();
```

---

## Runtime Monitoring

You can inspect the operational health of your worker at runtime using `host.getStats()`:

```typescript
const stats = host.getStats();
console.log(stats);
// Output:
// {
//   workerId: "worker-prod-1",
//   jobsProcessed: 1420,
//   orchestrationTicks: 120,
//   isRunning: true,
//   uptimeMs: 1200000,
//   eventSink: {
//     status: "healthy",        // or "degraded"
//     since: 1735689600000,     // when this status began (epoch ms)
//     consecutiveFailures: 0,
//     deadLettered: 0,
//     lastError: null
//   }
// }
```

### Degraded event sink

`stats.eventSink` is the named state of the event sink as of this host's last
outbox flush.

* **`healthy`** -- the last flush published everything it claimed.
* **`degraded`** -- the last flush could not publish at least one event.

Events are delivered at least once while retries remain. Delivery can duplicate whenever the sink effect happens without a durable acknowledgement. Examples include a crash or write error after acceptance, an emit in flight at expiry, a sink that commits and then rejects, and partial plugin success. Deduplicate using the outbox `eventId` supplied to the sink or plugin. `workflowRunId` and `sequence` order events within a run, but are not a permanent identity: after an operator deletes the newest outbox rows, the Prisma store can reuse a sequence. Failures exhaust the retry budget and move the event to the DLQ; `plugin.replayDLQ` makes it eligible again. The engine’s progress never depends on the sink. After `run.purge`, a flush skips a live claim until it completes or expires, skips published rows, and skips dead letters until replay. The engine never deletes outbox rows; operators remove them with SQL.
Events live in the transactional outbox, the poller (not the sink) is what
advances a run, and the events left behind are retried on the next flush. A
run started while the sink is down still reaches `COMPLETED`.

The host logs a single line on each transition (`event sink DEGRADED ...` and
`event sink recovered ...`), rather than one per tick, so a sink that is down
for an hour does not drown the log. It logs unconditionally whenever events
were dead-lettered:

```
[NodeHost] event sink DEAD-LETTERED 3 event(s) (3 total in this process):
they will not be delivered until replayed with the plugin.replayDLQ command
```

Dead-lettering is the point at which delivery genuinely cannot proceed on its
own: those events have exhausted their retry budget and stop retrying. Alert
on `eventSink.status === "degraded"` to see the problem before the queue
fills, and on `eventSink.deadLettered` growing to see that it already has.
Replay them with the `plugin.replayDLQ` command once the sink is back.

### Exporting gauges with `onTick`

`onTick` receives a copy of the counts of the tick that just ran (mutating it changes nothing else; `claimed`, `suspendedChecked`, `staleReleased`, `staleExpired`, `eventsFlushed`, `stuckReaped`, `purged`, `eventsFailed`, `eventsDeadLettered`, `eventSinkStatus` and, when the sink is degraded, `eventSinkError`). Dispatch [`engine.stats`](../core-concepts/kernel-and-ports.md#observing-the-engine) from it for queue depth and age. `metrics` below stands for your own metrics client; the engine depends on none.

```typescript
const host = createNodeHost({
  kernel,
  jobTransport,
  workerId: "worker-prod-1",
  onTick: async (counts) => {
    metrics.increment("workflow_events_flushed", counts.eventsFlushed);

    const stats = await kernel.dispatch({ type: "engine.stats" });
    if (stats.jobs.available) {
      metrics.gauge("workflow_jobs_pending", stats.jobs.byStatus.PENDING);
      metrics.gauge("workflow_jobs_oldest_pending_age_ms", stats.jobs.oldestPendingAgeMs ?? 0);
    }
    if (stats.outbox.available) {
      metrics.gauge("workflow_outbox_dead_lettered", stats.outbox.deadLettered);
    }
  },
});
```

The hook runs outside the tick, so the engine's liveness does not depend on it: claiming, polling suspended stages, lease reaping, the outbox flush and `run.reapStuck` go on whatever the hook awaits. This holds for a hook that yields (awaits I/O or a timer): measured with a hook that never settles, the host ran 16 ticks in 155 ms against 15 without a hook. Synchronous code in the hook runs on the host's thread and no tick runs while it does: a hook that computed for 40 ms on each call at a 10 ms interval left room for five calls in 202 ms. Keep the hook's synchronous part short and await the rest.

- At most one call is in flight. A tick that finds the previous call still running skips the hook and logs one warning the first time that happens (`[NodeHost] onTick hook is still running after <n> ms and ticks skip it while it runs; ...`); the hook is called again on the first tick after it settles. The warning is not repeated while the hook stays slower than the interval: a call that finishes without any tick having skipped it ends the episode, and the next skip warns again. A hook that never settles is therefore called once and warned about once, and gauges stop updating until it does settle: bound what it waits on (a timeout on the HTTP call) so they do not.
- A hook that throws or rejects is caught and logged (`[NodeHost] onTick hook error:`); it never stops the loop.
- `stop()` waits for a running hook for at most `shutdownTimeoutMs`, together with the in-flight tick. No hook starts once `stop()` has begun.
- A hook must not `await host.stop()`. `stop()` waits for the running hook, which is waiting for `stop()`, so the call returns only after `shutdownTimeoutMs` has elapsed (the host is already stopping by then, and the hook is not called again). Call `void host.stop()` from a hook if it has to stop the host, or stop it from outside.

---

## One-Shot Run Helper: `runAndWait`

Spinning up a host, dispatching a `run.create` command, and hand-rolling a poll loop is a lot of ceremony for a script, a test, or a request/response-style caller that just wants a run's final result. `runAndWait` collapses all of that into a single awaited call.

Reach for `runAndWait` when the calling code needs a run's result inline -- a CLI script, a test, an API handler awaiting a workflow before responding. Reach for `host.start()` plus `kernel.dispatch()` directly when you're building a long-running worker that should keep polling for new runs indefinitely; `runAndWait` is scoped to a single run's lifecycle, not a daemon process.

### How It Works

1. Dispatches `command` via `kernel.dispatch()` to create the run.
2. Checks `host.getStats().isRunning`. If the host isn't already running, `runAndWait` starts it.
3. Polls `persistence.getRun()` and `persistence.getStagesByRun()` every `pollIntervalMs`, calling `onStageChange` whenever the stage-status snapshot actually changes.
4. Returns once the run reaches a terminal status: `COMPLETED`, `FAILED`, or `CANCELLED`.
5. Stops the host again in a `finally` block -- but only if this call was the one that started it. A host that was already running before `runAndWait` was called is left running afterward.
6. Supports cooperative cancellation through `signal`: an aborted signal throws `Error("runAndWait aborted")`, both at the start of each poll iteration and while sleeping between polls.

### Options

| Option | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| **`kernel`** | `Kernel` | *Required* | The command kernel instance to dispatch `command` to. |
| **`persistence`** | `RunAndWaitPersistence` | *Required* | A minimal structural subset of `WorkflowPersistence` -- just `getRun` and `getStagesByRun` -- used to poll run and stage status. |
| **`host`** | `NodeHost` | *Required* | The host to start (if it isn't already running) and poll against while the run executes. |
| **`command`** | `RunCreateCommand` | *Required* | The `run.create` command to dispatch. |
| **`pollIntervalMs`** | `number` | `3000` (3s) | How often to re-check run and stage status. |
| **`onStageChange`** | `(stages: StageStatus[]) => void` | *Optional* | Called whenever the stage-status snapshot changes during polling. |
| **`signal`** | `AbortSignal` | *Optional* | Cooperatively aborts the wait; throws `Error("runAndWait aborted")`. |

### Result Shape

`runAndWait` resolves with the run's terminal state:

```typescript
interface RunAndWaitResult {
  runId: string;
  status: "COMPLETED" | "FAILED" | "CANCELLED";
  stages: StageStatus[];
  totalCost: number;
  totalTokens: number;
  duration: number | null;
  output: unknown | null;
}

interface StageStatus {
  stageId: string;
  stageName: string;
  status: string;
  duration: number | null;
}
```

### Example

```typescript
import { runAndWait } from "@bratsos/workflow-engine-host-node";
import crypto from "crypto";

const result = await runAndWait({
  kernel,
  persistence: createPrismaWorkflowPersistence(prisma),
  host,
  command: {
    type: "run.create",
    idempotencyKey: crypto.randomUUID(),
    workflowId: "document-analysis",
    input: { url: "https://example.com" },
  },
  onStageChange: (stages) => console.log("stages updated:", stages),
});

console.log(`Run ${result.runId} finished as ${result.status}`);
console.log(result.output);
```

A flush starts no further claims or sink calls after its timeout or after Node shutdown cancels its tick. A claim already sent to the database can finish, and a sink call already in flight can settle under its original owner fence.
