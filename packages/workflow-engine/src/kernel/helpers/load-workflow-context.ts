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
  const completedStages = await deps.persistence.getStagesByRun(workflowRunId, {
    status: "COMPLETED",
    orderBy: "asc",
  });

  const context: Record<string, unknown> = {};

  for (const stage of completedStages) {
    const outputData = stage.outputData as any;
    if (outputData?._artifactKey) {
      const key = outputData._artifactKey as string;
      let blob: unknown;
      try {
        blob = await deps.blobStore.get(key);
      } catch (error) {
        throw new Error(
          `Blob "${key}" (output of stage ${stage.stageId}, run ${workflowRunId}) is not in the blob store: ${
            error instanceof Error ? error.message : String(error)
          }. Every process that executes or polls a run must share one BlobStore (see createPrismaBlobStore).`,
        );
      }
      if (blob === undefined || blob === null) {
        throw new Error(
          `Blob "${key}" (output of stage ${stage.stageId}, run ${workflowRunId}) is not in the blob store. Every process that executes or polls a run must share one BlobStore (see createPrismaBlobStore).`,
        );
      }
      context[stage.stageId] = blob;
    } else if (outputData && typeof outputData === "object") {
      context[stage.stageId] = outputData;
    }
  }

  return context;
}
