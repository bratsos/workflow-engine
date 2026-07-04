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
  scheduler: myScheduler,
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
