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

When initializing a kernel with `createKernel`, you must inject implementations for these seven ports:

| Port Name | Interface | Purpose |
| :--- | :--- | :--- |
| **`persistence`** | `Persistence` | Manages metadata storage for runs, stages, execution logs, transaction outboxes, and idempotency records. |
| **`blobStore`** | `BlobStore` | Handles storage for large input/output payloads and intermediate stage artifacts (using methods like `put`, `get`, `has`, `delete`, and `list`). |
| **`jobTransport`** | `JobTransport` | Acts as the job queue (managing dequeue loops, claiming, and cancelling queued jobs). |
| **`eventSink`** | `EventSink` | Dispatches internal system event notifications asynchronously (e.g., `workflow:completed`, `stage:started`). |
| **`scheduler`** | `Scheduler` | Coordinates deferred command execution (such as resuming suspended async-batch stages). |
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

## Transactional Outbox Events

To ensure system notifications are reliable, **workflow-engine** implements the **Transactional Outbox Pattern**:
* When a command is executed, system events (like `workflow:completed`, `stage:failed`) are not sent immediately to the `EventSink`.
* Instead, they are written to the database in the `OutboxEvent` table as part of the primary database transaction.
* The host then dispatches the **`outbox.flush`** command, which reads these events, publishes them to the `EventSink`, and updates their status in the database.
* This guarantees **at-least-once delivery** of all system events and eliminates "phantom" events (e.g. notifications sent for a transaction that was rolled back).

---

## Idempotency Engine

To support safe retries in distributed networks, commands like `run.create`, `job.execute`, and `run.rerunFrom` accept an optional `idempotencyKey`.

* **Duplicate Prevention**: If a key has already completed execution, re-submitting the command immediately returns the previously cached output from the `IdempotencyKey` table without running it again.
* **In-Progress Guard**: If the command is currently running, subsequent dispatches throw an `IdempotencyInProgressError`.
* **Stuck-Key Reclamation (v0.11+)**: If a dispatcher process crashes midway, the key could stay in the `in_progress` state forever. In `v0.11`, you can configure **`idempotencyStaleInProgressMs`** (default: 10 minutes). If a key has been in progress longer than this threshold, it is automatically reclaimed and allowed to run again.
