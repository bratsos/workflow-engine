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
| `workerId` | `string` | required | Unique worker identifier |
| `orchestrationIntervalMs` | `number` | `10_000` | Interval for claim/poll/reap/flush orchestration tick |
| `jobPollIntervalMs` | `number` | `1_000` | Interval for polling job queue when empty |
| `staleLeaseThresholdMs` | `number` | `60_000` | Time before a job lease is considered stale |
| `maxClaimsPerTick` | `number` | `10` | Max pending runs to claim per orchestration tick |
| `maxSuspendedChecksPerTick` | `number` | `10` | Max suspended stages to poll per tick |
| `maxOutboxFlushPerTick` | `number` | `100` | Max outbox events to flush per tick |

### `NodeHost`

| Method | Returns | Description |
|--------|---------|-------------|
| `start()` | `Promise<void>` | Start polling loops and register SIGTERM/SIGINT handlers |
| `stop()` | `Promise<void>` | Graceful shutdown -- clears timers and signal handlers |
| `getStats()` | `HostStats` | Runtime statistics |

### `HostStats`

```typescript
interface HostStats {
  workerId: string;
  jobsProcessed: number;
  orchestrationTicks: number;
  isRunning: boolean;
  uptimeMs: number;
}
```

## How It Works

The host runs two concurrent loops:

1. **Orchestration timer** (every `orchestrationIntervalMs`):
   - `run.claimPending` -- claim pending runs, enqueue first-stage jobs
   - `stage.pollSuspended` -- check if suspended stages are ready to resume
   - `lease.reapStale` -- release stale job leases from crashed workers
   - `outbox.flush` -- publish pending events through EventSink

2. **Job processing loop** (continuous):
   - Dequeue next job from `jobTransport`
   - Dispatch `job.execute` to the kernel
   - On completion: mark complete, dispatch `run.transition`
   - On suspension: mark suspended with next poll time
   - On failure: mark failed with retry flag
   - Sleep `jobPollIntervalMs` when queue is empty

Signal handlers (`SIGTERM`, `SIGINT`) automatically call `stop()` for graceful shutdown.

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

## Multi-Worker

Multiple workers can share the same database. Each needs a unique `workerId`:

```typescript
// worker-1
createNodeHost({ kernel, jobTransport, workerId: "worker-1" });

// worker-2
createNodeHost({ kernel, jobTransport, workerId: "worker-2" });
```

Run claiming uses `FOR UPDATE SKIP LOCKED` in PostgreSQL to prevent race conditions.

## License

MIT
