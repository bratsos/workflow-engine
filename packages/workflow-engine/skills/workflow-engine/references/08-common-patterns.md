# Common Patterns

Best practices, recipes, and patterns for the command kernel.

## Idempotency

The `run.create` and `job.execute` commands support idempotency keys. Replaying a command with the same key returns the cached result without re-executing:

```typescript
const cmd = {
  type: "run.create" as const,
  idempotencyKey: "order-123-workflow",
  workflowId: "process-order",
  input: { orderId: "123" },
};

// First call creates the run
const first = await kernel.dispatch(cmd);

// Second call returns cached result (no duplicate run)
const second = await kernel.dispatch(cmd);
// first.workflowRunId === second.workflowRunId
```

Use deterministic keys derived from domain data (e.g., `order-${orderId}`) to prevent duplicate processing.

If the same key is currently executing, dispatch throws `IdempotencyInProgressError`. Retry with backoff instead of issuing parallel same-key commands.

## Transactional Outbox

Events are not emitted directly. Instead, handlers write events to a transactional outbox table. The `outbox.flush` command publishes pending events through the EventSink:

```typescript
// Events accumulate in the outbox as commands execute
await kernel.dispatch({ type: "run.create", ... });
await kernel.dispatch({ type: "job.execute", ... });

// Flush publishes all pending events
await kernel.dispatch({ type: "outbox.flush", maxEvents: 100 });
```

This ensures events are only published after the underlying database transaction succeeds, preventing lost or phantom events.

### Multi-phase transactions

Most commands execute inside a single database transaction (handler logic + outbox event writes). Two commands manage their own transactions to avoid holding connections during external I/O:

#### `job.execute`

Uses a 3-phase pattern so that long-running stage execution doesn't hold a DB connection:

1. **Phase 1 (Start):** Upsert stage to `RUNNING` + write `stage:started` outbox event in one transaction. Commits immediately so `RUNNING` status is visible to observers.
2. **Phase 2 (Execute):** `stageDef.execute()` runs outside any database transaction. Progress events are collected in memory.
3. **Phase 3 (Complete):** Update stage to `COMPLETED`/`SUSPENDED`/`FAILED` + write completion and progress outbox events in one transaction.

If the process crashes between Phase 1 and Phase 3, the stage stays in `RUNNING` and `lease.reapStale` will eventually retry the job.

#### `stage.pollSuspended`

Uses per-stage transactions so that `checkCompletion()` — which makes external HTTP calls to batch providers (Google Batch, OpenAI Batch, etc.) — runs outside any database transaction:

1. **Phase 1 (Check):** `stageDef.checkCompletion()` runs outside any transaction. External API calls happen here.
2. **Phase 2 (Persist):** Update stage status + append outbox events in one short transaction per stage.

Without this, slow batch provider responses would exceed Prisma's interactive transaction timeout (default 5s), causing P2028 errors and leaving stages permanently stuck in `SUSPENDED`.

The outbox includes retry logic with a dead-letter queue (DLQ). Events that fail to publish are retried up to 3 times before being moved to the DLQ. Use `plugin.replayDLQ` to reprocess them:

```typescript
await kernel.dispatch({ type: "plugin.replayDLQ", maxEvents: 50 });
```

## Stale Lease Recovery

When a worker crashes, its job leases become stale. The `lease.reapStale` command releases them:

```typescript
await kernel.dispatch({
  type: "lease.reapStale",
  staleThresholdMs: 60_000, // Release jobs locked > 60s
});
```

In the Node host, this runs automatically on each orchestration tick. For serverless, include it in your maintenance cron.

## Rerun From Stage

Rerun a workflow from a specific stage, keeping outputs from earlier stages:

```typescript
const { deletedStages } = await kernel.dispatch({
  type: "run.rerunFrom",
  workflowRunId: "run-123",
  fromStageId: "summarize",
});

// Stages from "summarize" onward are deleted and re-queued
// Earlier stages (e.g., "extract") keep their outputs
// Blob artifacts for deleted stages are cleaned up by key prefix
```

## Plugin System

Plugins react to kernel events published through the outbox:

```typescript
import { definePlugin, createPluginRunner } from "@bratsos/workflow-engine/kernel";

const metricsPlugin = definePlugin({
  name: "metrics",
  handlers: {
    "workflow:completed": async (event) => {
      await recordMetric("workflow_completed", { workflowId: event.workflowId });
    },
    "stage:failed": async (event) => {
      await alertOnFailure(event);
    },
  },
});

const runner = createPluginRunner({
  plugins: [metricsPlugin],
  eventSink: myEventSink,
});

// Process events from the outbox
await runner.processEvents(events);
```

## Multi-Worker Coordination

Multiple workers can process jobs from the same queue safely:

- **Run claiming** uses `FOR UPDATE SKIP LOCKED` in PostgreSQL -- no duplicate claims
- **Job dequeuing** uses atomic `UPDATE ... WHERE status = 'PENDING'` -- no duplicate execution
- **Stale lease recovery** releases jobs from crashed workers

```typescript
// Worker 1 and Worker 2 can run simultaneously
const host1 = createNodeHost({ kernel, jobTransport, workerId: "worker-1" });
const host2 = createNodeHost({ kernel, jobTransport, workerId: "worker-2" });
```

## Optimistic Concurrency

The persistence layer uses version fields on records to detect concurrent modifications:

```typescript
// If two workers try to update the same run simultaneously,
// one will get a StaleVersionError and retry
import { StaleVersionError } from "@bratsos/workflow-engine";
```

## Document Processing Pipeline

A common pattern combining sequential and parallel stages:

```typescript
const workflow = new WorkflowBuilder(
  "doc-processor", "Document Processor", "Process documents",
  InputSchema, OutputSchema,
)
  .pipe(extractTextStage)              // Stage 1: Extract
  .parallel([
    sentimentAnalysisStage,            // Stage 2a: Analyze sentiment
    keywordExtractionStage,            // Stage 2b: Extract keywords
  ])
  .pipe(aggregateResultsStage)         // Stage 3: Combine results
  .build();
```

Subsequent stages access parallel outputs by stage ID:

```typescript
async execute(ctx) {
  const sentiment = ctx.require("sentiment-analysis");
  const keywords = ctx.require("keyword-extraction");
  // ...
}
```

## Error Handling in Stages

```typescript
async execute(ctx) {
  try {
    const result = await processDocument(ctx.input);
    return { output: result };
  } catch (error) {
    ctx.log("ERROR", "Processing failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    throw error; // Re-throw to mark stage as FAILED
  }
}
```

Failed stages trigger the `stage:failed` event. The host's maintenance tick detects failure through `run.transition`, which marks the workflow as FAILED.

## Reliability & Self-Healing

The engine has several built-in reliability mechanisms:

### Idempotent Stage Creation

Both `run.claimPending` and `run.transition` use `upsertStage` instead of `createStage` when creating stage records. This means:
- If orphaned stages exist from a previous failed attempt, they're harmlessly overwritten
- Only stages with status `PENDING` get jobs enqueued (stages already `RUNNING`/`COMPLETED`/`SUSPENDED` are skipped)
- Prevents P2002 unique constraint violations that could otherwise cause infinite retry loops

### Per-Run Error Isolation

If claiming a specific run fails (e.g., workflow not found, database error), that run is marked `FAILED` with error code `CLAIM_FAILED` and processing continues to the next run. One bad run never blocks the entire claim batch.

### Ghost Job Guard

`job.execute` verifies the run is in `RUNNING` status both before and after executing the stage. Jobs for non-`RUNNING` runs are discarded with `outcome: "failed"` and a `ghost: true` flag in the result. Hosts check this flag to disable retries (`canRetry = false`). This prevents ghost jobs from rolled-back transactions or concurrent cancellations from resurrecting invalid state.

### Orchestration Tick Isolation

Each step of the orchestration tick (claim pending, poll suspended, reap stale, flush outbox, reap stuck) runs in its own error boundary. If one step fails, the others still execute. This prevents a single error from starving unrelated maintenance work.

### Stuck Run Detection

The `run.reapStuck` command finds RUNNING runs with no recent activity (no updates to run or stage records within the threshold). These runs are marked `FAILED` with error code `STUCK_RUN_REAPED`. The threshold defaults to `max(3 * staleLeaseThresholdMs, 5 minutes)`.

See [09-troubleshooting.md](09-troubleshooting.md) for debugging these scenarios.

## Progress Reporting

```typescript
async execute(ctx) {
  for (const [index, item] of items.entries()) {
    ctx.onProgress({
      progress: (index + 1) / items.length,
      message: `Processing item ${index + 1}/${items.length}`,
      details: { currentItem: item.id },
    });
    await processItem(item);
  }
  return { output: { processedCount: items.length } };
}
```
