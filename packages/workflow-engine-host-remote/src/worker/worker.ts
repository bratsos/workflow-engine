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
  /**
   * Called whenever processOne() throws (e.g. a permanent lease/version
   * mismatch). Defaults to console.error so failures are never silently
   * swallowed. Receives the running count of consecutive failures — the
   * loop also backs off (capped by maxBackoffMs) as this count grows.
   */
  onError?: (error: unknown, info: { consecutiveFailures: number }) => void;
  maxBackoffMs?: number;
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
  const maxBackoffMs = cfg.maxBackoffMs ?? 30_000;
  const onError =
    cfg.onError ??
    ((error: unknown, info: { consecutiveFailures: number }) => {
      console.error(
        `[activity-worker ${cfg.workerId}] processOne failed (consecutive failures: ${info.consecutiveFailures})`,
        error,
      );
    });
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

    // The Stage execution contract (see `Stage.execute` in
    // @bratsos/workflow-engine) has no AbortSignal parameter, so a running
    // activity cannot be interrupted mid-flight. Instead: as soon as the
    // broker's heartbeat response signals `cancel` (the lease was fenced or
    // reaped, e.g. by another worker or a stale-lease sweep), stop
    // heartbeating and skip the presign/report once execution finishes — a
    // reaped worker still burns the remaining compute, but it no longer
    // wastes a doomed report round-trip afterwards.
    let cancelled = false;
    const beat = setInterval(() => {
      void cfg.transport
        .heartbeat({ taskId: task.taskId, leaseToken: task.leaseToken })
        .then((res) => {
          if (!res.ok || res.cancel) {
            cancelled = true;
            clearInterval(beat);
          }
        })
        .catch(() => {});
    }, heartbeatMs);
    try {
      const report = await runActivity(task, stage, cfg.transport);
      if (cancelled) {
        return true;
      }
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
    let consecutiveFailures = 0;
    while (running) {
      let did = false;
      try {
        did = await processOne();
        consecutiveFailures = 0;
      } catch (error) {
        consecutiveFailures++;
        onError(error, { consecutiveFailures });
      }
      if (!did) {
        const delay =
          consecutiveFailures > 0
            ? Math.min(
                idleDelayMs * 2 ** (consecutiveFailures - 1),
                maxBackoffMs,
              )
            : idleDelayMs;
        await new Promise((r) => setTimeout(r, delay));
      }
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
