/**
 * Handler: run.purge
 *
 * Retention sweep. Deletes terminal runs that finished at or before the
 * cutoff, bounded by `limit`, and takes the following along: the durable-step ledger, the run's blobs, its job rows, and
 * the run row itself (stages, logs, artifacts and annotations go with it
 * through `PersistenceCore.deleteRun`). Age retention leaves outbox events
 * available for delivery and AI calls on their own retention policy.
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
 * `run.reapStuck`. Cleanup covers the stage records the run has at that
 * first re-read, not the ones selection saw.
 *
 * INVARIANT: a writer that read the run before it was deleted can still land
 * afterwards (a delayed post-commit enqueue, a signal's ledger write). The
 * sweep repeats its cleanup once the run is gone, and those writers check
 * for the run (or stage) after writing and remove what they wrote when it is
 * gone: whichever finishes second removes the data. Both are best effort.
 *
 * Nothing is emitted. Retention is housekeeping, not a lifecycle event.
 */

import type {
  PurgeableRun,
  PurgeableRunStatus,
  RunPurgeFence,
} from "../../persistence/interface.js";
import type {
  RunPurgeByAgeCommand,
  RunPurgeByAgeResult,
  RunPurgeByTargetCommand,
  RunPurgeByTargetResult,
  RunPurgeCounts,
} from "../commands";
import type { HandlerResult, KernelDeps } from "../kernel";
import {
  jobSpillPrefix,
  stepSpillPrefix,
  stepWriteSpillPrefix,
} from "../spill.js";
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
 * under `workflow-v2/spill/steps/<stageRecordId>/` (flat, before
 * 1.0.0-alpha.21) and `workflow-v2/spill/step-writes/<stageRecordId>/`. No engine key is
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
    ...run.stageRecordIds.flatMap((stageRecordId) => [
      stepSpillPrefix(stageRecordId),
      stepWriteSpillPrefix(stageRecordId),
    ]),
  ];
}

export async function handleRunPurge(
  command: RunPurgeByAgeCommand,
  deps: KernelDeps,
): Promise<HandlerResult<RunPurgeByAgeResult>> {
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
                // A stage execution or cancel sweep still writing for it.
                !(await postDeps.persistence.hasRunWriters?.(id)) &&
                (run.completedAt ?? run.updatedAt) <= command.olderThan
              );
            };
            const clearLedgers = async (run: PurgeableRun) => {
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
            };
            const clearJobsAndBlobs = async (run: PurgeableRun) => {
              const jobs = await postDeps.jobTransport.getJobsByWorkflowRun(
                run.id,
              );
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
                for (const key of await postDeps.blobStore.list(prefix)) {
                  await postDeps.blobStore.delete(key);
                }
              }
            };
            for (const selected of runs) {
              if (!(await eligible(selected.id))) continue;
              // The records it has now: one redriven and finished again since
              // selection has new ones.
              const run: PurgeableRun = {
                ...selected,
                stageRecordIds: (
                  await postDeps.persistence.getStagesByRun(selected.id)
                ).map((stage) => stage.id),
              };
              await clearLedgers(run);
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
              if (!removed) continue;
              deleted.push(run.id);
              // What a writer that read the run before it went landed since.
              await clearLedgers(run)
                .then(() => clearJobsAndBlobs(run))
                .catch(() => {});
            }
            return { purged: deleted.length, workflowRunIds: deleted };
          },
        }
      : {}),
  };
}

export class AICallDeletionUnavailableError extends Error {
  readonly code = "AI_CALL_DELETION_UNAVAILABLE";

  constructor(method: "deleteForRuns" | "pruneCalls" | "clearExpiredText") {
    super(`Configure services.aiLogger.${method} to erase AI call data`);
    this.name = "AICallDeletionUnavailableError";
  }
}

/**
 * Erasure by run id or tenant, run by run, outside any transaction.
 *
 * A terminal run with no registered writer (see `run-writes.ts`) has its
 * external data deleted first (blobs, AI calls, jobs, a pluggable ledger's
 * steps), while its rows still name them; then one transaction deletes its
 * rows and, last, the run row on the status and version read at the start.
 * A redrive since then makes that delete match nothing and the transaction
 * roll back: the run is reported `persistence` and stays discoverable. No
 * writer is admitted once a run has ended, so none can start after the
 * check; one admitted before is waited for (`writers`). A run already gone
 * still has what is recorded under its id removed.
 */
export async function handleTargetedRunPurge(
  command: RunPurgeByTargetCommand,
  deps: KernelDeps,
): Promise<RunPurgeByTargetResult> {
  const { persistence, blobStore, jobTransport, stepLedger } = deps;
  const aiLogger = deps.services?.aiLogger;
  if (!aiLogger?.deleteForRuns)
    throw new AICallDeletionUnavailableError("deleteForRuns");
  // Writer registration is what keeps a run from being erased under a
  // write, so an adapter without it cannot erase by name.
  if (
    !persistence.purgeRun ||
    !persistence.purgeJobKeys ||
    !persistence.listArchivedStageRecordIds ||
    !persistence.beginRunWrite ||
    !persistence.refreshRunWrite ||
    !persistence.endRunWrite ||
    !persistence.hasRunWriters
  ) {
    throw new Error(
      "Targeted run erasure requires a persistence adapter with purge support",
    );
  }
  if (!blobStore.deleteForPurge || (stepLedger && !stepLedger.deleteForPurge)) {
    throw new Error(
      "Targeted run erasure requires atomic blob and ledger delete counts",
    );
  }

  let ids: readonly string[];
  if ("workflowRunIds" in command) {
    ids = command.workflowRunIds;
  } else {
    const limit = command.limit ?? DEFAULT_PURGE_LIMIT;
    if (!Number.isSafeInteger(limit) || limit <= 0) {
      throw new Error("run.purge: limit must be a positive integer");
    }
    if (!persistence.listTenantRunsForPurge) {
      throw new Error("Tenant erasure requires persistence tenant selection");
    }
    ids = await persistence.listTenantRunsForPurge(command.tenantId, limit);
  }

  const removed: RunPurgeCounts = {
    runs: 0,
    stages: 0,
    steps: 0,
    jobs: 0,
    logs: 0,
    artifacts: 0,
    annotations: 0,
    outboxEvents: 0,
    idempotencyKeys: 0,
    aiCalls: 0,
    blobs: 0,
  };
  const skipped: RunPurgeByTargetResult["skipped"] = [];
  const incomplete: RunPurgeByTargetResult["incomplete"] = [];
  for (const id of new Set(ids)) {
    let phase: RunPurgeByTargetResult["incomplete"][number]["failed"][number] =
      "persistence";
    try {
      const run = await persistence.getRun(id);
      if (!run && "tenantId" in command) continue;
      if (run && "tenantId" in command && command.tenantId !== run.tenantId)
        continue;
      let fence: RunPurgeFence | null = null;
      let prefixes = [jobSpillPrefix(id)];
      let stageRecordIds: string[] = [];
      if (run) {
        const terminal = DEFAULT_PURGE_STATUSES.find(
          (status) => status === run.status,
        );
        if (!terminal) {
          skipped.push({ workflowRunId: id, status: run.status });
          continue;
        }
        // A writer admitted before the run ended can still write. No new one
        // is admitted now, so a later request finds it gone.
        if (await persistence.hasRunWriters(id)) {
          incomplete.push({ workflowRunId: id, failed: ["writers"] });
          continue;
        }
        fence = { id, status: terminal, version: run.version };
        stageRecordIds = [
          ...new Set([
            ...(await persistence.getStagesByRun(id)).map((stage) => stage.id),
            ...(await persistence.listArchivedStageRecordIds(id)),
          ]),
        ];
        prefixes = runBlobPrefixes({ ...run, stageRecordIds });
      }
      // Without a run (an earlier request or an age sweep deleted it), what
      // is found by its id alone still goes: AI calls, jobs, keys, outbox.

      // External stores first, while the run and its stage records still
      // exist: a failure here leaves everything needed to repeat the request.
      phase = "blobs";
      for (const prefix of prefixes) {
        for (const key of await blobStore.list(prefix)) {
          if (!key.startsWith(prefix)) continue;
          if (await blobStore.deleteForPurge(key)) removed.blobs++;
        }
      }
      phase = "aiCalls";
      removed.aiCalls += await aiLogger.deleteForRuns([id]);

      phase = "jobs";
      const jobs = await (jobTransport.getJobsForPurge?.(id) ??
        jobTransport.getJobsByWorkflowRun(id));
      // A key from a release that did not stamp run ids names only the job:
      // it goes before the jobs, or a retry could no longer find it.
      phase = "persistence";
      removed.idempotencyKeys += await persistence.purgeJobKeys(
        jobs.map((job) => job.id),
      );
      phase = "jobs";
      removed.jobs += await (jobTransport.deleteForRun?.(id) ??
        jobTransport.deleteByRunAndStages(id, [
          ...new Set(jobs.map((job) => job.stageId)),
        ]));

      phase = "steps";
      for (const stageRecordId of stageRecordIds) {
        removed.steps += await (stepLedger?.deleteForPurge?.(
          stageRecordId,
          persistence,
        ) ?? 0);
      }

      // Rolls back when a redrive or rerun changed the run since it was read.
      phase = "persistence";
      const counts = await persistence.withTransaction((tx) =>
        tx.purgeRun!(id, fence, stageRecordIds),
      );
      if (fence) removed.runs++;
      for (const key of Object.keys(counts) as (keyof typeof counts)[]) {
        removed[key] += counts[key];
      }
    } catch {
      incomplete.push({ workflowRunId: id, failed: [phase] });
    }
  }
  return { removed, skipped, incomplete };
}
