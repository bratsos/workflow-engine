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
import { createServerlessHost } from "../host.js";

const sqlite = process.env.SQLITE8_KERNEL_SQLITE === "1";
const databaseUrl = process.env.DATABASE_URL;
const major = process.env.PRISMA_MAJOR ?? "7";
const fixtures = createRequire(import.meta.url)(
  "../../../prisma-fixtures/index.cjs",
);

describe.skipIf(!sqlite && !databaseUrl)(
  `serverless outbox on ${sqlite ? "SQLite" : "Postgres"} Prisma ${major}`,
  () => {
    let directory: string | undefined;
    let client: any;
    beforeAll(async () => {
      if (sqlite) directory = await mkdtemp(join(tmpdir(), "host-outbox-"));
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
          const host = createServerlessHost({
            kernel,
            jobTransport,
            workerId: "tx-host",
          });
          expect(await host.runMaintenanceTick()).toMatchObject({
            outboxDeferred: true,
            eventsFlushed: 0,
          });
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

    it("starts no more claims or emits after the maintenance timeout", async () => {
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
      let verifies = 0;
      const jobTransport = Object.assign(new InMemoryJobQueue("blocked-host"), {
        async verifyStorage() {
          await queue.verifyStorage();
          verifies++;
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
      const host = createServerlessHost({
        kernel: tracked,
        jobTransport,
        workerId: "blocked-host",
        outboxFlushTimeoutMs: 100,
      });
      const tick = host.runMaintenanceTick();
      try {
        await started;
        expect(await tick).toMatchObject({ eventSinkStatus: "degraded" });
      } finally {
        release();
      }
      expect(await flushing).toMatchObject({ published: 1 });
      expect(accepted).toEqual([1]);
      expect(claims).toBe(1);
      expect(
        (await persistence.getUnpublishedOutboxEvents()).map(
          (row) => row.sequence,
        ),
      ).toEqual([2, 3]);
      await client.outboxEvent.deleteMany();
      await host.runMaintenanceTick();
      expect(verifies).toBe(2);
    });

    it("fences a timed-out post-job flush and lets a second host recover the event", async () => {
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
        "host-outbox",
        "host-outbox",
        "host-outbox",
        schema,
        schema,
      )
        .pipe(stage)
        .build();
      const clock = new FakeClock(new Date());
      const jobTransport = new InMemoryJobQueue("host-worker");
      const persistence = createPrismaWorkflowPersistence(client, {
        databaseType: sqlite ? "sqlite" : "postgresql",
      });
      const secondPersistence = createPrismaWorkflowPersistence(client, {
        databaseType: sqlite ? "sqlite" : "postgresql",
      });
      let entered!: () => void;
      let resume!: () => void;
      let completed!: () => void;
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        resume = resolve;
      });
      const firstCompleted = new Promise<void>((resolve) => {
        completed = resolve;
      });
      // The flush acknowledges a page through the batch write.
      const originalComplete =
        persistence.completeOutboxDeliveries!.bind(persistence);
      persistence.completeOutboxDeliveries = async (...args) => {
        const result = await originalComplete(...args);
        completed();
        return result;
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
      const host = createServerlessHost({
        kernel,
        jobTransport,
        workerId: "host-worker",
        outboxFlushTimeoutMs: 300,
      });
      const other = createServerlessHost({
        kernel: peer,
        jobTransport,
        workerId: "other-worker",
        maxOutboxFlushPerTick: 1,
      });
      await kernel.dispatch({
        type: "run.create",
        workflowId: workflow.id,
        idempotencyKey: "host-timeout",
        input: { value: "x" },
      });
      await kernel.dispatch({
        type: "run.claimPending",
        workerId: "host-worker",
      });
      const job = (await jobTransport.dequeue())!;
      const handling = host.handleJob({
        jobId: job.jobId,
        workflowRunId: job.workflowRunId,
        workflowId: job.workflowId,
        stageId: job.stageId,
        attempt: job.attempt,
        maxAttempts: job.maxAttempts,
        payload: job.payload,
      });
      await started;
      await handling;
      try {
        clock.advance(60_301);
        const tick = await other.runMaintenanceTick();
        expect(tick.eventsFlushed).toBe(1);
        expect(ids).toHaveLength(2);
        expect(ids[0]).toBe(ids[1]);
      } finally {
        resume();
        await firstCompleted;
      }
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(ids).toHaveLength(2);
    });
  },
);
