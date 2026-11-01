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
 * INVARIANT: selection is a snapshot, and a redrive can reopen a run at any
 * point of the sweep. `deleteRun` repeats selection's check atomically, so a
 * reopened run is never deleted and the job it enqueues is never orphaned.
 * The run is also re-read before its cleanup and before its jobs go, so one
 * reopened earlier keeps its data and its job, and the result names only the
 * runs that were deleted. Cleanup already done for a run reopened after the
 * last read is not undone: a job lost that way is re-enqueued by
 * `run.reapStuck`.
 *
 * Nothing is emitted. Retention is housekeeping, not a lifecycle event.
 */

import type { PurgeableRunStatus } from "../../persistence/interface.js";
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
            const eligible = async (id: string) => {
              const run = await postDeps.persistence.getRun(id);
              return (
                run !== null &&
                statuses.some((status) => status === run.status) &&
                (run.completedAt ?? run.updatedAt) <= command.olderThan
              );
            };
            for (const run of runs) {
              if (!(await eligible(run.id))) continue;
              for (const stageRecordId of run.stageRecordIds) {
                // Before the rows that name these keys. An unreadable row
                // leaves a key behind, which must not stall retention.
                const steps = await postDeps.stepLedger
                  ?.list(stageRecordId)
                  .catch(() => []);
                for (const step of steps ?? []) {
                  if (step.kind !== "signal") continue;
                  await postDeps.persistence.releaseIdempotencyKey(
                    signalWakeKey(stageRecordId, step.stepId),
                    SIGNAL_WAKE,
                  );
                }
                await postDeps.stepLedger?.clear(stageRecordId);
              }
              // job_queue has no foreign key to workflow_runs.
              const jobs = await postDeps.jobTransport.getJobsByWorkflowRun(
                run.id,
              );
              if (!(await eligible(run.id))) continue;
              const stageIds = Array.from(
                new Set(jobs.map((job) => job.stageId)),
              );
              if (stageIds.length > 0) {
                await postDeps.jobTransport.deleteByRunAndStages(
                  run.id,
                  stageIds,
                );
              }
              for (const prefix of runBlobPrefixes(run)) {
                const keys = await postDeps.blobStore.list(prefix);
                for (const key of keys) {
                  await postDeps.blobStore.delete(key);
                }
              }
              // Keep the cleanup keys reachable until every port succeeds.
              const removed = await postDeps.persistence.deleteRun(
                run.id,
                command.olderThan,
                statuses,
              );
              if (removed) deleted.push(run.id);
            }
            return { purged: deleted.length, workflowRunIds: deleted };
          },
        }
      : {}),
  };
}
