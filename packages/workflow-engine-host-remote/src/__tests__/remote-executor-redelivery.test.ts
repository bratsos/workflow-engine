/**
 * A blocking RemoteExecutor delivery that repeats an attempt must not run
 * the worker again once that attempt reported, even when the broker lost
 * the task; a retry the kernel granted (a higher attempt) must run it again.
 */
import { defineStage } from "@bratsos/workflow-engine";
import { FakeClock } from "@bratsos/workflow-engine/kernel/testing";
import { InMemoryWorkflowPersistence } from "@bratsos/workflow-engine/testing";
import { afterEach, expect, it } from "vitest";
import { z } from "zod";
import { Broker } from "../broker/broker.js";
import { InMemoryBrokerStore } from "../broker/store.js";
import { InMemoryObjectStore } from "../object-store.js";
import { createRemoteExecutor } from "../orchestrator/remote-executor.js";
import { createInProcessTransport } from "../transport.js";
import type { RemoteStage } from "../worker/run-activity.js";
import { createActivityWorker } from "../worker/worker.js";

const stops: Array<() => unknown> = [];
afterEach(async () => {
  for (const stop of stops.splice(0)) await stop();
});

function setup(fail: (call: number) => boolean) {
  let calls = 0;
  const stage = defineStage({
    id: "s",
    name: "S",
    schemas: { input: z.object({}), output: z.any(), config: z.object({}) },
    async execute() {
      if (fail(++calls)) throw new Error("declined");
      return { output: { call: calls } };
    },
  });
  const clock = new FakeClock(new Date());
  const objectStore = new InMemoryObjectStore(clock);
  const store = new InMemoryBrokerStore();
  const broker = new Broker({
    store,
    presigner: objectStore,
    clock,
    stageCodeVersion: "v1",
    staleLeaseMs: 60_000,
  });
  const { orchestrator, worker: workerTransport } = createInProcessTransport(
    broker,
    objectStore,
  );
  const worker = createActivityWorker({
    registry: new Map<string, RemoteStage>([["s", stage as RemoteStage]]),
    transport: workerTransport,
    workerId: "w",
    stageIds: ["s"],
    stageCodeVersion: "v1",
    idleDelayMs: 2,
  });
  worker.start();
  stops.push(() => worker.stop());
  const executor = createRemoteExecutor(orchestrator, { pollEveryMs: 2 });
  const deps = {
    persistence: new InMemoryWorkflowPersistence(),
    blobStore: objectStore,
    clock,
  };
  const run = (attempt: number) =>
    executor.run(
      {
        stageDef: stage,
        workflowId: "wf",
        workflowRunId: "run-1",
        workflowType: "wf",
        stageId: "s",
        stageName: "S",
        stageNumber: 1,
        stageRecordId: "record-1",
        attempt,
        rawInput: {},
        config: { s: {} },
        workflowContext: {},
      } as never,
      deps as never,
    );
  return { run, store, calls: () => calls };
}

it("answers a repeated attempt from its stored report after the broker lost the task", async () => {
  const { run, store, calls } = setup(() => false);
  const first = await run(1);
  expect((first.result as { output: unknown }).output).toEqual({ call: 1 });
  store.clear();

  const again = await run(1);
  expect((again.result as { output: unknown }).output).toEqual({ call: 1 });
  expect(calls()).toBe(1);
});

it("runs the worker again for a retry the kernel granted", async () => {
  const { run, calls } = setup((call) => call === 1);
  expect((await run(1)).error).toBe("declined");

  const retry = await run(2);
  expect(retry.error).toBeUndefined();
  expect((retry.result as { output: unknown }).output).toEqual({ call: 2 });
  expect(calls()).toBe(2);
});
