import { createRequire } from "node:module";
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
  fromPrisma8,
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

    it("recovers a crashed claim on its stage lease and heartbeats the new claim", async () => {
      const gate = Promise.withResolvers<void>();
      const workflow = defineWorkflow("lease", {
        input: schemas.input,
        leaseTimeoutMs: 60_000,
      })
        .stage("work", {
          schemas,
          leaseTimeoutMs: 900,
          async execute() {
            await gate.promise;
            return { output: {} };
          },
        })
        .build();
      const { host, kernel, jobTransport } = makeHost([workflow], db.client, {
        jobHeartbeatIntervalMs: 60_000,
      });
      const id = await createRun(kernel, workflow.id);
      await kernel.dispatch({ type: "run.claimPending", workerId: "crashed" });
      const crashed = await jobTransport.dequeue();
      expect(crashed).toMatchObject({ workflowRunId: id, leaseMs: 900 });
      const original = await jobOf(id);
      expect(
        original.leaseExpiresAt.getTime() - original.lockedAt.getTime(),
      ).toBe(900);
      try {
        await host.start();
        await expect
          .poll(() => jobOf(id), poll)
          .toMatchObject({ attempt: 2, status: "RUNNING" });
        const newClaim = await jobOf(id);
        await expect
          .poll(async () => (await jobOf(id)).leaseExpiresAt.getTime(), poll)
          .toBeGreaterThan(newClaim.leaseExpiresAt.getTime());
        const renewed = await jobOf(id);
        expect(
          renewed.leaseExpiresAt.getTime() - renewed.lockedAt.getTime(),
        ).toBe(900);
      } finally {
        gate.resolve();
      }
      await expect
        .poll(async () => (await db.persistence.getRun(id))?.status, poll)
        .toBe("COMPLETED");
    });

    it("keeps old runs with queued or leased jobs and restores policy on a missing job", async () => {
      const gate = Promise.withResolvers<void>();
      const workflow = defineWorkflow("stuck", {
        input: schemas.input,
        leaseTimeoutMs: 120_000,
        absoluteTimeoutMs: 90_000,
        jobRetry: { maxAttempts: 7, backoff: { initialDelayMs: 42 } },
      })
        .stage("work", {
          schemas,
          async execute() {
            await gate.promise;
            return { output: {} };
          },
        })
        .build();
      const { host, kernel } = makeHost([workflow]);
      const active = await createRun(kernel, workflow.id);
      const waiting = await createRun(kernel, workflow.id);
      const missing = await createRun(kernel, workflow.id);
      await kernel.dispatch({
        type: "run.claimPending",
        workerId: "runtime-1",
        maxClaims: 3,
      });
      await db.client.jobQueue.deleteMany({
        where: { workflowRunId: missing },
      });
      const reap = () =>
        kernel.dispatch({ type: "run.reapStuck", stuckThresholdMs: 1000 });
      const age = async (ids: string[]) => {
        const data = { updatedAt: new Date(0) };
        await db.client.workflowRun.updateMany({
          where: { id: { in: ids } },
          data,
        });
        await db.client.workflowStage.updateMany({
          where: { workflowRunId: { in: ids } },
          data,
        });
      };
      try {
        await age([active, waiting, missing]);
        expect(await reap()).toMatchObject({ failed: 0 });
        expect(await jobOf(missing)).toMatchObject({
          maxAttempts: 7,
          retryPolicy: { initialDelayMs: 42 },
          leaseTimeoutMs: 120_000,
          absoluteTimeoutMs: 90_000,
        });
        await host.start();
        await expect
          .poll(
            async () =>
              db.client.jobQueue.count({ where: { status: "RUNNING" } }),
            poll,
          )
          .toBe(1);
        await age([active, waiting, missing]);
        expect(await reap()).toMatchObject({ failed: 0 });
        expect(
          await db.client.workflowRun.count({ where: { status: "RUNNING" } }),
        ).toBe(3);
      } finally {
        gate.resolve();
      }
    });

    it("expires explicit deadlines when the host default cap is zero", async () => {
      const gate = Promise.withResolvers<void>();
      const workflow = (id: string, absoluteTimeoutMs?: number) =>
        defineWorkflow(id, { input: schemas.input, absoluteTimeoutMs })
          .stage("work", {
            schemas,
            async execute() {
              await gate.promise;
              return { output: {} };
            },
          })
          .build();
      const { host, kernel } = makeHost(
        [workflow("explicit-cap", 900), workflow("no-cap")],
        db.client,
        { jobAbsoluteTimeoutMs: 0, jobHeartbeatIntervalMs: 50, concurrency: 2 },
      );
      const id = await createRun(kernel, "explicit-cap");
      const ordinary = await createRun(kernel, "no-cap");
      try {
        await host.start();
        await expect
          .poll(() => jobOf(ordinary), poll)
          .toMatchObject({ status: "RUNNING", absoluteExpiresAt: null });
        await expect
          .poll(() => jobOf(id), poll)
          .toMatchObject({ status: "FAILED", attempt: 1 });
        const job = await jobOf(id);
        expect(job.lastError).toMatch(/^LEASE_ABSOLUTE_CAP/);
        expect(job.absoluteExpiresAt.getTime() - job.startedAt.getTime()).toBe(
          900,
        );
        expect(job.lockedAt.getTime()).toBeGreaterThan(job.startedAt.getTime());
        expect(await jobOf(ordinary)).toMatchObject({
          status: "RUNNING",
          attempt: 1,
          absoluteExpiresAt: null,
        });
      } finally {
        gate.resolve();
      }
    });

    it("keeps a workflow at its cap across two workers with two slots each", async () => {
      const gate = Promise.withResolvers<void>();
      let executing = 0;
      let peak = 0;
      const makeWorkflow = (id: string, maxConcurrent?: number) =>
        defineWorkflow(id, {
          input: schemas.input,
          maxConcurrent,
          leaseTimeoutMs: 120_000,
          absoluteTimeoutMs: 240_000,
        })
          .stage("work", {
            schemas,
            async execute() {
              if (maxConcurrent !== undefined) {
                executing++;
                peak = Math.max(peak, executing);
                await gate.promise;
                executing--;
              } else {
                await gate.promise;
              }
              return { output: {} };
            },
          })
          .build();
      const capped = makeWorkflow("capped", 1);
      const free = makeWorkflow("free");
      const workflows = [capped, free];
      const first = makeHost(workflows, db.client, { concurrency: 2 });
      const fixtures = createRequire(import.meta.url)(
        "../../../prisma-fixtures/index.cjs",
      );
      const secondClient =
        process.env.PRISMA_MAJOR === "8"
          ? (() => {
              const native = sqlite
                ? fixtures.openSqliteDb(db.file)
                : fixtures.createPostgresDb(process.env.DATABASE_URL);
              return Object.assign(fromPrisma8(native), {
                $disconnect: () => native.close(),
              });
            })()
          : sqlite
            ? fixtures.openSqliteClient(db.file)
            : fixtures.createPostgresClient(process.env.DATABASE_URL);
      const competitor = createPrismaJobQueue(secondClient, {
        databaseType: sqlite ? "sqlite" : "postgresql",
        workerId: "runtime-2",
      });
      // Share one root for the SQLite kernel's writes in this process.
      // The claim race below uses two separate database connections.
      const second = makeHost(workflows, sqlite ? db.client : secondClient, {
        workerId: "runtime-2",
        concurrency: 2,
      });
      try {
        const ids: string[] = [];
        for (let i = 0; i < 3; i++)
          ids.push(await createRun(first.kernel, capped.id, 10));
        for (let i = 0; i < 2; i++) await createRun(first.kernel, free.id, 1);
        await first.kernel.dispatch({
          type: "run.claimPending",
          workerId: "runtime-1",
          maxClaims: 5,
        });
        // Legacy rows participate in both candidate filtering and the RUNNING count.
        await db.client.jobQueue.updateMany({
          where: { workflowId: capped.id },
          data: { workflowId: null },
        });
        const options = {
          serves: first.kernel.servedDefinitions(),
          workflowLimits: first.kernel.workflowJobLimits?.(),
        };
        const claimsByWorker = await Promise.all([
          first.jobTransport.dequeue(options),
          competitor.dequeue(options),
        ]);
        expect(
          claimsByWorker.filter(
            (job) => job && ids.includes(job.workflowRunId),
          ),
        ).toHaveLength(1);
        for (const [index, job] of claimsByWorker.entries()) {
          expect(job).toMatchObject({ leaseMs: 120_000, attempt: 1 });
          const row = await jobOf(job!.workflowRunId);
          expect(row.leaseExpiresAt.getTime() - row.lockedAt.getTime()).toBe(
            120_000,
          );
          expect(
            row.absoluteExpiresAt.getTime() - row.startedAt.getTime(),
          ).toBe(240_000);
          const queue = index === 0 ? first.jobTransport : competitor;
          await queue.defer(
            job!.jobId,
            new Date(0),
            "return claim before starting the hosts",
            {
              attempt: job!.attempt,
              startedAt: job!.startedAt,
            },
          );
        }
        await Promise.all([first.host.start(), second.host.start()]);
        const claims = () =>
          db.client.jobQueue.findMany({ where: { status: "RUNNING" } });
        await expect.poll(async () => (await claims()).length, poll).toBe(3);
        const running = await claims();
        expect(
          running.filter((job: { workflowRunId: string }) =>
            ids.includes(job.workflowRunId),
          ),
        ).toHaveLength(1);
        expect(
          new Set(running.map((job: { workerId: string }) => job.workerId)),
        ).toEqual(new Set(["runtime-1", "runtime-2"]));
        gate.resolve();
        await expect
          .poll(
            () =>
              db.client.workflowRun.count({ where: { status: "COMPLETED" } }),
            poll,
          )
          .toBe(5);
        expect(peak).toBe(1);
      } finally {
        gate.resolve();
        await Promise.all([first.host.stop(), second.host.stop()]);
        await secondClient.$disconnect();
      }
    });
  },
);
