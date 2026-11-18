import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineStage, WorkflowBuilder } from "@bratsos/workflow-engine";
import { createKernel } from "@bratsos/workflow-engine/kernel";
import {
  FakeClock,
  InMemoryBlobStore,
} from "@bratsos/workflow-engine/kernel/testing";
import { InMemoryJobQueue } from "@bratsos/workflow-engine/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  createPrismaJobQueue,
  createPrismaWorkflowPersistence,
  fromPrisma8,
} from "../../../workflow-engine/src/persistence/prisma/index.js";
import { createNodeHost } from "../host.js";

const sqlite = process.env.SQLITE8_KERNEL_SQLITE === "1";
const databaseUrl = process.env.DATABASE_URL;
const major = process.env.PRISMA_MAJOR ?? "7";
const fixtures = createRequire(import.meta.url)(
  "../../../prisma-fixtures/index.cjs",
);

describe.skipIf(!sqlite && !databaseUrl)(
  `Node host outbox on ${sqlite ? "SQLite" : "Postgres"} Prisma ${major}`,
  () => {
    let directory: string | undefined;
    let client: any;
    beforeAll(async () => {
      if (sqlite) directory = await mkdtemp(join(tmpdir(), "node-outbox-"));
      if (major === "8") {
        const db = sqlite
          ? await fixtures.createSqliteDb(join(directory!, "host.db"))
          : fixtures.createPostgresDb(databaseUrl);
        client = Object.assign(fromPrisma8(db), {
          $disconnect: () => db.close(),
        });
      } else {
        client = sqlite
          ? fixtures.createSqliteClient(join(directory!, "host.db"))
          : fixtures.createPostgresClient(databaseUrl);
      }
      await client.outboxEvent.deleteMany();
      await client.workflowRun.deleteMany();
      await client.idempotencyKey.deleteMany();
    }, 120_000);
    afterAll(async () => {
      await client?.outboxEvent.deleteMany();
      await client?.workflowRun.deleteMany();
      await client?.idempotencyKey.deleteMany();
      await client?.$disconnect();
      if (directory) await rm(directory, { recursive: true, force: true });
    });

    const store = (prisma: typeof client) =>
      createPrismaWorkflowPersistence(prisma, {
        databaseType: sqlite ? "sqlite" : "postgresql",
      });

    const seed = (persistence: ReturnType<typeof store>, run: string, n = 1) =>
      persistence.appendOutboxEvents(
        Array.from({ length: n }, () => ({
          workflowRunId: run,
          eventType: "workflow:created",
          payload: { type: "workflow:created", workflowRunId: run },
          causationId: "host",
          occurredAt: new Date(),
        })),
      );

    it("keeps a caller's transactional tick free of outbox effects", async () => {
      const root = store(client);
      const accepted: string[] = [];
      const jobTransport = new InMemoryJobQueue("tx-host");
      const make = (persistence: ReturnType<typeof store>) =>
        createKernel({
          persistence,
          jobTransport,
          blobStore: new InMemoryBlobStore(),
          clock: new FakeClock(),
          registry: { getWorkflow: () => undefined },
          eventSink: {
            async emit(event) {
              if ("workflowRunId" in event) accepted.push(event.workflowRunId);
            },
          },
        });
      await seed(root, "committed-tx-host");
      await expect(
        client.$transaction(async (tx: typeof client) => {
          const scoped = store(tx);
          await seed(scoped, "rollback-tx-host");
          const kernel = make(scoped);
          let ticked!: (deferred?: true) => void;
          const finished = new Promise<true | undefined>((resolve) => {
            ticked = resolve;
          });
          const host = createNodeHost({
            kernel,
            jobTransport,
            workerId: "tx-host",
            orchestrationIntervalMs: 1_000,
            onTick(counts) {
              ticked(counts.outboxDeferred);
            },
          });
          await host.start();
          try {
            expect(await finished).toBe(true);
          } finally {
            await host.stop();
          }
          expect(accepted).toEqual([]);
          throw new Error("rollback host tick");
        }),
      ).rejects.toThrow("rollback host tick");
      expect(
        (await make(root).dispatch({ type: "outbox.flush" })).published,
      ).toBe(1);
      expect(accepted).toEqual(["committed-tx-host"]);
      await client.outboxEvent.deleteMany();
    });

    it("keeps a timed-out dequeue and tick with the start that created them", async () => {
      const latch = () => {
        let release!: () => void;
        const wait = new Promise<void>((resolve) => {
          release = resolve;
        });
        return { release, wait };
      };
      const persistence = store(client);
      await seed(persistence, "first-generation");
      const queue = createPrismaJobQueue(client, {
        databaseType: sqlite ? "sqlite" : "postgresql",
      });
      const oldDequeue = latch();
      const oldTick = latch();
      const release = latch();
      const notified = latch();
      const calls: number[] = [];
      let dequeues = 0;
      const dequeue = queue.dequeue.bind(queue);
      queue.dequeue = async (...args) => {
        if (++dequeues === 1) {
          oldDequeue.release();
          await release.wait;
        }
        return dequeue(...args);
      };
      const kernel = createKernel({
        persistence,
        jobTransport: queue,
        blobStore: new InMemoryBlobStore(),
        clock: new FakeClock(),
        registry: { getWorkflow: () => undefined },
        eventSink: { async emit() {} },
      });
      const dispatch = kernel.dispatch.bind(kernel);
      let first = true;
      kernel.dispatch = async (command) => {
        if (command.type === "run.reapStuck" && first) {
          first = false;
          oldTick.release();
          await release.wait;
        }
        return dispatch(command);
      };
      const host = createNodeHost({
        kernel,
        jobTransport: queue,
        workerId: "generations",
        orchestrationIntervalMs: 60_000,
        jobPollIntervalMs: 2,
        flushOutboxOnStop: false,
        shutdownTimeoutMs: 10,
        onTick(counts) {
          calls.push(counts.eventsFlushed);
          notified.release();
        },
      });
      try {
        await host.start();
        await Promise.all([oldDequeue.wait, oldTick.wait]);
        await host.stop();
        await host.start();
        await new Promise((resolve) => setTimeout(resolve, 25));
        expect(dequeues).toBe(1);
        release.release();
        await notified.wait;
        expect(calls).toEqual([0]);
        expect(host.getStats().orchestrationTicks).toBe(2);
      } finally {
        release.release();
        await host.stop();
        await client.outboxEvent.deleteMany();
      }
    });

    it.each([
      false,
      true,
    ])("stops an in-flight flush and cancels any pending restart (restart: %s)", async (restart) => {
      const persistence = store(client);
      await seed(persistence, "blocked-host", 3);
      const accepted: number[] = [];
      let claims = 0;
      const claim = persistence.claimOutboxDelivery.bind(persistence);
      persistence.claimOutboxDelivery = (...args) => {
        claims++;
        return claim(...args);
      };
      let entered!: () => void;
      let release!: () => void;
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const queue = createPrismaJobQueue(client, {
        databaseType: sqlite ? "sqlite" : "postgresql",
      });
      let checking!: () => void;
      let finishCheck!: () => void;
      const secondCheck = new Promise<void>((resolve) => {
        checking = resolve;
      });
      const checkGate = new Promise<void>((resolve) => {
        finishCheck = resolve;
      });
      let verifies = 0;
      const jobTransport = Object.assign(new InMemoryJobQueue("blocked-host"), {
        async verifyStorage() {
          await queue.verifyStorage();
          if (++verifies === 2) {
            checking();
            await checkGate;
          }
        },
      });
      const kernel = createKernel({
        persistence,
        jobTransport,
        blobStore: new InMemoryBlobStore(),
        clock: new FakeClock(),
        registry: { getWorkflow: () => undefined },
        eventSink: {
          async emit(_, delivery) {
            accepted.push(delivery!.sequence);
            entered();
            await gate;
          },
        },
      });
      const dispatch = kernel.dispatch.bind(kernel);
      let flushing: Promise<unknown> | undefined;
      const tracked = {
        ...kernel,
        dispatch: ((command: Parameters<typeof dispatch>[0]) => {
          const result = dispatch(command);
          if (command.type === "outbox.flush") flushing = result;
          return result;
        }) as typeof kernel.dispatch,
      };
      const host = createNodeHost({
        kernel: tracked,
        jobTransport,
        workerId: "blocked-host",
        orchestrationIntervalMs: 1_000,
        jobPollIntervalMs: 10,
        shutdownTimeoutMs: 100,
        outboxFlushTimeoutMs: 1_000,
        flushOutboxOnStop: false,
      });
      try {
        await host.start();
        await started;
        await host.stop();
        if (restart) {
          const starting = host.start();
          await secondCheck;
          await host.stop();
          finishCheck();
          await starting;
          expect(host.getStats().isRunning).toBe(false);
        }
      } finally {
        finishCheck();
        release();
        await host.stop();
      }
      expect(verifies).toBe(restart ? 2 : 1);
      expect(await flushing).toMatchObject({ published: 1 });
      expect(accepted).toEqual([1]);
      expect(claims).toBe(1);
      expect(
        (await persistence.getUnpublishedOutboxEvents()).map(
          (row) => row.sequence,
        ),
      ).toEqual([2, 3]);
      await client.outboxEvent.deleteMany();
    });

    it("continues a run with a blocked sink and lets another host recover its expired claim", async () => {
      const schema = z.object({ value: z.string() });
      const stage = defineStage({
        id: "stage",
        name: "stage",
        schemas: { input: schema, output: schema, config: z.object({}) },
        async execute(ctx) {
          return { output: ctx.input };
        },
      });
      const workflow = new WorkflowBuilder(
        "node-outbox",
        "node-outbox",
        "node-outbox",
        schema,
        schema,
      )
        .pipe(stage)
        .build();
      const clock = new FakeClock(new Date());
      const jobTransport = new InMemoryJobQueue("node-worker");
      const persistence = createPrismaWorkflowPersistence(client, {
        databaseType: sqlite ? "sqlite" : "postgresql",
      });
      const secondPersistence = createPrismaWorkflowPersistence(client, {
        databaseType: sqlite ? "sqlite" : "postgresql",
      });
      let entered!: () => void;
      let resume!: () => void;
      let firstCompleted!: () => void;
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        resume = resolve;
      });
      const completed = new Promise<void>((resolve) => {
        firstCompleted = resolve;
      });
      const complete = persistence.completeOutboxDelivery.bind(persistence);
      persistence.completeOutboxDelivery = async (...args) => {
        try {
          return await complete(...args);
        } finally {
          firstCompleted();
        }
      };
      const ids: string[] = [];
      const eventSink = {
        async emit(_event: unknown, delivery?: { eventId: string }) {
          ids.push(delivery!.eventId);
          if (ids.length === 1) {
            entered();
            await gate;
          }
        },
      };
      const makeKernel = (store: typeof persistence) =>
        createKernel({
          persistence: store,
          blobStore: new InMemoryBlobStore(),
          jobTransport,
          eventSink,
          clock,
          registry: { getWorkflow: () => workflow },
        });
      const kernel = makeKernel(persistence);
      const peer = makeKernel(secondPersistence);
      const config = {
        jobTransport,
        workerId: "node-worker",
        orchestrationIntervalMs: 20,
        jobPollIntervalMs: 10,
        postJobYieldMs: 0,
        outboxFlushTimeoutMs: 300,
        shutdownTimeoutMs: 200,
        maxOutboxFlushPerTick: 1,
        flushOutboxOnStop: false,
      };
      const host = createNodeHost({ ...config, kernel });
      const other = createNodeHost({ ...config, kernel: peer });
      const run = await kernel.dispatch({
        type: "run.create",
        workflowId: workflow.id,
        idempotencyKey: "node-outbox",
        input: { value: "x" },
      });
      const waitFor = async (check: () => Promise<boolean>, label: string) => {
        const deadline = Date.now() + 15_000;
        while (Date.now() < deadline) {
          if (await check()) return;
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        throw new Error(`timed out waiting for ${label}`);
      };
      try {
        await host.start();
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            started,
            new Promise<never>((_, reject) => {
              timer = setTimeout(
                () => reject(new Error("timed out waiting for sink")),
                15_000,
              );
            }),
          ]);
        } finally {
          if (timer) clearTimeout(timer);
        }
        await waitFor(
          async () =>
            (await persistence.getRun(run.workflowRunId))?.status ===
            "COMPLETED",
          "run progress",
        );
        await host.stop();
        clock.advance(60_301);
        await other.start();
        await waitFor(async () => ids.length >= 2, "claim recovery");
        expect(ids[0]).toBe(ids[1]);
        await other.stop();
      } finally {
        resume();
        if (ids.length > 0) await completed;
        await host.stop();
        await other.stop();
      }
    }, 30_000);
  },
);
