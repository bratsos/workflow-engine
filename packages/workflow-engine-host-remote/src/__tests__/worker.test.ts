import { defineStage } from "@bratsos/workflow-engine";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { Broker } from "../broker/broker.js";
import { InMemoryBrokerStore } from "../broker/store.js";
import { InMemoryObjectStore } from "../object-store.js";
import type { WorkerTransport } from "../transport.js";
import { createInProcessTransport } from "../transport.js";
import { createActivityWorker } from "../worker/worker.js";

const echo = defineStage({
  id: "echo",
  name: "Echo",
  schemas: {
    input: z.object({ msg: z.string() }),
    output: z.object({ echoed: z.string() }),
    config: z.object({}),
  },
  async execute(ctx) {
    return { output: { echoed: ctx.input.msg } };
  },
});

describe("createActivityWorker", () => {
  it("processOne leases, runs, and reports a task; returns false when idle", async () => {
    const clock = { now: () => new Date(0) };
    const os = new InMemoryObjectStore(clock);
    const broker = new Broker({
      store: new InMemoryBrokerStore(),
      presigner: os,
      clock,
      stageCodeVersion: "v1",
    });
    const { orchestrator, worker: transport } = createInProcessTransport(
      broker,
      os,
    );
    const { taskId } = await orchestrator.submit({
      workflowRunId: "r1",
      stageId: "echo",
      stageName: "Echo",
      stageNumber: 1,
      input: { msg: "hi" },
      config: {},
      workflowContext: {},
      pollInterval: 100,
      maxWaitTime: 10_000,
    });

    const worker = createActivityWorker({
      registry: new Map([["echo", echo]]),
      transport,
      workerId: "w1",
      stageIds: ["echo"],
      stageCodeVersion: "v1",
    });

    expect(await worker.processOne()).toBe(true);
    expect(await worker.processOne()).toBe(false); // nothing left

    const poll = await orchestrator.poll(taskId);
    expect(poll.state).toBe("reported");
    expect((poll.outcome as { output: { echoed: string } }).output.echoed).toBe(
      "hi",
    );
  });

  it("aborts on a broker cancel signal: skips presign + report and does not throw", async () => {
    const clock = { now: () => new Date(0) };
    const os = new InMemoryObjectStore(clock);
    const broker = new Broker({
      store: new InMemoryBrokerStore(),
      presigner: os,
      clock,
      stageCodeVersion: "v1",
    });
    const { orchestrator, worker: baseTransport } = createInProcessTransport(
      broker,
      os,
    );
    await orchestrator.submit({
      workflowRunId: "r1",
      stageId: "slow",
      stageName: "Slow",
      stageNumber: 1,
      input: { msg: "hi" },
      config: {},
      workflowContext: {},
      pollInterval: 100,
      maxWaitTime: 10_000,
    });

    // A slow stage that gives the heartbeat loop time to fire mid-execution.
    const slow = defineStage({
      id: "slow",
      name: "Slow",
      schemas: {
        input: z.object({ msg: z.string() }),
        output: z.object({ echoed: z.string() }),
        config: z.object({}),
      },
      async execute(ctx) {
        await new Promise((r) => setTimeout(r, 40));
        return { output: { echoed: ctx.input.msg } };
      },
    });

    const reportSpy = vi.fn(baseTransport.report);
    const presignSpy = vi.fn(baseTransport.presign);
    // Simulate the broker reaping the lease mid-activity: every heartbeat
    // after the first comes back with cancel:true (fenced/expired task).
    let heartbeatCount = 0;
    const transport: WorkerTransport = {
      ...baseTransport,
      heartbeat: async (req) => {
        heartbeatCount++;
        if (heartbeatCount >= 1) {
          return { ok: false, cancel: true };
        }
        return baseTransport.heartbeat(req);
      },
      report: reportSpy,
      presign: presignSpy,
    };

    const worker = createActivityWorker({
      registry: new Map([["slow", slow]]),
      transport,
      workerId: "w1",
      stageIds: ["slow"],
      stageCodeVersion: "v1",
      heartbeatMs: 5,
    });

    await expect(worker.processOne()).resolves.toBe(true);

    expect(heartbeatCount).toBeGreaterThan(0);
    expect(presignSpy).not.toHaveBeenCalled();
    expect(reportSpy).not.toHaveBeenCalled();
  });

  it("surfaces processOne errors via onError and backs off instead of spinning silently", async () => {
    const clock = { now: () => new Date(0) };
    const os = new InMemoryObjectStore(clock);
    const broker = new Broker({
      store: new InMemoryBrokerStore(),
      presigner: os,
      clock,
      stageCodeVersion: "v1",
    });
    const { worker: baseTransport } = createInProcessTransport(broker, os);

    // Simulate a permanent failure (e.g. a version-mismatch 409 on lease).
    const transport: WorkerTransport = {
      ...baseTransport,
      lease: async () => {
        throw new Error("stage code version mismatch: worker=v1 broker=v2");
      },
    };

    const onError = vi.fn();
    const worker = createActivityWorker({
      registry: new Map([["echo", echo]]),
      transport,
      workerId: "w1",
      stageIds: ["echo"],
      stageCodeVersion: "v1",
      idleDelayMs: 5,
      maxBackoffMs: 40,
      onError,
    });

    worker.start();
    await vi.waitFor(() => {
      expect(onError.mock.calls.length).toBeGreaterThanOrEqual(3);
    });
    worker.stop();

    for (const [error, info] of onError.mock.calls) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toMatch(/version mismatch/);
      expect(info.consecutiveFailures).toBeGreaterThan(0);
    }
    const failures = onError.mock.calls.map(
      ([, info]) => info.consecutiveFailures,
    );
    expect(failures).toEqual([...failures].sort((a, b) => a - b));
  });
});
