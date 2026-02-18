/**
 * Handler: run.rerunFrom
 *
 * Reruns a workflow from a specific stage. Deletes stage records and
 * blob artifacts at/after the target execution group, resets the run
 * to RUNNING, creates new stage records, and enqueues jobs.
 *
 * Works for both COMPLETED runs (rerun from any stage) and FAILED runs
 * (retry from the failed stage).
 */

import type { RunRerunFromCommand, RunRerunFromResult } from "../commands";
import type { KernelEvent } from "../events";
import type { KernelDeps, HandlerResult } from "../kernel";

export async function handleRunRerunFrom(
  command: RunRerunFromCommand,
  deps: KernelDeps,
): Promise<HandlerResult<RunRerunFromResult>> {
  const { workflowRunId, fromStageId } = command;
  const events: KernelEvent[] = [];

  // 1. Load run
  const run = await deps.persistence.getRun(workflowRunId);
  if (!run) throw new Error(`WorkflowRun ${workflowRunId} not found`);

  // 2. Validate run is in a rerunnable state
  if (run.status !== "COMPLETED" && run.status !== "FAILED") {
    throw new Error(
      `Cannot rerun workflow in ${run.status} state. Must be COMPLETED or FAILED.`,
    );
  }

  // 3. Load workflow definition
  const workflow = deps.registry.getWorkflow(run.workflowId);
  if (!workflow) throw new Error(`Workflow ${run.workflowId} not found in registry`);

  // 4. Validate stage exists in workflow
  const stageDef = workflow.getStage(fromStageId);
  if (!stageDef) {
    throw new Error(`Stage ${fromStageId} not found in workflow ${run.workflowId}`);
  }

  // 5. Get the execution group of the target stage
  const targetGroup = workflow.getExecutionGroupIndex(fromStageId);

  // 6. Get all existing stage records
  const existingStages = await deps.persistence.getStagesByRun(workflowRunId);

  // 7. Validate: stages before the target group must have been executed
  if (targetGroup > 1) {
    const priorStages = existingStages.filter((s) => s.executionGroup < targetGroup);
    if (priorStages.length === 0) {
      throw new Error(
        `Cannot rerun from stage ${fromStageId}: previous stages have not been executed`,
      );
    }
  }

  // 8. Find stages to delete (at or after the target group)
  const stagesToDelete = existingStages.filter(
    (s) => s.executionGroup >= targetGroup,
  );
  const deletedStageIds = stagesToDelete.map((s) => s.stageId);

  // 9. Delete blob artifacts for stages being removed
  for (const stage of stagesToDelete) {
    const outputRef = stage.outputData as { _artifactKey?: string } | null;
    if (outputRef?._artifactKey) {
      await deps.blobStore.delete(outputRef._artifactKey).catch(() => {});
    }
  }

  // 10. Delete stage records
  for (const stage of stagesToDelete) {
    await deps.persistence.deleteStage(stage.id);
  }

  // 11. Reset run to RUNNING
  await deps.persistence.updateRun(workflowRunId, {
    status: "RUNNING",
    completedAt: undefined as any,
  });

  // 12. Create new stage records for the target execution group
  const targetStages = workflow.getStagesInExecutionGroup(targetGroup);
  for (const stage of targetStages) {
    await deps.persistence.createStage({
      workflowRunId,
      stageId: stage.id,
      stageName: stage.name,
      stageNumber: workflow.getStageIndex(stage.id) + 1,
      executionGroup: targetGroup,
      status: "PENDING",
      config: (run.config as any)?.[stage.id] || {},
    });
  }

  // 13. Enqueue jobs
  await deps.jobTransport.enqueueParallel(
    targetStages.map((stage) => ({
      workflowRunId,
      workflowId: run.workflowId,
      stageId: stage.id,
      priority: run.priority,
      payload: { config: run.config || {} },
    })),
  );

  // 14. Emit workflow:started event (restarted)
  events.push({
    type: "workflow:started",
    timestamp: deps.clock.now(),
    workflowRunId,
  });

  return {
    workflowRunId,
    fromStageId,
    deletedStages: deletedStageIds,
    _events: events,
  };
}
