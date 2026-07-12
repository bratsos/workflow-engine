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

const prisma = new PrismaClient();
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
| **`staleLeaseThresholdMs`** | `number` | `300000` (5m) | The duration a lease is locked before it is considered stale. (Default changed from 60s to 5m in `v0.11` to prevent premature lease timeouts). |
| **`jobHeartbeatIntervalMs`**| `number` | `60000` (60s) | *New in v0.11*: How frequently to heartbeat active stage leases while executing them. |
| **`maxClaimsPerTick`** | `number` | `10` | Maximum number of pending workflow runs to claim in a single orchestration tick. |
| **`maxSuspendedChecksPerTick`**| `number` | `10` | Maximum number of suspended stage completion checks to perform in a single tick. |
| **`maxOutboxFlushPerTick`** | `number` | `100` | Maximum number of outbox events to publish in a single tick. |

---

## Process Management & Signal Handling

The Node.js host automatically hooks into the Node process handlers. Calling `await host.start()` registers listeners for `SIGTERM` and `SIGINT` to perform a **graceful shutdown**.

### Graceful Shutdown
During a graceful shutdown (when `SIGTERM` is received):
1. The host stops accepting new jobs from the queue.
2. Active jobs that are currently running are allowed to finish execution.
3. The host releases any claims on pending runs.
4. The database connections are safely released, and the `host.start()` promise resolves.

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
//   uptimeMs: 1200000
// }
```

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
