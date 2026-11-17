/**
 * Crash, replay and concurrent delivery checks through kernel.dispatch on
 * real SQLite and PostgreSQL adapters for Prisma 6, 7 and 8.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createKernel,
  createPluginRunner,
  definePlugin,
  type PluginDefinition,
} from "../../kernel/index.js";
import { FakeClock, InMemoryBlobStore } from "../../kernel/testing/index.js";
import {
  createPrismaWorkflowPersistence,
  fromPrisma8,
} from "../../persistence/prisma/index.js";
import { InMemoryJobQueue } from "../../testing/index.js";

const major = process.env.PRISMA_MAJOR ?? "7";
const sqlite = process.env.SQLITE8_KERNEL_SQLITE === "1";
const databaseUrl = process.env.DATABASE_URL;
const fixtures = createRequire(import.meta.url)(
  "../../../../prisma-fixtures/index.cjs",
);

describe.skipIf(!sqlite && !databaseUrl)(
  `dead-lettering across a crash on ${sqlite ? "SQLite" : "Postgres"} (Prisma ${major})`,
  () => {
    let directory: string | undefined;
    let client: any;
    let persistence: ReturnType<typeof createPrismaWorkflowPersistence>;
    let kernel: ReturnType<typeof createKernel>;
    let clock: FakeClock;
    let runner: ReturnType<typeof createPluginRunner>;
    let shouldFail = true;
    let holdNext: (() => Promise<void>) | undefined;
    const delivered: string[] = [];
    const identities: string[] = [];

    async function open() {
      if (major === "8") {
        const db = sqlite
          ? await fixtures.createSqliteDb(join(directory!, "dlq.db"))
          : fixtures.createPostgresDb(databaseUrl);
        return Object.assign(fromPrisma8(db), {
          $disconnect: () => db.close(),
        });
      }
      return sqlite
        ? fixtures.createSqliteClient(join(directory!, "dlq.db"))
        : fixtures.createPostgresClient(databaseUrl);
    }

    /** One run and its one event, as `run.create` would have left them. */
    async function seedEvent(id: string) {
      await persistence.createRun({
        id,
        workflowId: "dlq",
        workflowName: "dlq",
        workflowType: "dlq",
        input: {},
      });
      await persistence.appendOutboxEvents([
        {
          workflowRunId: id,
          eventType: "workflow:created",
          payload: { type: "workflow:created", workflowRunId: id },
          causationId: `cause-${id}`,
          occurredAt: new Date(),
        },
      ]);
    }

    const rows = () =>
      client.outboxEvent.findMany({
        select: { publishedAt: true, dlqAt: true, retryCount: true },
      });
    const flush = () => kernel.dispatch({ type: "outbox.flush" as const });
    const replay = () =>
      kernel.dispatch({ type: "plugin.replayDLQ" as const, maxEvents: 10 });

    /** Dies after the atomic dead-letter and claim release. */
    async function flushAndCrash() {
      const fail = persistence.failOutboxDelivery.bind(persistence);
      persistence.failOutboxDelivery = async (...args) => {
        await fail(...args);
        throw new Error("process died");
      };
      try {
        await expect(flush()).rejects.toThrow("process died");
      } finally {
        persistence.failOutboxDelivery = fail;
      }
    }

    beforeAll(async () => {
      if (sqlite) {
        directory = await mkdtemp(join(tmpdir(), `dlq-window-${major}-`));
      }
      client = await open();
      persistence = createPrismaWorkflowPersistence(client, {
        databaseType: sqlite ? "sqlite" : "postgresql",
      });
      const plugin = definePlugin({
        id: "dlq-plugin",
        name: "DLQ plugin",
        on: ["workflow:created"],
        handle: async (event, delivery) => {
          if (shouldFail) throw new Error("plugin failure");
          const hold = holdNext;
          holdNext = undefined;
          if (hold) await hold();
          delivered.push(event.type);
          identities.push(delivery!.eventId);
        },
      });
      clock = new FakeClock();
      runner = createPluginRunner({
        plugins: [plugin as PluginDefinition],
        maxRetries: 1,
      });
      kernel = createKernel({
        persistence,
        blobStore: new InMemoryBlobStore(),
        jobTransport: new InMemoryJobQueue("dlq-worker"),
        eventSink: runner,
        clock,
        registry: { getWorkflow: () => undefined },
      });
    }, 120_000);

    beforeEach(async () => {
      await client.outboxEvent.deleteMany({});
      await client.workflowRun.deleteMany({});
      shouldFail = true;
      holdNext = undefined;
      delivered.length = 0;
      identities.length = 0;
      clock.set(new Date("2025-01-01T00:00:00.000Z"));
      (runner as { maxRetries: number }).maxRetries = 1;
    });

    afterAll(async () => {
      await client?.$disconnect();
      if (directory) await rm(directory, { recursive: true, force: true });
    });

    it("leaves a dead letter after death following the atomic write, and a replay delivers it", async () => {
      await seedEvent("crash-run");
      await flushAndCrash();

      // The row the crash left: dead-lettered, and not stamped as published.
      expect(await rows()).toEqual([
        { publishedAt: null, dlqAt: expect.any(Date), retryCount: 1 },
      ]);
      expect((await flush()).published).toBe(0);
      const stats = await kernel.dispatch({ type: "engine.stats" });
      expect(stats.outbox.available && stats.outbox.deadLettered).toBe(1);

      shouldFail = false;
      expect((await replay()).replayed).toBe(1);
      expect((await flush()).published).toBe(1);
      expect(delivered).toEqual(["workflow:created"]);
    });

    it("revives a dead letter an earlier version left stamped as published", async () => {
      await seedEvent("legacy-run");
      // The state a crash used to leave: dead-lettered and claim-stamped.
      await client.outboxEvent.updateMany({
        data: { dlqAt: new Date(), publishedAt: new Date(), retryCount: 1 },
      });
      const stats = await kernel.dispatch({ type: "engine.stats" });
      expect(stats.outbox.available && stats.outbox.deadLettered).toBe(1);

      shouldFail = false;
      expect((await replay()).replayed).toBe(1);
      expect(await rows()).toEqual([
        { publishedAt: null, dlqAt: null, retryCount: 0 },
      ]);
      expect((await flush()).published).toBe(1);
      expect(delivered).toEqual(["workflow:created"]);
    });

    it("does not clear a publication that races a stale dead-letter replay", async () => {
      await seedEvent("replay-race");
      await client.outboxEvent.updateMany({
        where: { workflowRunId: "replay-race" },
        data: { dlqAt: new Date() },
      });
      const stamp = new Date("2026-01-01T00:00:00.000Z");
      const delegate = client.outboxEvent;
      const racedDelegate = new Proxy(delegate, {
        get(target, key) {
          if (key === "findMany")
            return async (args: unknown) => {
              const selected = await target.findMany(args);
              await target.updateMany({
                where: { workflowRunId: "replay-race" },
                data: { dlqAt: null, publishedAt: stamp },
              });
              return selected;
            };
          return Reflect.get(target, key);
        },
      });
      const racedClient = new Proxy(client, {
        get(target, key) {
          return key === "outboxEvent"
            ? racedDelegate
            : Reflect.get(target, key, target);
        },
      });
      const racedPersistence = createPrismaWorkflowPersistence(racedClient, {
        databaseType: sqlite ? "sqlite" : "postgresql",
      });
      const racedKernel = createKernel({
        persistence: racedPersistence,
        blobStore: new InMemoryBlobStore(),
        jobTransport: new InMemoryJobQueue("race"),
        eventSink: runner,
        clock,
        registry: { getWorkflow: () => undefined },
      });
      expect(
        (await racedKernel.dispatch({ type: "plugin.replayDLQ" })).replayed,
      ).toBe(0);
      expect((await rows())[0]?.publishedAt).toEqual(stamp);
    });

    it("recovers a process death after the durable claim", async () => {
      await seedEvent("death-after-claim");
      shouldFail = false;
      const claim = persistence.claimOutboxDelivery.bind(persistence);
      persistence.claimOutboxDelivery = async (...args) => {
        await claim(...args);
        throw new Error("death after claim");
      };
      try {
        await expect(flush()).rejects.toThrow("death after claim");
      } finally {
        persistence.claimOutboxDelivery = claim;
      }
      expect((await rows())[0]?.publishedAt).toBeNull();
      expect((await flush()).published).toBe(0);
      clock.advance(60_001);
      expect((await flush()).published).toBe(1);
      expect(delivered).toEqual(["workflow:created"]);
    });

    it("retries with the same identity after death between emit and publication", async () => {
      await seedEvent("death-after-emit");
      shouldFail = false;
      const complete = persistence.completeOutboxDelivery.bind(persistence);
      persistence.completeOutboxDelivery = async () => {
        throw new Error("death after emit");
      };
      try {
        await expect(flush()).rejects.toThrow("death after emit");
      } finally {
        persistence.completeOutboxDelivery = complete;
      }
      expect((await rows())[0]?.publishedAt).toBeNull();
      clock.advance(60_001);
      expect((await flush()).published).toBe(1);
      expect(delivered).toHaveLength(2);
      expect(identities[0]).toBe(identities[1]);
    });

    it("does not redeliver after death following the published write", async () => {
      await seedEvent("death-after-published");
      shouldFail = false;
      const complete = persistence.completeOutboxDelivery.bind(persistence);
      persistence.completeOutboxDelivery = async (...args) => {
        await complete(...args);
        throw new Error("death after published");
      };
      try {
        await expect(flush()).rejects.toThrow("death after published");
      } finally {
        persistence.completeOutboxDelivery = complete;
      }
      clock.advance(60_001);
      expect((await flush()).published).toBe(0);
      expect(delivered).toHaveLength(1);
    });

    it("retries after death following the retry-and-release write", async () => {
      await seedEvent("death-after-release");
      (runner as { maxRetries: number }).maxRetries = 2;
      await flushAndCrash();
      expect((await rows())[0]).toMatchObject({
        publishedAt: null,
        dlqAt: null,
        retryCount: 1,
      });
      shouldFail = false;
      expect((await flush()).published).toBe(1);
    });

    it("prevents an overlapping run claim, then fences a slow sink after expiry", async () => {
      await seedEvent("slow-run");
      await persistence.appendOutboxEvents([
        {
          workflowRunId: "slow-run",
          eventType: "workflow:created",
          payload: { type: "workflow:created", workflowRunId: "slow-run" },
          causationId: "second",
          occurredAt: new Date(),
        },
      ]);
      shouldFail = false;
      let entered!: () => void;
      let resume!: () => void;
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        resume = resolve;
      });
      holdNext = async () => {
        entered();
        await gate;
      };
      const first = kernel.dispatch({
        type: "outbox.flush",
        maxEvents: 1,
        claimDurationMs: 1_000,
      });
      await started;
      try {
        expect(
          (await kernel.dispatch({ type: "outbox.flush", maxEvents: 1 }))
            .published,
        ).toBe(0);
        expect(
          (await kernel.dispatch({ type: "engine.stats" })).outbox,
        ).toMatchObject({ available: true, unpublished: 2 });
        clock.advance(1_001);
        expect(
          (await kernel.dispatch({ type: "outbox.flush", maxEvents: 1 }))
            .published,
        ).toBe(1);
      } finally {
        resume();
        expect((await first).published).toBe(0);
      }
      expect(delivered).toHaveLength(2);
      expect(identities[0]).toBe(identities[1]);
      expect(
        (await kernel.dispatch({ type: "outbox.flush", maxEvents: 1 }))
          .published,
      ).toBe(1);
    });
  },
);
