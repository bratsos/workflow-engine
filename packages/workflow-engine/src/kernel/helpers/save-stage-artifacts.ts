/**
 * Save stage artifacts to BlobStore using deterministic per-stage keys.
 */

import type { KernelDeps } from "../kernel.js";

export async function saveStageArtifacts(
  runId: string,
  workflowType: string,
  stageId: string,
  artifacts: Record<string, unknown>,
  deps: KernelDeps,
): Promise<Record<string, string>> {
  const artifactKeys: Record<string, string> = {};

  for (const [artifactName, artifact] of Object.entries(artifacts)) {
    const encodedName = encodeURIComponent(artifactName);
    const key = `workflow-v2/${workflowType}/${runId}/${stageId}/artifacts/${encodedName}.json`;
    await deps.blobStore.put(key, artifact);
    artifactKeys[artifactName] = key;
  }

  return artifactKeys;
}
