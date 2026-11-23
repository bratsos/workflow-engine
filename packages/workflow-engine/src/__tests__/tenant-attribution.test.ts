import { runInNewContext } from "node:vm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { defineStage } from "../core/stage-factory.js";
import { defineWorkflow } from "../core/workflow.js";
import { executeJobWithHeartbeat } from "../kernel/helpers/host-support.js";
import {
  type KernelDatabase,
  kernelDatabase,
  realDatabase,
} from "./sqlite8-kernel-utils.js";

const schema = z.object({});
const workflow = defineWorkflow({
  id: "tenant-attribution",
  name: "Tenant attribution",
  description: "Waits for a signal",
  input: schema,
})
  .pipe(
    defineStage({
      id: "wait",
      name: "Wait",
      schemas: { input: schema, output: schema, config: schema },
      async execute(ctx) {
        await ctx.step.waitForSignal("approval", { timeout: "10m" });
        return { output: {} };
      },
    }),
  )
  .build();

describe.skipIf(!realDatabase)("tenant and run attribution", () => {
  let db: KernelDatabase;
  let kernel: KernelDatabase["kernel"];

  beforeAll(async () => {
    db = await kernelDatabase();
    kernel = db.makeKernel({ registry: { getWorkflow: () => workflow } });
  }, 120_000);
  beforeEach(() => db.reset());
  afterAll(() => db?.close());

  const createRun = (labels: unknown = { queue: "batch", priority: "low" }) =>
    kernel.dispatch({
      type: "run.create",
      workflowId: workflow.id,
      idempotencyKey: "tenant-test",
      input: {},
      tenantId: "tenant-a",
      labels: labels as Record<string, string>,
    });

  async function enterSignalWait() {
    const { workflowRunId } = await createRun();
    await kernel.dispatch({
      type: "run.claimPending",
      workerId: "kernel-worker",
    });
    const job = await db.jobTransport.dequeue();
    if (!job) throw new Error("Expected the run's first job");
    await executeJobWithHeartbeat(kernel, {
      jobTransport: db.jobTransport,
      job,
    });
    return { workflowRunId, job };
  }

  it("stores tenantId and labels on the run created by the kernel", async () => {
    const { workflowRunId } = await createRun();
    const row = await db.client.workflowRun.findUnique({
      where: { id: workflowRunId },
    });
    expect(row).toMatchObject({
      tenantId: "tenant-a",
      labels: { queue: "batch", priority: "low" },
    });
  });

  it("attributes the run.create key to the new run", async () => {
    const { workflowRunId } = await createRun();
    const key = await db.client.idempotencyKey.findFirst({
      where: { key: "tenant-test", commandType: "run.create" },
    });
    expect(key?.workflowRunId).toBe(workflowRunId);
  });

  it("rejects labels outside the portable flat string-map contract before creating a run", async () => {
    const invalid = [
      null,
      ["value"],
      "value",
      1,
      true,
      new Date(0),
      { queue: null },
      { queue: 1 },
      { queue: {} },
      { queue: [] },
      { queue: ["value"] },
      { queue: undefined },
      {
        get queue() {
          return "value";
        },
      },
      { [Symbol("queue")]: "value" },
      JSON.parse('{"__proto__":"value"}'),
      { ["\0"]: "value" },
      { ["\uD800"]: "value" },
      { queue: "\0" },
      { queue: "\uD800" },
    ];
    for (const labels of invalid) {
      await expect(createRun(labels)).rejects.toThrow(/labels.*string values/i);
    }
    expect(await db.client.workflowRun.count()).toBe(0);
    expect(await db.client.idempotencyKey.count()).toBe(0);

    const labels = Object.assign(Object.create(null), {
      $type: "ordinary",
      constructor: "ordinary",
      set: "value",
      toJSON: "also ordinary",
      "queue-🔔": "ready-🔔",
    });
    const { workflowRunId } = await createRun(labels);
    expect(
      await db.client.workflowRun.findUnique({
        where: { id: workflowRunId },
      }),
    ).toMatchObject({ labels });
    // Replaying a completed key observes the original run.
    expect(await createRun({ queue: [] })).toMatchObject({ workflowRunId });
  });

  it("accepts a plain label map created in another realm", async () => {
    const { workflowRunId } = await createRun(
      runInNewContext('({ queue: "normal" })'),
    );
    expect(
      await db.client.workflowRun.findUnique({
        where: { id: workflowRunId },
      }),
    ).toMatchObject({ labels: { queue: "normal" } });
  });

  it("attributes the worker's job.execute attempt key to its run", async () => {
    const { workflowRunId, job } = await enterSignalWait();
    const key = await db.client.idempotencyKey.findFirst({
      where: {
        key: `job:${job.jobId}:attempt:${job.attempt}`,
        commandType: "job.execute",
      },
    });
    expect(key?.workflowRunId).toBe(workflowRunId);
  });

  it("attributes the signal wake key to the suspended run", async () => {
    const { workflowRunId } = await enterSignalWait();
    await kernel.dispatch({
      type: "step.signal",
      workflowRunId,
      stageId: "wait",
      stepId: "approval",
      payload: {},
    });
    const key = await db.client.idempotencyKey.findFirst({
      where: { commandType: "step.signal.wake" },
    });
    expect(key?.workflowRunId).toBe(workflowRunId);
  });
});
