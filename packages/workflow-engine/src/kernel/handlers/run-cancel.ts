/**
 * Handler: run.cancel
 *
 * Cancels a running workflow if it is not already in a terminal state.
 */

import type { RunCancelCommand, RunCancelResult } from "../commands";
import type { KernelDeps, HandlerResult } from "../kernel";

const TERMINAL_STATUSES = new Set(["COMPLETED", "FAILED", "CANCELLED"]);

export async function handleRunCancel(
  command: RunCancelCommand,
  deps: KernelDeps,
): Promise<HandlerResult<RunCancelResult>> {
  const run = await deps.persistence.getRun(command.workflowRunId);

  if (!run || TERMINAL_STATUSES.has(run.status)) {
    return { cancelled: false, _events: [] };
  }

  await deps.persistence.updateRun(command.workflowRunId, {
    status: "CANCELLED",
    completedAt: deps.clock.now(),
  });

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
