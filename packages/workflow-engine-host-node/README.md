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

## License

MIT
