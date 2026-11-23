import { defineWorkflow, type Workflow } from "@bratsos/workflow-engine";
import {
  createWorkflowRegistry,
  type Kernel,
} from "@bratsos/workflow-engine/kernel";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import { z } from "zod";
import {
  type KernelDatabase,
  kernelDatabase,
  realDatabase,
  sqlite,
} from "../../../workflow-engine/src/__tests__/sqlite8-kernel-utils.js";
import {
  createPrismaJobQueue,
  createPrismaWorkflowPersistence,
} from "../../../workflow-engine/src/persistence/prisma/index.js";
import { createNodeHost, type NodeHost, type NodeHostConfig } from "../host.js";

const schemas = {
  input: z.object({}),
  output: z.object({}),
  config: z.object({}),
};

describe.skipIf(!realDatabase)(
  "workflow runtime controls on the Prisma queue",
  () => {
    let db: KernelDatabase;
    let hosts: NodeHost[];
    beforeAll(async () => {
      db = await kernelDatabase();
    }, 120_000);
    beforeEach(async () => {
      hosts = [];
      await db.reset();
    });
    afterEach(async () => {
      await Promise.all(hosts.map((host) => host.stop()));
    });
    afterAll(async () => {
      if (!db) return;
      try {
        await db.reset();
      } finally {
        await db.close();
      }
    });

    function makeHost(
      workflows: Workflow<any, any>[],
      client = db.client,
      config: Partial<NodeHostConfig> = {},
    ) {
      const databaseType = sqlite ? "sqlite" : "postgresql";
      const jobTransport = createPrismaJobQueue(client, { databaseType });
      const kernel = db.makeKernel({
        jobTransport,
        persistence: createPrismaWorkflowPersistence(client, { databaseType }),
        registry: createWorkflowRegistry(workflows),
      });
      const host = createNodeHost({
        workerId: "runtime-1",
        jobTransport,
        kernel,
        orchestrationIntervalMs: 50,
        jobPollIntervalMs: 10,
        postJobYieldMs: 0,
        ...config,
      });
      hosts.push(host);
      return { host, kernel, jobTransport };
    }

    async function createRun(
      kernel: Kernel,
      workflowId: string,
      priority?: number,
    ) {
      const result = await kernel.dispatch({
        type: "run.create",
        idempotencyKey: crypto.randomUUID(),
        workflowId,
        input: {},
        priority,
      });
      return result.workflowRunId;
    }

    const jobOf = (id: string) =>
      db.client.jobQueue.findFirst({ where: { workflowRunId: id } });
    const poll = { timeout: 10_000, interval: 20 };

    it("applies the workflow job retry budget and delay to a failed delivery", async () => {
      let attempts = 0;
      const workflow = defineWorkflow("delivery", {
        input: schemas.input,
        jobRetry: { maxAttempts: 2, backoff: { initialDelayMs: 30_000 } },
      })
        .stage("work", {
          schemas,
          async execute() {
            attempts++;
            throw new Error("temporary failure");
          },
        })
        .build();
      const { host, kernel } = makeHost([workflow]);
      const id = await createRun(kernel, workflow.id);
      await host.start();
      await expect
        .poll(() => jobOf(id), poll)
        .toMatchObject({ status: "PENDING", attempt: 1, maxAttempts: 2 });
      const job = await jobOf(id);
      expect(
        job.nextPollAt.getTime() - job.updatedAt.getTime(),
      ).toBeGreaterThan(29_000);
      await db.client.jobQueue.update({
        where: { id: job.id },
        data: { nextPollAt: new Date(0) },
      });
      await expect
        .poll(async () => (await db.persistence.getRun(id))?.status, poll)
        .toBe("FAILED");
      expect(attempts).toBe(2);
    });

    it("uses the stage retry override for failed suspended polls", async () => {
      let polls = 0;
      const workflow = defineWorkflow("poll", {
        input: schemas.input,
        jobRetry: { maxAttempts: 1, backoff: { initialDelayMs: 0 } },
      })
        .stage("work", {
          schemas,
          jobRetry: {
            maxAttempts: 2,
            backoff: { initialDelayMs: 30_000, factor: 1 },
          },
          async execute(ctx) {
            await ctx.step.waitForSignal("gate", { timeout: "2m" });
            polls++;
            throw new Error("poll failed");
          },
        })
        .build();
      const { host, kernel } = makeHost([workflow]);
      const id = await createRun(kernel, workflow.id);
      await host.start();
      await expect
        .poll(() => jobOf(id), poll)
        .toMatchObject({ status: "SUSPENDED", attempt: 1, maxAttempts: 2 });
      await kernel.dispatch({
        type: "step.signal",
        workflowRunId: id,
        stageId: "work",
        stepId: "gate",
        payload: null,
      });
      await expect
        .poll(() => db.persistence.getStage(id, "work"), poll)
        .toMatchObject({ status: "SUSPENDED", errorMessage: "poll failed" });
      const stage = (await db.persistence.getStage(id, "work"))!;
      expect(
        stage.nextPollAt!.getTime() - stage.updatedAt.getTime(),
      ).toBeGreaterThan(29_000);
      await db.persistence.updateStage(stage.id, { nextPollAt: new Date(0) });
      await expect
        .poll(async () => (await db.persistence.getRun(id))?.status, poll)
        .toBe("FAILED");
      expect(polls).toBe(2);
    });
  },
);
