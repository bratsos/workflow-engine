/**
 * Resolve the output of an execution group from the workflow context.
 *
 * - Single-stage group → returns that stage's output directly.
 * - Multi-stage (parallel) group → returns an object keyed by stage ID.
 */

import type { Workflow } from "../../core/workflow.js";

export function resolveExecutionGroupOutput(
  workflow: Workflow<any, any>,
  groupIndex: number,
  workflowContext: Record<string, unknown>,
): unknown {
  const stages = workflow.getStagesInExecutionGroup(groupIndex);

  if (stages.length === 0) return undefined;

  if (stages.length === 1) {
    return workflowContext[stages[0].id];
  }

  // Parallel group → merge outputs keyed by stage ID
  const merged: Record<string, unknown> = {};
  for (const stage of stages) {
    if (workflowContext[stage.id] !== undefined) {
      merged[stage.id] = workflowContext[stage.id];
    }
  }
  return merged;
}
