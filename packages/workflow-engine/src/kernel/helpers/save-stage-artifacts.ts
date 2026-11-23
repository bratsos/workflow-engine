/**
 * Save stage artifacts to BlobStore under the attempt's own keys (see
 * saveStageOutput).
 */

import type { KernelDeps } from "../kernel.js";
import { writeForRun } from "./run-writes.js";
import { stageAttemptPrefix } from "./save-stage-output.js";

export async function saveStageArtifacts(
  runId: string,
  workflowType: string,
  stageId: string,
  artifacts: Record<string, unknown>,
  deps: KernelDeps,
  attemptKey: string = crypto.randomUUID(),
): Promise<Record<string, string>> {
  const artifactKeys: Record<string, string> = {};
  const prefix = stageAttemptPrefix(runId, workflowType, stageId, attemptKey);

  for (const [artifactName, artifact] of Object.entries(artifacts)) {
    const encodedName = encodeURIComponent(artifactName);
    const key = `${prefix}/artifacts/${encodedName}.json`;
    await writeForRun(deps.persistence, runId, () =>
      deps.blobStore.put(key, artifact),
    );
    artifactKeys[artifactName] = key;
  }

  return artifactKeys;
}
