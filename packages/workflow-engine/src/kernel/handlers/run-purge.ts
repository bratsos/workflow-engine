/**
 * Handler: run.purge
 *
 * Retention sweep. Deletes terminal runs that finished at or before the
 * cutoff, bounded by `limit`, and takes everything the engine stored for
 * them along: the durable-step ledger, the run's blobs, its job rows, and
 * the run row itself (stages, logs, artifacts and annotations go with it
 * through `PersistenceCore.deleteRun`).
 *
 * Order matters. The ledger is cleared through the `StepLedger` port
 * *before* the run is deleted: the reference schema cascades
 * `workflow_steps` from `workflow_stages`, but the port is pluggable and a
 * ledger that lives elsewhere has no cascade to rely on. Blob deletion is a
 * post-commit side effect: a rolled-back purge must not leave a surviving
 * run pointing at outputs that are gone.
 *
 * Nothing is emitted. Retention is housekeeping, not a lifecycle event.
 */

import type { PurgeableRunStatus } from "../../persistence/interface.js";
import type { RunPurgeCommand, RunPurgeResult } from "../commands";
import type { HandlerResult, KernelDeps } from "../kernel";
import { jobSpillPrefix, stepSpillPrefix } from "../spill.js";

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

  const workflowRunIds: string[] = [];
  const blobPrefixes: string[] = [];

  for (const run of runs) {
    // 1. Ledger first, through the port (see the file comment).
    if (deps.stepLedger) {
      for (const stageRecordId of run.stageRecordIds) {
        await deps.stepLedger.clear(stageRecordId);
      }
    }

    // 2. Job rows: the reference schema has no foreign key from
    //    job_queue to workflow_runs, so they would otherwise outlive it.
    const jobs = await deps.jobTransport.getJobsByWorkflowRun(run.id);
    const stageIds = Array.from(new Set(jobs.map((job) => job.stageId)));
    if (stageIds.length > 0) {
      await deps.jobTransport.deleteByRunAndStages(run.id, stageIds);
    }

    // 3. The run and everything the persistence owns under it.
    await deps.persistence.deleteRun(run.id);

    workflowRunIds.push(run.id);
    blobPrefixes.push(...runBlobPrefixes(run));
  }

  return {
    purged: workflowRunIds.length,
    workflowRunIds,
    _events: [],
    ...(blobPrefixes.length > 0
      ? {
          // 4. Blobs, only once the deletes above have committed.
          _postCommit: async (postDeps: KernelDeps) => {
            for (const prefix of blobPrefixes) {
              const keys = await postDeps.blobStore.list(prefix);
              for (const key of keys) {
                await postDeps.blobStore.delete(key);
              }
            }
          },
        }
      : {}),
  };
}
