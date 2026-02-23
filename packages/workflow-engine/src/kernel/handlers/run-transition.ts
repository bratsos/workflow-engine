/**
 * Handler: run.transition
 *
 * Advances a workflow run to its next execution group, or marks it as
 * completed/failed depending on the current state of its stages.
 *
 * Extracted from WorkflowRuntime.transitionWorkflow() and completeWorkflow().
 */

import type { Workflow } from "../../core/workflow";
import type { RunTransitionCommand, RunTransitionResult } from "../commands";
import type { KernelEvent } from "../events";
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

async function enqueueExecutionGroup(
  run: WorkflowRunRecord,
  workflow: Workflow<any, any>,
  groupIndex: number,
  deps: KernelDeps,
): Promise<string[]> {
  const stages = workflow.getStagesInExecutionGroup(groupIndex);

  for (const stage of stages) {
    await deps.persistence.createStage({
      workflowRunId: run.id,
      stageId: stage.id,
      stageName: stage.name,
      stageNumber: workflow.getStageIndex(stage.id) + 1,
      executionGroup: groupIndex,
      status: "PENDING",
      config: (run.config as any)?.[stage.id] || {},
    });
  }

  return deps.jobTransport.enqueueParallel(
    stages.map((stage) => ({
      workflowRunId: run.id,
      workflowId: run.workflowId,
      stageId: stage.id,
      priority: run.priority,
      payload: { config: run.config || {} },
    })),
  );
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
    await enqueueExecutionGroup(run, workflow, 1, deps);

    events.push({
      type: "workflow:started",
      timestamp: deps.clock.now(),
      workflowRunId: run.id,
    });

    return { action: "advanced" as const, nextGroup: 1, _events: events };
  }

  // 6. If any stage is still active, the run is in-flight -- noop
  const hasActive = stages.some((s) => ACTIVE_STATUSES.has(s.status));
  if (hasActive) {
    return { action: "noop" as const, _events: [] };
  }

  // 7. If any stage has failed, mark the entire run as failed
  const failedStage = stages.find((s) => s.status === "FAILED");
  if (failedStage) {
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
    await enqueueExecutionGroup(run, workflow, maxGroup + 1, deps);
    return {
      action: "advanced" as const,
      nextGroup: maxGroup + 1,
      _events: events,
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

  await deps.persistence.updateRun(command.workflowRunId, {
    status: "COMPLETED",
    completedAt: deps.clock.now(),
    duration,
    totalCost,
    totalTokens,
  });

  events.push({
    type: "workflow:completed",
    timestamp: deps.clock.now(),
    workflowRunId: command.workflowRunId,
    duration,
    totalCost,
    totalTokens,
  });

  return { action: "completed" as const, _events: events };
}
