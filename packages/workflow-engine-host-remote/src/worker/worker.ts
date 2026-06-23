import type { WorkerTransport } from "../transport.js";
import type { RemoteStage } from "./run-activity.js";
import { runActivity } from "./run-activity.js";

export interface ActivityWorkerConfig {
  registry: Map<string, RemoteStage>;
  transport: WorkerTransport;
  workerId: string;
  stageIds: string[];
  stageCodeVersion: string;
  heartbeatMs?: number;
  idleDelayMs?: number;
}

export interface ActivityWorker {
  processOne(): Promise<boolean>;
  start(): void;
  stop(): void;
}

export function createActivityWorker(cfg: ActivityWorkerConfig): ActivityWorker {
  const heartbeatMs = cfg.heartbeatMs ?? 5_000;
  const idleDelayMs = cfg.idleDelayMs ?? 500;
  let running = false;

  async function processOne(): Promise<boolean> {
    const task = await cfg.transport.lease({
      workerId: cfg.workerId,
      stageIds: cfg.stageIds,
      stageCodeVersion: cfg.stageCodeVersion,
    });
    if (!task) return false;

    const stage = cfg.registry.get(task.stageId);
    if (!stage) {
      await cfg.transport.report({
        taskId: task.taskId, leaseToken: task.leaseToken,
        outcome: { kind: "failed", error: `stage ${task.stageId} not registered on worker` },
        logs: [], annotations: [], progress: [],
      });
      return true;
    }

    const beat = setInterval(() => {
      void cfg.transport.heartbeat({ taskId: task.taskId, leaseToken: task.leaseToken }).catch(() => {});
    }, heartbeatMs);
    try {
      const report = await runActivity(task, stage, cfg.transport);
      await cfg.transport.report(report);
    } finally {
      clearInterval(beat);
    }
    return true;
  }

  async function loop(): Promise<void> {
    while (running) {
      const did = await processOne().catch(() => false);
      if (!did) await new Promise((r) => setTimeout(r, idleDelayMs));
    }
  }

  return {
    processOne,
    start() {
      if (running) return;
      running = true;
      void loop();
    },
    stop() {
      running = false;
    },
  };
}
