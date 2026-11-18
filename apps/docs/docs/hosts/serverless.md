---
sidebar_position: 2
title: Serverless Host
---

# Serverless Host

The **Serverless Host** (`@bratsos/workflow-engine-host-serverless`) is a stateless, single-invocation wrapper around the command kernel. It is designed for edge runtimes and serverless platforms like Cloudflare Workers, AWS Lambda, Deno Deploy, or Vercel Edge.

Rather than running persistent polling loops, the serverless host exposes functional entry points that you bind to your platform's queue trigger, cron trigger, or HTTP handler.

---

## Configuration

Initialize the host using `createServerlessHost`. It shares the same default settings (such as lease thresholds and heartbeat intervals) as the Node.js host.

```typescript
import { createServerlessHost } from "@bratsos/workflow-engine-host-serverless";
import { createKernel } from "@bratsos/workflow-engine/kernel";

const kernel = createKernel({ ... });
const jobTransport = createPrismaJobQueue(prisma);

const host = createServerlessHost({
  kernel,
  jobTransport,
  workerId: "edge-worker-1",
  
  // Optional tuning
  staleLeaseThresholdMs: 300_000, // default 5m: heartbeat tier of the job lease
  jobAbsoluteTimeoutMs: 3_600_000, // default 1h: absolute cap, 0 disables
  jobHeartbeatIntervalMs: 60_000, // default 1m: renews the lease, feeds ctx.abortSignal
  maxClaimsPerTick: 10,
  maxSuspendedChecksPerTick: 10,
  maxOutboxFlushPerTick: 100,
  flushOutboxAfterJob: true,      // default: publish this job's events before returning
  outboxFlushTimeoutMs: 10_000,   // bounds post-job and maintenance flushes; errors are logged, never thrown

  // Opt-in retention: run.purge deletes terminal runs older than this on
  // every maintenance tick. Off unless set.
  // retention: { olderThanMs: 30 * 24 * 60 * 60 * 1000 },

  // Which definition versions this host may claim, poll and dequeue.
  // Omit it and the kernel derives it from the registry, which is what
  // makes a rolling deploy safe; "all" turns version filtering off.
  // serves: "all",

  // Called at the end of every runMaintenanceTick() with a copy of its counts.
  // A hook that throws or rejects is logged and the tick still returns; the
  // call waits for it at most onTickTimeoutMs (default 5s), then returns the
  // counts and logs a warning.
  // onTick: async (counts) => { ... },
  // onTickTimeoutMs: 5_000,
});
```

---

## Entry Points

### 1. `handleJob(message)`
Execute a single pre-dequeued job. This is the optimal entry point when using platform queue integrations (like Cloudflare Queues or AWS SQS).

Your consumer takes a message from the queue, passes it to the host, and handles the outcome (e.g. ack or retry):

```typescript
// Example: Cloudflare Queue Handler
export default {
  async queue(batch: MessageBatch<any>, env: Env, ctx: ExecutionContext) {
    for (const msg of batch.messages) {
      const result = await host.handleJob({
        jobId: msg.id,
        workflowRunId: msg.body.workflowRunId,
        workflowId: msg.body.workflowId,
        stageId: msg.body.stageId,
        attempt: msg.body.attempt,
        payload: msg.body.payload,
      });

      if (result.outcome === "completed" || result.outcome === "suspended") {
        msg.ack();
      } else if (result.willRetry && !result.dead) {
        // failed with attempts left: the kernel left the stage PENDING and
        // expects the transport to re-deliver with backoff
        msg.retry({ delaySeconds: Math.ceil((result.retryDelayMs ?? 0) / 1000) });
      } else {
        // terminal (attempts exhausted), or a dead job (orphan, malformed
        // message, run/stage no longer exists): already failed and acknowledged
        msg.ack();
      }
    }
  }
};
```

`handleJob` returns `{ outcome, error?, dead?, willRetry?, attempt?, maxAttempts?, retryDelayMs? }`. A push transport whose `fail()` cannot re-enqueue (a Cloudflare Queue consumer) uses `willRetry` and `retryDelayMs` (the built-in transports' `2^attempt` seconds) to retry the message itself; `dead: true` means the message was failed and acknowledged up front and must not be retried. The transport's `maxAttempts` is the retry budget; a job whose run was cancelled, or whose run is pinned to a definition version this build does not serve, is handled the same way as on the Node host (see [Execution Model](../core-concepts/execution-model.md#ghost-job-guard)). If you deliver job messages through your own queue and built the message yourself, resolve a spilled payload first with `createPayloadSpill({ blobStore }).unpack(msg.payload)` (see [Kernel and Ports](../core-concepts/kernel-and-ports.md#job-payloads-opt-in-at-wiring)).

---

### 2. `processAvailableJobs(options)`
For environments that poll the queue rather than receive push triggers. It dequeues and processes available jobs up to the specified `maxJobs` limit.

```typescript
// Process up to 5 jobs in this execution context
const result = await host.processAvailableJobs({ maxJobs: 5 });

console.log(result);
// Output: { processed: 3, succeeded: 2, failed: 1 }
```

> [!TIP]
> Setting `maxJobs: 1` (default) is recommended for edge functions with strict CPU execution limits, as it prevents function terminations mid-execution.

---

### 3. `runMaintenanceTick()`
Because serverless functions are ephemeral, they cannot run continuous background loops. You must trigger a maintenance tick periodically (e.g. once per minute) using a scheduler or cron job (like Cloudflare Crons or AWS EventBridge).

The maintenance tick performs one cycle of:
1. **Claiming**: Finds runs in `PENDING` status this build serves and enqueues their first stages.
2. **Polling**: Replays `SUSPENDED` durable stages whose `nextPollAt` has passed — a `ctx.step.waitFor` poll, a batch status check, a sleep or signal keepalive.
3. **Lease Reaping**: Releases job locks from crashed worker nodes and fails jobs past `jobAbsoluteTimeoutMs`.
4. **Outbox Flushing**: Dispatches pending transactional outbox events to the `EventSink`.
5. **Stuck Run Detection**: Automatically fails runs that have ceased updates.
6. **Retention** (only with `retention` configured): `run.purge` deletes terminal runs past their age. See [Run Retention](../troubleshooting/overview.md#run-retention).

```typescript
// Example: Cron schedule trigger
export default {
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    const stats = await host.runMaintenanceTick();
    console.log(`Maintenance completed:`, stats);
    // Output:
    // {
    //   claimed: 2,
    //   suspendedChecked: 1,
    //   staleReleased: 0,
    //   eventsFlushed: 4,
    //   stuckReaped: 0,
    //   purged: 0,          // > 0 only with `retention` configured
    //   eventsFailed: 0,
    //   eventsDeadLettered: 0,
    //   eventSinkStatus: "healthy"   // or "degraded", with eventSinkError
    // }
  }
};
```

### Exporting gauges with `onTick`

`onTick` receives a copy of the counts `runMaintenanceTick()` returns (mutating it changes nothing the method returns), after the tick has finished and before the method returns them. A hook that throws or rejects is caught and logged, and the tick still returns its counts. The hook is awaited for at most `onTickTimeoutMs` (default `5000`, the same as `outboxFlushTimeoutMs`: both bound optional work the host awaits after its own commands finished, inside an invocation that has a time limit). When the bound passes, `runMaintenanceTick()` returns the counts, logs `[ServerlessHost] onTick hook did not settle within <n> ms; not waiting for it (it keeps running)` and leaves the hook running in the background, where the platform may cut it off when the invocation ends. `onTick` must be a function: anything else throws a `TypeError` from `createServerlessHost`. A hook that never settles therefore costs one bounded wait per tick and never withholds the counts. The bound covers a hook that yields: measured with a hook that never settles and `onTickTimeoutMs: 25`, `runMaintenanceTick()` returned after 28 ms. Synchronous code in the hook cannot be bounded: the timer fires only once it yields, so a body that computed for 60 ms delayed the return by 60 ms. `onTickTimeoutMs` must be a number from `1` to `2147483647` (the longest delay a timer honours, about 24.8 days); `Infinity`, `NaN`, zero or a negative number makes `createServerlessHost` throw a `RangeError`. Nothing switches the bound off: pass `2147483647` to wait for practically any hook. The same rule applies to every other option that reaches a timer: `outboxFlushTimeoutMs` and `jobHeartbeatIntervalMs` (and `runToCompletion`'s `jobHeartbeatIntervalMs`, checked before it creates the run). Dispatch [`engine.stats`](../core-concepts/kernel-and-ports.md#observing-the-engine) from it for queue depth and age. `metrics` below stands for your own metrics client; the engine depends on none.

If a timer option or `onTick` value cannot be formatted, the constructor still throws the validation error and describes the value as `Unprintable error`.

```typescript
const host = createServerlessHost({
  kernel,
  jobTransport,
  workerId: "edge-worker-1",
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

## Running a workflow inside a request: `runToCompletion`

Running a workflow synchronously in one request handler is a real pattern,
and until now every caller wrote the same drain loop by hand: create the run,
claim it, dequeue and execute jobs until none remain. `runToCompletion` is
that loop, once.

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

if (result.outcome === "completed") return Response.json(result.output);
if (result.outcome === "suspended") return new Response(null, { status: 202 });
return new Response(result.reason ?? "run failed", { status: 500 });
```

It returns `{ workflowRunId, status, outcome, output?, reason?, jobsProcessed,
foreignJobsProcessed, suspendedStageId? }`. `outcome` is `"completed"`,
`"failed"` or `"cancelled"` when the run reached a terminal state, and
`"suspended"` or `"incomplete"` when it did not — those two are not errors,
they say the run is alive and something else has to carry it.

### Three things to know before you use it

**1. It shares the queue, so it can execute another caller's job.** The
kernel's queue is global: `run.claimPending` claims whichever runs are
pending, and `dequeue()` returns whichever job is next. Neither can be
narrowed to one run, so this call may start other callers' runs and execute
their jobs — inside your request's latency and error budget.
`foreignJobsProcessed` reports how many jobs it ran that belonged to someone
else. If that matters, give the call a kernel wired to its own
`jobTransport`, so the only jobs it can see are the ones it created.

**2. It cannot complete a workflow that suspends.** A durable sleep, wait or
signal parks the stage until a later poll, and that poll is not this request.
Rather than spin, it returns immediately with `outcome: "suspended"` and the
stage that parked; a background host or a scheduled `runMaintenanceTick()`
resumes the run. Workflows you intend to run this way should have no durable
waits.

**3. It is bounded, never an unbounded loop.** `maxJobs` (default 50) caps
the jobs one call executes and `maxClaimRounds` (default 5) caps the search
for this run's first job. Hitting either returns `outcome: "incomplete"` with
a `reason`; it never throws and never keeps going. The same applies when a
stage fails and is re-enqueued with a retry backoff: the job is not due yet,
the queue is empty, and the call returns rather than waiting for it.

It deliberately does not poll suspended stages or reap stale leases — that is
maintenance, it is exactly what would make it spin, and
`host.runMaintenanceTick()` already owns it.

Options: `kernel`, `jobTransport`, `persistence`, `command`, plus `workerId`,
`maxJobs`, `maxClaimRounds`, `claimsPerRound`, `jobHeartbeatIntervalMs`,
`flushOutbox` (default true — publish the run's events before returning),
`maxOutboxFlush` and `logPrefix`.

### Refused storage

There is no `start()` here, so every call of `handleJob`, `processAvailableJobs` or `runMaintenanceTick` first calls the job transport's optional `verifyStorage()` and throws its error when the storage may not be used: with the Prisma SQLite adapters, a file another Prisma major wrote (`SqliteDateStorageError`, see [A SQLite file belongs to the Prisma major that created it](../persistence/prisma-setup.md#a-sqlite-file-belongs-to-the-prisma-major-that-created-it)). Nothing is dispatched. The host remembers nothing: the Prisma job queue answers from its own cache once a check is conclusive, and checks again after a failure (`SqliteDateStorageUnverifiedError`) or on a file with no stored date.

### Degraded event sink

`eventSinkStatus` is `"degraded"` when the flush in this tick could not
publish at least one event. Those events stay committed in the outbox and the
next flush retries them; the run keeps progressing regardless, because the
poller -- not the sink -- is what advances it.

There is no process to carry the state between invocations here, so the
serverless host reports it per tick (and logs it per tick) rather than on a
transition; alert on a *run* of degraded ticks. `eventsDeadLettered` counts
events that exhausted their retry budget in this tick: those stop retrying on
their own and need a `plugin.replayDLQ` dispatch once the sink is back.

A timed-out outbox flush starts no further claims or sink calls. A claim already sent to the database can finish, and a sink call already in flight can settle under its original owner fence. A tick on a caller-owned transaction reports `outboxDeferred: true`. Flush on the root client after commit.
