/**
 * A crash between the two writes that dead-letter an outbox event, against a
 * real database: SQLite (`SQLITE8_KERNEL_SQLITE=1`, Prisma 6, 7 or 8) and
 * Postgres (`DATABASE_URL`). The in-memory twin is
 * `kernel/outbox-dlq-crash.test.ts`; this one adds what only a database shows:
 * the row after the crash, and a row an earlier version left stamped.
 *
 * Through `kernel.dispatch`: `outbox.flush` with a plugin that fails until the
 * event is dead-lettered, a crash injected after the DLQ move and before the
 * release of the claim, `plugin.replayDLQ`, then `outbox.flush`.
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
    let shouldFail = true;
    const delivered: string[] = [];

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

    /** Dies after the DLQ move, before the claim is released. */
    async function flushAndCrash() {
      const release = persistence.releaseOutboxEvents.bind(persistence);
      persistence.releaseOutboxEvents = async () => {
        throw new Error("process died");
      };
      try {
        await expect(flush()).rejects.toThrow("process died");
      } finally {
        persistence.releaseOutboxEvents = release;
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
        handle: async (event) => {
          if (shouldFail) throw new Error("plugin failure");
          delivered.push(event.type);
        },
      });
      kernel = createKernel({
        persistence,
        blobStore: new InMemoryBlobStore(),
        jobTransport: new InMemoryJobQueue("dlq-worker"),
        eventSink: createPluginRunner({
          plugins: [plugin as PluginDefinition],
          maxRetries: 1,
        }),
        clock: new FakeClock(),
        registry: { getWorkflow: () => undefined },
      });
    }, 120_000);

    beforeEach(async () => {
      await client.outboxEvent.deleteMany({});
      await client.workflowRun.deleteMany({});
      shouldFail = true;
      delivered.length = 0;
    });

    afterAll(async () => {
      await client?.$disconnect();
      if (directory) await rm(directory, { recursive: true, force: true });
    });

    it("leaves a dead letter, not a published event, when the process dies before the release, and a replay delivers it", async () => {
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
  },
);
