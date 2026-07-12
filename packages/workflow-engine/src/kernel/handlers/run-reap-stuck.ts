import { StaleVersionError } from "../../persistence/interface.js";
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

    // Status guard: only update if run is still RUNNING to avoid
    // overwriting a run that recovered between query and update.
    const currentStatus = await deps.persistence.getRunStatus(run.id);
    if (currentStatus !== "RUNNING") {
      continue;
    }

    // Recovery sweep: a PENDING stage with no queued job means the run
    // isn't actually dead, it's just missing the job that job.execute
    // needs to pick it up — the classic symptom of the enqueue-outside-
    // the-transaction race (run.transition / run.claimPending commit the
    // stage as PENDING, but the process crashes before — or the tx
    // rolls back after — the corresponding job is enqueued). Re-enqueue
    // instead of failing the run.
    const pendingStages = stages.filter((s) => s.status === "PENDING");
    if (pendingStages.length > 0) {
      const jobs = await deps.jobTransport.getJobsByWorkflowRun(run.id);
      const missingJobStages = pendingStages.filter(
        (stage) =>
          !jobs.some(
            (job) =>
              job.stageId === stage.stageId &&
              (job.status === "PENDING" || job.status === "RUNNING"),
          ),
      );
      if (missingJobStages.length > 0) {
        await deps.jobTransport.enqueueParallel(
          missingJobStages.map((stage) => ({
            workflowRunId: run.id,
            workflowId: run.workflowId,
            stageId: stage.stageId,
            priority: run.priority,
            payload: { config: run.config || {} },
          })),
        );
        continue;
      }
    }

    // Version guard: two hosts racing to reap the same run would
    // otherwise both pass the status check above and both write
    // updateRun + emit workflow:failed. expectedVersion turns the second
    // writer's update into a StaleVersionError instead of a double-reap.
    try {
      await deps.persistence.updateRun(run.id, {
        expectedVersion: run.version,
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
    } catch (error) {
      if (error instanceof StaleVersionError) {
        continue;
      }
      throw error;
    }

    events.push({
      type: "workflow:failed",
      timestamp: deps.clock.now(),
      workflowRunId: run.id,
      error: `Stuck run reaped after ${command.stuckThresholdMs}ms inactivity`,
    });

    failed++;
  }

  // `transitioned` reports the count of runs actually transitioned to
  // FAILED by this call — the only transition run.reapStuck performs.
  return { transitioned: failed, failed, _events: events };
}
