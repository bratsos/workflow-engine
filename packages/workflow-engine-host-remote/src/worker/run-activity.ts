import type { EnhancedStageContext, Stage } from "@bratsos/workflow-engine";
import type { z } from "zod";
import type { ActivityReport, ActivityTask, BufferedLog, BufferedProgress } from "../protocol.js";
import type { WorkerTransport } from "../transport.js";
import { createScopedStorage } from "./scoped-storage.js";

export type RemoteStage = Stage<z.ZodTypeAny, z.ZodTypeAny, z.ZodTypeAny>;

// Base StageContext shape, derived from the exported EnhancedStageContext.
type BaseContext = Omit<
  EnhancedStageContext<unknown, unknown, Record<string, unknown>>,
  "require" | "optional"
>;

export async function runActivity(
  task: ActivityTask,
  stage: RemoteStage,
  transport: WorkerTransport,
): Promise<ActivityReport> {
  const logs: BufferedLog[] = [];
  const annotations: unknown[][] = [];
  const progress: BufferedProgress[] = [];

  const log = (level: string, message: string, meta?: Record<string, unknown>) => {
    logs.push({ level, message, meta });
  };

  const context: BaseContext = {
    workflowRunId: task.workflowRunId,
    stageId: task.stageId,
    stageNumber: task.stageNumber,
    stageName: task.stageName,
    input: task.input,
    config: task.config,
    resumeState: task.resumeState as BaseContext["resumeState"],
    workflowContext: task.workflowContext,
    onProgress: (u) => progress.push({ progress: u.progress, message: u.message, details: u.details }),
    onLog: log,
    log,
    // annotate is an overloaded callable; the engine itself casts here.
    annotate: ((...args: unknown[]) => {
      annotations.push(args);
    }) as BaseContext["annotate"],
    storage: createScopedStorage(task.grant, transport, task.taskId, task.leaseToken),
  };

  try {
    const result = await stage.execute(context as Parameters<RemoteStage["execute"]>[0]);
    if (result && typeof result === "object" && "suspended" in result && (result as { suspended?: unknown }).suspended === true) {
      return {
        taskId: task.taskId,
        leaseToken: task.leaseToken,
        outcome: { kind: "failed", error: "async-batch (suspended) stages are not supported on remote workers in v1" },
        logs,
        annotations,
        progress,
      };
    }
    const r = result as { output: unknown; metrics?: { itemsProcessed?: number }; artifacts?: Record<string, unknown> };
    return {
      taskId: task.taskId,
      leaseToken: task.leaseToken,
      outcome: { kind: "completed", output: r.output, customMetrics: extractCustomMetrics(r.metrics) },
      logs,
      annotations,
      progress,
    };
  } catch (error) {
    return {
      taskId: task.taskId,
      leaseToken: task.leaseToken,
      outcome: { kind: "failed", error: error instanceof Error ? error.message : String(error) },
      logs,
      annotations,
      progress,
    };
  }
}

function extractCustomMetrics(metrics: unknown): Record<string, number> | undefined {
  if (!metrics || typeof metrics !== "object") return undefined;
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(metrics as Record<string, unknown>)) {
    if (typeof v === "number" && !["startTime", "endTime", "duration"].includes(k)) out[k] = v;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}
