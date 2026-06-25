import type { WorkerTransport } from "../transport.js";
import type { RemoteStage } from "./run-activity.js";
import { runActivity } from "./run-activity.js";

export interface ActivityWorkerConfig {
  registry: Map<string, RemoteStage>;
  transport: WorkerTransport;
  workerId: string;
  stageIds: string[];
  stageCodeVersion: string;
  /**
   * How often (ms) the worker sends a heartbeat to the broker while running a
   * stage. MUST be comfortably below the broker's `staleLeaseMs` threshold so
   * that a running worker is never falsely reaped. The default (5 000 ms) is
   * intentionally well below the broker's default stale-lease window (60 000 ms)
   * — at least one heartbeat fires before any stale-lease sweep can release the
   * lease. Rule: heartbeatMs < staleLeaseMs (a safe margin is heartbeatMs ≤
   * staleLeaseMs / 4).
   */
  heartbeatMs?: number;
  idleDelayMs?: number;
}

export interface ActivityWorker {
  processOne(): Promise<boolean>;
  start(): void;
  stop(): void;
}

export function createActivityWorker(
  cfg: ActivityWorkerConfig,
): ActivityWorker {
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
        taskId: task.taskId,
        leaseToken: task.leaseToken,
        outcome: {
          kind: "failed",
          error: `stage ${task.stageId} not registered on worker`,
        },
        logs: [],
        annotations: [],
        progress: [],
      });
      return true;
    }

    const beat = setInterval(() => {
      void cfg.transport
        .heartbeat({ taskId: task.taskId, leaseToken: task.leaseToken })
        .catch(() => {});
    }, heartbeatMs);
    try {
      const report = await runActivity(task, stage, cfg.transport);
      // Write a durable copy of the report to object storage BEFORE telling the
      // broker. This ensures that if the orchestrator restarts after the worker
      // completes (and the broker loses the REPORTED task), checkCompletion can
      // recover the outcome from object storage without re-running the work.
      // Key: <artifactPrefix>/<taskId>/report.json — derivable by both sides.
      const durableReportKey = `${task.grant.prefix}report.json`;
      await cfg.transport
        .presign({
          taskId: task.taskId,
          leaseToken: task.leaseToken,
          relKey: durableReportKey,
          op: "put",
        })
        .then((r) => cfg.transport.putBytes(r.url, report))
        .catch(() => {
          // Non-fatal: if the write fails the broker still gets the report.
          // The durable-report recovery path simply won't find the key on restart.
        });
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
