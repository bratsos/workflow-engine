import type { RunReapStuckCommand, RunReapStuckResult } from "../commands";
import type { KernelEvent } from "../events";
import type { HandlerResult, KernelDeps } from "../kernel";

export async function handleRunReapStuck(
  command: RunReapStuckCommand,
  deps: KernelDeps,
): Promise<HandlerResult<RunReapStuckResult>> {
  const events: KernelEvent[] = [];
  const stuckSince = new Date(
    deps.clock.now().getTime() - command.stuckThresholdMs,
  );

  const stuckRuns = await deps.persistence.getStuckRuns(stuckSince);
  let failed = 0;

  for (const run of stuckRuns) {
    const stages = await deps.persistence.getStagesByRun(run.id);

    await deps.persistence.updateRun(run.id, {
      status: "FAILED",
      completedAt: deps.clock.now(),
      output: {
        error: {
          code: "STUCK_RUN_REAPED",
          message: `Run stuck for >${command.stuckThresholdMs}ms with no activity`,
          stageStatuses: stages.map((s) => ({
            stageId: s.stageId,
            status: s.status,
          })),
        },
      },
    });

    events.push({
      type: "workflow:failed",
      timestamp: deps.clock.now(),
      workflowRunId: run.id,
      error: `Stuck run reaped after ${command.stuckThresholdMs}ms inactivity`,
    });

    failed++;
  }

  return { transitioned: 0, failed, _events: events };
}
