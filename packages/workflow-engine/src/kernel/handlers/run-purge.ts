/**
 * Handler: run.purge
 *
 * Retention sweep. Deletes terminal runs that finished at or before the
 * cutoff, bounded by `limit`, and takes everything the engine stored for
 * them along: the durable-step ledger, the run's blobs, its job rows, and
 * the run row itself (stages, logs, artifacts and annotations go with it
 * through `PersistenceCore.deleteRun`).
 *
 * INVARIANT: jobs, ledger rows and blobs are removed in `_postCommit`, never
 * inside the persistence transaction (see run-cancel.ts). These ports use
 * their own connections: waiting on them inside a transaction can exhaust
 * the pool or block SQLite's writer, and their writes cannot be rolled back.
 * The reference ledger cascades with the stages; a pluggable ledger needs
 * explicit cleanup. Selection commits first; each run is deleted only after
 * all its cleanup succeeds. A failure propagates with that run and later
 * runs still discoverable by the next purge, including after a process exit.
 * Cleanup can be partial and must be safe to repeat.
 *
 * INVARIANT: selection is a snapshot. Before it touches a run, the sweep
 * takes that run's purge claim (an idempotency key of type `PURGE_CLAIM`)
 * and re-reads the run and its current stage records under it. `run.redrive`
 * and a signal's wake take the same key first in their transactions and
 * refuse while a purge holds it, so a run cannot be reopened, nor a wake
 * committed, between that read and the run's deletion: cleanup never removes
 * a live generation's data, and it covers the stage records that exist now,
 * not the ones selection saw. A run redriven before the claim is no longer
 * eligible and is skipped. Only a purge takes a claim over: a sweep that
 * fails completes its claim and the next purge finishes the run; a claim
 * left by a crashed sweep goes stale after `PURGE_CLAIM_STALE_MS`, and a
 * sweep still running at that age stops before its next delete and leaves
 * the claim alone. Kernels from before the claim ignore it.
 *
 * INVARIANT: a writer that read the run before it was deleted can still land
 * afterwards (a delayed post-commit enqueue, a signal's ledger write). The
 * sweep repeats its cleanup once the run is gone, and those writers check
 * for the run (or stage) after writing and remove what they wrote when it is
 * gone: whichever finishes second removes the data.
 *
 * Nothing is emitted. Retention is housekeeping, not a lifecycle event.
 */

import type {
  PurgeableRun,
  PurgeableRunStatus,
} from "../../persistence/interface.js";
import type { RunPurgeCommand, RunPurgeResult } from "../commands";
import type { HandlerResult, KernelDeps } from "../kernel";
import { jobSpillPrefix, stepSpillPrefix } from "../spill.js";
import { SIGNAL_WAKE, signalWakeKey } from "./step-signal.js";

export const DEFAULT_PURGE_STATUSES: readonly PurgeableRunStatus[] = [
  "COMPLETED",
  "FAILED",
  "CANCELLED",
];

export const DEFAULT_PURGE_LIMIT = 100;

/** Idempotency type of the claim `run.purge` holds on a run while it deletes it. */
export const PURGE_CLAIM = "run.purge.claim";

/** Age after which a purge claim left by a crashed sweep can be taken over. */
export const PURGE_CLAIM_STALE_MS = 10 * 60 * 1000;

/**
 * Runs `fn` holding `workflowRunId`'s purge claim, and refuses while a purge
 * holds it. Wrap everything the transaction that writes the run does: on
 * Postgres the uncommitted claim row keeps a purge from taking the claim
 * until the transaction ends, on SQLite the insert takes the writer lock,
 * and on memory, which has no rollback, the claim is held until `fn`
 * returns. It never takes over a stale claim: one left by a purge that
 * stopped part-way marks a partly erased run, which only another purge may
 * take over and finish.
 */
export async function withPurgeHeldOff<T>(
  persistence: KernelDeps["persistence"],
  workflowRunId: string,
  fn: () => Promise<T>,
): Promise<T> {
  const claim = await persistence.acquireIdempotencyKey(
    workflowRunId,
    PURGE_CLAIM,
  );
  if (claim.status !== "acquired") {
    throw new Error(
      `Run ${workflowRunId} is being deleted by run.purge; retry once the purge has finished (the next run.purge finishes one that stopped part-way)`,
    );
  }
  const release = () =>
    persistence.releaseIdempotencyKey(workflowRunId, PURGE_CLAIM);
  let result: T;
  try {
    result = await fn();
  } catch (error) {
    await release().catch(() => {});
    throw error;
  }
  await release();
  return result;
}

/**
 * Idempotency type of the record that names a run's deleted stage records
 * whose step ledger (and spilled step results) are still to be cleared.
 * `run.redrive` writes it in the transaction that deletes them, since
 * nothing else can name a deleted record afterwards, and releases it once
 * its post-commit clear succeeded; `run.purge` clears whatever it still
 * names.
 */
export const PENDING_LEDGER_CLEAR = "run.redrive.pendingLedgerClear";

/** The deleted stage records `workflowRunId` still has to clear. */
export async function pendingLedgerClears(
  persistence: KernelDeps["persistence"],
  workflowRunId: string,
): Promise<string[]> {
  const pending = await persistence.acquireIdempotencyKey(
    workflowRunId,
    PENDING_LEDGER_CLEAR,
  );
  if (pending.status === "acquired") {
    await persistence.releaseIdempotencyKey(
      workflowRunId,
      PENDING_LEDGER_CLEAR,
    );
  }
  if (pending.status !== "replay") return [];
  const ids = (pending.result as { stageRecordIds?: unknown } | null)
    ?.stageRecordIds;
  return Array.isArray(ids) ? ids.filter((id) => typeof id === "string") : [];
}

/**
 * Adds `stageRecordIds` to the run's pending clears, in the caller's
 * transaction. Returns every id now pending.
 */
export async function addPendingLedgerClears(
  persistence: KernelDeps["persistence"],
  workflowRunId: string,
  stageRecordIds: readonly string[],
): Promise<string[]> {
  const pending = await persistence.acquireIdempotencyKey(
    workflowRunId,
    PENDING_LEDGER_CLEAR,
  );
  const previous =
    pending.status === "replay"
      ? ((pending.result as { stageRecordIds?: string[] } | null)
          ?.stageRecordIds ?? [])
      : [];
  const ids = [...new Set([...previous, ...stageRecordIds])];
  await persistence.completeIdempotencyKey(
    workflowRunId,
    PENDING_LEDGER_CLEAR,
    { stageRecordIds: ids },
  );
  return ids;
}

/**
 * Drops `cleared` from the run's pending clears, keeping the ids a later
 * redrive added meanwhile.
 */
export async function retirePendingLedgerClears(
  persistence: KernelDeps["persistence"],
  workflowRunId: string,
  cleared: readonly string[],
): Promise<void> {
  const pending = await persistence.acquireIdempotencyKey(
    workflowRunId,
    PENDING_LEDGER_CLEAR,
  );
  if (pending.status === "in_progress") return;
  const left =
    pending.status === "replay"
      ? (
          (pending.result as { stageRecordIds?: string[] } | null)
            ?.stageRecordIds ?? []
        ).filter((id) => !cleared.includes(id))
      : [];
  if (left.length > 0) {
    await persistence.completeIdempotencyKey(
      workflowRunId,
      PENDING_LEDGER_CLEAR,
      { stageRecordIds: left },
    );
  } else {
    await persistence.releaseIdempotencyKey(
      workflowRunId,
      PENDING_LEDGER_CLEAR,
    );
  }
}

/**
 * Blob key prefixes the engine writes for one run. Stage outputs and
 * artifacts live under `workflow-v2/<workflowType>/<runId>/`
 * (`save-stage-output.ts`, `save-stage-artifacts.ts`); spilled job
 * payloads under `workflow-v2/spill/jobs/<runId>/`; spilled step results
 * under `workflow-v2/spill/steps/<stageRecordId>/`. No engine key is
 * prefixed by the bare run id, so each family is listed by its own prefix.
 */
export function runBlobPrefixes(run: {
  id: string;
  workflowType: string;
  stageRecordIds: readonly string[];
}): string[] {
  return [
    `workflow-v2/${run.workflowType}/${run.id}/`,
    jobSpillPrefix(run.id),
    ...run.stageRecordIds.map((stageRecordId) =>
      stepSpillPrefix(stageRecordId),
    ),
  ];
}

export async function handleRunPurge(
  command: RunPurgeCommand,
  deps: KernelDeps,
): Promise<HandlerResult<RunPurgeResult>> {
  const statuses = command.statuses ?? DEFAULT_PURGE_STATUSES;
  const limit = command.limit ?? DEFAULT_PURGE_LIMIT;
  if (!(limit > 0)) {
    throw new Error(`run.purge: limit must be a positive number, got ${limit}`);
  }

  const runs = await deps.persistence.listRunsForPurge(
    command.olderThan,
    statuses,
    limit,
  );

  const workflowRunIds = runs.map((run) => run.id);

  return {
    purged: workflowRunIds.length,
    workflowRunIds,
    _events: [],
    ...(runs.length > 0
      ? {
          _postCommit: async (postDeps: KernelDeps) => {
            const deleted: string[] = [];
            const { persistence, stepLedger, jobTransport, blobStore } =
              postDeps;
            // Nothing renews a claim: once it is old enough for another
            // sweep to take over, this one stops before its next delete.
            let claimedAt = 0;
            const owned = (runId: string) => {
              if (
                postDeps.clock.now().getTime() - claimedAt >=
                PURGE_CLAIM_STALE_MS
              ) {
                throw new Error(
                  `run.purge: the claim on run ${runId} went stale mid-sweep; the next run.purge finishes the run`,
                );
              }
            };
            const cleanUp = async (run: PurgeableRun) => {
              for (const stageRecordId of run.stageRecordIds) {
                // Before the rows that name these keys. An unreadable row
                // leaves a key behind, which must not stall retention.
                const steps = await stepLedger
                  ?.list(stageRecordId)
                  .catch(() => []);
                for (const step of steps ?? []) {
                  if (step.kind !== "signal") continue;
                  await persistence.releaseIdempotencyKey(
                    signalWakeKey(stageRecordId, step.stepId),
                    SIGNAL_WAKE,
                  );
                }
                owned(run.id);
                await stepLedger?.clear(stageRecordId);
              }
              // job_queue has no foreign key to workflow_runs.
              const jobs = await jobTransport.getJobsByWorkflowRun(run.id);
              const stageIds = Array.from(
                new Set(jobs.map((job) => job.stageId)),
              );
              if (stageIds.length > 0) {
                owned(run.id);
                await jobTransport.deleteByRunAndStages(run.id, stageIds);
              }
              for (const prefix of runBlobPrefixes(run)) {
                const keys = await blobStore.list(prefix);
                for (const key of keys) {
                  owned(run.id);
                  await blobStore.delete(key);
                }
              }
            };
            for (const selected of runs) {
              const acquire = () =>
                persistence.acquireIdempotencyKey(selected.id, PURGE_CLAIM, {
                  now: postDeps.clock.now(),
                  staleInProgressAfterMs: PURGE_CLAIM_STALE_MS,
                });
              let claim = await acquire();
              // A completed claim is a sweep that failed part-way: finish it.
              if (claim.status === "replay") {
                await persistence.releaseIdempotencyKey(
                  selected.id,
                  PURGE_CLAIM,
                );
                claim = await acquire();
              }
              // Another sweep is deleting it.
              if (claim.status !== "acquired") continue;
              claimedAt = postDeps.clock.now().getTime();
              // A failed sweep completes its claim instead of releasing it:
              // redrive and a signal's wake refuse the partly erased run,
              // and the next purge takes it over at once.
              let failed = false;
              try {
                const current = await persistence.getRun(selected.id);
                if (
                  current === null ||
                  !statuses.some((status) => status === current.status) ||
                  (current.completedAt ?? current.updatedAt) > command.olderThan
                ) {
                  continue;
                }
                // Current records, and records a redrive deleted whose
                // ledger clear has not succeeded yet.
                const pending = await pendingLedgerClears(
                  persistence,
                  selected.id,
                );
                const run: PurgeableRun = {
                  ...selected,
                  stageRecordIds: [
                    ...(await persistence.getStagesByRun(selected.id)).map(
                      (stage) => stage.id,
                    ),
                    ...pending,
                  ],
                };
                // Without a step ledger this kernel cannot clear what the
                // record names; a kernel that has one purges the run.
                if (pending.length > 0 && !stepLedger) continue;
                await cleanUp(run);
                if (pending.length > 0) {
                  await retirePendingLedgerClears(
                    persistence,
                    selected.id,
                    pending,
                  );
                }
                // Keep the cleanup keys reachable until every port succeeds.
                owned(run.id);
                const removed = await persistence.deleteRun(
                  run.id,
                  command.olderThan,
                  statuses,
                );
                if (!removed) continue;
                deleted.push(run.id);
                // What a writer that read the run before it went landed
                // since. Best effort: the run is already gone.
                await cleanUp(run).catch(() => {});
              } catch (error) {
                failed = true;
                throw error;
              } finally {
                // Past the stale age the claim may be another sweep's.
                if (
                  postDeps.clock.now().getTime() - claimedAt <
                  PURGE_CLAIM_STALE_MS
                ) {
                  await (failed
                    ? persistence.completeIdempotencyKey(
                        selected.id,
                        PURGE_CLAIM,
                        { stopped: true },
                      )
                    : persistence.releaseIdempotencyKey(
                        selected.id,
                        PURGE_CLAIM,
                      )
                  ).catch(() => {});
                }
              }
            }
            return { purged: deleted.length, workflowRunIds: deleted };
          },
        }
      : {}),
  };
}
