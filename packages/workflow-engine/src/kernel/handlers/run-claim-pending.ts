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
import { servedDefinitions } from "../helpers/definition-pinning.js";
import { prepareExecutionGroup, toErrorMessage } from "../helpers/index.js";
import type { HandlerResult, KernelDeps } from "../kernel";

export async function handleRunClaimPending(
  command: RunClaimPendingCommand,
  deps: KernelDeps,
): Promise<HandlerResult<RunClaimPendingResult>> {
  const maxClaims = command.maxClaims ?? 10;
  // Which definition versions this claim may adopt. An explicit `serves`
  // wins; otherwise the registry's enumeration decides, and a registry
  // that cannot enumerate claims everything (pre-versioning behaviour).
  // This is what makes a rolling deploy safe by construction: an old host
  // finishes its own work and a new host never adopts an incompatible run.
  const serves =
    command.serves === "all"
      ? undefined
      : (command.serves ?? servedDefinitions(deps.registry));
  const claimed: Array<{
    workflowRunId: string;
    workflowId: string;
    jobIds: string[];
  }> = [];
  const events: KernelEvent[] = [];
  // The closures returned by prepareExecutionGroup are deferred to
  // _postCommit, exactly like run.transition/run.rerunFrom (see
  // kernel/helpers/prepare-execution-group.ts). Enqueueing inside the
  // claim transaction published a job for a run that was still PENDING on
  // every other connection until the commit landed: a job loop polling
  // faster than the transaction commits dequeued it, job.execute's guard
  // saw PENDING and discarded it, and the run wedged RUNNING with no job
  // until run.reapStuck fired minutes later. Deferring makes the run
  // committed RUNNING before its job is visible to anyone.
  //
  // The trade: a jobTransport failure after the commit leaves a claimed
  // run RUNNING with no job (the enqueue can no longer be rolled back with
  // the claim). That is the exact shape run.reapStuck's
  // PENDING-stage-without-job sweep heals, and the enqueue is idempotent
  // on (workflowRunId, stageId), so the sweep cannot double-queue.
  const pendingEnqueues: Array<{
    entry: { workflowRunId: string; jobIds: string[] };
    enqueue: () => Promise<string[]>;
  }> = [];

  for (let i = 0; i < maxClaims; i++) {
    const run = await deps.persistence.claimNextPendingRun({
      now: deps.clock.now(),
      serves,
    });
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
      // PENDING (skip RUNNING/COMPLETED/SUSPENDED) — deferred to
      // _postCommit, see the NOTE above.
      const enqueue = await prepareExecutionGroup(run, workflow, deps, {
        groupIndex: 1,
        attemptMode: "none",
        createMode: "upsert",
      });

      events.push({
        type: "workflow:started",
        timestamp: deps.clock.now(),
        workflowRunId: run.id,
      });

      // `jobIds` is filled in by _postCommit before the kernel returns
      // this object to the caller — the array is the same reference the
      // result carries, so the public result still reports the ids.
      const entry = {
        workflowRunId: run.id,
        workflowId: run.workflowId,
        jobIds: [] as string[],
      };
      claimed.push(entry);
      pendingEnqueues.push({ entry, enqueue });
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

  if (pendingEnqueues.length === 0) return { claimed, _events: events };

  return {
    claimed,
    _events: events,
    _postCommit: async () => {
      // Every claimed run gets its enqueue attempted, even if an earlier
      // one failed: a transport error on one run must not leave the rest
      // of the batch jobless. Failures are reported together afterwards
      // (the hosts log run.claimPending errors and carry on).
      const failures: string[] = [];
      for (const { entry, enqueue } of pendingEnqueues) {
        try {
          entry.jobIds.push(...(await enqueue()));
        } catch (err) {
          failures.push(`${entry.workflowRunId}: ${toErrorMessage(err)}`);
        }
      }
      if (failures.length > 0) {
        throw new Error(
          `run.claimPending: could not enqueue the first-stage job of ${failures.length} claimed run(s) — run.reapStuck will recover them (${failures.join("; ")})`,
        );
      }
    },
  };
}
