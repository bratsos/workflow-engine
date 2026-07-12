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
  staleLeaseThresholdMs: 300_000, // default 5m
  jobHeartbeatIntervalMs: 60_000, // default 1m
  maxClaimsPerTick: 10,
  maxSuspendedChecksPerTick: 10,
  maxOutboxFlushPerTick: 100,
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
      } else {
        // failed: instruct queue to retry
        msg.retry();
      }
    }
  }
};
```

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
1. **Claiming**: Finds runs in `PENDING` status and enqueues their first stages.
2. **Polling**: Checks completion status of `SUSPENDED` batch stages (e.g. OpenAI/Google Batch jobs).
3. **Lease Reaping**: Releases locks from crashed worker nodes.
4. **Outbox Flushing**: Dispatches pending transactional outbox events to the `EventSink`.
5. **Stuck Run Detection**: Automatically fails runs that have ceased updates.

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
    //   stuckReaped: 0
    // }
  }
};
```
