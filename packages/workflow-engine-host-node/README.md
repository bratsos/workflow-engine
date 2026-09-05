# @bratsos/workflow-engine-host-node

Node.js host for the [`@bratsos/workflow-engine`](../workflow-engine) command kernel. Provides process loops, signal handling, and continuous job processing.

## Installation

```bash
npm install @bratsos/workflow-engine-host-node
```

## Quick Start

```typescript
import { createKernel } from "@bratsos/workflow-engine/kernel";
import { createNodeHost } from "@bratsos/workflow-engine-host-node";
import { createPrismaJobQueue } from "@bratsos/workflow-engine";

const kernel = createKernel({ /* ... */ });
const jobTransport = createPrismaJobQueue(prisma);

const host = createNodeHost({
  kernel,
  jobTransport,
  workerId: "worker-1",
});

await host.start();
```

## API

### `createNodeHost(config): NodeHost`

Creates a new Node host instance.

### `NodeHostConfig`

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `kernel` | `Kernel` | required | Kernel instance to dispatch commands to |
| `jobTransport` | `JobTransport` | required | Job transport for dequeue/complete/suspend/fail |
| `workerId` | `string` | required | Unique worker identifier; `start()` also stamps it on the job transport (see below) |
| `orchestrationIntervalMs` | `number` | `10_000` | Interval for claim/poll/reap/flush orchestration tick |
| `jobPollIntervalMs` | `number` | `1_000` | Interval for polling job queue when empty |
| `postJobYieldMs` | `number` | `jobPollIntervalMs` | Upper bound on the randomised pause after a completed job (`0` disables it) |
| `staleLeaseThresholdMs` | `number` | `300_000` | Heartbeat tier: a job whose lease (measured from `lockedAt`, on the database clock for Postgres) is older is re-queued with `lastError` prefixed `LEASE_HEARTBEAT_LOST` |
| `jobAbsoluteTimeoutMs` | `number` | `3_600_000` | Absolute tier: a job claimed longer ago than this (from `startedAt`, which no heartbeat refreshes) is failed terminally with `LEASE_ABSOLUTE_CAP`; `0` disables |
| `jobHeartbeatIntervalMs` | `number` | `60_000` | How often the job in flight dispatches `job.heartbeat`, which renews its lease and aborts the stage's `ctx.abortSignal` when the run is cancelled or the lease is lost |
| `maxClaimsPerTick` | `number` | `10` | Max pending runs to claim per orchestration tick |
| `serves` | `ServedDefinition[] \| "all"` | derived from registry | Which definition versions this host claims, dequeues and polls; `"all"` restores the pre-1.0 predicate |
| `maxSuspendedChecksPerTick` | `number` | `10` | Max suspended stages to poll per tick |
| `maxOutboxFlushPerTick` | `number` | `100` | Max outbox events to flush per tick |
| `retention` | `RetentionOptions` | off | `{ olderThanMs, statuses?, limit? }`: delete terminal runs older than this through `run.purge` at the end of every tick |
| `shutdownTimeoutMs` | `number` | `10_000` | Bound on `stop()`: wait for the in-flight job, then for the final outbox flush |
| `flushOutboxOnStop` | `boolean` | `true` | Run a final `outbox.flush` in `stop()` |

### `NodeHost`

| Method | Returns | Description |
|--------|---------|-------------|
| `start()` | `Promise<void>` | Start polling loops and register SIGTERM/SIGINT handlers |
| `stop()` | `Promise<void>` | Graceful shutdown -- clears timers and signal handlers, waits (bounded) for the in-flight job, then runs a final `outbox.flush` so a run this process finished is published before exit |
| `getStats()` | `HostStats` | Runtime statistics |

### `HostStats`

```typescript
interface HostStats {
  workerId: string;
  jobsProcessed: number;
  orchestrationTicks: number;
  isRunning: boolean;
  uptimeMs: number;
  /** Event sink state as of the last flush: { status, since, consecutiveFailures, deadLettered, lastError } */
  eventSink: EventSinkHealth;
}
```

A `"degraded"` event sink never stalls a run — the poller advances runs and events stay committed in the outbox — but it is worth alerting on before `deadLettered` climbs. The host logs one line per transition rather than one per tick, and unconditionally when events were dead-lettered (recover them with `plugin.replayDLQ`).

## How It Works

The host runs two concurrent loops:

1. **Orchestration timer** (every `orchestrationIntervalMs`):
   - `run.claimPending` -- claim pending runs this build serves (`serves`), enqueue first-stage jobs
   - `stage.pollSuspended` -- check if suspended stages are ready to resume (durable-step waits, signals, batch polls)
   - `lease.reapStale` -- re-queue jobs whose heartbeat stopped; fail jobs past `jobAbsoluteTimeoutMs`
   - `outbox.flush` -- publish pending events through EventSink
   - `run.reapStuck` -- fail RUNNING runs with no recent activity; re-enqueue a PENDING stage that lost its job
   - `run.purge` -- only when `retention` is set: delete terminal runs older than `olderThanMs`

   A firing that lands while the previous tick is still running is skipped, not queued, so a suspended-stage replay longer than the interval never overlaps the next tick in this process; `orchestrationTicks` counts only ticks that ran. Several hosts may tick against one database: the kernel claims each suspended stage before polling it, and a run pinned to a definition version this build does not serve is left for a host that does.

2. **Job processing loop** (continuous):
   - Dequeue next job from `jobTransport` (filtered by `serves`)
   - Dispatch `job.execute` to the kernel, dispatching `job.heartbeat` every `jobHeartbeatIntervalMs` while it runs; a cancelled run or a lost lease aborts the stage's `ctx.abortSignal`
   - On completion: mark complete, dispatch `run.transition`
   - On suspension: mark suspended with next poll time
   - On failure: mark failed with retry flag
   - Every acknowledgement carries a fence (`{ startedAt, attempt }`): a stale worker whose job was re-claimed writes nothing, logs `superseded`, and skips the `run.transition` the newer attempt owns
   - A job whose run is still `PENDING` (`ghostReason: "race"`) is re-delivered; one this build cannot serve (`"version"`) is deferred without spending its attempt; an orphan whose run, workflow or stage no longer exists is failed and acknowledged as dead
   - Sleep `jobPollIntervalMs` when queue is empty
   - After a completed job, pause for a uniform draw over `[0, postJobYieldMs)` — unless draining a backlog

Signal handlers (`SIGTERM`, `SIGINT`) automatically call `stop()` for graceful shutdown. `stop()` lets the in-flight orchestration tick and the job in flight finish (each up to `shutdownTimeoutMs`) and then flushes the outbox once more, bounded by the same timeout, so `workflow:completed` for a run this process finished reaches the `EventSink` (and your plugins) here rather than in whichever process ticks next. Flush errors are logged, not thrown. Set `flushOutboxOnStop: false` when another process owns event publication.

### `workerId` and the job transport

`job_queue.workerId` is written by the transport, not the host, and the transport is built first — left alone, `createPrismaJobQueue(prisma)` generated `worker-<pid>-<timestamp>`, an id no host answered to. As of 0.4.4 `start()` offers this host's `workerId` to the transport (`JobTransport.adoptWorkerId`, optional on the port): a transport with no `workerId` of its own adopts it, one built with an explicit id keeps it and the host logs a single `workerId mismatch` line naming both. Build the queue as `createPrismaJobQueue(prisma)` under a host.

### Spreading one run across workers

The host that completes a job is the one that dispatches `run.transition`, so it enqueues the next execution group from its own process. Before 0.4.4 it then went straight back to `dequeue()` while every other worker was still parked in its `jobPollIntervalMs` timer, and won the stage it had just created almost every time — a sequential pipeline ran end-to-end on a single worker however many were alive.

The loop now pauses for a uniform draw over `[0, postJobYieldMs)` after a **completed** job (the only outcome that enqueues a successor from this process), giving this worker the same phase as every competitor. `postJobYieldMs` defaults to `jobPollIntervalMs`; set it to `0` to turn the pause off (lowest latency for a single-worker deployment, at the cost of pinning each run to one worker again).

The pause is skipped while the loop is draining a backlog: once `dequeue()` hands it a job from a run other than the one it just completed, it stops pausing until the queue comes back empty, so a queue with real work in it costs at most one pause rather than one per job.

On failure, the job loop marks the job failed with a retry flag while the job has attempts left (`maxAttempts` on the transport); the kernel has already left the stage `PENDING` with the error, and the queue re-delivers it with backoff. Once the attempts are exhausted the stage is `FAILED` and `run.transition` is dispatched immediately.

## Worker Process Pattern

```typescript
// worker.ts
import { host } from "./setup";

await host.start();
// Host runs until SIGTERM/SIGINT or host.stop() is called
```

```bash
npx tsx worker.ts
```

## One-Shot Run Helper

For scripts, tests, or request/response-style callers, `runAndWait` dispatches a run and resolves with its terminal result -- no hand-written poll loop, no manual host start/stop.

### `runAndWait(options): Promise<RunAndWaitResult>`

Dispatches `command` via `kernel.dispatch()`, starts `host` if it isn't already running, and polls until the run reaches a terminal status. If `runAndWait` started the host, it stops it again afterward; a host that was already running is left running.

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `kernel` | `Kernel` | required | Kernel instance to dispatch `command` to |
| `persistence` | `RunAndWaitPersistence` | required | Minimal structural subset of `WorkflowPersistence` (`getRun`, `getStagesByRun`) used for polling |
| `host` | `NodeHost` | required | Host to start (if needed) and poll against |
| `command` | `RunCreateCommand` | required | The `run.create` command to dispatch |
| `pollIntervalMs` | `number` | `3_000` | Interval between polls |
| `onStageChange` | `(stages: StageStatus[]) => void` | none | Called when the stage-status snapshot changes |
| `signal` | `AbortSignal` | none | Aborts the wait; throws `Error("runAndWait aborted")` |

### `RunAndWaitResult`

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

Dispatch a run and log the result once it finishes:

```typescript
import { runAndWait } from "@bratsos/workflow-engine-host-node";
import crypto from "crypto";

const result = await runAndWait({
  kernel,
  persistence,
  host,
  command: {
    type: "run.create",
    idempotencyKey: crypto.randomUUID(),
    workflowId: "document-analysis",
    input: { url: "https://example.com" },
  },
});

console.log(result.status, result.output);
```

## Multi-Worker

Multiple workers can share the same database. Each needs a unique `workerId`:

```typescript
// worker-1
createNodeHost({ kernel, jobTransport, workerId: "worker-1" });

// worker-2
createNodeHost({ kernel, jobTransport, workerId: "worker-2" });
```

Run claiming uses `FOR UPDATE SKIP LOCKED` in PostgreSQL to prevent race conditions.

### Rolling deploys

Build the kernel's registry with `createWorkflowRegistry(workflows)`. A run is pinned to the structural version of its workflow at `run.create`, and a host only claims, dequeues and polls runs whose `(workflowId, version)` it serves — old workers finish their own runs, new workers never adopt an incompatible one. Leave `serves` unset to derive it from the registry; `serves: "all"` restores the pre-1.0 behaviour. `run.listVersions` shows which versions still have runs and whether this build serves them; `run.redrive` with `definitionVersion: "latest"` moves a stranded run forward.

## License

MIT
