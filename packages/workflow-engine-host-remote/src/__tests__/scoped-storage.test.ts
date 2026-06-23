import { describe, expect, it } from "vitest";
import { Broker } from "../broker/broker.js";
import { InMemoryBrokerStore } from "../broker/store.js";
import { InMemoryObjectStore } from "../object-store.js";
import { createInProcessTransport } from "../transport.js";
import { createScopedStorage } from "../worker/scoped-storage.js";

describe("scoped storage", () => {
  it("saves under the grant prefix and the orchestrator can read it back via BlobStore", async () => {
    const clock = { now: () => new Date(0) };
    const os = new InMemoryObjectStore(clock);
    const broker = new Broker({
      store: new InMemoryBrokerStore(),
      presigner: os,
      clock,
      stageCodeVersion: "v1",
    });
    const { orchestrator, worker } = createInProcessTransport(broker, os);
    await orchestrator.submit({
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

    const storage = createScopedStorage(
      task!.grant,
      worker,
      task!.taskId,
      task!.leaseToken,
    );
    const key = storage.getStageKey("download", "audio.bin");
    await storage.save(key, { bytes: 7 });

    expect(key.startsWith(task!.grant.prefix)).toBe(true);
    expect(await os.get(key)).toEqual({ bytes: 7 }); // orchestrator-side read
    expect(await storage.load(key)).toEqual({ bytes: 7 }); // worker-side read
  });
});
