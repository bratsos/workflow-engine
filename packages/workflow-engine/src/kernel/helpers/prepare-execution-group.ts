/**
 * Creates (or upserts) the stage records for one execution group and
 * returns a closure that enqueues jobs for the stages that ended up
 * PENDING. The enqueue itself is NOT performed here — most callers must
 * invoke the returned closure from `_postCommit`, after the transaction
 * that created these stage records has committed. Enqueueing
 * mid-transaction risks an orphan job if the transaction later rolls back
 * (jobTransport isn't part of the DB transaction, so its writes can't be
 * undone). `run.claimPending` is the one exception — see the note at its
 * call site.
 *
 * Shared by three callers whose `attempt`/create semantics are each
 * intentionally different:
 *  - `run.claimPending` (`attemptMode: "none"`, `createMode: "upsert"`):
 *    first execution group of a fresh run; upsert tolerates orphaned
 *    stage rows from a previously-interrupted claim.
 *  - `run.transition` (`attemptMode: "max"`, `createMode: "upsert"`):
 *    propagates the run's current max stage attempt to newly-created
 *    downstream groups, so annotations from a single rerun span share one
 *    attempt value (distinguishable from prior-attempt annotations
 *    preserved via SetNull). Upsert tolerates a re-dispatched transition.
 *  - `run.rerunFrom` (`attemptMode: "max+1"`, `createMode: "create"`,
 *    `filterPending: false`): the target group's prior stage records were
 *    just deleted, so every record here is guaranteed fresh — `create`
 *    avoids a needless upsert lookup and every stage is enqueued
 *    unconditionally (no PENDING filter needed). The new attempt is one
 *    past the max among the caller-supplied `attemptSourceStages`
 *    (typically the just-deleted records) so annotations from the new
 *    execution are distinguishable from those the rerun left behind.
 */

import type { Workflow } from "../../core/workflow.js";
import type { KernelDeps } from "../kernel.js";
import type { WorkflowRunRecord } from "../ports.js";

export interface PrepareExecutionGroupOptions {
  /** Execution group to create/upsert stage records for. */
  groupIndex: number;
  /**
   * How to compute the `attempt` stamped on each new stage record:
   *  - `"none"` — omit `attempt` entirely (persistence defaults to 0).
   *  - `"max"` — the max `attempt` across the run's existing stage records.
   *  - `"max+1"` — one past the max `attempt` among `attemptSourceStages`.
   */
  attemptMode: "none" | "max" | "max+1";
  /**
   * `"upsert"` — idempotent create-or-update, safe to call repeatedly
   * (e.g. from a re-dispatched command or an orphaned stage row left by a
   * previously-interrupted claim).
   * `"create"` — unconditional insert. Only safe when the caller has
   * already guaranteed no conflicting record exists.
   */
  createMode: "upsert" | "create";
  /**
   * When true (default), only stages that end up PENDING are enqueued —
   * skips stages already RUNNING/COMPLETED/SUSPENDED from a prior partial
   * attempt. Set false when `createMode: "create"` already guarantees
   * every record is fresh, so every stage should be enqueued
   * unconditionally.
   */
  filterPending?: boolean;
  /** Attempt source for `attemptMode: "max+1"`; ignored otherwise. */
  attemptSourceStages?: ReadonlyArray<{ attempt: number }>;
}

export async function prepareExecutionGroup(
  run: WorkflowRunRecord,
  workflow: Workflow<any, any>,
  deps: KernelDeps,
  options: PrepareExecutionGroupOptions,
): Promise<() => Promise<string[]>> {
  const { groupIndex, attemptMode, createMode, filterPending = true } = options;
  const stages = workflow.getStagesInExecutionGroup(groupIndex);

  let attempt: number | undefined;
  if (attemptMode === "max") {
    const existingStages = await deps.persistence.getStagesByRun(run.id);
    attempt = existingStages.reduce(
      (max, s) => (s.attempt > max ? s.attempt : max),
      0,
    );
  } else if (attemptMode === "max+1") {
    const source = options.attemptSourceStages ?? [];
    attempt =
      source.reduce((max, s) => (s.attempt > max ? s.attempt : max), 0) + 1;
  }

  const stagesToEnqueue: typeof stages = [];
  for (const stage of stages) {
    const create = {
      workflowRunId: run.id,
      stageId: stage.id,
      stageName: stage.name,
      stageNumber: workflow.getStageIndex(stage.id) + 1,
      executionGroup: groupIndex,
      status: "PENDING" as const,
      config: (run.config as any)?.[stage.id] || {},
      ...(attempt !== undefined ? { attempt } : {}),
    };

    const record =
      createMode === "create"
        ? await deps.persistence.createStage(create)
        : await deps.persistence.upsertStage({
            workflowRunId: run.id,
            stageId: stage.id,
            create,
            update: {},
          });

    if (!filterPending || record.status === "PENDING") {
      stagesToEnqueue.push(stage);
    }
  }

  return () => {
    if (stagesToEnqueue.length === 0) return Promise.resolve([]);
    return deps.jobTransport.enqueueParallel(
      stagesToEnqueue.map((stage) => ({
        workflowRunId: run.id,
        workflowId: run.workflowId,
        stageId: stage.id,
        priority: run.priority,
        payload: { config: run.config || {} },
      })),
    );
  };
}
