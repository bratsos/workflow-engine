/**
 * Handler: run.transition
 *
 * Advances a workflow run to its next execution group, or marks it as
 * completed/failed depending on the current state of its stages.
 */

import type { Workflow } from "../../core/workflow";
import { StaleVersionError } from "../../persistence/interface.js";
import type { RunTransitionCommand, RunTransitionResult } from "../commands";
import type { KernelEvent } from "../events";
import {
  loadWorkflowContext,
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
// Helper: enqueue an execution group
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

/**
 * Upserts stage records for an execution group (must run inside the
 * transaction) and returns a closure that enqueues jobs for the
 * newly-PENDING stages. The enqueue itself is NOT performed here — the
 * caller must invoke the returned closure from `_postCommit`, after the
 * transaction has committed. Enqueueing mid-transaction risks an orphan
 * job if the transaction later rolls back (jobTransport isn't part of
 * the DB transaction, so its writes can't be undone).
 */
async function prepareExecutionGroup(
  run: WorkflowRunRecord,
  workflow: Workflow<any, any>,
  groupIndex: number,
  deps: KernelDeps,
): Promise<() => Promise<string[]>> {
  const stages = workflow.getStagesInExecutionGroup(groupIndex);

  // Compute the current run-level attempt by taking the max attempt
  // across all existing stages. After `run.rerunFrom` bumps the target
  // group's stage records to a new attempt, this propagates the same
  // attempt to downstream groups created here, so annotations from a
  // single rerun span share one attempt value (and are distinguishable
  // from prior-attempt annotations preserved via SetNull).
  const existingStages = await deps.persistence.getStagesByRun(run.id);
  const currentAttempt = existingStages.reduce(
    (max, s) => (s.attempt > max ? s.attempt : max),
    0,
  );

  const stagesToEnqueue: typeof stages = [];
  for (const stage of stages) {
    const record = await deps.persistence.upsertStage({
      workflowRunId: run.id,
      stageId: stage.id,
      create: {
        workflowRunId: run.id,
        stageId: stage.id,
        stageName: stage.name,
        stageNumber: workflow.getStageIndex(stage.id) + 1,
        executionGroup: groupIndex,
        attempt: currentAttempt,
        status: "PENDING",
        config: (run.config as any)?.[stage.id] || {},
      },
      update: {},
    });
    if (record.status === "PENDING") {
      stagesToEnqueue.push(stage);
    }
  }

  return () => {
    if (stagesToEnqueue.length === 0) return Promise.resolve([]);
    return deps.jobTransport.enqueueParallel(
      stagesToEnqueue.map((stage) => ({
        workflowRunId: run.id,
        workflowId: run.workflowId,
        stageId: stage.id,
        priority: run.priority,
        payload: { config: run.config || {} },
      })),
    );
  };
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
    const enqueue = await prepareExecutionGroup(run, workflow, 1, deps);

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
    const enqueue = await prepareExecutionGroup(
      run,
      workflow,
      maxGroup + 1,
      deps,
    );
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
