/**
 * Shared StageStorage implementation backed by BlobStore.
 *
 * Used by both job-execute and stage-poll-suspended handlers.
 */

import type { StageStorage } from "../../core/stage.js";
import type { BlobStore, Persistence } from "../ports.js";
import { writeForRun } from "./run-writes.js";

export function createStorageShim(
  workflowRunId: string,
  workflowType: string,
  deps: { blobStore: BlobStore; persistence?: Persistence },
): StageStorage {
  return {
    async save<T>(key: string, data: T): Promise<void> {
      const put = () => deps.blobStore.put(key, data);
      if (deps.persistence)
        await writeForRun(deps.persistence, workflowRunId, put);
      else await put();
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
