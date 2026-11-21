/**
 * Save stage output to BlobStore and return the blob key.
 *
 * The key is stored in stage.outputData._artifactKey so that
 * loadWorkflowContext() can retrieve it later.
 */

import type { KernelDeps } from "../kernel.js";

export async function saveStageOutput(
  runId: string,
  workflowType: string,
  stageId: string,
  output: unknown,
  deps: KernelDeps,
  /** A folder under the stage's prefix, for a writer that may be superseded. */
  scope?: string,
): Promise<string> {
  const dir = scope ? `${stageId}/${scope}` : stageId;
  const key = `workflow-v2/${workflowType}/${runId}/${dir}/output.json`;
  await deps.blobStore.put(key, output);
  return key;
}
