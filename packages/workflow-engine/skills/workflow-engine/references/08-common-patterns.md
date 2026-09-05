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

The lease has two tiers. The heartbeat tier (`staleLeaseThresholdMs`, measured from `lockedAt`, which `touchJob` refreshes) requeues a job whose worker stopped, stamping `lastError` with the `LEASE_HEARTBEAT_LOST` prefix. A worker that is alive but wedged keeps heartbeating, so `absoluteTimeoutMs` (host option `jobAbsoluteTimeoutMs`, default one hour, `0` disables) is measured from `startedAt`, which nothing refreshes, and fails the job terminally with the `LEASE_ABSOLUTE_CAP` prefix. The result is `{ released, expired }`. On Postgres both stamps come from the database clock, so a host with a skewed system clock cannot make a fresh lease look stale. Job leases only: a durable step's lease is `StepRunOptions.lease` (see [12-durable-steps.md](12-durable-steps.md)).

A running body learns that its lease is gone, or that the run was cancelled, through `ctx.abortSignal`: the host's heartbeat dispatches `job.heartbeat`, which renews the lease and aborts the signal with a `StageAbortedError` (`reason: "cancelled"` or `"lease-lost"`) when the work is no longer wanted.

## Redrive: Retry, Restart, Rerun

`run.redrive` is one command with three resume points. See
[14-redrive.md](14-redrive.md) for the full contract.

```typescript
// Retry: resume at the earliest stage that is not COMPLETED (the default).
await kernel.dispatch({ type: "run.redrive", workflowRunId: "run-123" });

// Restart: run the whole pipeline again from the first group.
await kernel.dispatch({
  type: "run.redrive",
  workflowRunId: "run-123",
  from: { kind: "start" },
});

// Rerun: resume at a stage you choose, optionally on a newer definition.
const { supersededStages, redriveCount } = await kernel.dispatch({
  type: "run.redrive",
  workflowRunId: "run-123",
  from: { kind: "stage", stageId: "summarize" },
  definitionVersion: "latest",                 // optional re-pin
  idempotencyKey: "redrive-run-123-summarize-1", // optional; replay returns the cached result
});

// Stages at and after the resume point are superseded and re-queued.
// Earlier stages keep their outputs.
// For `lastFailure` and `stage` the resumed stage record is reopened in
// place (back to PENDING, `attempt` + 1, error/output/timings cleared), so
// its step ledger survives: completed `ctx.step.run` rows are answered from
// the ledger and only the unfinished steps run again. Stages after it are
// deleted and recreated; `start` replaces everything.
// Each superseded stage is archived as a `run.supersededAttempt` annotation
// in the same transaction, so the failed attempt is not lost.
// Blob artifacts for deleted stages are cleaned up by key prefix, after commit.
// The run keeps its id; `workflow_runs.redriveCount` increments and never resets.
```

`run.rerunFrom` is deprecated. It still works and its result shape is
unchanged (`deletedStages` now reports the superseded stages), and it now
delegates to `run.redrive` (same reopen-in-place, same archive), but it
cannot change the definition version and it still refuses a `CANCELLED` run.

## Run Retention

Nothing deletes a terminal run on its own. `run.purge` (`{ olderThan,
statuses?, limit? }` → `{ purged, workflowRunIds }`) clears each run's step
ledger, job rows and blobs and deletes the run with everything under it;
both hosts run it at the end of the maintenance tick once `retention:
{ olderThanMs, statuses?, limit? }` is set (off by default). See "Run
Retention" in [09-troubleshooting.md](09-troubleshooting.md).

## Near-synchronous runs: `runToCompletion`

`runToCompletion({ kernel, jobTransport, persistence, command })` from
`@bratsos/workflow-engine-host-serverless` creates a run and drives it to a
terminal state inside the calling request, returning `{ workflowRunId,
status, outcome, output?, reason?, jobsProcessed, foreignJobsProcessed,
suspendedStageId? }`. Three limits: it shares the queue, so it may execute
another caller's job (`foreignJobsProcessed` says how many; give it its own
`jobTransport` when that is unacceptable); it cannot finish a workflow that
suspends and returns `outcome: "suspended"` naming the stage; and it is
bounded by `maxJobs` (default 50) and `maxClaimRounds` (default 5),
returning `outcome: "incomplete"` with a `reason` rather than throwing.

## Enqueue from SQL

`sql/enqueue.sql` (shipped in the package, applied by your own migration
after the engine's tables exist) defines `workflow_engine_enqueue(...)`, so a
trigger or a non-TypeScript service creates a run inside its own
transaction:

```sql
PERFORM workflow_engine_enqueue(
  'order:' || v_order_id, 'fulfil-order', 'Fulfil Order',
  jsonb_build_object('orderId', v_order_id));
```

It writes exactly the rows `run.create` writes (idempotency key, run,
`workflow:created` outbox event) and leaves the run `PENDING` for
`run.claimPending`. It cannot validate input against the Zod schema, cannot
compute the definition version (the run is created unpinned unless
`p_definition_version` names an existing `workflow_definitions` row) and
stores `p_config` verbatim. See [05-persistence-setup.md](05-persistence-setup.md).

## Plugin System

Plugins react to kernel events published through the outbox:

```typescript
import { definePlugin, createPluginRunner } from "@bratsos/workflow-engine/kernel";

const metricsPlugin = definePlugin({
  id: "metrics",
  name: "Metrics",
  on: ["workflow:completed", "stage:retrying", "stage:failed"],
  async handle(event) {
    switch (event.type) {
      case "workflow:completed":
        return recordMetric("workflow_completed", { workflowId: event.workflowId });
      case "stage:retrying":
        return recordMetric("stage_retry", { stageId: event.stageId, attempt: event.attempt });
      case "stage:failed":
        return alertOnFailure(event);
    }
  },
});

// The runner is an EventSink: hand it to createKernel and `outbox.flush`
// delivers each event to every plugin whose `on` names its type.
const eventSink = createPluginRunner({ plugins: [metricsPlugin] });
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

`version` increments on every update, whether or not the caller passes `expectedVersion` — don't compute an expected next version from your own arithmetic; re-read the persisted record instead.

## Document Processing Pipeline

A common pattern combining sequential and parallel stages:

```typescript
const workflow = defineWorkflow({
  id: "doc-processor",
  name: "Document Processor",
  description: "Process documents",
  input: InputSchema,
})
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

A stage attempt that throws is either retried or terminal, depending on the job's attempt budget (the transport's `maxAttempts`, default 3 — the `maxRetries` field of the config presets is *not* read by the kernel):

- **Attempts left** (and the error is not deterministic, e.g. not a Zod input failure or a `DuplicateStepKeyError`): the kernel records the stage as `PENDING` with the error on `errorMessage`, keeps its step-ledger rows for the replay (completed steps are answered from the ledger; a `run` step or map item that ended `failed` is re-opened and runs again, keeping its `attempt` count), emits **`stage:retrying`** (`{ workflowRunId, stageId, stageName, attempt, maxAttempts, error }`) and returns `willRetry: true`; the host calls `jobTransport.fail(jobId, error, true)`, which **must** put the job back in the queue with backoff (the Prisma and in-memory queues do). A push transport whose `fail()` cannot re-enqueue reads `willRetry` / `retryDelayMs` off the host's job result and retries the message itself — acknowledging it without a retry leaves the run `RUNNING` until `run.reapStuck` heals it. The run stays `RUNNING` — `run.transition` treats a `PENDING` stage as active.
- **No attempts left**: the stage is `FAILED`, **`stage:failed`** is emitted, and the host dispatches `run.transition` immediately (in the same `job.execute` completion, since v0.11), so the run fails with the real stage error right away rather than waiting for a later orchestration tick or `run.reapStuck` to notice. Both hosts behave the same; the serverless host does this inside `handleJob`. A stage that fails terminally from the poll path (a `ctx.step.run` retry that ran inside `stage.pollSuspended`, a `checkCompletion` error, a wait past its deadline) fails the run the same way and finalises its `job_queue` row.

`stage:failed` therefore means the stage row is `FAILED`; a consumer that mirrors engine events into its own log sees one `stage:retrying` per retried attempt, not a failure the run never had.

## Reliability & Self-Healing

The engine has several built-in reliability mechanisms:

### Idempotent Stage Creation

Both `run.claimPending` and `run.transition` use `upsertStage` instead of `createStage` when creating stage records. This means:
- If orphaned stages exist from a previous failed attempt, they're harmlessly overwritten
- Only stages with status `PENDING` get jobs enqueued (stages already `RUNNING`/`COMPLETED`/`SUSPENDED` are skipped)
- Prevents P2002 unique constraint violations that could otherwise cause infinite retry loops

### Per-Run Error Isolation

If claiming a specific run fails (e.g., workflow not found, database error), that run is marked `FAILED` with error code `CLAIM_FAILED` and processing continues to the next run. One bad run never blocks the entire claim batch. With a registry built by `createWorkflowRegistry`, a run whose workflow this build does not hold is never claimed in the first place (the `serves` filter leaves it `PENDING` for a host that has it); only a hand-written `{ getWorkflow }` registry, or `serves: "all"`, still adopts it and fails it with `WORKFLOW_NOT_FOUND`.

### Ghost Job Guard

`job.execute` verifies the run is in `RUNNING` status both before and after executing the stage. A job for a run that is not `RUNNING` comes back with `outcome: "failed"`, `ghost: true` and a `ghostReason`: `"orphan"` (the run is terminal — the hosts fail the job without retry), `"race"` (the run is still `PENDING`, its claim had not committed — re-delivered while the attempt budget lasts) or `"version"` (the run is pinned to a definition version this build does not serve — deferred for a host that serves it, no attempt spent). This prevents ghost jobs from rolled-back transactions or concurrent cancellations from resurrecting invalid state.

### Orchestration Tick Isolation

Each step of the orchestration tick (claim pending, poll suspended, reap stale, flush outbox, reap stuck, purge) runs in its own error boundary. If one step fails, the others still execute. This prevents a single error from starving unrelated maintenance work.

### Suspended-Stage Claims (Multiple Orchestrators)

Any number of processes may run the orchestration tick against the same database. `stage.pollSuspended` claims each suspended stage before working on it: a version-guarded `updateStage(id, { nextPollAt: now + lease, expectedVersion })` outside the per-stage transaction, where the lease is `max(pollInterval, 60s)` bounded by `maxWaitUntil`. A poller whose claim fails (`StaleVersionError`) skips the stage — the body of a durable stage, or `checkCompletion`, runs once per poll across all processes. Every outcome then writes `nextPollAt` explicitly (re-suspend, `now + pollInterval` when not ready, `null` on completion/failure/cancel, back to `now` when the run-level claim was lost), so the lease only matters when a process dies mid-replay: that stage is polled again once the lease elapses. A poller that comes back to a run another process has since finished leaves the stage row alone; only a run that is `CANCELLED` cancels the stage.

The Node host additionally skips an interval firing while a tick is still in flight, so a long replay never overlaps the next tick in the same process.

**Why not a Postgres advisory lock.** A session-scoped `pg_try_advisory_lock`
looks like the stronger primitive — it releases the instant the connection
dies, so there is no stale-lock window and no reaper to tune — and it was
evaluated and rejected for four reasons. It belongs to the *connection*, not
the task, and is re-entrant, so a pool that hands one connection to two
pollers grants both the "lock" and single flight is gone. Under PgBouncer in
transaction mode consecutive statements land on different server connections,
so the lock is taken and never released. A serverless host has no long-lived
connection to own one at all. And advisory locks live in one global 64-bit
integer namespace with no schema and no row-level-security boundary: a lock
taken inside a tenant's transaction outlives the `COMMIT` on the pooled
connection, and tenant B can be blocked by tenant A's hashed stage id. The
version-guarded `nextPollAt` lease is a row, so it is scoped by the same RLS
policies as everything else and works on SQLite too.

Since a build that cannot serve a run's definition version must not hold the
claim either, `stage.pollSuspended` releases the claim immediately when
`servesRun` is false, rather than sitting on the lease for its duration — an
unserving host re-claiming every tick would otherwise starve the serving one
during a rolling deploy. See [13-definition-versioning.md](13-definition-versioning.md).

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

## Config Presets

Reduce config-schema boilerplate with the built-in presets -- each merges standard fields onto whatever Zod object schema you pass in:

```typescript
import { withAIConfig, withConcurrency, withFeatureFlags, withStandardConfig } from "@bratsos/workflow-engine";
import { z } from "zod";

withAIConfig(schema);        // + model, temperature, maxTokens
withConcurrency(schema);     // + concurrency, delayMs, maxRetries
withFeatureFlags(schema);    // + featureFlags: Record<string, boolean>
withStandardConfig(schema);  // AI + Concurrency + FeatureFlags combined -- the recommended default for most stages
```

Use one directly as a stage's `config` schema:

```typescript
const myStage = defineStage({
  id: "my-stage",
  name: "My Stage",
  schemas: {
    input: z.object({ data: z.string() }),
    output: z.object({ result: z.string() }),
    config: withAIConfig(z.object({ customField: z.string() })),
  },
  async execute(ctx) {
    // ctx.config.model / ctx.config.temperature / ctx.config.maxTokens, plus ctx.config.customField
  },
});
```

As of v0.11, `stageId`/`stageName` are optional on `onProgress()` — the engine auto-fills them from the current stage (as shown above). Pass them explicitly only if you need to override.
