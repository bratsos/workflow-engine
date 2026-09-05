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
* **Check**:
  * Check host stats using `host.getStats()`. Ensure `orchestrationTicks` is incrementing.
  * Check the database run records. If `run.claimPending` fails to find the workflow in the registry, the run will be marked `FAILED` with the error code `WORKFLOW_NOT_FOUND`.
* **Fix**:
  * Ensure `host.start()` was called.
  * Verify that the workflow ID matches the key registered in your `createKernel({ registry: { getWorkflow } })` handler.

---

### 2. Runs Stuck in `RUNNING`
* **Symptom**: Runs are marked `RUNNING` but no progress is made. No new jobs are being enqueued, and logs have ceased.
* **Cause**:
  * A host worker crashed midway through executing a stage, leaving the stage stuck in `RUNNING` with an active lease.
  * A database or network failure prevented the host from calling `run.transition` after completing a job.
* **Self-Healing (Reap Stuck)**:
  * The kernel's `run.reapStuck` command runs automatically on every host orchestration tick.
  * It detects `RUNNING` runs that have had no database updates within the threshold (default: `max(3 * staleLeaseThresholdMs, 5 minutes)`).
  * Stuck runs are failed with the error code `STUCK_RUN_REAPED`.
* **Manual Recovery**:
  * If a run was completed but failed to transition, you can manually trigger a transition:
    ```typescript
    await kernel.dispatch({ 
      type: "run.transition", 
      workflowRunId: "your-stuck-run-id" 
    });
    ```

---

### 3. ghost Jobs
* **Symptom**: Workers are processing stages for workflow runs that have already been `FAILED` or `CANCELLED`, creating zombie loops.
* **Cause**:
  * If a workflow is cancelled, active jobs might still reside in the worker's queue.
* **Self-Healing**:
  * **Authoritative Cancellation**: Calling `run.cancel` automatically purges queued jobs from the queue via `jobTransport.cancelByRun()`.
  * **Ghost Job Guard**: `job.execute` verifies that the run is in `RUNNING` status both before and after executing a stage.
  * **No-Retry**: If the status is not `RUNNING`, the execution result is discarded and returned with a `ghost: true` flag. The host detects this flag and skips retrying the job.

---

### 4. Prisma `P2002` (Unique Constraint) Errors
* **Symptom**: Error logs show unique constraint violations on stage creation.
* **Cause**: 
  * In older versions, if a crashed worker left an orphaned stage record, enqueuing the stage again threw a `P2002` conflict on `(workflowRunId, stageId)`.
* **Self-Healing**:
  * `run.claimPending` and `run.transition` use **idempotent stage upserts** (`upsertStage`). If a record exists, the engine preserves it and enqueues jobs only for stages that are still `PENDING`, resolving retry-loop lockups.

---

### 5. Prisma `P2028` (Transaction Timeout) on Suspended Stages
* **Symptom**: Logs show transaction timeouts when checking suspended async-batch stages.
* **Cause**:
  * Making external API calls to batch providers (like OpenAI or Google) inside a database transaction exceeds Prisma's interactive transaction timeout (5 seconds by default).
* **Self-Healing**:
  * `stage.pollSuspended` executes `checkCompletion()` outside database transactions. State updates are committed in a subsequent short transaction, resolving P2028 database timeouts.

---

## Orchestration Tick Flow

The host orchestration tick executes these operations sequentially. Each operation runs inside its own try/catch block, preventing a single failure (e.g. one bad database query) from starving unrelated operations:

1. **`run.claimPending`**: Discovers new runs, creates stage rows, and enqueues jobs.
2. **`stage.pollSuspended`**: Interrogates batch providers for suspended async-batch stages.
3. **`lease.reapStale`**: Recovers job locks from crashed worker processes.
4. **`outbox.flush`**: Emits events to the `EventSink`.
5. **`run.reapStuck`**: Cleans up zombie runs that have lost database activity.
6. **`run.purge`** (only when the host is given `retention`): Deletes terminal runs past their retention age.

---

## Run Retention

Nothing deletes a finished run by itself. Opt in per host with `retention: { olderThanMs, statuses?, limit? }` (off by default) and the maintenance tick dispatches `run.purge`, which deletes `COMPLETED`/`FAILED`/`CANCELLED` runs that finished at or before the cutoff, `limit` (default 100) per tick, oldest first: the step ledger is cleared through the `StepLedger` port, job rows go through the `JobTransport`, the run through `PersistenceCore.deleteRun` (stages, logs, artifacts, annotations cascade), and the run's blobs (`workflow-v2/<workflowType>/<runId>/`, `workflow-v2/spill/jobs/<runId>/`, `workflow-v2/spill/steps/<stageRecordId>/`) are removed after commit. No events are emitted. The command can also be dispatched directly:

```typescript
await kernel.dispatch({ type: "run.purge", olderThan: new Date(Date.now() - 30 * 86_400_000) });
```

Deleting by SQL instead: with the reference schema, `DELETE FROM "workflow_runs" WHERE ...` cascades to stages, logs, artifacts and annotations, and from `workflow_stages` to `workflow_steps` **only once the `workflow_steps_stageRecordId_fkey` foreign key exists** (package schema from the release that added `run.purge`; earlier 1.0 alphas need the `ADD CONSTRAINT` in the 0.13 → 1.0 migration guide). `job_queue` has no foreign key to the run and must be deleted explicitly, and blobs live outside the database. The reference (`09-troubleshooting.md`, "Run Retention") has the batched statement.

---

## Error Codes Reference

When a workflow fails, the error details are persisted inside the `WorkflowRun.output` JSON column under the `error` key.

| Error Code | Location | Description |
| :--- | :--- | :--- |
| **`WORKFLOW_NOT_FOUND`** | `run.claimPending` | The workflow ID does not exist in the kernel's registry. |
| **`EMPTY_STAGE_GRAPH`** | `run.claimPending` | The workflow definition contains no stages in its first execution group. |
| **`CLAIM_FAILED`** | `run.claimPending` | An unexpected database exception occurred while claiming. The run is failed, but other runs in the batch continue processing. |
| **`STUCK_RUN_REAPED`** | `run.reapStuck` | The workflow run ceased database updates and exceeded the stuck threshold. |
