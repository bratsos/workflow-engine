---
sidebar_position: 1
title: Troubleshooting
---

# Troubleshooting

This guide covers common issues encountered when running **workflow-engine**, how the engine recovers, and steps to manually inspect and debug your runs.

---

## Common Issues & Symptoms

### 1. Runs Stuck in `PENDING`
* **Symptom**: New runs stay in `PENDING` and never start execution.
* **Cause**: 
  * The orchestration tick loop is not running.
  * The host process is crashed or offline.
  * The workflow definition is missing from the kernel's registry.
  * The run is pinned to a definition version no running host serves (a deploy changed the pipeline's structure while runs were pending).
* **Check**:
  * Check host stats using `host.getStats()`. Ensure `orchestrationTicks` is incrementing.
  * Dispatch `run.listVersions`: `unservedHere` lists the versions with live runs that this build does not present. See [Definition Versioning](../core-concepts/definition-versioning.md#has-it-drained).
  * With a hand-written `{ getWorkflow }` registry (or `serves: "all"`), a run whose workflow is missing is adopted and marked `FAILED` with `WORKFLOW_NOT_FOUND`. With `createWorkflowRegistry`, the claim query does not return it at all and it stays `PENDING` for a host that has the workflow.
* **Fix**:
  * Ensure `host.start()` was called.
  * Verify that the workflow ID matches a workflow in `createKernel({ registry: createWorkflowRegistry([...]) })`.
  * For a stranded version, redrive the run onto the current build with `run.redrive` and `definitionVersion: "latest"` (see [Retry, Restart and Rerun](../core-concepts/redriving-runs.md)).

---

### 2. Runs Stuck in `RUNNING`
* **Symptom**: Runs are marked `RUNNING` but no progress is made. No new jobs are being enqueued, and logs have ceased.
* **Cause**:
  * A host worker crashed midway through executing a stage, leaving the stage stuck in `RUNNING` with an active lease.
  * A database or network failure prevented the host from calling `run.transition` after completing a job.
* **Self-Healing (Reap Stuck)**:
  * The kernel's `run.reapStuck` command runs automatically on every host orchestration tick.
  * It detects `RUNNING` runs that have had no database updates within the threshold (default: `max(3 * staleLeaseThresholdMs, 5 minutes)`).
  * Stuck runs are failed with the error code `STUCK_RUN_REAPED`. Their active child stages fail in the same transaction, with completion times and errors; terminal stages remain unchanged.
  * A run waiting on a `SUSPENDED` stage is not stuck: while that stage's `nextPollAt` is ahead, or came due less than one threshold ago, the run is left alone, so a long `ctx.step.sleep`, `waitFor` `every` or signal `keepalive` is safe.
  * In a parallel group the same rule covers the whole run: while one stage waits this way, the run is not reaped even if a sibling stage has stopped making progress. The reap follows once the waiting stage resumes, or once its `nextPollAt` is more than one threshold behind. A `PENDING` sibling whose job was lost is still re-enqueued in the meantime.
  * A `PENDING` stage whose job was lost is re-enqueued instead of failing the run, and the sweep refreshes the run's activity, so the next sweep before a worker dequeues the recovered job does not reap it.
* **Manual Recovery**:
  * If a run was completed but failed to transition, you can manually trigger a transition:
    ```typescript
    await kernel.dispatch({ 
      type: "run.transition", 
      workflowRunId: "your-stuck-run-id" 
    });
    ```

---

### 3. Ghost Jobs
* **Symptom**: Workers are processing stages for workflow runs that have already been `FAILED` or `CANCELLED`, creating zombie loops.
* **Cause**:
  * If a workflow is cancelled, active jobs might still reside in the worker's queue.
* **Self-Healing**:
  * **Authoritative Cancellation**: Calling `run.cancel` marks the run and its open stages cancelled, and once that commits it purges the run's queued jobs from the queue via `jobTransport.cancelByRun()`. The job executing at that moment is told to stop through `ctx.abortSignal` on its next lease heartbeat.
  * **Ghost Job Guard**: `job.execute` verifies that the run is in `RUNNING` status both before and after executing a stage.
  * **Reason-specific handling**: If the run is not something this worker should execute, the result is discarded and returned with `ghost: true` and a `ghostReason`. `"orphan"` (run cancelled or finished) is failed terminally without a retry; `"race"` (the run is still `PENDING` because the claim that enqueued the job had not committed) is re-delivered; `"version"` (the run is pinned to a definition version this build does not serve) is deferred without spending an attempt. See [Execution Model](../core-concepts/execution-model.md#ghost-job-guard).

---

### 4. Crash resumption of a durable step waits minutes
* **Symptom**: A worker died inside a `ctx.step.run` body; the replay on another worker reports `StepInFlight` and the stage only resumes about five minutes later.
* **Cause**: The step's lease. A `workflow_steps` row carries no worker identity, so the lease (`StepRunOptions.lease`, default five minutes) is the only liveness signal the step has, and nothing — not `lease.reapStale`, which releases *job* leases only — releases it early without risking a second execution of the body.
* **Fix**: Size `lease` per step to the longest the body should take plus headroom (`{ lease: "30s" }` recovers in about 30 s), and use `heartbeat` for a body whose length you cannot bound. See [Durable Steps](../core-concepts/durable-steps.md#leases-retries-and-deadlines).

---

### 5. A stage is stuck on `waitForSignal`
* **Symptom**: A stage is `SUSPENDED` with a `signal` step `pending` and nobody delivered the signal.
* **Fix**: Dispatch `{ type: "step.signal", workflowRunId, stageId, stepId, payload }`, or use *Deliver signal* on the step in the [console](../console/overview.md#delivering-a-signal). Delivery wakes the stage on the next maintenance tick regardless of the step's `keepalive`. A step past its `timeout` cannot be signalled; redrive the run instead.

---

### 6. `StepNotReplaySafeError` or a `step.outcome-conflict` annotation
* **Symptom**: A stage failed with `StepNotReplaySafeError` naming a step and its external key, or the run carries a `step.outcome-conflict` annotation.
* **Cause**: A `run` body declared `onReclaim: "fail"` lost its lease and the engine refused to re-execute it (the error), or two workers executed the same body and the second outcome lost the compare-and-set (the annotation). In both cases the body may have run more than once.
* **Fix**: Search the provider for the effect under the step's `externalKey` (shown on the console's run detail, or `SELECT "externalKey" FROM workflow_steps WHERE "stageRecordId" = ? AND "stepId" = ?`). Then either complete the run by hand or redrive it once you know the effect is absent.

---

### 7. Prisma `P2002` (Unique Constraint) Errors
* **Symptom**: Error logs show unique constraint violations on stage creation.
* **Cause**: 
  * In older versions, if a crashed worker left an orphaned stage record, enqueuing the stage again threw a `P2002` conflict on `(workflowRunId, stageId)`.
* **Self-Healing**:
  * `run.claimPending` and `run.transition` use **idempotent stage upserts** (`upsertStage`). If a record exists, the engine preserves it and enqueues jobs only for stages that are still `PENDING`, resolving retry-loop lockups.

---

### 8. Prisma `P2028` (Transaction Timeout) on Suspended Stages
* **Symptom**: Logs show transaction timeouts when polling suspended stages.
* **Cause**:
  * Making external API calls to batch providers (like OpenAI or Google) inside a database transaction exceeds Prisma's interactive transaction timeout (5 seconds by default).
* **Self-Healing**:
  * `stage.pollSuspended` replays the stage body (and runs `checkCompletion()`) outside database transactions. State updates are committed in a subsequent short transaction, resolving P2028 database timeouts. A poll whose stage row moved on while `checkCompletion()` or the replay ran (a `job.execute`, a cancel, a redrive or another poller wrote it) commits nothing: every stage write it makes is fenced on the version it claimed, it is not counted as resumed or failed, and it reads the row once before its first write. A failed read does not fail the stage; the fence decides. A poller that cannot serve the workflow fences its FAILED write the same way. Output and artifacts go to keys of the poll's own, which only its committed write points `outputData` at, so a superseded poll never changes the winner's bytes, and its keys are deleted again. Limits, all also on main: what user code writes itself (`ctx.storage`, `ctx.log`, step rows) is not undone; a durable replay's retry reopens failed step rows from a ledger read after its commit, and an expired wait is marked through the ledger before the replay runs; a poll that completes or fails the stage before the host acknowledged the job's suspension leaves that job row SUSPENDED; output a failed publication already wrote stays until `run.purge` removes it.
* **What it looks like**: the code is `P2028` on Prisma 6, 7 and 8, but the error differs. On Prisma 6 and 7 it is a `PrismaClientKnownRequestError` with `meta`, and the message contains `A query cannot be executed on an expired transaction` (Prisma 6 puts `Transaction already closed:` in front of it). On Prisma 8 it is a plain `Error` with no `meta`, raised by `fromPrisma8`, and the message is `Transaction already closed: the 1000ms timeout passed.` (with your timeout). A log search for the Prisma 6 and 7 text finds nothing on Prisma 8, so search for the code.

---

### 9. `PrismaClient is not assignable to EnginePrismaClient`
* **Symptom**: A wall of type errors when passing your Prisma client to `createPrismaWorkflowPersistence`, `createPrismaStepLedger` or `createPrismaJobQueue`.
* **Cause**: The generated client is missing a delegate the adapter calls — after 1.0, almost always `workflowStep` (the `WorkflowStep` model) or `workflowDefinition`.
* **Fix**: Add the missing models from [Prisma Setup](../persistence/prisma-setup.md) and re-run `prisma generate`. On Prisma 8 there is no generated client to be incomplete; `fromPrisma8(db)` throws `the contract has no model for the engine table "..."` instead, naming the table to copy from `contract.prisma`. It also throws when a timestamp column is not `TimestampString(3)` or `status` is not the native `Status` enum, each with the fix in the message.

---

### 10. `DefinitionRegistrationRetryableError` during registration
* **Symptom**: Definition registration throws `DefinitionRegistrationRetryableError` with `code: "DEFINITION_REGISTRATION_RETRY"`.
* **Cause**: A concurrent winner is outside a `REPEATABLE READ` / `SERIALIZABLE` snapshot, PostgreSQL reports `40001` / Prisma `P2034`, or the follow-up read finds no row.
* **Fix**: Catch it outside the caller transaction, let it roll back, and retry the **whole caller transaction**. It may already be aborted; retrying only registration inside it is insufficient. See [Definition Versioning](../core-concepts/definition-versioning.md#concurrent-registration-and-transaction-retries).

---

### 11. Prisma 8 SQLite: `Transaction commit failed` after about 5 seconds

Symptom: on a SQLite file in the default rollback-journal mode, your own `db.transaction(...)` (one you open on the Prisma 8 client, not the adapter's `$transaction`) fails with `Transaction commit failed` after the busy timeout, while the engine runs in the same process. Cause: a root read of the wrapped client was still handing over rows, holding the file's read lock, and the commit waited for it synchronously, so the read could not finish. The adapter's own transactions wait for those reads; yours cannot. The engine's own transactions fail the same way when the read is one your code holds open: a `for await` loop over `db.orm.<Model>.all()` or `db.query(...)` that awaits an engine call (`kernel.dispatch`, `$transaction`) inside the loop, or an iterator left unfinished. The adapter does not wait for a read whose consumer is not taking rows (its consumer may be awaiting that very commit), so the commit fails as it would without the adapter. Fix: turn on WAL once on the file (`PRAGMA journal_mode=WAL`, see Prisma Setup), or build the ports over your transaction's `tx` and do not read through the root client while it is open. For a loop, read the rows first (`.toArray()`) and write after, or finish or `return()` the iterator before the engine call. In WAL the same shape does not fail the commit. A `kernel.dispatch` made under a read your code holds open can still reject with `SQLITE_BUSY_SNAPSHOT` (errcode 517) after its run was stored: the kernel completes the idempotency key after the commit, and that write meets the read's older snapshot. This is a limit of the kernel's idempotency handling on every database, not of the wrapper; read the rows first in the same way.

### 12. Prisma 8 SQLite: `BEGIN on the root client ... Use $transaction`

Symptom: `$executeRaw`/`$queryRaw` of `BEGIN` or `SAVEPOINT` on the Prisma 8 SQLite wrapper (or `db.execute`/`db.query` of one on the client it wraps) throws `fromPrisma8: BEGIN on the root client: other callers' writes would join it. Use $transaction`. `COMMIT`, `END`, `ROLLBACK` and `RELEASE` are never refused. Cause: the root connection is shared by every caller in the process; a transaction opened on it by hand would take in the engine's writes, and a later `ROLLBACK` would undo writes their callers saw succeed. Fix: use `prisma.$transaction(async (tx) => ...)` or `db.transaction(async (tx) => ...)`; inside either, `SAVEPOINT` and `RELEASE` work.

### 13. Prisma 8 SQLite: `the SQLite root connection is inside a transaction this adapter did not open`

Symptom: engine calls (`kernel.dispatch`, adapter writes, `$transaction`) fail with this busy error (`code: "SQLITE_BUSY"`) after about 5 seconds. Cause: your code sent a raw `BEGIN` or `SAVEPOINT` to the client's root connection (`db.execute`, `db.query`) before the adapter's first call, so the wrapper had not yet taken the connection over and could not refuse it, and that transaction is still open. Engine writes wait for it to end instead of joining it, so that your `ROLLBACK`, or a close without `COMMIT`, cannot take back a write the engine acknowledged. Fix: end it with `COMMIT` or `ROLLBACK` (both are always allowed); engine writes waiting at that moment then run. Open transactions with `$transaction(...)` or `db.transaction(...)` instead.

## Orchestration Tick Flow

The host orchestration tick executes these operations sequentially. Each operation runs inside its own try/catch block, preventing a single failure (e.g. one bad database query) from starving unrelated operations:

1. **`run.claimPending`**: Discovers new runs this build serves, creates stage rows, and enqueues jobs after the claim commits.
2. **`stage.pollSuspended`**: Replays suspended durable stages whose `nextPollAt` has passed (a `waitFor` poll, a batch status check, a sleep or signal keepalive).
3. **`lease.reapStale`**: Recovers job locks from crashed worker processes and fails jobs past the absolute cap.
4. **`outbox.flush`**: Emits events to the `EventSink`.
5. **`run.reapStuck`**: Cleans up zombie runs that have lost database activity.
6. **`run.purge`** (only when the host is given `retention`): Deletes terminal runs past their retention age.

---

## Run Retention

Nothing deletes a finished run by itself. Opt in per host with `retention: { olderThanMs, statuses?, limit? }` (off by default) and the maintenance tick dispatches `run.purge`, which deletes `COMPLETED`/`FAILED`/`CANCELLED` runs that finished at or before the cutoff, `limit` (default 100) per tick, oldest first. Selection commits before cleanup starts. For each run, the step ledger is cleared through the `StepLedger` port, job rows go through the `JobTransport`, and blobs under `workflow-v2/<workflowType>/<runId>/`, `workflow-v2/spill/jobs/<runId>/` and `workflow-v2/spill/steps/<stageRecordId>/` are removed. Only then is the run deleted through `PersistenceCore.deleteRun` (stages, logs, artifacts, annotations cascade). A run redriven during the sweep is kept, and the result names only the runs deleted. Cleanup already done is not undone, so what follows depends on when the redrive lands: before cleanup starts, nothing is touched; after the ledger is cleared, completed steps can run again; after the job rows or blobs are gone, the stage output is missing and the run ends `FAILED` through `run.reapStuck`. This window is also on main: nothing holds off a redrive, a rerun or a signal while the sweep runs. The sweep cleans the stage records the run has when it re-reads it, not the ones selection saw. After the run is deleted it repeats its cleanup once, and a delayed enqueue or a signal that lands later removes what it wrote. Both are best effort: if that repeat or the writer's own check fails, the late data stays and no later purge can select the deleted run (also on main, which has neither). If the step ledger cannot list a record's rows, that record's signal wake keys stay behind (also on main). Cleanup uses the ports outside the selection transaction. If any cleanup or the final delete fails, dispatch rejects and the run remains eligible for a later purge; cleanup can be partial, so custom ports must tolerate repeated cleanup. No events are emitted. The command can also be dispatched directly:

```typescript
await kernel.dispatch({ type: "run.purge", olderThan: new Date(Date.now() - 30 * 86_400_000) });
```

Deleting by SQL instead: with the reference schema, `DELETE FROM "workflow_runs" WHERE ...` cascades to stages, logs, artifacts and annotations, and from `workflow_stages` to `workflow_steps` **only once the `workflow_steps_stageRecordId_fkey` foreign key exists** (package schema from the release that added `run.purge`; earlier 1.0 alphas need the `ADD CONSTRAINT` in the [0.13 → 1.0 migration guide](../migrations/migrate-0.13-to-1.0.md)). `job_queue` and `outbox_events` have no foreign key to the run and must be deleted explicitly, and blobs live outside the database. `run.purge` itself never deletes outbox rows (nor `ai_calls`): nothing in the engine does, so the outbox table is not bounded by retention and you remove its rows with SQL.

---

## Error Codes Reference

When a workflow fails, the error details are persisted inside the `WorkflowRun.output` JSON column under the `error` key.

| Error Code | Location | Description |
| :--- | :--- | :--- |
| **`WORKFLOW_NOT_FOUND`** | `run.claimPending` | The workflow ID does not exist in the kernel's registry. |
| **`EMPTY_STAGE_GRAPH`** | `run.claimPending` | The workflow definition contains no stages in its first execution group. |
| **`CLAIM_FAILED`** | `run.claimPending` | An unexpected database exception occurred while claiming. The run is failed, but other runs in the batch continue processing. |
| **`STUCK_RUN_REAPED`** | `run.reapStuck` | The workflow run ceased database updates and exceeded the stuck threshold. |
| **`LEASE_HEARTBEAT_LOST`** | `lease.reapStale` (prefix on `job_queue.lastError`) | The job's lease went unheartbeated past `staleLeaseThresholdMs`; the job was requeued. |
| **`LEASE_ABSOLUTE_CAP`** | `lease.reapStale` (prefix on `job_queue.lastError`) | The job ran past `jobAbsoluteTimeoutMs`; it was failed terminally. |
