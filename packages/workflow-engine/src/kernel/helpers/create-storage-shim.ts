/**
 * Shared StageStorage implementation backed by BlobStore.
 *
 * Used by both job-execute and stage-poll-suspended handlers.
 */

import type { StageStorage } from "../../core/stage.js";
import type { KernelDeps } from "../kernel.js";

export function createStorageShim(
  workflowRunId: string,
  workflowType: string,
  deps: KernelDeps,
): StageStorage {
  return {
    async save<T>(key: string, data: T): Promise<void> {
      await deps.blobStore.put(key, data);
    },

    async load<T>(key: string): Promise<T> {
      return deps.blobStore.get(key) as Promise<T>;
    },

    async exists(key: string): Promise<boolean> {
      return deps.blobStore.has(key);
    },

    async delete(key: string): Promise<void> {
      return deps.blobStore.delete(key);
    },

    getStageKey(stageId: string, suffix?: string): string {
      const base = `workflow-v2/${workflowType}/${workflowRunId}/${stageId}`;
      return suffix ? `${base}/${suffix}` : `${base}/output.json`;
    },
  };
}
