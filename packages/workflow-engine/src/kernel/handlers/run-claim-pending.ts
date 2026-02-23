/**
 * Handler: run.claimPending
 *
 * Claims pending workflow runs, creates first-stage records, and enqueues
 * their jobs for processing.
 */

import type {
  RunClaimPendingCommand,
  RunClaimPendingResult,
} from "../commands";
import type { KernelEvent } from "../events";
import type { KernelDeps, HandlerResult } from "../kernel";

export async function handleRunClaimPending(
  command: RunClaimPendingCommand,
  deps: KernelDeps,
): Promise<HandlerResult<RunClaimPendingResult>> {
  const maxClaims = command.maxClaims ?? 10;
  const claimed: Array<{
    workflowRunId: string;
    workflowId: string;
    jobIds: string[];
  }> = [];
  const events: KernelEvent[] = [];

  for (let i = 0; i < maxClaims; i++) {
    const run = await deps.persistence.claimNextPendingRun();
    if (!run) break;

    const workflow = deps.registry.getWorkflow(run.workflowId);
    if (!workflow) {
      const error = `Workflow ${run.workflowId} not found in registry`;
      const failedAt = deps.clock.now();
      await deps.persistence.updateRun(run.id, {
        status: "FAILED",
        completedAt: failedAt,
        output: {
          error: {
            code: "WORKFLOW_NOT_FOUND",
            message: error,
            workerId: command.workerId,
          },
        },
      });
      await deps.persistence
        .createLog({
          workflowRunId: run.id,
          level: "ERROR",
          message: error,
          metadata: {
            workerId: command.workerId,
            code: "WORKFLOW_NOT_FOUND",
          },
        })
        .catch(() => {});
      events.push({
        type: "workflow:failed",
        timestamp: failedAt,
        workflowRunId: run.id,
        error,
      });
      continue;
    }

    const stages = workflow.getStagesInExecutionGroup(1);
    if (stages.length === 0) {
      const error = `Workflow ${run.workflowId} has no stages in execution group 1`;
      const failedAt = deps.clock.now();
      await deps.persistence.updateRun(run.id, {
        status: "FAILED",
        completedAt: failedAt,
        output: {
          error: {
            code: "EMPTY_STAGE_GRAPH",
            message: error,
            workerId: command.workerId,
          },
        },
      });
      await deps.persistence
        .createLog({
          workflowRunId: run.id,
          level: "ERROR",
          message: error,
          metadata: {
            workerId: command.workerId,
            code: "EMPTY_STAGE_GRAPH",
          },
        })
        .catch(() => {});
      events.push({
        type: "workflow:failed",
        timestamp: failedAt,
        workflowRunId: run.id,
        error,
      });
      continue;
    }

    // Create stage records
    for (const stage of stages) {
      await deps.persistence.createStage({
        workflowRunId: run.id,
        stageId: stage.id,
        stageName: stage.name,
        stageNumber: workflow.getStageIndex(stage.id) + 1,
        executionGroup: 1,
        status: "PENDING",
        config: (run.config as any)?.[stage.id] || {},
      });
    }

    // Enqueue jobs
    const jobIds = await deps.jobTransport.enqueueParallel(
      stages.map((stage) => ({
        workflowRunId: run.id,
        workflowId: run.workflowId,
        stageId: stage.id,
        priority: run.priority,
        payload: { config: run.config || {} },
      })),
    );

    events.push({
      type: "workflow:started",
      timestamp: deps.clock.now(),
      workflowRunId: run.id,
    });

    claimed.push({
      workflowRunId: run.id,
      workflowId: run.workflowId,
      jobIds,
    });
  }

  return { claimed, _events: events };
}
