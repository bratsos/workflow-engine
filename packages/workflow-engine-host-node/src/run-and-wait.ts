// packages/workflow-engine-host-node/src/run-and-wait.ts
import type { Kernel, RunCreateCommand } from "@bratsos/workflow-engine/kernel";
import type { NodeHost } from "./host.js";

export interface RunAndWaitPersistence {
  getRun(id: string): Promise<{
    id: string;
    status: string;
    totalCost: number;
    totalTokens: number;
    startedAt: Date | null;
    completedAt: Date | null;
    duration: number | null;
    output: unknown | null;
  } | null>;
  getStagesByRun(
    runId: string,
    options?: { orderBy?: "asc" | "desc" },
  ): Promise<
    Array<{
      stageId: string;
      stageName: string;
      status: string;
      duration: number | null;
    }>
  >;
}

export interface StageStatus {
  stageId: string;
  stageName: string;
  status: string;
  duration: number | null;
}

export interface RunAndWaitResult {
  runId: string;
  status: "COMPLETED" | "FAILED" | "CANCELLED";
  stages: StageStatus[];
  totalCost: number;
  totalTokens: number;
  duration: number | null;
  output: unknown | null;
}

export interface RunAndWaitOptions {
  kernel: Kernel;
  persistence: RunAndWaitPersistence;
  host: NodeHost;
  command: RunCreateCommand;
  pollIntervalMs?: number;
  onStageChange?: (stages: StageStatus[]) => void;
  signal?: AbortSignal;
}

const TERMINAL_STATUSES = new Set<RunAndWaitResult["status"]>([
  "COMPLETED",
  "FAILED",
  "CANCELLED",
]);

function isTerminalStatus(
  status: string,
): status is RunAndWaitResult["status"] {
  return TERMINAL_STATUSES.has(status as RunAndWaitResult["status"]);
}

export async function runAndWait(
  options: RunAndWaitOptions,
): Promise<RunAndWaitResult> {
  const {
    kernel,
    persistence,
    host,
    command,
    pollIntervalMs = 3_000,
    onStageChange,
    signal,
  } = options;

  const createResult = await kernel.dispatch(command);
  const runId = createResult.workflowRunId;

  const wasAlreadyRunning = host.getStats().isRunning;
  if (!wasAlreadyRunning) {
    await host.start();
  }

  try {
    return await pollUntilDone({
      runId,
      persistence,
      pollIntervalMs,
      onStageChange,
      signal,
    });
  } finally {
    if (!wasAlreadyRunning) {
      await host.stop();
    }
  }
}

async function pollUntilDone(opts: {
  runId: string;
  persistence: RunAndWaitPersistence;
  pollIntervalMs: number;
  onStageChange?: (stages: StageStatus[]) => void;
  signal?: AbortSignal;
}): Promise<RunAndWaitResult> {
  const { runId, persistence, pollIntervalMs, onStageChange, signal } = opts;
  let previousStageSnapshot = "";

  while (true) {
    if (signal?.aborted) {
      throw new Error("runAndWait aborted");
    }

    const run = await persistence.getRun(runId);
    if (!run) {
      throw new Error(`Run ${runId} not found`);
    }

    const stages = await persistence.getStagesByRun(runId, { orderBy: "asc" });
    const stageStatuses: StageStatus[] = stages.map((s) => ({
      stageId: s.stageId,
      stageName: s.stageName,
      status: s.status,
      duration: s.duration,
    }));

    const stageSnapshot = JSON.stringify(stageStatuses);
    if (onStageChange && stageSnapshot !== previousStageSnapshot) {
      previousStageSnapshot = stageSnapshot;
      onStageChange(stageStatuses);
    }

    if (isTerminalStatus(run.status)) {
      return {
        runId,
        status: run.status,
        stages: stageStatuses,
        totalCost: run.totalCost,
        totalTokens: run.totalTokens,
        duration: run.duration,
        output: run.output,
      };
    }

    await sleep(pollIntervalMs, signal);
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("runAndWait aborted"));
      return;
    }
    const id = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(id);
        reject(new Error("runAndWait aborted"));
      },
      { once: true },
    );
  });
}
