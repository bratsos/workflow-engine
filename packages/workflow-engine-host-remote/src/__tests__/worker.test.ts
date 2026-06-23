import { defineStage } from "@bratsos/workflow-engine";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { Broker } from "../broker/broker.js";
import { InMemoryBrokerStore } from "../broker/store.js";
import { InMemoryObjectStore } from "../object-store.js";
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
});
