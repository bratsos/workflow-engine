/**
 * Handler: run.cancel
 *
 * Cancels a running workflow authoritatively:
 * 1. Marks the run as CANCELLED
 * 2. Marks all non-terminal stages as CANCELLED
 * 3. Cancels queued/suspended jobs via job transport, in `_postCommit`
 *
 * INVARIANT: the jobs are cancelled after the transaction commits, never
 * inside it. The job transport runs on its own connection, so inside the
 * kernel transaction every cancel held one connection and waited for a second:
 * a burst as large as the pool wedged it until the transactions timed out, and
 * a timed-out cancel rolled back its run while its queued job update still ran
 * afterwards, leaving CANCELLED jobs under a run that was not.
 *
 * In the window between the commit and the job update, a worker that dequeues
 * one of the jobs finds the run CANCELLED and discards it as an orphan
 * (`job.execute`, `ghostReason: "orphan"`, the job ends FAILED). If the job
 * update fails, the run stays CANCELLED and a PENDING job is closed that way
 * when dequeued; a SUSPENDED job is never dequeued, so it stays SUSPENDED until
 * `run.purge`, and a second `run.cancel` returns `cancelled: false` without
 * retrying the update.
 *
 * `run.redrive` accepts a CANCELLED run, so one that lands in that window is
 * undone: the run ends RUNNING with its new job CANCELLED, and
 * `run.reapStuck` re-enqueues the job later.
 */

import type { RunCancelCommand, RunCancelResult } from "../commands";
import type { HandlerResult, KernelDeps } from "../kernel";

const TERMINAL_STATUSES = new Set(["COMPLETED", "FAILED", "CANCELLED"]);

export async function handleRunCancel(
  command: RunCancelCommand,
  deps: KernelDeps,
): Promise<HandlerResult<RunCancelResult>> {
  const run = await deps.persistence.getRun(command.workflowRunId);

  if (!run || TERMINAL_STATUSES.has(run.status)) {
    return { cancelled: false, _events: [] };
  }

  // 1. Mark run as CANCELLED
  await deps.persistence.updateRun(command.workflowRunId, {
    status: "CANCELLED",
    completedAt: deps.clock.now(),
  });

  // 2. Mark all non-terminal stages as CANCELLED
  const stages = await deps.persistence.getStagesByRun(command.workflowRunId);
  for (const stage of stages) {
    if (!TERMINAL_STATUSES.has(stage.status)) {
      await deps.persistence.updateStage(stage.id, {
        status: "CANCELLED",
        completedAt: deps.clock.now(),
        nextPollAt: null,
      });
    }
  }

  return {
    cancelled: true,
    _events: [
      {
        type: "workflow:cancelled",
        timestamp: deps.clock.now(),
        workflowRunId: command.workflowRunId,
        reason: command.reason,
      },
    ],
    // 3. Cancel queued/suspended jobs
    _postCommit: async (postDeps) => {
      await postDeps.jobTransport.cancelByRun(command.workflowRunId);
    },
  };
}
