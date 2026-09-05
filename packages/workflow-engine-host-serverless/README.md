# @bratsos/workflow-engine-host-serverless

Platform-agnostic serverless host for the [`@bratsos/workflow-engine`](../workflow-engine) command kernel. Works with Cloudflare Workers, AWS Lambda, Vercel Edge, Deno Deploy, and any stateless runtime.

## Installation

```bash
npm install @bratsos/workflow-engine-host-serverless
```

## Quick Start

```typescript
import { createKernel } from "@bratsos/workflow-engine/kernel";
import { createServerlessHost } from "@bratsos/workflow-engine-host-serverless";

const kernel = createKernel({ /* ... */ });

const host = createServerlessHost({
  kernel,
  jobTransport,
  workerId: "my-worker",
});

// Handle a job from a queue message
const result = await host.handleJob(msg);

// Run maintenance from a cron trigger
const tick = await host.runMaintenanceTick();
```

## API

### `createServerlessHost(config): ServerlessHost`

Creates a new serverless host instance.

### `ServerlessHostConfig`

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `kernel` | `Kernel` | required | Kernel instance to dispatch commands to |
| `jobTransport` | `JobTransport` | required | Job transport for complete/suspend/fail lifecycle |
| `workerId` | `string` | required | Unique worker identifier (e.g. function name) |
| `staleLeaseThresholdMs` | `number` | `300_000` | Heartbeat tier: a job whose lease is older is re-queued (`LEASE_HEARTBEAT_LOST`) |
| `jobAbsoluteTimeoutMs` | `number` | `3_600_000` | Absolute tier: a job claimed longer ago than this is failed terminally (`LEASE_ABSOLUTE_CAP`); `0` disables |
| `jobHeartbeatIntervalMs` | `number` | `60_000` | How often `handleJob` dispatches `job.heartbeat` while the stage runs; it renews the lease and aborts `ctx.abortSignal` on cancel or lease loss |
| `maxClaimsPerTick` | `number` | `10` | Max pending runs to claim per maintenance tick |
| `serves` | `ServedDefinition[] \| "all"` | derived from registry | Which definition versions this host claims, dequeues and polls; `"all"` restores the pre-1.0 predicate |
| `maxSuspendedChecksPerTick` | `number` | `10` | Max suspended stages to poll per tick |
| `maxOutboxFlushPerTick` | `number` | `100` | Max outbox events to flush per tick |
| `retention` | `RetentionOptions` | off | `{ olderThanMs, statuses?, limit? }`: delete terminal runs through `run.purge` at the end of every tick |
| `flushOutboxAfterJob` | `boolean` | `true` | Publish the job's outbox events right after `handleJob` settles it |
| `outboxFlushTimeoutMs` | `number` | `5_000` | Bound on that post-job flush; errors are logged, not thrown |

### `ServerlessHost`

| Method | Returns | Description |
|--------|---------|-------------|
| `handleJob(msg)` | `Promise<JobResult>` | Execute a single pre-dequeued job |
| `processAvailableJobs(opts?)` | `Promise<ProcessJobsResult>` | Dequeue and process jobs |
| `runMaintenanceTick()` | `Promise<MaintenanceTickResult>` | Run one bounded maintenance cycle |

### `JobMessage`

The shape of a job message passed to `handleJob()`:

```typescript
interface JobMessage {
  jobId: string;
  workflowRunId: string;
  workflowId: string;
  stageId: string;
  attempt: number;
  maxAttempts?: number; // retry budget; defaults to 3
  payload: Record<string, unknown>;
}
```

A message delivered through your own push queue may carry a spilled payload if you wrapped the transport with `createSpillingJobTransport`; resolve it first with `createPayloadSpill({ blobStore }).unpack(msg.payload)` (both from `@bratsos/workflow-engine/kernel`).

### `JobResult`

```typescript
interface JobResult {
  outcome: "completed" | "suspended" | "failed";
  error?: string;
  /** The message was an orphan or malformed; it was failed and acknowledged. */
  dead?: boolean;
  /** The stage was left PENDING and the job must run again. */
  willRetry?: boolean;
  /** The job attempt that ran (1 on the first execution). */
  attempt?: number;
  maxAttempts?: number;
  /** Backoff before the retry (2^attempt seconds), when `willRetry`. */
  retryDelayMs?: number;
}
```

The consumer's ack/retry decision reads `willRetry`, not `outcome`: a failed attempt with attempts left is `outcome: "failed", willRetry: true`, and the stage row is `PENDING` waiting for the next delivery. A transport whose `fail()` re-enqueues (the built-in Prisma and in-memory queues) has already re-queued the job — acknowledge the message. A push transport whose `fail()` cannot re-enqueue (a Cloudflare Queue consumer has to call `msg.retry()` itself) retries the message after `retryDelayMs`; when `willRetry` is false (settled, or `dead`) acknowledge it. Acknowledging a `willRetry: true` result without retrying leaves the run `RUNNING` until `run.reapStuck` heals it. A message without `payload` or `workflowId` is rejected as a dead job (`dead: true`, failed and acknowledged) instead of throwing.

### `ProcessJobsResult`

```typescript
interface ProcessJobsResult {
  processed: number;
  succeeded: number;
  failed: number;
}
```

### `MaintenanceTickResult`

```typescript
interface MaintenanceTickResult {
  claimed: number;            // Pending runs claimed
  suspendedChecked: number;   // Suspended stages polled
  staleReleased: number;      // Stale leases re-queued (heartbeat tier)
  eventsFlushed: number;      // Outbox events published
  stuckReaped: number;        // RUNNING runs failed for inactivity
  purged: number;             // Terminal runs deleted; 0 unless `retention` is set
  eventsFailed: number;       // Events the next flush will retry
  eventsDeadLettered: number; // Events that exhausted their retries (disjoint from eventsFailed)
  eventSinkStatus: "healthy" | "degraded";
  eventSinkError?: string;    // First publish failure of this tick, when degraded
}
```

There is no process to carry event-sink state across invocations, so a serverless caller reads `eventSinkStatus` per tick and alerts on a run of `"degraded"` results; runs keep progressing either way.

### `runToCompletion(options)`

A supported synchronous drain loop for callers who need the run's result inside the request that created it:

```typescript
import { runToCompletion } from "@bratsos/workflow-engine-host-serverless";

const result = await runToCompletion({
  kernel,
  jobTransport,
  persistence,       // { getRun } — the WorkflowPersistence you gave the kernel works
  command: {
    type: "run.create",
    idempotencyKey: crypto.randomUUID(),
    workflowId: "document-processor",
    input: { url: "https://example.com" },
  },
  maxJobs: 50,       // default
  maxClaimRounds: 5, // default
});

// { workflowRunId, status, outcome, output?, reason?, jobsProcessed, foreignJobsProcessed, suspendedStageId? }
if (result.outcome === "completed") return Response.json(result.output);
```

Its three limits: it shares the queue, so it may execute another caller's job (`foreignJobsProcessed` says how many; give it its own `jobTransport` when that is unacceptable); it cannot finish a workflow that suspends, and returns `outcome: "suspended"` naming the stage instead of spinning; and it is bounded by `maxJobs` and `maxClaimRounds`, returning `outcome: "incomplete"` with a `reason` rather than looping or throwing. It does not poll suspended stages or reap leases — that is `runMaintenanceTick()`.

## Platform Integration Examples

### Cloudflare Workers (Queue + Cron)

```typescript
import { createServerlessHost } from "@bratsos/workflow-engine-host-serverless";

export default {
  // Queue consumer -- process jobs from Cloudflare Queue
  async queue(batch, env, ctx) {
    const host = createServerlessHost({ kernel, jobTransport, workerId: "cf-worker" });

    for (const msg of batch.messages) {
      const result = await host.handleJob(msg.body);

      if (result.willRetry) {
        // The CF transport's fail() cannot re-enqueue: redeliver after the backoff.
        msg.retry({ delaySeconds: Math.ceil((result.retryDelayMs ?? 0) / 1000) });
      } else {
        msg.ack(); // completed, suspended, terminally failed, or dead
      }
    }
  },

  // Cron trigger -- run maintenance
  async scheduled(event, env, ctx) {
    const host = createServerlessHost({ kernel, jobTransport, workerId: "cf-worker" });
    ctx.waitUntil(host.runMaintenanceTick());
  },
};
```

### AWS Lambda (SQS + EventBridge)

```typescript
import { createServerlessHost } from "@bratsos/workflow-engine-host-serverless";

// SQS handler -- process jobs
export async function jobHandler(event) {
  const host = createServerlessHost({ kernel, jobTransport, workerId: "lambda-worker" });

  for (const record of event.Records) {
    const msg = JSON.parse(record.body);
    await host.handleJob(msg);
  }
}

// EventBridge handler -- maintenance cron
export async function maintenanceHandler() {
  const host = createServerlessHost({ kernel, jobTransport, workerId: "lambda-worker" });
  return host.runMaintenanceTick();
}
```

### Vercel Edge (API Route + Cron)

```typescript
import { createServerlessHost } from "@bratsos/workflow-engine-host-serverless";

// POST /api/process-job
export async function POST(request: Request) {
  const host = createServerlessHost({ kernel, jobTransport, workerId: "vercel-worker" });
  const result = await host.processAvailableJobs({ maxJobs: 5 });
  return Response.json(result);
}

// GET /api/cron/maintenance (Vercel Cron)
export async function GET() {
  const host = createServerlessHost({ kernel, jobTransport, workerId: "vercel-worker" });
  const tick = await host.runMaintenanceTick();
  return Response.json(tick);
}
```

## How It Works

Unlike the Node host, the serverless host has **no loops, timers, or signal handlers**. Every method is a single stateless invocation:

- **`handleJob(msg)`** -- Dispatches `job.execute` to the kernel, then marks the job complete/suspended/failed via `jobTransport`. On completion, also dispatches `run.transition` to advance the workflow, and (unless `flushOutboxAfterJob: false`) runs one bounded `outbox.flush` so the run's events are published by this invocation instead of by the next maintenance tick — there is no process lifecycle to hook a final flush on. A failure with attempts left (`msg.attempt < msg.maxAttempts`, default 3) leaves the stage `PENDING` with the error, emits `stage:retrying`, calls `jobTransport.fail(jobId, error, true)` and returns `willRetry: true` with `retryDelayMs`: either your transport re-enqueues the message with backoff from `fail()`, or your consumer retries it from the result (acknowledging it without a retry strands the run as `RUNNING` until `run.reapStuck`). When no attempts remain the stage is `FAILED`, `stage:failed` is emitted, and `run.transition` fails the run immediately with the stage error. A malformed message is failed and acknowledged as a dead job (`dead: true`).

- **`processAvailableJobs(opts?)`** -- Dequeues up to `maxJobs` (default: 1) from the job transport and processes each via `handleJob`. Safe for edge runtimes with CPU limits.

- **`runMaintenanceTick()`** -- Runs one bounded pass of all orchestration duties: `run.claimPending` (filtered by `serves`), `stage.pollSuspended`, `lease.reapStale` (both tiers), `outbox.flush`, `run.reapStuck`, and `run.purge` when `retention` is set. A run pinned to a definition version this build does not serve is left untouched for a host that does.

- **Cancellation** -- `handleJob` dispatches `job.heartbeat` every `jobHeartbeatIntervalMs` while the stage runs; when the run is cancelled or the job lease is lost, the stage's `ctx.abortSignal` aborts with a `StageAbortedError` (`reason: "cancelled" | "lease-lost"`). Acknowledgements are fenced on `{ startedAt, attempt }`, so an invocation that outlived its lease writes nothing and reports `superseded`.

Consumers wire platform-specific glue (queue ack/retry, `waitUntil`, cron triggers) around these methods.

## License

MIT
