# Troubleshooting

Common issues, how the engine handles them, and how to debug.

## Runs Stuck in PENDING

**Symptom:** Runs stay in `PENDING` status and never start.

**Cause:** The orchestration tick isn't running, or `run.claimPending` is failing silently.

**Check:**
1. Is the host running? Check `host.getStats()` — `orchestrationTicks` should be incrementing.
2. Is the workflow registered? `run.claimPending` marks runs `FAILED` with `WORKFLOW_NOT_FOUND` if the workflow ID isn't in the registry.
3. Check logs for `run.claimPending error:` — each orchestration step logs errors independently.

**Fix:** Ensure the host is started and all workflows are registered before runs are created.

## Runs Stuck in RUNNING

**Symptom:** Runs are `RUNNING` but no progress is being made. Stages may be `PENDING`, `RUNNING`, or `COMPLETED` with no forward movement.

**Possible causes:**
- `run.transition` was never called after a stage completed (e.g., host crashed between job completion and transition)
- A stage is stuck `RUNNING` with no active job (worker crashed during execution)
- All stages in a group completed but the next group was never enqueued

**Self-healing:** The `run.reapStuck` command runs on every orchestration tick. It finds `RUNNING` runs with no recent activity (no updates to run or any stage record within the threshold) and marks them `FAILED` with error code `STUCK_RUN_REAPED`. The output includes `stageStatuses` showing each stage's status at reap time. A status guard re-checks `status === "RUNNING"` before updating, preventing race conditions where a run recovers between the query and the update.

**Manual investigation:**
```typescript
const run = await persistence.getRun(runId);
const stages = await persistence.getStagesByRun(runId);
console.log(run.status, stages.map(s => ({ id: s.stageId, status: s.status, updatedAt: s.updatedAt })));
```

If all stages in a group are `COMPLETED` but no next group was created, dispatch `run.transition` manually:
```typescript
await kernel.dispatch({ type: "run.transition", workflowRunId: runId });
```

## P2002 Unique Constraint Errors

**Symptom:** Logs show `P2002` errors from stage creation, or `run.claimPending skipped (P2002)` warnings.

**What it was:** Stage records have a unique constraint on `(workflowRunId, stageId)`. If orphaned stage records existed from a previous partial operation, `createStage` would throw. The transaction would roll back, the run would stay `PENDING`, and the next tick would hit the same error — forever.

**How it's fixed:** Both `run.claimPending` and `run.transition` now use `upsertStage` instead of `createStage`. Existing records are preserved (not overwritten), and only `PENDING` stages get jobs enqueued. This makes the operation fully idempotent.

**If you still see P2002 errors:** They should only come from other parts of the system (e.g., idempotency key conflicts, which are expected and handled). Check the error's `meta.target` field to see which constraint was violated.

## P2028 Transaction Timeout on Suspended Stage Polling

**Symptom:** Logs show `P2028: Transaction API error: A query cannot be executed on an expired transaction` during `stage.pollSuspended`. Suspended stages never transition to `COMPLETED` even when the batch provider reports completion.

**What it was:** `checkCompletion()` was running inside the kernel's global Prisma interactive transaction. Batch provider API calls (Google Batch, OpenAI Batch, etc.) that took longer than the default 5s timeout would expire the transaction, and the subsequent `updateStage()` call would fail.

**How it's fixed:** `stage.pollSuspended` now manages its own per-stage transactions (same pattern as `job.execute`). `checkCompletion()` runs outside any transaction, and only the DB state update + outbox writes are wrapped in a short transaction afterward.

## Ghost Jobs

**Symptom:** Jobs execute against runs that aren't `RUNNING`, or stages get upserted to `RUNNING` for runs that should be `FAILED`/`CANCELLED`.

**What it was:** If the kernel transaction rolled back after `jobTransport.enqueueParallel` committed (separate transaction), ghost jobs would exist in the queue pointing to runs/stages that were rolled back.

**How it's fixed (two layers):**
1. **Kernel guard:** `job.execute` checks `workflowRun.status === "RUNNING"` before proceeding. Ghost jobs for non-RUNNING runs are discarded with `outcome: "failed"` and error message containing `"ghost job discarded"`.
2. **Host no-retry:** Both Node and Serverless hosts detect ghost job failures (error contains `"ghost job discarded"`) and set `canRetry = false`, preventing infinite retry loops.

## One Bad Run Blocks Everything

**Symptom (old):** A single run with corrupt state would cause `run.claimPending` to throw, which blocked the entire orchestration tick — including outbox flush, stale lease reaping, and suspended stage polling.

**How it's fixed (two layers):**
1. **Per-run isolation:** The claim loop catches errors per-run and marks that run `FAILED` with code `CLAIM_FAILED`. Processing continues to the next run.
2. **Per-step isolation:** Each orchestration step (claim, poll, reap, flush, reap stuck) runs in its own try/catch. If claiming fails entirely, the outbox still flushes.

## Orchestration Tick Steps

The orchestration tick runs these steps in order, each independently:

| Step | Command | Purpose |
|------|---------|---------|
| 1 | `run.claimPending` | Find PENDING runs, create stages, enqueue jobs |
| 2 | `stage.pollSuspended` | Check suspended stages for readiness, trigger transitions |
| 3 | `lease.reapStale` | Release job leases from crashed workers |
| 4 | `outbox.flush` | Publish pending events through EventSink |
| 5 | `run.reapStuck` | Fail RUNNING runs with no recent activity |

**Node host:** Runs automatically on `orchestrationIntervalMs` (default: 10s).
**Serverless host:** Must be triggered externally via `host.runMaintenanceTick()`.

## Error Codes Reference

| Code | Where | Meaning |
|------|-------|---------|
| `WORKFLOW_NOT_FOUND` | `run.claimPending` | Workflow ID not in registry when run was claimed |
| `EMPTY_STAGE_GRAPH` | `run.claimPending` | Workflow has no stages in execution group 1 |
| `CLAIM_FAILED` | `run.claimPending` | Unexpected error during claim (DB error, etc.) |
| `STUCK_RUN_REAPED` | `run.reapStuck` | Run had no activity past the stuck threshold |

All error codes appear in `run.output.error.code` on failed runs.
