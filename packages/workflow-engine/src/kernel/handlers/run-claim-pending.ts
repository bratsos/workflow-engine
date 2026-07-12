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
import { prepareExecutionGroup, toErrorMessage } from "../helpers/index.js";
import type { HandlerResult, KernelDeps } from "../kernel";

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
  // NOTE: the closure returned by prepareExecutionGroup is invoked
  // immediately below — inside the enclosing DB transaction — unlike
  // run.transition/run.rerunFrom, which defer it to _postCommit (see
  // kernel/helpers/prepare-execution-group.ts). This handler's public
  // result includes the enqueued jobIds synchronously per claimed run. A
  // crash between enqueue and commit can still orphan a job or lose one;
  // run.reapStuck's PENDING-without-job recovery sweep (see there) covers
  // the resulting stuck run either way.

  for (let i = 0; i < maxClaims; i++) {
    const run = await deps.persistence.claimNextPendingRun();
    if (!run) break;

    try {
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

      // Upsert stage records (idempotent — handles orphaned stages from
      // previous failed claims) and enqueue jobs only for stages that are
      // PENDING (skip RUNNING/COMPLETED/SUSPENDED) — invoked immediately,
      // see the NOTE above.
      const enqueue = await prepareExecutionGroup(run, workflow, deps, {
        groupIndex: 1,
        attemptMode: "none",
        createMode: "upsert",
      });
      const jobIds = await enqueue();

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
    } catch (err) {
      const error = toErrorMessage(err);
      const failedAt = deps.clock.now();
      await deps.persistence
        .updateRun(run.id, {
          status: "FAILED",
          completedAt: failedAt,
          output: {
            error: {
              code: "CLAIM_FAILED",
              message: error,
              workerId: command.workerId,
            },
          },
        })
        .catch(() => {});
      await deps.persistence
        .createLog({
          workflowRunId: run.id,
          level: "ERROR",
          message: error,
          metadata: {
            workerId: command.workerId,
            code: "CLAIM_FAILED",
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
  }

  return { claimed, _events: events };
}
