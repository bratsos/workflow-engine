/**
 * Save stage output to BlobStore and return the blob key.
 *
 * The key is stored in stage.outputData._artifactKey so that
 * loadWorkflowContext() can retrieve it later.
 *
 * Every attempt writes under a key of its own (`attempts/<attemptKey>/`
 * below the stage's prefix): only the attempt whose fenced stage write
 * commits gets its key into `outputData`, so an attempt that loses never
 * changes the bytes a reader of that pointer gets. Pointers stored by an
 * earlier release name the old per-stage key and stay readable.
 */

import type { WorkflowStageRecord } from "../../persistence/interface.js";
import type { KernelDeps } from "../kernel.js";

/** The prefix under which one attempt of a stage writes its output and artifacts. */
export function stageAttemptPrefix(
  runId: string,
  workflowType: string,
  stageId: string,
  attemptKey: string,
): string {
  return `workflow-v2/${workflowType}/${runId}/${stageId}/attempts/${attemptKey}`;
}

export async function saveStageOutput(
  runId: string,
  workflowType: string,
  stageId: string,
  output: unknown,
  deps: KernelDeps,
  attemptKey: string = crypto.randomUUID(),
): Promise<string> {
  const key = `${stageAttemptPrefix(runId, workflowType, stageId, attemptKey)}/output.json`;
  await deps.blobStore.put(key, output);
  return key;
}

/**
 * After the stage write committed: copy the winner's output and artifacts
 * to the fixed per-stage keys every earlier release wrote
 * (`<stage>/output.json`, the default `getStageKey(stageId)`, and
 * `<stage>/artifacts/<name>.json`), for code that reads them there. Only a
 * committed attempt calls this, never one that lost its fence. Best-effort:
 * the pointer in `outputData` is what the engine reads.
 */
export async function publishStageKeys(
  runId: string,
  workflowType: string,
  stageId: string,
  output: unknown,
  artifacts: Record<string, unknown> | undefined,
  deps: Pick<KernelDeps, "blobStore">,
): Promise<void> {
  const base = `workflow-v2/${workflowType}/${runId}/${stageId}`;
  try {
    await deps.blobStore.put(`${base}/output.json`, output);
    for (const [name, artifact] of Object.entries(artifacts ?? {})) {
      await deps.blobStore.put(
        `${base}/artifacts/${encodeURIComponent(name)}.json`,
        artifact,
      );
    }
  } catch {
    // The committed pointer stays authoritative.
  }
}

/** The blob keys a stage record's outputData points at. */
export function outputKeys(stage: WorkflowStageRecord): string[] {
  const data = stage.outputData as {
    _artifactKey?: unknown;
    _artifactKeys?: Record<string, unknown>;
  } | null;
  return [
    data?._artifactKey,
    ...Object.values(data?._artifactKeys ?? {}),
  ].filter((key): key is string => typeof key === "string");
}

/**
 * Best-effort cleanup of the blobs an attempt saved before its stage write
 * was discarded. A key some stage's outputData points at is kept; a failed
 * read keeps everything. Never throws: what stays goes with `run.purge`.
 */
export async function discardUnreferencedBlobs(
  workflowRunId: string,
  keys: readonly string[],
  deps: Pick<KernelDeps, "persistence" | "blobStore">,
): Promise<void> {
  if (keys.length === 0) return;
  try {
    const kept = new Set(
      (await deps.persistence.getStagesByRun(workflowRunId)).flatMap(
        outputKeys,
      ),
    );
    for (const key of keys) {
      if (!kept.has(key)) await deps.blobStore.delete(key).catch(() => {});
    }
  } catch {
    // Unreadable stages: keep every key.
  }
}
