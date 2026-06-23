import { describe, expect, it } from "vitest";
import { Broker } from "../broker/broker.js";
import { InMemoryBrokerStore } from "../broker/store.js";
import { InMemoryObjectStore } from "../object-store.js";
import { createInProcessTransport } from "../transport.js";

describe("in-process transport", () => {
  it("routes submit/lease/report/poll and putBytes/getBytes through one broker + store", async () => {
    const clock = { now: () => new Date(0) };
    const os = new InMemoryObjectStore(clock);
    const broker = new Broker({
      store: new InMemoryBrokerStore(),
      presigner: os,
      clock,
      stageCodeVersion: "v1",
    });
    const { orchestrator, worker } = createInProcessTransport(broker, os);

    const { taskId } = await orchestrator.submit({
      workflowRunId: "r1",
      stageId: "download",
      stageName: "D",
      stageNumber: 1,
      input: {},
      config: {},
      workflowContext: {},
      pollInterval: 100,
      maxWaitTime: 10_000,
    });
    const task = await worker.lease({
      workerId: "w1",
      stageIds: ["download"],
      stageCodeVersion: "v1",
    });
    expect(task?.taskId).toBe(taskId);

    const url = (
      await worker.presign({
        taskId,
        leaseToken: task!.leaseToken,
        relKey: `${task!.grant.prefix}a.bin`,
        op: "put",
      })
    ).url;
    await worker.putBytes(url, { n: 1 });
    const getUrl = (
      await worker.presign({
        taskId,
        leaseToken: task!.leaseToken,
        relKey: `${task!.grant.prefix}a.bin`,
        op: "get",
      })
    ).url;
    expect(await worker.getBytes(getUrl)).toEqual({ n: 1 });

    await worker.report({
      taskId,
      leaseToken: task!.leaseToken,
      outcome: { kind: "completed", output: { ok: 1 } },
      logs: [],
      annotations: [],
      progress: [],
    });
    expect((await orchestrator.poll(taskId)).state).toBe("reported");
  });
});
