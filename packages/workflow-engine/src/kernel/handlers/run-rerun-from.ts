/**
 * Handler: run.rerunFrom
 *
 * Reruns a workflow from a specific stage. Deletes stage records and
 * blob artifacts at/after the target execution group, resets the run
 * to RUNNING, creates new stage records, and enqueues jobs.
 *
 * Works for both COMPLETED runs (rerun from any stage) and FAILED runs
 * (retry from the failed stage).
 */

import type { RunRerunFromCommand, RunRerunFromResult } from "../commands";
import type { KernelEvent } from "../events";
import { prepareExecutionGroup } from "../helpers/index.js";
import type { HandlerResult, KernelDeps } from "../kernel";

export async function handleRunRerunFrom(
  command: RunRerunFromCommand,
  deps: KernelDeps,
): Promise<HandlerResult<RunRerunFromResult>> {
  const { workflowRunId, fromStageId } = command;
  const events: KernelEvent[] = [];

  // 1. Load run
  const run = await deps.persistence.getRun(workflowRunId);
  if (!run) throw new Error(`WorkflowRun ${workflowRunId} not found`);

  // 2. Validate run is in a rerunnable state
  if (run.status !== "COMPLETED" && run.status !== "FAILED") {
    throw new Error(
      `Cannot rerun workflow in ${run.status} state. Must be COMPLETED or FAILED.`,
    );
  }

  // 3. Load workflow definition
  const workflow = deps.registry.getWorkflow(run.workflowId);
  if (!workflow)
    throw new Error(`Workflow ${run.workflowId} not found in registry`);

  // 4. Validate stage exists in workflow
  const stageDef = workflow.getStage(fromStageId);
  if (!stageDef) {
    throw new Error(
      `Stage ${fromStageId} not found in workflow ${run.workflowId}`,
    );
  }

  // 5. Get the execution group of the target stage
  const targetGroup = workflow.getExecutionGroupIndex(fromStageId);

  // 6. Get all existing stage records
  const existingStages = await deps.persistence.getStagesByRun(workflowRunId);

  // 7. Validate: stages before the target group must have been executed
  if (targetGroup > 1) {
    const priorStages = existingStages.filter(
      (s) => s.executionGroup < targetGroup,
    );
    if (priorStages.length === 0) {
      throw new Error(
        `Cannot rerun from stage ${fromStageId}: previous stages have not been executed`,
      );
    }
  }

  // 8. Find stages to delete (at or after the target group)
  const stagesToDelete = existingStages.filter(
    (s) => s.executionGroup >= targetGroup,
  );
  const deletedStageIds = stagesToDelete.map((s) => s.stageId);

  // 9. Collect blob prefixes for stages being removed. Deletion is
  // deferred to _postCommit (see below) — deleting mid-transaction would
  // permanently lose the blobs even if the transaction later rolls back
  // (e.g. a downstream write fails), since blob deletes aren't part of
  // the DB transaction and can't be undone.
  const blobPrefixesToDelete = stagesToDelete.map(
    (stage) =>
      `workflow-v2/${run.workflowType}/${workflowRunId}/${stage.stageId}/`,
  );

  // 10. Delete stage records
  for (const stage of stagesToDelete) {
    await deps.persistence.deleteStage(stage.id);
  }

  // 11. Reset run to RUNNING
  await deps.persistence.updateRun(workflowRunId, {
    status: "RUNNING",
    startedAt: deps.clock.now(),
    completedAt: null,
    duration: null,
    output: null,
    totalCost: 0,
    totalTokens: 0,
  });

  // 12. Create new stage records for the target execution group. `create`
  // mode is safe (no upsert lookup needed): the target group's prior
  // records were just deleted above, so every stage here is guaranteed
  // fresh, and every one of them is enqueued unconditionally
  // (filterPending: false) since none can already be RUNNING/COMPLETED.
  // attemptMode "max+1" over the just-deleted `stagesToDelete` gives new
  // stage records attempt = (max prior + 1), so annotations from the new
  // execution can be distinguished from those surviving the rerun
  // (annotations have `onDelete: SetNull` on the stage relation, so their
  // attempt value sticks even though their workflowStageRecordId is
  // nulled).
  const enqueue = await prepareExecutionGroup(run, workflow, deps, {
    groupIndex: targetGroup,
    attemptMode: "max+1",
    createMode: "create",
    filterPending: false,
    attemptSourceStages: stagesToDelete,
  });

  // 13. Emit workflow:started event (restarted)
  events.push({
    type: "workflow:started",
    timestamp: deps.clock.now(),
    workflowRunId,
  });

  return {
    workflowRunId,
    fromStageId,
    deletedStages: deletedStageIds,
    _events: events,
    // Runs only after the transaction above commits: enqueueing jobs
    // mid-transaction risks an orphan job (tx rolls back after enqueue
    // succeeds) or a lost job (process crashes after commit but before
    // enqueue). Deferring to post-commit avoids the orphan case; the
    // lost-job case is covered by run.reapStuck's PENDING-without-job
    // recovery sweep.
    _postCommit: async (postDeps) => {
      for (const prefix of blobPrefixesToDelete) {
        const keys = await postDeps.blobStore
          .list(prefix)
          .catch(() => [] as string[]);
        for (const key of keys) {
          await postDeps.blobStore.delete(key).catch(() => {});
        }
      }

      await enqueue();
    },
  };
}
