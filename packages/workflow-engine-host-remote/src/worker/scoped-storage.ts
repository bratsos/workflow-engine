import type { EnhancedStageContext } from "@bratsos/workflow-engine";
import type { ArtifactGrant } from "../protocol.js";
import type { WorkerTransport } from "../transport.js";

// Derive StageStorage from the exported EnhancedStageContext (no core change).
export type RemoteStageStorage = Omit<
  EnhancedStageContext<unknown, unknown, Record<string, unknown>>,
  "require" | "optional"
>["storage"];

export function createScopedStorage(
  grant: ArtifactGrant,
  transport: WorkerTransport,
  taskId: string,
  leaseToken: string,
): RemoteStageStorage {
  return {
    async save<T>(key: string, data: T): Promise<void> {
      const { url } = await transport.presign({ taskId, leaseToken, relKey: key, op: "put" });
      await transport.putBytes(url, data);
    },
    async load<T>(key: string): Promise<T> {
      const { url } = await transport.presign({ taskId, leaseToken, relKey: key, op: "get" });
      return (await transport.getBytes(url)) as T;
    },
    async exists(key: string): Promise<boolean> {
      const { url } = await transport.presign({ taskId, leaseToken, relKey: key, op: "get" });
      return (await transport.getBytes(url)) !== undefined;
    },
    async delete(_key: string): Promise<void> {
      throw new Error("scoped storage delete is not supported for remote stages (v1)");
    },
    getStageKey(_stageId: string, suffix?: string): string {
      return `${grant.prefix}${suffix ?? "output.json"}`;
    },
  };
}
