import { defineStage } from "@bratsos/workflow-engine";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { Broker } from "../broker/broker.js";
import { InMemoryBrokerStore } from "../broker/store.js";
import { InMemoryObjectStore } from "../object-store.js";
import { createInProcessTransport } from "../transport.js";
import { runActivity } from "../worker/run-activity.js";

const echo = defineStage({
  id: "echo",
  name: "Echo",
  schemas: { input: z.object({ msg: z.string() }), output: z.object({ echoed: z.string() }), config: z.object({}) },
  async execute(ctx) {
    ctx.log("INFO", "running");
    ctx.annotate("test.key", "v");
    return { output: { echoed: ctx.input.msg.toUpperCase() } };
  },
});

const boom = defineStage({
  id: "boom", name: "Boom",
  schemas: { input: z.object({}), output: z.object({}), config: z.object({}) },
  async execute() { throw new Error("kaboom"); },
});

async function leaseFor(stageId: string) {
  const clock = { now: () => new Date(0) };
  const os = new InMemoryObjectStore(clock);
  const broker = new Broker({ store: new InMemoryBrokerStore(), presigner: os, clock, stageCodeVersion: "v1" });
  const { orchestrator, worker } = createInProcessTransport(broker, os);
  await orchestrator.submit({ workflowRunId: "r1", stageId, stageName: stageId, stageNumber: 1, input: stageId === "echo" ? { msg: "hi" } : {}, config: {}, workflowContext: {}, pollInterval: 100, maxWaitTime: 10_000 });
  const task = await worker.lease({ workerId: "w1", stageIds: [stageId], stageCodeVersion: "v1" });
  return { task: task!, worker };
}

describe("runActivity", () => {
  it("runs a sync stage and captures output + buffered logs/annotations", async () => {
    const { task, worker } = await leaseFor("echo");
    const report = await runActivity(task, echo, worker);
    expect(report.outcome).toEqual({ kind: "completed", output: { echoed: "HI" }, customMetrics: undefined });
    expect(report.logs).toEqual([{ level: "INFO", message: "running", meta: undefined }]);
    expect(report.annotations).toEqual([["test.key", "v"]]);
  });

  it("maps a thrown stage to a failed outcome", async () => {
    const { task, worker } = await leaseFor("boom");
    const report = await runActivity(task, boom, worker);
    expect(report.outcome.kind).toBe("failed");
    expect((report.outcome as { error: string }).error).toMatch(/kaboom/);
  });
});
