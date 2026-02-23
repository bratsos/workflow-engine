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
| `staleLeaseThresholdMs` | `number` | `60_000` | Time before a job lease is considered stale |
| `maxClaimsPerTick` | `number` | `10` | Max pending runs to claim per maintenance tick |
| `maxSuspendedChecksPerTick` | `number` | `10` | Max suspended stages to poll per tick |
| `maxOutboxFlushPerTick` | `number` | `100` | Max outbox events to flush per tick |

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
  payload: Record<string, unknown>;
}
```

### `JobResult`

```typescript
interface JobResult {
  outcome: "completed" | "suspended" | "failed";
  error?: string;
}
```

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
  claimed: number;          // Pending runs claimed
  suspendedChecked: number; // Suspended stages polled
  staleReleased: number;    // Stale leases released
  eventsFlushed: number;    // Outbox events published
}
```

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

      if (result.outcome === "failed") {
        msg.retry();
      } else {
        msg.ack();
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

- **`handleJob(msg)`** -- Dispatches `job.execute` to the kernel, then marks the job complete/suspended/failed via `jobTransport`. On completion, also dispatches `run.transition` to advance the workflow.

- **`processAvailableJobs(opts?)`** -- Dequeues up to `maxJobs` (default: 1) from the job transport and processes each via `handleJob`. Safe for edge runtimes with CPU limits.

- **`runMaintenanceTick()`** -- Runs one bounded pass of all orchestration duties: `run.claimPending`, `stage.pollSuspended`, `lease.reapStale`, `outbox.flush`.

Consumers wire platform-specific glue (queue ack/retry, `waitUntil`, cron triggers) around these methods.

## License

MIT
