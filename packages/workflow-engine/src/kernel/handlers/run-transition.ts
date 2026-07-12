/**
 * Handler: run.transition
 *
 * Advances a workflow run to its next execution group, or marks it as
 * completed/failed depending on the current state of its stages.
 */

import { StaleVersionError } from "../../persistence/interface.js";
import type { RunTransitionCommand, RunTransitionResult } from "../commands";
import type { KernelEvent } from "../events";
import {
  loadWorkflowContext,
  prepareExecutionGroup,
  resolveExecutionGroupOutput,
} from "../helpers/index.js";
import type { HandlerResult, KernelDeps } from "../kernel";
import type { WorkflowRunRecord } from "../ports";

// ---------------------------------------------------------------------------
// Terminal statuses -- a run in one of these states cannot be transitioned.
// ---------------------------------------------------------------------------

const TERMINAL_STATUSES = new Set(["COMPLETED", "FAILED", "CANCELLED"]);

// ---------------------------------------------------------------------------
// Active statuses -- if any stage is in one of these states the run is still
// in-flight and should not be transitioned yet.
// ---------------------------------------------------------------------------

const ACTIVE_STATUSES = new Set(["RUNNING", "PENDING", "SUSPENDED"]);

// ---------------------------------------------------------------------------
// Helper: claim the run before mutating it
// ---------------------------------------------------------------------------

async function claimRunTransition(
  run: WorkflowRunRecord,
  deps: KernelDeps,
): Promise<boolean> {
  try {
    await deps.persistence.updateRun(run.id, {
      expectedVersion: run.version,
    });
    return true;
  } catch (error) {
    if (error instanceof StaleVersionError) {
      return false;
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export async function handleRunTransition(
  command: RunTransitionCommand,
  deps: KernelDeps,
): Promise<HandlerResult<RunTransitionResult>> {
  const events: KernelEvent[] = [];

  // 1. Get run from persistence
  const run = await deps.persistence.getRun(command.workflowRunId);
  if (!run) {
    return { action: "noop" as const, _events: [] };
  }

  // 2. If run is already in a terminal state, nothing to do
  if (TERMINAL_STATUSES.has(run.status)) {
    return { action: "noop" as const, _events: [] };
  }

  // 3. Get workflow definition from registry
  const workflow = deps.registry.getWorkflow(run.workflowId);
  if (!workflow) {
    return { action: "noop" as const, _events: [] };
  }

  // 4. Get all stages for this run
  const stages = await deps.persistence.getStagesByRun(command.workflowRunId);

  // 5. If no stages exist, this is the first transition -- enqueue group 1
  if (stages.length === 0) {
    if (!(await claimRunTransition(run, deps))) {
      return { action: "noop" as const, _events: [] };
    }
    const enqueue = await prepareExecutionGroup(run, workflow, deps, {
      groupIndex: 1,
      attemptMode: "max",
      createMode: "upsert",
    });

    events.push({
      type: "workflow:started",
      timestamp: deps.clock.now(),
      workflowRunId: run.id,
    });

    return {
      action: "advanced" as const,
      nextGroup: 1,
      _events: events,
      _postCommit: enqueue,
    };
  }

  // 6. If any stage is still active, the run is in-flight -- noop
  const hasActive = stages.some((s) => ACTIVE_STATUSES.has(s.status));
  if (hasActive) {
    return { action: "noop" as const, _events: [] };
  }

  // 7. If any stage has failed, mark the entire run as failed — unless a
  // retry is still queued or in flight for it. A FAILED stage record does
  // not necessarily mean the stage is done: job-execute flips the stage
  // to FAILED on every throw, including ones the host will retry (job
  // goes back to PENDING with backoff). If a sibling in the same
  // execution group completes first, its run.transition dispatch must
  // not race ahead and kill the run out from under the pending retry.
  //
  // A job is "still active" for a FAILED stage when it's RUNNING, or
  // PENDING with attempt > 0 — the latter is the signature of a retry
  // requeued by jobTransport.fail(..., shouldRetry: true) (dequeue()
  // increments attempt before execution, and a retry-requeue preserves
  // that count). A freshly-enqueued, never-dequeued job is PENDING with
  // attempt === 0 and does not represent a retry in flight — it only
  // occurs when a stage was enqueued but its job.execute was dispatched
  // out-of-band (or hasn't run yet, in which case the stage wouldn't be
  // FAILED in the first place).
  const failedStages = stages.filter((s) => s.status === "FAILED");
  let failedStage: (typeof failedStages)[number] | undefined;
  if (failedStages.length > 0) {
    const jobs = await deps.jobTransport.getJobsByWorkflowRun(run.id);
    failedStage = failedStages.find(
      (stage) =>
        !jobs.some(
          (job) =>
            job.stageId === stage.stageId &&
            (job.status === "RUNNING" ||
              (job.status === "PENDING" && job.attempt > 0)),
        ),
    );
    if (!failedStage) {
      // Every FAILED stage still has a retry queued or in flight — the
      // run is still active; wait for the retry's outcome.
      return { action: "noop" as const, _events: [] };
    }
  }
  if (failedStage) {
    if (!(await claimRunTransition(run, deps))) {
      return { action: "noop" as const, _events: [] };
    }
    await deps.persistence.updateRun(command.workflowRunId, {
      status: "FAILED",
      completedAt: deps.clock.now(),
    });

    events.push({
      type: "workflow:failed",
      timestamp: deps.clock.now(),
      workflowRunId: command.workflowRunId,
      error: failedStage.errorMessage || "Stage failed",
    });

    return { action: "failed" as const, _events: events };
  }

  // 8. Find the maximum execution group among completed stages
  const maxGroup = stages.reduce(
    (max, s) => (s.executionGroup > max ? s.executionGroup : max),
    0,
  );

  // 9. Get stages in the next execution group
  const nextGroupStages = workflow.getStagesInExecutionGroup(maxGroup + 1);

  // 10. If there are stages in the next group, enqueue them
  if (nextGroupStages.length > 0) {
    if (!(await claimRunTransition(run, deps))) {
      return { action: "noop" as const, _events: [] };
    }
    const enqueue = await prepareExecutionGroup(run, workflow, deps, {
      groupIndex: maxGroup + 1,
      attemptMode: "max",
      createMode: "upsert",
    });
    return {
      action: "advanced" as const,
      nextGroup: maxGroup + 1,
      _events: events,
      _postCommit: enqueue,
    };
  }

  // 11. No next group -- the workflow is complete
  let totalCost = 0;
  let totalTokens = 0;

  for (const stage of stages) {
    const metrics = stage.metrics as any;
    if (metrics) {
      totalCost += metrics.totalCost ?? 0;
      totalTokens += metrics.totalTokens ?? 0;
    }
  }

  const duration = deps.clock.now().getTime() - run.createdAt.getTime();

  // Resolve the final execution group's output for persistence
  const workflowContext = await loadWorkflowContext(
    command.workflowRunId,
    deps,
  );
  const output = resolveExecutionGroupOutput(
    workflow,
    maxGroup,
    workflowContext,
  );

  if (!(await claimRunTransition(run, deps))) {
    return { action: "noop" as const, _events: [] };
  }

  await deps.persistence.updateRun(command.workflowRunId, {
    status: "COMPLETED",
    completedAt: deps.clock.now(),
    duration,
    output,
    totalCost,
    totalTokens,
  });

  events.push({
    type: "workflow:completed",
    timestamp: deps.clock.now(),
    workflowRunId: command.workflowRunId,
    duration,
    output,
    totalCost,
    totalTokens,
  });

  return { action: "completed" as const, _events: events };
}
