---
sidebar_position: 4
title: Kernel and Ports
---

# Kernel and Ports

**workflow-engine** is designed around a **hexagonal (ports-and-adapters) architecture**. The core library exposes a pure, stateless **Command Kernel** that is completely isolated from side effects. It interacts with the outside world strictly through defined interfaces called **Ports**.

---

## Hexagonal Architecture Overview

By decoupling execution logic from infrastructure, the core engine has:
* **Zero global state**: All state belongs to the caller or the database.
* **Zero runtime timers/signals**: The kernel does not manage standard intervals or event loops.
* **Environment independence**: The exact same kernel can execute on Node.js, serverless edge workers, AWS Lambda, or in-memory unit tests.

```mermaid
flowchart LR
    app["Your application<br/>(run.create, run.redrive, step.signal)"]
    hosts["Host<br/>host-node · host-serverless · host-remote"]
    kernel(["Kernel<br/>kernel.dispatch(command)"])
    subgraph ports [Ports]
        direction TB
        persistence[persistence]
        jobs[jobTransport]
        ledger["stepLedger (optional)"]
        blobs[blobStore]
        sink[eventSink]
        clock[clock]
        registry[registry]
    end
    subgraph adapters [Adapters]
        direction TB
        pg[("Prisma / Postgres")]
        mem["In-memory (tests)"]
        custom["Your own"]
    end
    app --> kernel
    hosts -- "ticks: claim, execute, poll, flush" --> kernel
    kernel --> ports
    ports --> adapters
```

The kernel never runs on its own. Hosts drive it with commands on a schedule, your code dispatches commands for the things only it knows about, and everything the kernel reads or writes goes through a port you supply.

---

## The Core Ports

When initializing a kernel with `createKernel`, you must inject implementations for six required ports — `persistence`, `blobStore`, `jobTransport`, `eventSink`, `clock`, and `registry`:

| Port Name | Interface | Purpose |
| :--- | :--- | :--- |
| **`persistence`** | `Persistence` | Manages metadata storage for runs, stages, execution logs, transaction outboxes, definition snapshots and idempotency records. |
| **`blobStore`** | `BlobStore` | Handles storage for large input/output payloads, intermediate stage artifacts and spilled step results (using methods like `put`, `get`, `has`, `delete`, and `list`). Must be shared by every process that executes or polls a run. |
| **`jobTransport`** | `JobTransport` | Acts as the job queue (managing dequeue loops, claiming, and cancelling queued jobs). |
| **`eventSink`** | `EventSink` | `{ emit(event) }` — receives system events (e.g., `workflow:completed`, `stage:started`) when the outbox is flushed. |
| **`clock`** | `Clock` | Resolves the current system time. Can be mocked in tests (`FakeClock`) to control duration math. |
| **`registry`** | `WorkflowRegistry` | Maps workflow IDs to their respective immutable `Workflow` objects. Build it with `createWorkflowRegistry([...])`: that implements the optional `listWorkflows()`, which is what lets a host claim only runs pinned to a definition version it can execute (see [Definition Versioning](./definition-versioning.md)). A hand-written `{ getWorkflow }` works but claims unfiltered. |

The optional ports and settings:

| Option | Type | Purpose |
| :--- | :--- | :--- |
| **`stepLedger`** | `StepLedger` | Storage for [durable steps](./durable-steps.md) (`InMemoryStepLedger`, `createPrismaStepLedger`). A stage that never touches `ctx.step` needs none; touching it unconfigured throws `StepLedgerNotConfiguredError`. |
| **`services`** | `{ aiLogger, ai? }` | Provides `ctx.ai` (an `AIHelper` built lazily per stage under the topic `workflow.<runId>.stage.<stageId>`) and `ctx.aiLogger`. `ai` is an optional factory with the signature of `createAIHelper`, for routing options, an adapter or timeouts in one place. Accessing `ctx.ai` without services throws `AIServicesNotConfiguredError`. |
| **`executor`** | `ActivityExecutor` | Delegates stage executions to separate processes or remote activity workers (see [Remote Workers](../hosts/remote-workers.md)). Defaults to the local executor. |
| **`spillThresholdBytes`** | `number` | Soft threshold above which a step result is written to the blob store behind a claim check (default 64 KiB); see below. |
| **`idempotencyStaleInProgressMs`** | `number` | How long an idempotency key may sit `in_progress` before a later dispatch may reclaim it (default 10 minutes). |

There is no `scheduler` port: `KernelConfig.scheduler` and `NoopScheduler` were removed in 1.0. Suspended stages are resumed by host-driven `stage.pollSuspended` polling — see [Command Dispatch](#command-dispatch) below.

---

## Command Dispatch

The kernel acts as a single command processor. Host runtimes interact with the kernel by calling `kernel.dispatch(command)`.

All operations are expressed as strongly-typed commands:

```typescript
// Example: Creating a workflow run
const result = await kernel.dispatch({
  type: "run.create",
  idempotencyKey: "order-456",
  workflowId: "order-processing",
  input: { orderId: "456", total: 99.99 },
});
```

The key kernel commands are:
* **`run.create`** creates a pending run pinned to the workflow's current definition version. Pass optional `tenantId` and `labels` to store an opaque tenant ID and a map of string labels on the run.
* **`run.claimPending`**: Scans for and claims pending runs this build serves, then enqueues their first-stage jobs (after the claim commits).
* **`job.execute`**: Executes a single stage (runs `execute()`). Takes the job's `attempt`/`maxAttempts` to decide `willRetry`, and an optional `abortSignal` that becomes `ctx.abortSignal`.
* **`job.heartbeat`**: One beat of a host's job lease heartbeat: renews the lease and reports the run's status and whether the worker still holds the job, which is what the host aborts `ctx.abortSignal` from.
* **`run.transition`**: Evaluates completed stage outputs and transitions the workflow run to the next execution group or completes the run.
* **`run.cancel`**: Authority that marks a run cancelled and sets open stages to cancelled; after that commits, it purges the run's jobs from the job queue and cancels the provider batches the run created (`result.batches`, bounded to 60 seconds; see [Batch Operations](../ai/batch-operations.md#cancelling-a-run)).
* **`run.redrive`**: Retry, restart or rerun a terminal run — `from: { kind: "lastFailure" | "start" | "stage" }` — keeping the resumed stage's step ledger and archiving every superseded attempt; optionally re-pins the run to another definition version. See [Retry, Restart and Rerun](./redriving-runs.md). `run.rerunFrom` still works but is deprecated and delegates to it.
* **`stage.pollSuspended`**: Replays suspended durable stages whose `nextPollAt` has passed (and runs `checkCompletion` for the internal async-batch mode).
* **`step.signal`**: Completes a `ctx.step.waitForSignal` step with a payload and nudges its stage for replay. Idempotent: a second signal reports `alreadyCompleted: true`.
* **`lease.reapStale`**: Recovers jobs held by crashed workers (heartbeat tier) and fails jobs past the absolute cap.
* **`outbox.flush`**: Publishes committed outbox events to the `EventSink` and reports the sink's health.
* **`plugin.replayDLQ`**: Re-queues dead-lettered outbox events once the sink is back.
* **`run.reapStuck`**: Automatically fails workflow runs that have ceased database updates.
* **`run.purge`**: Deletes terminal runs by age, run IDs, or tenant. Targeted erasure also removes attributed outbox events, idempotency keys and AI calls. See [Run Retention](../troubleshooting/overview.md#run-retention).
* **`engine.prune`**: Runs bounded retention for AI calls, expired AI call text, published outbox events, and completed idempotency keys.
* **`run.listVersions`**: Reports which definition versions still have runs and whether this build serves them.
* **`engine.stats`**: Read-only gauges of active work: runs, stages, jobs and outbox events by status, plus the age of the oldest waiting item. See [Observing the engine](#observing-the-engine).

---

## Observing the engine

`engine.stats` answers "is the engine keeping up?" without the engine taking a metrics dependency. It counts only active work (PENDING, RUNNING and SUSPENDED rows, plus unpublished and dead-lettered outbox events). The built-in adapters answer each figure from an index that leads with the active column, so the cost follows the amount of work in flight, not the size of the tables, when the tables were never analysed or their statistics are current: the plans are asserted on SQLite and on PostgreSQL in both states, with 500,000 published outbox events and 100,000 terminal runs, stages and jobs. Statistics that are out of date are the exception on PostgreSQL. When `ANALYZE` ran while most rows were active and the tables then grew by terminal rows without another (autovacuum off or behind, or a bulk load after the last `ANALYZE`), the planner still believes most rows are active and reads the whole table for the runs, jobs and unpublished-outbox counts: on Prisma 7 with 100,000 terminal rows per table, these counts used 1,725, 1,640 and 1,430 buffers, respectively (177, 165 and 144 at 10,000). The stage count used 10 buffers in this Prisma 7 measurement. The due-stage and dead-letter counts each used 3. Planner choices depend on the stored estimates. `ANALYZE workflow_runs, workflow_stages, job_queue, outbox_events` restores the index plans. SQLite is bounded in that state too: its statements mark the active-status, unpublished, due and dead-letter terms as rare with `likelihood()`, so the planner searches the index whatever `sqlite_stat1` says (asserted at 10,000 and 100,000 rows on Prisma 6, 7 and 8). Two figures are read slightly differently. The dead-lettered count reads `outbox_events_dlqAt_idx` from its first non-NULL entry, so it visits only the dead letters' entries; on PostgreSQL it counts events whose `dlqAt` lies between 1970-01-01 and 9999-12-31, the range that lets the planner choose that index without statistics, and the engine never writes one outside it. A dead letter stamped before 1970 (only a test clock set that far back writes one) is not counted on PostgreSQL. The due-stage count uses `workflow_stages_status_idx` or, on PostgreSQL once its statistics say few stages carry a deadline, `workflow_stages_nextPollAt_idx`, which holds a terminal stage only until its job is settled. It writes nothing: no outbox event, no idempotency key, no transaction.

```typescript
const stats = await kernel.dispatch({ type: "engine.stats" });
// {
//   at: Date,                                     // the kernel clock; ages are measured at it
//   runs:   { available: true,
//             byStatus: { PENDING: 3, RUNNING: 12, SUSPENDED: 5 },
//             oldestPendingAgeMs: 4200 },         // null when nothing is pending
//   stages: { available: true,
//             byStatus: { PENDING: 0, RUNNING: 12, SUSPENDED: 5 },
//             suspendedDue: 1,                    // SUSPENDED and nextPollAt <= now
//             mostOverdueMs: 800 },               // null when none is due
//   jobs:   { available: true,
//             byStatus: { PENDING: 3, RUNNING: 12, SUSPENDED: 0 },
//             oldestPendingAgeMs: 4200 },
//   outbox: { available: true,
//             unpublished: 2,                     // includes events with live claims
//             oldestUnpublishedAgeMs: 1500,
//             deadLettered: 0 },                  // replay with plugin.replayDLQ
// }
```

The figures come from separate queries, not one snapshot, so work that moves while they run can be counted in two places or in none. Treat them as gauges.

`engine.stats` reads through two optional port methods, `Persistence.getActiveWorkStats(now)` and `JobTransport.getJobStats()`. The built-in in-memory and Prisma adapters implement both. A custom port without one reports its sections as `{ available: false }` (`runs`, `stages` and `outbox` for persistence, `jobs` for the transport) instead of failing or reporting zero. See [Custom Adapters](../persistence/custom-adapters.md#active-work-stats).

To export the gauges on every tick, combine the command with a host's `onTick` hook ([Node host](../hosts/node.md#exporting-gauges-with-ontick), [serverless host](../hosts/serverless.md#exporting-gauges-with-ontick)).

---

## Large Payloads: The Claim Check

The engine has no payload ceiling. A stage that returns a 4 MB extraction is
not rejected, which is the right default for AI work and also why there has
to be an escape hatch: without one, a very large value is simply a very large
row, read back in full on every replay.

Stage outputs have never had that problem -- they go to the `blobStore` and
the row keeps only `outputData._artifactKey`. Since 1.0 the same claim check
covers the two other places a payload can grow without bound.

### Durable step results (automatic)

`workflow_steps.result` is the largest thing the engine writes per row, and a
replay reads every step of the stage. Results above a **soft threshold** are
written to the `blobStore` and the row keeps a reference:

```json
{ "$wfSpill": 1, "key": "workflow-v2/spill/step-writes/<stageRecordId>/<stepId>/<uuid>.json", "bytes": 400018 }
```

Every write spills to a new key, so the blob a committed row names is never
written again: a compare-and-set that does not apply (another execution won
the row) leaves only its own blob, which it deletes, and one that replaces a
spilled result deletes the blob the previous version named. Rows written
before 1.0.0-alpha.21 name `workflow-v2/spill/steps/<stageRecordId>/<stepId>.json`
and are still read through their reference; the new keys live under a
separate prefix, so an older release's redrive, which clears the old prefix,
cannot delete them. An older release's `run.purge` or `run.redrive` from
the start leaves them in the blob store.

This is on by default and needs no wiring: `createKernel` already has a
`blobStore`, so it wraps the `stepLedger` you give it. Reads resolve the
reference before the value reaches your code, so `ctx.step.run(...)` returns
what it stored either way.

```typescript
const kernel = createKernel({
  // ...
  spillThresholdBytes: 65_536, // the default; Infinity keeps everything inline
});
```

The threshold is **soft**: a payload above it spills, it is never rejected,
and there is no hard barrier above it. The default is 64 KiB -- chosen from
the smallest ceiling downstream of a payload (Cloudflare Queues' 128 KiB
message limit; SQS is 256 KiB), with a whole message envelope of headroom,
and two orders of magnitude above Postgres's ~2 KiB TOAST threshold so an
ordinary result never pays the extra round trip.

### Job payloads (opt in at wiring)

`job_queue.payload` carries the run's config, and a transport that puts the
row on a real queue is bound by that queue's message size. Wrap the transport
once and pass the *same* wrapped object to the kernel and to the host:

```typescript
import { createSpillingJobTransport } from "@bratsos/workflow-engine";

const jobTransport = createSpillingJobTransport(createPrismaJobQueue(prisma), {
  blobStore,
});

const kernel = createKernel({ /* ... */ jobTransport, blobStore });
const host = createNodeHost({ kernel, jobTransport, workerId });
```

It packs on `enqueueParallel`, resolves on `dequeue` and
`getJobsByWorkflowRun`, and deletes the spilled blob in
`deleteByRunAndStages`. If you deliver job messages through your *own* push
queue and call `host.handleJob(msg)` with a message you built yourself, you
bypass `dequeue()` and must resolve the payload first:

```typescript
const spill = createPayloadSpill({ blobStore });
await host.handleJob({
  ...msg,
  payload: (await spill.unpack(msg.payload)) as Record<string, unknown>,
});
```

### When there is no blob store

There is no configuration in which a value spills with nowhere to go: the
kernel's `blobStore` port is mandatory and `createSpillingJobTransport` takes
one as an argument, so leaving the transport unwrapped simply keeps job
payloads inline exactly as before.

What *does* break is the same thing that breaks stage outputs: every process
that executes or replays a run must read the **same** blob store. Reading a
spilled value through a different one throws
`SpilledPayloadUnavailableError`, naming the key and the requirement. An
`InMemoryBlobStore` is single-process only; use `createPrismaBlobStore` (the
`workflow_blobs` table) or an S3/R2-backed store.

### Not spilled

`workflow_runs.input`, `.output` and `.config`, `workflow_stages`
`suspendedState`, annotation values and log metadata stay inline. They are
part of your read model -- you query those rows in dashboards and reports --
and turning them into opaque references would cost more than the row size
saves. The claim check is applied only to rows that are engine plumbing.

---

## Transactional Outbox Events

**workflow-engine** implements the **Transactional Outbox Pattern** for system notifications:
* When a command is executed, system events (like `workflow:completed`, `stage:failed`) are not sent immediately to the `EventSink`.
* Instead, they are written to the database in the `OutboxEvent` table as part of the primary database transaction.
* The host then dispatches the **`outbox.flush`** command, which claims these events, publishes them to the `EventSink`, and updates their status in the database.

The outbox delivers at least once until the retry budget is exhausted. A claim is separate from `publishedAt` and expires after 60 seconds by default. The claim statement returns only the rows it now owns, and the flush checks the lease expiry immediately before each emit. A row revoked after the claim, by an operator's DLQ move or a purge, can still reach the sink once in that page: its acknowledgement then changes nothing, the row stays where the operator put it, and the flush ends after the page. A replay of that row delivers it again. Only a successful sink call can set `publishedAt`. A flush on a caller-owned transaction reports deferred delivery. Run a root-client flush after commit. After a crash, an expired claim can be recovered. Two flushers cannot own the same live claim. A live or retrying head blocks its successors at acquisition. Order is decided at claim time. A replayed dead letter is delivered after later events of its run already claimed or published before replay. After replay, later unclaimed events wait behind it.

The Prisma flusher visits runs in database run-ID order and wraps at the end. One statement reads the rotation position, claims one head for each available run until the page is full or every run has been visited, and then gives each claimed run its next live events, up to an equal share of the page (`maxEvents` divided by the runs claimed; a page holds at most 128 events). A run's events reach the sink one after another, in sequence order. Different runs in a page reach the sink concurrently, without waiting for another run's sink. The first failure in a run stops that run for the page and releases its other events for the next flush. A write error (an acknowledgement, or the failure write after a sink rejection), an expired lease or a cancellation stops the whole page: no run starts another emit, emits already started settle, and the remaining events wait for their claim to expire.

Each claimed row records a rank: the rank of the rotation position plus the run's position in the walk, counting the runs it skipped. Completion and failure keep the rank. The next statement starts after the run with the highest rank, even on a new adapter and even if the last sink failed. Statements that start from the same position, such as concurrent cold flushes, rank a run by its distance from that position, so the next position is the furthest run any of them claimed. On PostgreSQL a run locked by a concurrent claim is skipped (`FOR UPDATE SKIP LOCKED`); the statement that holds the lock claims it. With N runs in the rotation and a head that stays ready, at most N successful successive claim pages across any instances reach that head. This bound assumes the run set is stable, the cursor rows are retained and the claim finishes while the lease is live. A new rank is never below a stored one, so the highest rank is the latest acquisition. A rank saturates at 9,223,372,036,854,775,807 (2^63 - 1), also when the walk skips more runs than a page holds. Equal ranks (two statements at the same distance, saturation, or seeded values) order by the rest of the stored claim, the lease expiry and then the owner token, and then by run ID. At the ceiling the rotation therefore follows the lease expiry: with one claim duration across flushers each page starts after a run of the latest page. There, a page that wraps past the last run ID is followed by a page that starts after the highest run ID it claimed, a run whose delivery failed keeps only its rank, so the next page starts after a run of an earlier page, and a flusher with a shorter claim duration than earlier ones starts its pages after the run with the latest expiry until that expiry passes. The ceiling is out of reach of the counter itself, which grows by at most the runs a walk visits: from zero it takes 9.2 × 10^18 of them, about 292,000 years at a million runs a second, so only a seeded or edited rank reaches it.

A flush seeks directly to the next run head and skips runs with active claims, including a successor claimed before replay. The walk probes each run it visits once, including runs with active claims. On PostgreSQL, a probe can also visit old index entries that a long-running transaction prevents vacuum from removing. In a PostgreSQL 16 test, the first head selection after publishing 100,000 events under a retained snapshot used about 100,600 shared buffers and took 38 ms. After releasing the snapshot and vacuuming, the same index plan used 23 shared buffers. On PostgreSQL the claim runs in one transaction whose timeout is the claim's lease (`claimDurationMs`, 60 s by default), and at least Prisma's 5 s default. A walk that outlasts the lease fails with `P2028` and rolls back: nothing is claimed, and the next flush walks again.

The claim needs a raw read (`$queryRaw` or `$queryRawUnsafe`) on PostgreSQL and SQLite. `createPrismaWorkflowPersistence` refuses a root without one with `OutboxClaimUnsupportedError` (code `OUTBOX_CLAIM_UNSUPPORTED`). The interactive claim runs in a READ COMMITTED transaction whose first statement turns off sequential, bitmap and sort plans for that transaction. This pins the walk to its indexes. As an ordinary role on PostgreSQL 16, ten heads at 0, 10,000 and 100,000 live runs took at most 781 shared buffers and 2.1 ms in each of four statistics states: never analysed, analysed after the outbox drained, analysed on a few published rows, and current. Walking past 25,000 runs with active claims took 511 ms. Three client shapes cannot run those settings in the claim's transaction: a root without `$transaction`, a root with `skipInteractiveTransactions: true`, and a wrapper whose transaction view has no raw read (its claim runs on the root). They run the same single statement, so exclusion and order are unchanged, but the plan follows the statistics. With statistics taken on a few published rows, ten heads over 100,000 live runs read 54,487 shared buffers in 551 ms. With statistics taken after the outbox drained, a walk past 25,000 runs with active claims did not finish in 30 seconds. No statement shape avoids this. Any `"publishedAt" IS NULL` condition the live-run index can serve is also served by `outbox_events_publishedAt_idx`, and the planner prefers that index and a sort when the statistics promise almost no unpublished rows. On these shapes, run `ANALYZE outbox_events` after bulk loads, or use the default interactive transaction.

Fencing costs statements. On PostgreSQL a page costs a transaction with the planner settings and the claim (`BEGIN`, the isolation level, the settings, the claim, `COMMIT`) and one acknowledgement write per run whose events finish apart: 6 driver statements for a page of eight events, from one run or from eight that finish together. An alpha.20 flusher stamped a page in one statement. In a paired local benchmark (Prisma 7, PostgreSQL 16, medians of six runs in rotated order), such a page took 3.1 to 3.5 ms against 0.5 to 0.9 ms for alpha.20, and eight one-event flushes took 19.7 ms (48 statements) against 3.2 ms (8). On SQLite a page costs 3 statements (a one-row read that lets an idle flush skip the write lock, the claim and the acknowledgement) against 9 for alpha.20, and took 1.1 to 1.3 ms against 2.2 to 2.9 ms; eight one-event flushes took 10.0 ms (24 statements) against 3.3 ms (16).

The sink or plugin receives an optional second argument `{ eventId, workflowRunId, sequence, attempt }`. Deduplicate with `eventId`. `workflowRunId` and `sequence` order events within a run, but are not a permanent identity: after an operator deletes the newest outbox rows, the Prisma store can reuse a sequence. `attempt` is the number of recorded failures plus one; crashes and overlapping emits can repeat that number. Delivery can duplicate whenever the sink effect happens without a durable acknowledgement. Examples include a crash or write error after acceptance, an emit in flight at expiry, a sink that commits and then rejects, and partial plugin success. Once failures reach `maxRetries` (default 3), the event is dead-lettered and does not retry until `plugin.replayDLQ` resets it. The poller advances runs independently of the sink. Maintenance ticks and `runToCompletion` bound their waits for outbox delivery (5 seconds by default).

`maxEvents` bounds how many events a flush claims. Each claim permits at most one emit. Its default lifetime is 60 seconds across the page, regardless of its size. A slow sink can delay acquisition of another page by that dispatch. Other flushes can continue through the saved rotation position. The lease clock starts before sending the claim query. After awaiting the claim the flush checks the local expiry immediately before invoking the sink. A claim returned after expiry produces a warning and degraded result with no delivery from that claim. A pause or competing database change can still occur between that check and the effect. Consumers deduplicate using the event ID. The serverless post-job claim lasts `outboxFlushTimeoutMs + 60_000` milliseconds (capped at 2,147,483,647); the timeout stops the dispatch from starting further claims or emits. An already-started emit can settle under the owner fence. Node shutdown uses the remaining shutdown wait plus 60,000 ms, with the same cap. Repeated crashes or indefinitely slow sink calls can cause repeated deliveries; there is no fixed total duplicate bound. Clocks on hosts must be synchronized for expiry decisions.

`engine.stats` and `getUnpublishedOutboxEvents` include claimed events until publication. The console shows a live claim as claimed. Age-based `run.purge` leaves outbox rows for delivery. During a rolling upgrade an alpha.20 flusher ignores the new claim and can stamp an undelivered event as published; the new guarantee starts only after all alpha.20 flushers stop. A legacy stamp without a claim is treated as published and a legacy event already lost that way cannot be recovered.

Targeted erasure removes all outbox events of each erased run. `engine.prune` removes old published events of terminal runs. When age-based purge has deleted a run, an outbox flush still skips live claims until they expire, published rows, and dead letters awaiting replay. If a persistence write fails, `kernel.dispatch` rejects without logging; host maintenance logs `outbox.flush error` and reports degraded delivery. A later flush recovers still-claimed rows after expiry; if the write committed before the error, its recorded outcome applies.

### Dead-letter replay and order

`plugin.replayDLQ` clears the dead-letter status and retry count. Order is decided at claim time. A replayed dead letter is delivered after later events of its run already claimed or published before replay. After replay, later unclaimed events wait behind it. A successor's live claim keeps its turn. If it expires before delivery, a new claim chooses the current head again.

### Degraded delivery

`outbox.flush` returns the sink's state alongside the publish count:

```typescript
const result = await kernel.dispatch({ type: "outbox.flush" });
// {
//   published: 4,
//   failed: 0,            // claimed but not published; retried next flush
//   deadLettered: 0,      // retry budget exhausted; needs plugin.replayDLQ
//                         // (disjoint from `failed` — a dead letter does
//                         //  not retry, so it is not counted there too)
//   eventSinkStatus: "healthy",  // or "degraded"
//   eventSinkError: undefined    // first publish failure, when degraded
// }
```

**`degraded`** is the named state for "the sink is refusing events". It is
deliberately not an error, because an event sink is a notification channel
and the committed poller is what advances a run: a degraded sink costs
delivery latency and dead letters you can replay, and nothing else. What it must not do is stay invisible
until the dead-letter queue fills, so both built-in hosts surface it from
wherever they report status (`host.getStats().eventSink` on the Node host,
`eventSinkStatus` in the serverless maintenance tick result). Consumers who
run their own loop can use `createEventSinkMonitor()` from
`@bratsos/workflow-engine/kernel` to get the same transition-only logging and
`EventSinkHealth` report.

---

## Process diagnostics

Call `setLogger` during startup to send engine diagnostics to your application's logger. The kernel, Node, serverless and remote hosts, standalone AI helpers, and Prisma adapters share the configured sink, including adapter diagnostics from the operational console. Each worker process or JavaScript worker installs its own sink.

```typescript
import { setLogger } from "@bratsos/workflow-engine/kernel";

setLogger({
  debug: (message, fields) => appLogger.debug(fields ?? {}, message),
  info: (message, fields) => appLogger.info(fields ?? {}, message),
  warn: (message, fields) => appLogger.warn(fields ?? {}, message),
  error: (message, fields) => appLogger.error(fields ?? {}, message),
});
```

Each method receives a message and an optional `Record<string, unknown>`. Entries include identifiers such as `workflowRunId`, `stageId` and `jobId` when available. The application sink receives all emitted levels and controls filtering. If a method throws or rejects, the engine tries the console sink once for that entry and continues.

The default console sink emits warnings and errors and enables debug and info with `WORKFLOW_ENGINE_TRACE=1` (or `true`). Call `setLogger(undefined)` to restore it. Set `WORKFLOW_ENGINE_TRACE_TEXT=1` (or `true`) to include AI prompt and response previews and potentially sensitive error details. This flag applies to both sinks. Persisted workflow logs and AI call records have their own storage configuration.

---

## Idempotency Engine

To support safe retries in distributed networks, commands like `run.create`, `job.execute`, `run.redrive` and `run.rerunFrom` accept an optional `idempotencyKey`.

* **Duplicate Prevention**: If a key has already completed execution, re-submitting the command immediately returns the previously cached output from the `IdempotencyKey` table without running it again.
* **In-Progress Guard**: If the command is currently running, subsequent dispatches throw an `IdempotencyInProgressError`.
* **Stuck-Key Reclamation**: If a dispatcher process crashes midway, the key could stay in the `in_progress` state forever. **`idempotencyStaleInProgressMs`** (default: 10 minutes) bounds that: a key that has been in progress longer than the threshold is reclaimed and allowed to run again.
* **Completed With the Command**: A command with no work after its commit, such as `run.create`, completes its key in the same transaction as its writes. If the worker dies after that commit, the key is already complete and a retry with it returns the run that was created. If the key write or the commit fails, nothing is written and the key is released, so a retry creates the run once. A command with work after its commit (an enqueue, a cancel or a cleanup) still completes its key after that work, as before.
