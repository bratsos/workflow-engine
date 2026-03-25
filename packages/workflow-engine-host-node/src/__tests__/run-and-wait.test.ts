// packages/workflow-engine-host-node/src/__tests__/run-and-wait.test.ts
import { describe, expect, it, vi } from "vitest";
import { type RunAndWaitResult, runAndWait } from "../run-and-wait.js";

function createFakeKernel() {
  return {
    dispatch: vi.fn(async (command: any) => {
      if (command.type === "run.create") {
        return { workflowRunId: "run-1", status: "PENDING" };
      }
      return {
        claimed: [],
        checked: 0,
        resumed: 0,
        failed: 0,
        resumedWorkflowRunIds: [],
        released: 0,
        published: 0,
        transitioned: 0,
      };
    }),
  };
}

function createFakePersistence(
  opts: {
    terminalStatus?: "COMPLETED" | "FAILED";
    ticksBeforeTerminal?: number;
  } = {},
) {
  const { terminalStatus = "COMPLETED", ticksBeforeTerminal = 1 } = opts;
  let pollCount = 0;
  return {
    getRun: vi.fn(async (id: string) => {
      pollCount++;
      const isTerminal = pollCount >= ticksBeforeTerminal;
      return {
        id,
        status: isTerminal ? terminalStatus : "RUNNING",
        totalCost: isTerminal ? 0.05 : 0,
        totalTokens: isTerminal ? 1000 : 0,
        startedAt: new Date("2026-01-01T00:00:00Z"),
        completedAt: isTerminal ? new Date("2026-01-01T00:01:00Z") : null,
        duration: isTerminal ? 60_000 : null,
        output: isTerminal ? { result: "done" } : null,
      };
    }),
    getStagesByRun: vi.fn(async () => [
      {
        stageId: "s1",
        stageName: "Stage 1",
        status: "COMPLETED",
        duration: 30_000,
      },
      {
        stageId: "s2",
        stageName: "Stage 2",
        status: "COMPLETED",
        duration: 30_000,
      },
    ]),
  };
}

function createFakeHost(alreadyRunning = false) {
  let started = alreadyRunning;
  return {
    start: vi.fn(async () => {
      started = true;
    }),
    stop: vi.fn(async () => {
      started = false;
    }),
    getStats: vi.fn(() => ({
      isRunning: started,
      workerId: "w1",
      jobsProcessed: 0,
      orchestrationTicks: 0,
      uptimeMs: 0,
    })),
  };
}

describe("runAndWait", () => {
  it("creates a run, waits for completion, and returns result", async () => {
    const kernel = createFakeKernel();
    const persistence = createFakePersistence({ terminalStatus: "COMPLETED" });
    const host = createFakeHost();

    const result = await runAndWait({
      kernel: kernel as any,
      persistence: persistence as any,
      host: host as any,
      command: {
        type: "run.create",
        idempotencyKey: "test-1",
        workflowId: "test-workflow",
        input: { data: "hello" },
      },
      pollIntervalMs: 10,
    });

    expect(result.status).toBe("COMPLETED");
    expect(result.runId).toBe("run-1");
    expect(kernel.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ type: "run.create" }),
    );
    expect(host.start).toHaveBeenCalled();
    expect(host.stop).toHaveBeenCalled();
  });

  it("returns FAILED status when run fails", async () => {
    const kernel = createFakeKernel();
    const persistence = createFakePersistence({ terminalStatus: "FAILED" });
    const host = createFakeHost();

    const result = await runAndWait({
      kernel: kernel as any,
      persistence: persistence as any,
      host: host as any,
      command: {
        type: "run.create",
        idempotencyKey: "test-2",
        workflowId: "test-workflow",
        input: {},
      },
      pollIntervalMs: 10,
    });

    expect(result.status).toBe("FAILED");
    expect(host.stop).toHaveBeenCalled();
  });

  it("stops host even if polling throws", async () => {
    const kernel = createFakeKernel();
    const persistence = {
      getRun: vi.fn(async () => {
        throw new Error("db down");
      }),
      getStagesByRun: vi.fn(async () => []),
    };
    const host = createFakeHost();

    await expect(
      runAndWait({
        kernel: kernel as any,
        persistence: persistence as any,
        host: host as any,
        command: {
          type: "run.create",
          idempotencyKey: "test-3",
          workflowId: "test-workflow",
          input: {},
        },
        pollIntervalMs: 10,
      }),
    ).rejects.toThrow("db down");

    expect(host.stop).toHaveBeenCalled();
  });

  it("does not stop a host that was already running", async () => {
    const kernel = createFakeKernel();
    const persistence = createFakePersistence();
    const host = createFakeHost(/* alreadyRunning */ true);

    await runAndWait({
      kernel: kernel as any,
      persistence: persistence as any,
      host: host as any,
      command: {
        type: "run.create",
        idempotencyKey: "test-4",
        workflowId: "test-workflow",
        input: {},
      },
      pollIntervalMs: 10,
    });

    expect(host.stop).not.toHaveBeenCalled();
  });

  it("throws when abort signal is already aborted", async () => {
    const kernel = createFakeKernel();
    const persistence = createFakePersistence({ ticksBeforeTerminal: 100 });
    const host = createFakeHost();
    const controller = new AbortController();
    controller.abort();

    await expect(
      runAndWait({
        kernel: kernel as any,
        persistence: persistence as any,
        host: host as any,
        command: {
          type: "run.create",
          idempotencyKey: "test-5",
          workflowId: "test-workflow",
          input: {},
        },
        pollIntervalMs: 10,
        signal: controller.signal,
      }),
    ).rejects.toThrow("runAndWait aborted");

    expect(host.stop).toHaveBeenCalled();
  });

  it("calls onStageChange when stage statuses change", async () => {
    const kernel = createFakeKernel();
    const persistence = createFakePersistence({ ticksBeforeTerminal: 2 });
    const host = createFakeHost();
    const stageChanges: any[] = [];

    await runAndWait({
      kernel: kernel as any,
      persistence: persistence as any,
      host: host as any,
      command: {
        type: "run.create",
        idempotencyKey: "test-6",
        workflowId: "test-workflow",
        input: {},
      },
      pollIntervalMs: 10,
      onStageChange: (stages) => stageChanges.push(stages),
    });

    expect(stageChanges).toHaveLength(1);
    expect(stageChanges[0]).toEqual(
      expect.arrayContaining([expect.objectContaining({ stageId: "s1" })]),
    );
  });
});
