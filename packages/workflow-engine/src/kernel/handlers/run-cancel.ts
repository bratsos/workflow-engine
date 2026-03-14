/**
 * Handler: run.cancel
 *
 * Cancels a running workflow authoritatively:
 * 1. Marks the run as CANCELLED
 * 2. Marks all non-terminal stages as CANCELLED
 * 3. Cancels queued/suspended jobs via job transport
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

  // 3. Cancel queued/suspended jobs
  await deps.jobTransport.cancelByRun(command.workflowRunId);

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
  };
}
