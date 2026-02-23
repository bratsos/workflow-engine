/**
 * Load workflow context from completed stages.
 *
 * For each completed stage, loads the output from BlobStore using
 * the _artifactKey stored in stage.outputData.
 */

import type { KernelDeps } from "../kernel.js";

export async function loadWorkflowContext(
  workflowRunId: string,
  deps: KernelDeps,
): Promise<Record<string, unknown>> {
  const completedStages = await deps.persistence.getStagesByRun(
    workflowRunId,
    {
      status: "COMPLETED",
      orderBy: "asc",
    },
  );

  const context: Record<string, unknown> = {};

  for (const stage of completedStages) {
    const outputData = stage.outputData as any;
    if (outputData?._artifactKey) {
      context[stage.stageId] = await deps.blobStore.get(
        outputData._artifactKey,
      );
    } else if (outputData && typeof outputData === "object") {
      context[stage.stageId] = outputData;
    }
  }

  return context;
}
