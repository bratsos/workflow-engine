---
sidebar_position: 3
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

---

## The 7 Core Ports

When initializing a kernel with `createKernel`, you must inject implementations for six required ports — `persistence`, `blobStore`, `jobTransport`, `eventSink`, `clock`, and `registry`. A seventh, `scheduler`, is optional and currently unused (see below):

| Port Name | Interface | Purpose |
| :--- | :--- | :--- |
| **`persistence`** | `Persistence` | Manages metadata storage for runs, stages, execution logs, transaction outboxes, and idempotency records. |
| **`blobStore`** | `BlobStore` | Handles storage for large input/output payloads and intermediate stage artifacts (using methods like `put`, `get`, `has`, `delete`, and `list`). |
| **`jobTransport`** | `JobTransport` | Acts as the job queue (managing dequeue loops, claiming, and cancelling queued jobs). |
| **`eventSink`** | `EventSink` | Dispatches internal system event notifications asynchronously (e.g., `workflow:completed`, `stage:started`). |
| **`scheduler`** | `Scheduler` | Optional; currently unused/vestigial (reserved for a possible future phase). The kernel supplies an internal no-op automatically when omitted. Suspended async-batch stages are actually resumed via host-driven `stage.pollSuspended` polling — see [Command Dispatch](#command-dispatch) below. |
| **`clock`** | `Clock` | Resolves the current system time. Can be mocked in tests (`FakeClock`) to control duration math. |
| **`registry`** | `WorkflowRegistry` | Maps workflow IDs to their respective immutable `Workflow` objects compiled via `WorkflowBuilder`. |

An optional 8th port, **`executor`** (`ActivityExecutor`), can be injected to delegate stage executions to separate processes or remote activity workers (see [Remote Workers](../hosts/remote-workers.md)).

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
* **`run.create`**: Creates a pending run record.
* **`run.claimPending`**: Scans for and claims pending runs, then enqueues their first-stage jobs.
* **`job.execute`**: Executes a single stage (runs `execute()`).
* **`run.transition`**: Evaluates completed stage outputs and transitions the workflow run to the next execution group or completes the run.
* **`run.cancel`**: Authority that marks a run cancelled, sets open stages to cancelled, and purges the job queue.
* **`run.rerunFrom`**: Deletes downstream stages and queues them for execution from a specific point.
* **`stage.pollSuspended`**: Triggers completion checks for stages currently waiting for asynchronous processes.
* **`lease.reapStale`**: Recovers jobs held by crashed workers.
* **`run.reapStuck`**: Automatically fails workflow runs that have ceased database updates.

---

## Large Payloads: The Claim Check

The engine has no payload ceiling. A stage that returns a 4 MB extraction is
not rejected, which is the right default for AI work and also why there has
to be an escape hatch: without one, a very large value is simply a very large
row, read back in full on every replay.

Stage outputs have never had that problem -- they go to the `blobStore` and
the row keeps only `outputData._artifactKey`. From `1.0.0-alpha.9` the same
claim check covers the two other places a payload can grow without bound.

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

To ensure system notifications are reliable, **workflow-engine** implements the **Transactional Outbox Pattern**:
* When a command is executed, system events (like `workflow:completed`, `stage:failed`) are not sent immediately to the `EventSink`.
* Instead, they are written to the database in the `OutboxEvent` table as part of the primary database transaction.
* The host then dispatches the **`outbox.flush`** command, which reads these events, publishes them to the `EventSink`, and updates their status in the database.
* This guarantees **at-least-once delivery** of all system events and eliminates "phantom" events (e.g. notifications sent for a transaction that was rolled back).

### Degraded delivery

`outbox.flush` returns the sink's state alongside the publish count:

```typescript
const result = await kernel.dispatch({ type: "outbox.flush" });
// {
//   published: 4,
//   failed: 0,            // claimed but not published; retried next flush
//   deadLettered: 0,      // retry budget exhausted; needs plugin.replayDLQ
//   eventSinkStatus: "healthy",  // or "degraded"
//   eventSinkError: undefined    // first publish failure, when degraded
// }
```

**`degraded`** is the named state for "the sink is refusing events". It is
deliberately not an error, because an event sink is a notification channel
and the committed poller is what advances a run: a degraded sink costs
delivery latency and nothing else. What it must not do is stay invisible
until the dead-letter queue fills, so both built-in hosts surface it from
wherever they report status (`host.getStats().eventSink` on the Node host,
`eventSinkStatus` in the serverless maintenance tick result). Consumers who
run their own loop can use `createEventSinkMonitor()` from
`@bratsos/workflow-engine/kernel` to get the same transition-only logging and
`EventSinkHealth` report.

---

## Idempotency Engine

To support safe retries in distributed networks, commands like `run.create`, `job.execute`, and `run.rerunFrom` accept an optional `idempotencyKey`.

* **Duplicate Prevention**: If a key has already completed execution, re-submitting the command immediately returns the previously cached output from the `IdempotencyKey` table without running it again.
* **In-Progress Guard**: If the command is currently running, subsequent dispatches throw an `IdempotencyInProgressError`.
* **Stuck-Key Reclamation (v0.11+)**: If a dispatcher process crashes midway, the key could stay in the `in_progress` state forever. In `v0.11`, you can configure **`idempotencyStaleInProgressMs`** (default: 10 minutes). If a key has been in progress longer than this threshold, it is automatically reclaimed and allowed to run again.
