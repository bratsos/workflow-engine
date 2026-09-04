---
sidebar_position: 2
title: Execution Model
---

# Execution Model

**workflow-engine** uses a distributed, database-native execution model built for reliability, self-healing, and low operational overhead.

---

## Checkpointing at Stage Granularity

Instead of continuously recording execution state at the CPU/instruction level (which makes hosting complex and environment-dependent), **workflow-engine** checkpoints state at the boundaries of individual **Stages**.

* When a stage completes, its output is validated against its Zod output schema and written to the database (in the `WorkflowStage` record) as a single transaction.
* If a worker crashes or a stage fails, the workflow does not need to restart from the beginning. It resumes from the last completed stage.
* This makes it easy to run heavy, multi-stage pipelines on cheap, ephemeral instances (like spot instances or serverless functions).

---

## Execution Groups

Workflows consist of an ordered list of **Execution Groups**:
* A sequential stage added via `.pipe()` gets its own execution group.
* Multiple concurrent stages added via `.parallel()` reside in the same execution group.
* The engine guarantees that all stages in execution group $N$ must reach a terminal state (`COMPLETED` or `SKIPPED`) before any stage in execution group $N+1$ can be claimed and executed.

---

## Job Queue and Claiming

Jobs are queued in the `JobQueue` table. Polling is coordinated directly through database queries:
* **PG-native lock avoidance**: The engine uses PostgreSQL's `FOR UPDATE SKIP LOCKED` (or SQLite's equivalent transactions) to dequeue jobs. This allows multiple host processes to safely run concurrently without double-claiming jobs.
* **Orchestration ticks**: Hosts run periodic orchestration ticks that look for runs in `PENDING` status, claim them, and queue their initial stages as jobs in the `JobQueue`.

---

## Leases & Heartbeats

To prevent jobs from hanging indefinitely when a worker crashes mid-execution:
* **Job Leases**: When a worker claims a job, it locks it with a lease (`lockedAt`).
* **Heartbeating (v0.11+)**: While a worker is executing a job, the host periodically heartbeats the job to extend its lease. The default stale lease threshold in `v0.11` is **300,000 ms (5 minutes)** (increased from 60 seconds in `v0.10` to prevent premature lease timeouts during heavy local CPU execution).
* **Lease Reaping**: The `lease.reapStale` command periodically searches the `JobQueue` for active leases that haven't been updated within the threshold, releases them, and marks them for retry. This runs automatically on each host orchestration tick.

### Suspended-stage single flight

A suspended stage is claimed by a different mechanism: the poller bumps the stage's `nextPollAt` to `now + max(pollInterval, 60s)` under a version-guarded compare-and-set. A second poller's guarded write touches zero rows and it skips the stage. Every outcome branch writes `nextPollAt` explicitly afterwards, so the lease value survives only when the process dies mid-replay -- in which case the stage waits out the lease and the next poller takes it.

**Why not a Postgres advisory lock?** A session-level advisory lock would release the moment the connection died, closing that window with no lease to tune. It was evaluated and rejected, for four independent reasons:

1. **Connection pooling.** The lock must span the `checkCompletion()` HTTP call and the transaction after it, so it has to be a *session* lock (`pg_advisory_xact_lock` releases at `COMMIT`, mid-replay). Session locks are re-entrant within a session, so two pollers handed the same pooled connection both win `pg_try_advisory_lock` on the same key -- single flight fails exactly where concurrency is highest.
2. **PgBouncer in transaction mode** does not support session-level advisory locks. Statements land on different server connections and the lock leaks with nothing to release it.
3. **The serverless host** has no long-lived connection to own a session lock, so it would need the `nextPollAt` lease as a fallback anyway.
4. **Row-level security.** This is the decisive one. If you run the kernel inside your own transaction (`skipInteractiveTransactions`, your `tx` client, `SET LOCAL` for your tenant), a session lock taken inside that transaction is *not* released at your `COMMIT` -- it leaks into your pooled connection. And the advisory namespace is one 64-bit integer space, global to the database and invisible to RLS: a tenant blocked on another tenant's key sees that key in `pg_locks` and waits on it, with no policy able to intervene. Row-level security cannot scope a lock it cannot see.

`Persistence` also has no raw-SQL escape hatch and SQLite has no advisory locks, so the port would have grown a Postgres-only optional method whose fallback was the lease regardless.

---

## Retries & Error Taxonomy

When a stage fails (by throwing an error), the engine increments the attempt count.

### Retry Mechanics
* The job is returned to the queue if `attempt < maxAttempts`.
* The backoff strategy is managed by the host.

### Terminal Failures
Once a stage exhausts its `maxAttempts`, it is marked as `FAILED`.
* In `v0.11+`, a terminal stage failure triggers `run.transition` **immediately** within the same database transaction. The parent workflow run is failed with the stage's error right away, rather than waiting for the next orchestration poll.

### Ghost Job Guard
A **ghost job** occurs when a worker processes a job whose parent workflow run is no longer in the `RUNNING` status (e.g., the run was cancelled or marked failed by another process).
* `job.execute` checks the parent run status before and after stage execution.
* If the run is not `RUNNING`, the result is discarded, and a `ghost: true` flag is returned.
* Hosts check for this flag and **immediately disable retries** to prevent zombie execution loops.

### Stuck Run Detection
If a run becomes stuck in `RUNNING` status (e.g., due to an unhandled worker crash and queue loss), the `run.reapStuck` command detects it.
* A run is deemed stuck if neither the run nor any of its stages have had database updates within the threshold (default: `max(3 * staleLeaseThresholdMs, 5 minutes)`).
* Stuck runs are automatically failed with the error code `STUCK_RUN_REAPED`.

---

## Authoritative Cancellation

Cancellation in **workflow-engine** is designed to cascade immediately through the system to prevent unnecessary API spending:
1. **Mark Run**: `run.cancel` sets the `WorkflowRun` status to `CANCELLED`.
2. **Cascade to Stages**: All non-terminal stage records in that run are updated to `CANCELLED` and their `nextPollAt` time is cleared.
3. **Purge Job Queue**: All active and queued jobs associated with that run are cancelled in the job transport via `jobTransport.cancelByRun()`.
4. **Discard Active Work**: Any active worker running a cancelled stage will hit the **Ghost Job Guard** upon completion, ensuring its results are discarded and no further stages in that pipeline are queued.
