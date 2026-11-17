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
* **`run.create`**: Creates a pending run record, pinned to the workflow's current definition version.
* **`run.claimPending`**: Scans for and claims pending runs this build serves, then enqueues their first-stage jobs (after the claim commits).
* **`job.execute`**: Executes a single stage (runs `execute()`). Takes the job's `attempt`/`maxAttempts` to decide `willRetry`, and an optional `abortSignal` that becomes `ctx.abortSignal`.
* **`job.heartbeat`**: One beat of a host's job lease heartbeat: renews the lease and reports the run's status and whether the worker still holds the job, which is what the host aborts `ctx.abortSignal` from.
* **`run.transition`**: Evaluates completed stage outputs and transitions the workflow run to the next execution group or completes the run.
* **`run.cancel`**: Authority that marks a run cancelled and sets open stages to cancelled; after that commits, it purges the run's jobs from the job queue.
* **`run.redrive`**: Retry, restart or rerun a terminal run — `from: { kind: "lastFailure" | "start" | "stage" }` — keeping the resumed stage's step ledger and archiving every superseded attempt; optionally re-pins the run to another definition version. See [Retry, Restart and Rerun](./redriving-runs.md). `run.rerunFrom` still works but is deprecated and delegates to it.
* **`stage.pollSuspended`**: Replays suspended durable stages whose `nextPollAt` has passed (and runs `checkCompletion` for the internal async-batch mode).
* **`step.signal`**: Completes a `ctx.step.waitForSignal` step with a payload and nudges its stage for replay. Idempotent: a second signal reports `alreadyCompleted: true`.
* **`lease.reapStale`**: Recovers jobs held by crashed workers (heartbeat tier) and fails jobs past the absolute cap.
* **`outbox.flush`**: Publishes committed outbox events to the `EventSink` and reports the sink's health.
* **`plugin.replayDLQ`**: Re-queues dead-lettered outbox events once the sink is back.
* **`run.reapStuck`**: Automatically fails workflow runs that have ceased database updates.
* **`run.purge`**: Deletes terminal runs older than a cutoff with everything under them (stages, logs, artifacts, annotations, step ledger, job rows, blobs). Off unless a host is given `retention`; see [Run Retention](../troubleshooting/overview.md#run-retention).
* **`run.listVersions`**: Reports which definition versions still have runs and whether this build serves them.
* **`engine.stats`**: Read-only gauges of active work: runs, stages, jobs and outbox events by status, plus the age of the oldest waiting item. See [Observing the engine](#observing-the-engine).

---

## Observing the engine

`engine.stats` answers "is the engine keeping up?" without the engine taking a metrics dependency. It counts only active work (PENDING, RUNNING and SUSPENDED rows, plus unpublished and dead-lettered outbox events). The built-in adapters answer each figure from an index that leads with the active column, so the cost follows the amount of work in flight, not the size of the tables, with or without planner statistics: the plans are asserted on SQLite without statistics, and on PostgreSQL for tables that were never analysed and after `ANALYZE`, with 500,000 published outbox events and 100,000 terminal runs, stages and jobs. Two figures are read slightly differently. The dead-lettered count reads `outbox_events_dlqAt_idx` from its first non-NULL entry, so it visits only the dead letters' entries; on PostgreSQL it counts events whose `dlqAt` lies between 1970-01-01 and 9999-12-31, the range that lets the planner choose that index without statistics, and the engine never writes one outside it. The due-stage count uses `workflow_stages_status_idx` or, on PostgreSQL once its statistics say few stages carry a deadline, `workflow_stages_nextPollAt_idx`, which holds a terminal stage only until its job is settled. It writes nothing: no outbox event, no idempotency key, no transaction.

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
//             unpublished: 2,                     // what the next outbox.flush delivers
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
{ "$wfSpill": 1, "key": "workflow-v2/spill/steps/<stageRecordId>/<stepId>.json", "bytes": 400018 }
```

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

What that does and does not guarantee:

* **No phantom events.** An event is written in the same transaction as the state change it describes, so a rolled-back transaction writes none.
* **One delivery attempt per claim.** The flush claims an event (stamps its `publishedAt`) before it calls `EventSink.emit`. The claim is atomic, so two hosts flushing the same outbox never deliver the same event.
* **Retried on a sink failure.** If `emit` throws, the event is released and the next flush tries again, up to the retry budget (`maxRetries`, default 3 failed attempts); then it is dead-lettered until you replay it with `plugin.replayDLQ`. A retry calls `emit` again for the whole event: with the plugin runner, plugins that ran before the failing one see it again, so keep plugin handlers idempotent.
* **Lost only if the process dies between the claim and the emit.** The stamp then says the event was published, and no later flush picks it up. Delivery is at-most-once per claim, retried only after a sink failure; it is **not** at-least-once.
* **The engine's own progress never depends on the sink.** The poller, not the sink, advances runs. A refusing sink costs delivery latency and dead letters you can replay, and nothing else.
* **If you need every event, read the table.** Treat the `EventSink` as a notification channel and the `outbox_events` table as the record: the row stays whatever became of its delivery, until `run.purge` removes the run. The [console](../console/overview.md) reads the same rows (the run's outbox event timeline and the dead letters).

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

## Idempotency Engine

To support safe retries in distributed networks, commands like `run.create`, `job.execute`, `run.redrive` and `run.rerunFrom` accept an optional `idempotencyKey`.

* **Duplicate Prevention**: If a key has already completed execution, re-submitting the command immediately returns the previously cached output from the `IdempotencyKey` table without running it again.
* **In-Progress Guard**: If the command is currently running, subsequent dispatches throw an `IdempotencyInProgressError`.
* **Stuck-Key Reclamation**: If a dispatcher process crashes midway, the key could stay in the `in_progress` state forever. **`idempotencyStaleInProgressMs`** (default: 10 minutes) bounds that: a key that has been in progress longer than the threshold is reclaimed and allowed to run again.
