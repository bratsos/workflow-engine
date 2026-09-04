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

**How it's fixed (three layers):**
1. **Authoritative cancellation:** `run.cancel` cancels all queued/suspended jobs via `jobTransport.cancelByRun()`, preventing most ghost jobs before dequeue.
2. **Kernel guard:** `job.execute` checks `workflowRun.status === "RUNNING"` both before AND after stage execution. A job whose run is not RUNNING comes back with `outcome: "failed"` and a typed `ghost: true` flag, plus `ghostReason` saying which kind it is.
3. **Host handling by reason:** both hosts read `ghostReason` (never the message text). `"orphan"` -- the run is `CANCELLED`/`COMPLETED`/`FAILED` -- is failed terminally, since a retry can only fail again. `"race"` -- the run is still `PENDING` -- is re-delivered while the job's attempt budget lasts; see below.

**A third reason: `"version"`.** With definition versioning on, a job can
reach a build that does not serve the run's pinned definition version. That is
not a ghost in the rollback sense -- the run is legitimately `RUNNING`, just
not here. `job.execute` returns `{ ghost: true, ghostReason: "version" }`, the
job goes back on the queue for a host that does serve the version, and the run
stays `RUNNING`. Nothing fails and no attempt is spent. If it never clears,
the version has no host left: `run.listVersions` reports it under
`unservedHere`, and `run.redrive` with `definitionVersion: "latest"` moves the
run onto a version you do serve. See
[13-definition-versioning.md](13-definition-versioning.md).

## Runs Wedge `RUNNING` With No Job (Short Job Poll)

**Symptom:** with a small `jobPollIntervalMs` (a caller chasing near-synchronous behaviour), a large share of freshly created runs sit `RUNNING` forever with no queued job, a `job_queue` row `FAILED` with "ghost job discarded", and nothing moves until `run.reapStuck` kills the run minutes later. Invisible at the 1000 ms default, and worse the shorter the poll gets.

**What it was:** `run.claimPending` enqueued the claimed run's first-stage job *inside* the claim transaction. The job transport is a separate connection that takes no part in that transaction, so the job row was visible to every other connection while the run it named was still `PENDING`. A job loop polling faster than the claim committed dequeued it, the kernel's ghost guard discarded it as an orphan, and nothing ever re-enqueued it.

**How it's fixed (two layers, either sufficient):**
1. **Enqueue after commit:** `run.claimPending` defers the enqueue to the kernel's post-commit step, like `run.transition` and `run.rerunFrom` already did. The run is committed `RUNNING` before its job exists, so the window is gone. `claimed[].jobIds` still carries the enqueued ids.
2. **A racing job is re-delivered, not discarded:** `job.execute` reports a still-`PENDING` run as `ghostReason: "race"` and the hosts re-enqueue the job (through `fail(jobId, error, true)`, so the transport's usual backoff applies) instead of throwing it away. A terminal run stays `ghostReason: "orphan"` and is still failed terminally.

`run.reapStuck`'s PENDING-stage-without-job sweep remains the backstop for a job lost after the commit (a transport error, a process death); the enqueue is idempotent on `(workflowRunId, stageId)`, so the sweep cannot double-queue.

## Crash Recovery Never Happens (Non-UTC Postgres Session)

**Symptom:** a killed worker's job stays `RUNNING` forever. `lease.reapStale` / `releaseStaleJobs` report 0 released no matter how long you wait, `job_queue.lockedAt` reads hours ahead of `createdAt` on the same row, and a `touchJob` heartbeat appears to move the lease *backwards*. Only on a database or session whose `TimeZone` is not UTC.

**What it was:** the raw `FOR UPDATE SKIP LOCKED` statements bound a JS `Date`, which Prisma sends as a `timestamptz`. Assigning that to the naive `timestamp` columns the schema declares -- or comparing the two -- converts it through the *session's* timezone, while everything Prisma's model API writes to the same columns is UTC. On `Europe/Zurich` every raw-written timestamp landed two hours in the future, so a lease could never look stale. (`NOW()` is wrong the same way.)

**How it's fixed:** every raw statement converts its bound timestamps explicitly -- `$n::timestamptz AT TIME ZONE 'UTC'` -- so `job_queue.lockedAt`/`startedAt`, `workflow_runs.startedAt`/`updatedAt` and `outbox_events.publishedAt` mean the same thing as the columns Prisma writes, on any session timezone, with nothing for you to set. The Postgres conformance suite runs the lease sweep on a session pinned to `Pacific/Kiritimati` to keep it that way.

**Check your own schema:** the engine's timestamp columns must stay plain Prisma `DateTime` (naive `timestamp`), as the shipped `prisma/schema.prisma` declares them. Mapping them to `@db.Timestamptz` re-introduces the skew in the opposite direction.

## Crash Resumption Waits Minutes On A Durable Step

**Symptom:** a worker is SIGKILLed mid-stage; a fresh worker picks the run up quickly (its job lease is released after `staleLeaseThresholdMs`) but the resumed stage suspends again instead of finishing, and only completes minutes later. Only stages that use `ctx.step.*`.

**Why:** the step the killed process was executing is still `running` in the ledger with a live lease, and a replay that meets a live lease raises `StepInFlight` and suspends rather than running the body a second time. A ledger row records no worker identity — the lease *is* the step's only liveness signal — so nothing can tell "the owner is dead" from "the owner is slow", and releasing it early would risk executing the step body twice, which is the one thing the ledger exists to prevent. This is deliberate, not a missing reaper: `lease.reapStale` releases *job* leases only.

**The dial:** `StepRunOptions.leaseMs`, default **five minutes**. Set it per step to the longest you expect that body to take plus headroom — `ctx.step.run("submit", fn, { leaseMs: 30_000 })` recovers in about 30 s. Keep it generous for a step that legitimately runs for minutes; a lease shorter than the body means a replay re-runs work that was still in flight. See 12-durable-steps.md, "Leases, retries and deadlines".

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

**Node host:** Runs automatically on `orchestrationIntervalMs` (default: 10s). A firing that lands while the previous tick is still running is skipped, not queued; `getStats().orchestrationTicks` counts only ticks that ran.
**Serverless host:** Must be triggered externally via `host.runMaintenanceTick()`.

Several processes may tick against the same database: `stage.pollSuspended` claims each suspended stage (a version-guarded bump of `nextPollAt`) before polling or replaying it, so a stage body runs once per poll across processes. A suspended stage whose `nextPollAt` sits up to 60s (or one `pollInterval`) in the future while nothing is polling it was claimed by a process that died mid-replay; it is picked up again when that lease elapses. See "Suspended-Stage Claims" in [08-common-patterns.md](08-common-patterns.md).

## Error Codes Reference

| Code | Where | Meaning |
|------|-------|---------|
| `WORKFLOW_NOT_FOUND` | `run.claimPending` | Workflow ID not in registry when run was claimed |
| `EMPTY_STAGE_GRAPH` | `run.claimPending` | Workflow has no stages in execution group 1 |
| `CLAIM_FAILED` | `run.claimPending` | Unexpected error during claim (DB error, etc.) |
| `STUCK_RUN_REAPED` | `run.reapStuck` | Run had no activity past the stuck threshold |

All error codes appear in `run.output.error.code` on failed runs.
