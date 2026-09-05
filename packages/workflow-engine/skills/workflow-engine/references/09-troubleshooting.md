# Troubleshooting

Common issues, how the engine handles them, and how to debug.

## Runs Stuck in PENDING

**Symptom:** Runs stay in `PENDING` status and never start.

**Cause:** The orchestration tick isn't running, or `run.claimPending` is failing silently.

**Check:**
1. Is the host running? Check `host.getStats()` — `orchestrationTicks` should be incrementing.
2. Is the workflow registered? With a registry built by `createWorkflowRegistry` (or an explicit host `serves` list), `run.claimPending` claims only runs pinned to a `(workflowId, version)` this build presents, and an unpinned run only when `serves` names its workflow — everything else stays `PENDING` for a host that has it. A hand-written `{ getWorkflow }` registry, or `serves: "all"`, adopts any run and marks one whose workflow it lacks `FAILED` with `WORKFLOW_NOT_FOUND`.
3. Is the run pinned to a version nobody serves any more? `run.listVersions` reports it under `unservedHere`; `run.redrive` with `definitionVersion: "latest"` moves it onto the current build. See [13-definition-versioning.md](13-definition-versioning.md).
4. Check logs for `run.claimPending error:` — each orchestration step logs errors independently.

**Fix:** Ensure the host is started and all workflows are registered before runs are created.

## `42703` on Every Claim After Upgrading

**Symptom:** the host cannot claim a single run; every `run.claimPending` fails with a raw Postgres `42703` (undefined column) naming `definitionVersion`, or a `workflow_definitions` relation error.

**Why:** the generated Prisma client carries the definition-versioning models (`prisma generate` ran) but the database has not been migrated yet — a first migration, or a rolling deploy that ships code ahead of schema. The Prisma adapter now confirms the client's answer against the database once, lazily, with a catalogue read that returns "absent" instead of raising, so this should only appear on an adapter or wrapper the structural check cannot see through.

**Fix:** apply the migration (`migrations/migrate-0.13-to-1.0.md`), or set `createPrismaWorkflowPersistence(prisma, { definitionVersioning: false })` for a client whose schema carries the models against a database deliberately left unmigrated (`true` forces it on for a proxy the detection cannot inspect). Runs created before the migration carry a `null` version and stay claimable by any host whose registry holds their workflow.

## `PrismaClient is not assignable to EnginePrismaClient`

A wall of these at `createPrismaWorkflowPersistence` / `createPrismaJobQueue` / `createPrismaStepLedger` means one of the delegates the adapters require is missing from your generated client: `workflowRun`, `workflowStage`, `workflowStep`, `workflowLog`, `workflowArtifact`, `workflowAnnotation`, `outboxEvent`, `idempotencyKey`, `jobQueue`, `aICall`. After an upgrade to 1.0 it is almost always `WorkflowStep`. Add the model from `prisma/schema.prisma`, run `prisma generate`, and the error goes away. See [05-persistence-setup.md](05-persistence-setup.md).

## Runs Stuck in RUNNING

**Symptom:** Runs are `RUNNING` but no progress is being made. Stages may be `PENDING`, `RUNNING`, or `COMPLETED` with no forward movement.

**Possible causes:**
- `run.transition` was never called after a stage completed (e.g., host crashed between job completion and transition)
- A stage is stuck `RUNNING` with no active job (worker crashed during execution)
- All stages in a group completed but the next group was never enqueued

**Self-healing:** The `run.reapStuck` command runs on every orchestration tick. A run whose every stage is terminal while the run still says `RUNNING` (a dropped `run.transition`) is healed by firing the missing transition (`healed` in the result). Otherwise it finds `RUNNING` runs with no recent activity (no updates to run or any stage record within the threshold) and marks them `FAILED` with error code `STUCK_RUN_REAPED`. A run pinned to a definition version this build does not serve is left alone — it only looks stuck from here. The output includes `stageStatuses` showing each stage's status at reap time. A status guard re-checks `status === "RUNNING"` before updating, preventing race conditions where a run recovers between the query and the update.

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

## A Job Was Requeued Or Failed With `LEASE_HEARTBEAT_LOST` / `LEASE_ABSOLUTE_CAP`

Both are `lastError` prefixes the lease sweep stamps on `job_queue`, so an operator can tell a reclaimed lease from a stage-level failure.

- **`LEASE_HEARTBEAT_LOST`** — the worker stopped calling `touchJob` for longer than `staleLeaseThresholdMs` (measured from `lockedAt`): it died, or a single body ran longer than the heartbeat could cover. The job went back to `PENDING` for another worker. On Postgres the lease runs on the database clock, so a host with a skewed system clock is not the cause.
- **`LEASE_ABSOLUTE_CAP`** — the claim held its lease past `jobAbsoluteTimeoutMs` (default one hour, measured from `startedAt`, which no heartbeat refreshes): a worker that was alive but wedged. The job is failed terminally, because a job that hung for the whole cap will hang again. Raise the cap for a stage that legitimately runs longer; `0` disables the tier.

The body that lost its lease learns of it through `ctx.abortSignal` (a `StageAbortedError` with `reason: "lease-lost"`) on the next heartbeat; its outcome, if it finishes anyway, is discarded as `"superseded"` by the fenced acknowledgement. A `run.cancel` aborts the same signal with `reason: "cancelled"`. Use `stageAbortReason(signal)` to read it.

## Errors A Durable Stage Can Throw

| Error | Thrown when | What to do |
|-------|-------------|------------|
| `StepLedgerNotConfiguredError` | `ctx.step.*` called with no `stepLedger` on `createKernel` / `createTestKernel` | pass a `StepLedger` (`InMemoryStepLedger`, `createPrismaStepLedger`) |
| `AIServicesNotConfiguredError` | `ctx.ai` / `ctx.aiLogger` read with no `services` on `createKernel` | pass `services: { aiLogger, ai? }` (`createMockAIHelperFactory()` in tests) |
| `DuplicateStepKeyError` | one stage invocation asks for the same step key twice (a `ctx.step.ai.map` item key colliding with another step included); names both uses | give the call sites distinct keys — inside a loop, build the key from the iteration. Deterministic, so the stage fails without spending retries |
| `StepTimeoutError` | a `waitFor` / `waitForSignal` passed its non-sliding deadline | raise `timeout`, or deliver the signal sooner |
| `StepLeaseLostError` | `step.heartbeat()` found the row no longer `running` at this execution's attempt — the lease expired and a replay took the step over | stop: this execution's outcome will not be recorded either |
| `StepNotReplaySafeError` | a step declared `onReclaim: "fail"` whose lease expired; names the step and its `externalKey` | look for the effect under that key, then complete by hand or re-run with `onReclaim: "rerun"` |
| `BatchNotAdoptableError` | a reclaimed `ctx.step.ai.map` submit on a transport with nothing to search (Anthropic, OpenRouter) | `batch: { onReclaim: "resubmit" }` to accept a possible duplicate batch |
| `AiMapBudgetExceededError` / `AiMapBatchFailedError` | the map's `realtime.budget` ran out before an item's first call / the batch failed or timed out with `onExpiry: "fail"` | raise the budget; use `onExpiry: "partial"` to get per-item failures instead |
| `UnportableSchemaError` | a Zod schema uses a keyword OpenAI strict outputs cannot express (`patternProperties`, `not`, `if`/`then`, …); carries `path`, `keyword`, `target` | reshape the schema before any request is sent |
| `SpilledPayloadUnavailableError` | a step result or job payload above `spillThresholdBytes` was read through a blob store other than the one that wrote it | every process that executes or polls a run must share the `blobStore` (see [15-large-payloads.md](15-large-payloads.md)) |
| `StageAbortedError` | the `reason` on `ctx.abortSignal` after a cancel or a lost lease | honour the signal; the outcome is discarded either way |

A `step.outcome-conflict` annotation (see [10-annotations.md](10-annotations.md)) is not an error: two executions reached the same step's outcome write, the first won, and the body ran more than once — check for a duplicate external effect under the recorded `externalKey`.

## OpenRouter: "No endpoints found that can handle the requested parameters"

`routing.requireParameters` defaults to `true`, so OpenRouter excludes any endpoint that would silently ignore a parameter you sent — typically `maxTokens` or `temperature` on a model whose endpoints do not honour it (GPT-5 through OpenRouter). The engine wraps the error naming the fix: drop the parameter, or pass `routing: { requireParameters: false }` on the call to let such an endpoint serve it. No default `temperature` is sent by the engine; set it explicitly where a fixed value is relied upon.

## Crash Resumption Waits Minutes On A Durable Step

**Symptom:** a worker is SIGKILLed mid-stage; a fresh worker picks the run up quickly (its job lease is released after `staleLeaseThresholdMs`) but the resumed stage suspends again instead of finishing, and only completes minutes later. Only stages that use `ctx.step.*`.

**Why:** the step the killed process was executing is still `running` in the ledger with a live lease, and a replay that meets a live lease raises `StepInFlight` and suspends rather than running the body a second time. A ledger row records no worker identity — the lease *is* the step's only liveness signal — so nothing can tell "the owner is dead" from "the owner is slow", and releasing it early would risk executing the step body twice, which is the one thing the ledger exists to prevent. This is deliberate, not a missing reaper: `lease.reapStale` releases *job* leases only.

**The dial:** `StepRunOptions.lease`, default **five minutes**. Set it per step to the longest you expect that body to take plus headroom — `ctx.step.run("submit", fn, { lease: "30s" })` recovers in about 30 s. Keep it generous for a step that legitimately runs for minutes; a lease shorter than the body means a replay re-runs work that was still in flight. See 12-durable-steps.md, "Leases, retries and deadlines".

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
| 3 | `lease.reapStale` | Release job leases from crashed workers (heartbeat tier) and fail runaway jobs past `jobAbsoluteTimeoutMs` (absolute tier) |
| 4 | `outbox.flush` | Publish pending events through EventSink; reports `eventSinkStatus: "degraded"` when the sink refused an event |
| 5 | `run.reapStuck` | Fail RUNNING runs with no recent activity |
| 6 | `run.purge` | Opt-in (`retention` host option): delete terminal runs past their retention age — see "Run Retention" below |

**Node host:** Runs automatically on `orchestrationIntervalMs` (default: 10s). A firing that lands while the previous tick is still running is skipped, not queued; `getStats().orchestrationTicks` counts only ticks that ran.
**Serverless host:** Must be triggered externally via `host.runMaintenanceTick()`.

Several processes may tick against the same database: `stage.pollSuspended` claims each suspended stage (a version-guarded bump of `nextPollAt`) before polling or replaying it, so a stage body runs once per poll across processes. A suspended stage whose `nextPollAt` sits up to 60s (or one `pollInterval`) in the future while nothing is polling it was claimed by a process that died mid-replay; it is picked up again when that lease elapses. See "Suspended-Stage Claims" in [08-common-patterns.md](08-common-patterns.md).

## Run Retention

Nothing in the engine deletes a run on its own: `COMPLETED`, `FAILED` and `CANCELLED` rows accumulate, with their stages, logs, artifacts, annotations, `workflow_steps` ledger rows, job rows and blobs, until something removes them. Two supported ways to do that:

**`run.purge` (kernel command).** Deletes terminal runs that finished at or before a cutoff, bounded per call:

```typescript
const { purged, workflowRunIds } = await kernel.dispatch({
  type: "run.purge",
  olderThan: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000), // finished 30+ days ago
  statuses: ["COMPLETED", "FAILED", "CANCELLED"],             // default: all three
  limit: 100,                                                  // default: 100 runs per call
});
```

A run is eligible when its `status` is in `statuses` and its `completedAt` (or `updatedAt`, for a terminal run with no `completedAt`) is at or before `olderThan`; oldest first. For each run the kernel clears the `StepLedger` for every stage record through the port (before the row goes — the port is pluggable, so the reference schema's cascade is not relied on), deletes the run's job rows through the `JobTransport`, deletes the run through `PersistenceCore.deleteRun` (stages, logs, artifacts and annotations go with it), and after the transaction commits deletes the run's blobs under the engine's own key prefixes (`workflow-v2/<workflowType>/<runId>/`, `workflow-v2/spill/jobs/<runId>/`, `workflow-v2/spill/steps/<stageRecordId>/`). It emits no events. Loop until `purged` is `0` to drain a backlog; `ai_calls` rows are accounting and are left alone.

**Host option.** Both hosts run `run.purge` at the end of every maintenance tick once `retention` is set; it is off by default:

```typescript
createNodeHost({ ..., retention: { olderThanMs: 30 * 24 * 60 * 60 * 1000, statuses: ["COMPLETED"], limit: 100 } });
createServerlessHost({ ..., retention: { olderThanMs: 30 * 24 * 60 * 60 * 1000 } });
// The tick result / MaintenanceTickCounts gains `purged`.
```

**Deleting by hand.** With the reference schema, one statement per run does the same job for the rows — the cascades from `workflow_runs` take `workflow_stages`, `workflow_logs`, `workflow_artifacts` and `workflow_annotations`, and `workflow_stages` takes `workflow_steps` **only once the `workflow_steps_stageRecordId_fkey` foreign key exists** (in the package schema from the release that added `run.purge`; a table created from an earlier 1.0 alpha needs the `ADD CONSTRAINT` in `migrations/migrate-0.13-to-1.0.md`). `job_queue` has no foreign key to the run, so delete it explicitly; blobs in the `BlobStore` are outside the database:

```sql
-- Terminal runs that finished 30+ days ago
WITH doomed AS (
  SELECT "id" FROM "workflow_runs"
  WHERE "status" IN ('COMPLETED', 'FAILED', 'CANCELLED')
    AND COALESCE("completedAt", "updatedAt") <= now() - interval '30 days'
  LIMIT 1000
),
jobs AS (
  DELETE FROM "job_queue" WHERE "workflowRunId" IN (SELECT "id" FROM doomed)
)
DELETE FROM "workflow_runs" WHERE "id" IN (SELECT "id" FROM doomed);
```

Run it in batches (the `LIMIT`) and drop the run's blob prefixes above from your object store afterwards. Without the foreign key on `workflow_steps`, add `DELETE FROM "workflow_steps" WHERE "stageRecordId" IN (SELECT "id" FROM "workflow_stages" WHERE "workflowRunId" IN (SELECT "id" FROM doomed))` before the run delete, or the ledger rows are orphaned.

## Error Codes Reference

| Code | Where | Meaning |
|------|-------|---------|
| `WORKFLOW_NOT_FOUND` | `run.claimPending` | Workflow ID not in registry when run was claimed (only with a non-enumerating registry or `serves: "all"`; an enumerating registry never claims such a run) |
| `EMPTY_STAGE_GRAPH` | `run.claimPending` | Workflow has no stages in execution group 1 |
| `CLAIM_FAILED` | `run.claimPending` | Unexpected error during claim (DB error, etc.) |
| `STUCK_RUN_REAPED` | `run.reapStuck` | Run had no activity past the stuck threshold |

All error codes appear in `run.output.error.code` on failed runs.
