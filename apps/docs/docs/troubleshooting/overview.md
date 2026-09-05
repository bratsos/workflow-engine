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

### 3. Ghost Jobs
* **Symptom**: Workers are processing stages for workflow runs that have already been `FAILED` or `CANCELLED`, creating zombie loops.
* **Cause**:
  * If a workflow is cancelled, active jobs might still reside in the worker's queue.
* **Self-Healing**:
  * **Authoritative Cancellation**: Calling `run.cancel` automatically purges queued jobs from the queue via `jobTransport.cancelByRun()`, and the job executing at that moment is told to stop through `ctx.abortSignal` on its next lease heartbeat.
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
  * `stage.pollSuspended` replays the stage body (and runs `checkCompletion()`) outside database transactions. State updates are committed in a subsequent short transaction, resolving P2028 database timeouts.

---

### 9. `PrismaClient is not assignable to EnginePrismaClient`
* **Symptom**: A wall of type errors when passing your Prisma client to `createPrismaWorkflowPersistence`, `createPrismaStepLedger` or `createPrismaJobQueue`.
* **Cause**: The generated client is missing a delegate the adapter calls — after 1.0, almost always `workflowStep` (the `WorkflowStep` model) or `workflowDefinition`.
* **Fix**: Add the missing models from [Prisma Setup](../persistence/prisma-setup.md) and re-run `prisma generate`.

---

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

Nothing deletes a finished run by itself. Opt in per host with `retention: { olderThanMs, statuses?, limit? }` (off by default) and the maintenance tick dispatches `run.purge`, which deletes `COMPLETED`/`FAILED`/`CANCELLED` runs that finished at or before the cutoff, `limit` (default 100) per tick, oldest first: the step ledger is cleared through the `StepLedger` port, job rows go through the `JobTransport`, the run through `PersistenceCore.deleteRun` (stages, logs, artifacts, annotations cascade), and the run's blobs (`workflow-v2/<workflowType>/<runId>/`, `workflow-v2/spill/jobs/<runId>/`, `workflow-v2/spill/steps/<stageRecordId>/`) are removed after commit. No events are emitted. The command can also be dispatched directly:

```typescript
await kernel.dispatch({ type: "run.purge", olderThan: new Date(Date.now() - 30 * 86_400_000) });
```

Deleting by SQL instead: with the reference schema, `DELETE FROM "workflow_runs" WHERE ...` cascades to stages, logs, artifacts and annotations, and from `workflow_stages` to `workflow_steps` **only once the `workflow_steps_stageRecordId_fkey` foreign key exists** (package schema from the release that added `run.purge`; earlier 1.0 alphas need the `ADD CONSTRAINT` in the [0.13 → 1.0 migration guide](../migrations/migrate-0.13-to-1.0.md)). `job_queue` has no foreign key to the run and must be deleted explicitly, and blobs live outside the database.

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
