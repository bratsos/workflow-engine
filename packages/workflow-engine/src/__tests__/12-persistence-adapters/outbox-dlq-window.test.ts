/**
 * Crash, replay and concurrent delivery checks through kernel.dispatch on
 * real SQLite and PostgreSQL adapters for Prisma 6, 7 and 8.
 */

import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { z } from "zod";
import { defineWorkflow } from "../../core/workflow.js";
import {
  OutboxClaimUnsupportedError as RootClaimUnsupportedError,
  OutboxSchemaMissingError as RootSchemaMissingError,
} from "../../index.js";
import {
  createKernel,
  createPluginRunner,
  definePlugin,
  type PluginDefinition,
  runMaintenanceTick,
} from "../../kernel/index.js";
import { FakeClock, InMemoryBlobStore } from "../../kernel/testing/index.js";
import {
  createPrismaWorkflowPersistence,
  fromPrisma8,
  OutboxClaimUnsupportedError,
  OutboxSchemaMissingError,
} from "../../persistence/prisma/index.js";
import { rawFor } from "../../persistence/prisma/prisma-client-type.js";
import { InMemoryJobQueue } from "../../testing/index.js";

const major = process.env.PRISMA_MAJOR ?? "7";
const sqlite = process.env.SQLITE8_KERNEL_SQLITE === "1";
const databaseUrl = process.env.DATABASE_URL;
const fixtures = createRequire(import.meta.url)(
  "../../../../prisma-fixtures/index.cjs",
);

describe.skipIf(!sqlite && !databaseUrl)(
  `dead-lettering across a crash on ${
    sqlite ? "SQLite" : "Postgres"
  } (Prisma ${major})`,
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

    // Tests that take the delivery schema step back run DDL. On PostgreSQL it
    // gives up after 2 s behind another session's lock (`55P03`), well inside
    // the 5 s transaction timeout, instead of queueing for the test timeout,
    // and every DDL statement goes through here.
    const alterSchema = (sql: string) =>
      sqlite
        ? client.$executeRawUnsafe(sql)
        : client.$transaction(async (tx: typeof client) => {
            await tx.$executeRawUnsafe("SET LOCAL lock_timeout = '2s'");
            await tx.$executeRawUnsafe(sql);
          });
    const DELIVERY_INDEXES = [
      [
        "outbox_events_delivery_run_idx",
        '"publishedAt", "dlqAt", "workflowRunId", "deliveryClaim"',
      ],
      [
        "outbox_events_live_run_sequence_idx",
        '"publishedAt", "dlqAt", "workflowRunId", "sequence"',
      ],
      ["outbox_events_delivery_cursor_idx", '"deliveryClaim", "workflowRunId"'],
    ] as const;
    /**
     * Puts the delivery column and indexes back, whichever test took them. It
     * reads the catalog first and runs DDL only for what is missing: even
     * `CREATE INDEX IF NOT EXISTS` waits for a lock on PostgreSQL.
     */
    async function restoreDeliverySchema() {
      const reader =
        major === "8" ? client.$withColumns({ name: "text" }) : client;
      const names = async (sql: string) =>
        new Set(
          ((await reader.$queryRawUnsafe(sql)) as Array<{ name: string }>).map(
            (row) => row.name,
          ),
        );
      const columns = await names(
        sqlite
          ? "SELECT name FROM pragma_table_info('outbox_events')"
          : "SELECT column_name AS name FROM information_schema.columns WHERE table_name = 'outbox_events' AND table_schema = current_schema()",
      );
      for (const name of ["legacyClaim", "preUpgradeClaim"])
        if (columns.has(name))
          await alterSchema(
            `ALTER TABLE "outbox_events" RENAME COLUMN "${name}" TO "deliveryClaim"`,
          );
      const indexes = await names(
        sqlite
          ? "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'outbox_events'"
          : "SELECT indexname AS name FROM pg_indexes WHERE tablename = 'outbox_events' AND schemaname = current_schema()",
      );
      for (const [name, indexed] of DELIVERY_INDEXES)
        if (!indexes.has(name))
          await alterSchema(
            `CREATE INDEX "${name}" ON "outbox_events" (${indexed})`,
          );
    }

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
      // A test that timed out may have left the schema step taken back.
      await restoreDeliverySchema();
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
      const complete = persistence.completeOutboxDeliveries!.bind(persistence);
      persistence.completeOutboxDeliveries = async () => {
        throw new Error("death after emit");
      };
      try {
        await expect(flush()).rejects.toThrow("death after emit");
      } finally {
        persistence.completeOutboxDeliveries = complete;
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
      const complete = persistence.completeOutboxDeliveries!.bind(persistence);
      persistence.completeOutboxDeliveries = async (...args) => {
        await complete(...args);
        throw new Error("death after published");
      };
      try {
        await expect(flush()).rejects.toThrow("death after published");
      } finally {
        persistence.completeOutboxDeliveries = complete;
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

    it.each([
      ["publication", false],
      ["publication", true],
      ["retry release", false],
      ["retry release", true],
      ["dead letter", false],
      ["dead letter", true],
    ] as const)("recovers three claimed events after a live-process %s error (committed: %s)", async (operation, committed) => {
      for (let i = 0; i < 3; i++) await seedEvent(`write-error-${i}`);
      const first = await client.outboxEvent.findFirst({
        where: { workflowRunId: "write-error-0" },
      });
      shouldFail = operation !== "publication";
      (runner as { maxRetries: number }).maxRetries =
        operation === "dead letter" ? 1 : 3;
      const delegate = client.outboxEvent;
      const faultingDelegate = new Proxy(delegate, {
        get(target, key) {
          if (key === "updateMany")
            return async (args: any) => {
              const targetWrite =
                operation === "publication"
                  ? args.data.publishedAt !== undefined
                  : args.data.retryCount !== undefined;
              const ids: unknown[] = args.where.id?.in ?? [args.where.id];
              if (!ids.includes(first.id) || !targetWrite)
                return target.updateMany(args);
              if (committed) await target.updateMany(args);
              throw new Error("injected outbox write error");
            };
          return Reflect.get(target, key);
        },
      });
      const faultingClient = new Proxy(client, {
        get(target, key) {
          return key === "outboxEvent"
            ? faultingDelegate
            : Reflect.get(target, key, target);
        },
      });
      const faultingPersistence = createPrismaWorkflowPersistence(
        faultingClient,
        {
          databaseType: sqlite ? "sqlite" : "postgresql",
        },
      );
      const faultingKernel = createKernel({
        persistence: faultingPersistence,
        blobStore: new InMemoryBlobStore(),
        jobTransport: new InMemoryJobQueue("write-fault"),
        eventSink: runner,
        clock,
        registry: { getWorkflow: () => undefined },
      });
      await expect(
        faultingKernel.dispatch({ type: "outbox.flush" }),
      ).rejects.toThrow("injected outbox write error");
      shouldFail = false;
      const before = await flush();
      expect(before.published).toBe(
        operation === "retry release" ? (committed ? 3 : 2) : 0,
      );
      if (operation === "dead letter")
        expect((await replay()).replayed).toBe(committed ? 3 : 2);
      clock.advance(60_001);
      await flush();
      expect(new Set(identities).size).toBe(3);
      expect(
        (await rows()).every(
          (row: { publishedAt: Date | null }) => row.publishedAt !== null,
        ),
      ).toBe(true);
      // The three runs' acceptances share one acknowledgement write: when it
      // fails uncommitted, all three are delivered again.
      expect(delivered).toHaveLength(
        operation === "publication" && !committed ? 6 : 3,
      );
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

    function deferred() {
      let release!: () => void;
      const promise = new Promise<void>((resolve) => {
        release = resolve;
      });
      return { promise, release };
    }

    function make(
      eventSink: Parameters<typeof createKernel>[0]["eventSink"],
      store = persistence,
    ) {
      return createKernel({
        persistence: store,
        eventSink,
        clock,
        blobStore: new InMemoryBlobStore(),
        jobTransport: new InMemoryJobQueue("outbox"),
        registry: { getWorkflow: () => undefined },
      });
    }

    function storeOver(prisma: typeof client) {
      return createPrismaWorkflowPersistence(prisma, {
        databaseType: sqlite ? "sqlite" : "postgresql",
      });
    }

    function omitClientMembers(...hidden: string[]) {
      function view(target: typeof client): typeof client {
        return new Proxy(target, {
          get(prisma, key) {
            if (hidden.includes(String(key))) return undefined;
            if (key === "$withColumns" && prisma.$withColumns)
              return (...args: unknown[]) => view(prisma.$withColumns(...args));
            return Reflect.get(prisma, key, prisma);
          },
        });
      }
      return view(client);
    }

    it.each([
      false,
      true,
    ])("flushes a root facade and inserts its batch atomically (skip transactions: %s)", async (skipInteractiveTransactions) => {
      const root = omitClientMembers("$transaction");
      const inserted: string[][] = [];
      const facade = new Proxy(root, {
        get(target, key) {
          if (key !== "outboxEvent") return Reflect.get(target, key, target);
          return new Proxy(target.outboxEvent, {
            get(table, method) {
              if (method !== "createMany") return Reflect.get(table, method);
              return async (args: { data: { workflowRunId: string }[] }) => {
                inserted.push(
                  args.data.map(({ workflowRunId }) => workflowRunId),
                );
                return table.createMany(args);
              };
            },
          });
        },
      });
      const store = createPrismaWorkflowPersistence(facade, {
        databaseType: sqlite ? "sqlite" : "postgresql",
        skipInteractiveTransactions,
      });
      await store.appendOutboxEvents(
        ["z", "a", "a"].map((workflowRunId) => ({
          workflowRunId,
          eventType: "workflow:created",
          payload: { workflowRunId },
          occurredAt: clock.now(),
          causationId: "autocommit",
        })),
      );
      expect(inserted).toEqual([["a", "a", "z"]]);
      const accepted: string[] = [];
      const dispatcher = make(
        {
          async emit(_, meta) {
            accepted.push(meta!.workflowRunId);
          },
        },
        store,
      );
      await expect(
        dispatcher.dispatch({ type: "outbox.flush" }),
      ).resolves.toMatchObject({ published: 3 });
      expect(accepted.sort()).toEqual(["a", "a", "z"]);
    });

    it.skipIf(sqlite)(
      "honours skipInteractiveTransactions for an outbox claim",
      async () => {
        await seedEvent("skip-transaction");
        const root = new Proxy(client, {
          get(target, key) {
            if (key === "$transaction")
              return () => {
                throw new Error("unexpected interactive transaction");
              };
            return Reflect.get(target, key, target);
          },
        });
        const store = createPrismaWorkflowPersistence(root, {
          skipInteractiveTransactions: true,
        });
        await expect(
          make({ async emit() {} }, store).dispatch({ type: "outbox.flush" }),
        ).resolves.toMatchObject({ published: 1 });
      },
    );

    it.skipIf(sqlite)(
      "reserves sequences in the same run order for opposite append inputs",
      async () => {
        const writes: string[][] = [[], []];
        const batches = [
          ["a", "z"],
          ["z", "a"],
        ];
        await Promise.all(
          batches.map((runIds, index) =>
            client.$transaction(async (tx: typeof client) => {
              const table = new Proxy(tx.outboxEvent, {
                get(target, key) {
                  if (key !== "createMany") return Reflect.get(target, key);
                  return async (args: {
                    data: { workflowRunId: string }[];
                    skipDuplicates?: boolean;
                  }) => {
                    const result = await target.createMany(args);
                    if (args.skipDuplicates && result.count) {
                      writes[index]!.push(args.data[0]!.workflowRunId);
                      // Hold the first reservation to expose opposite lock order.
                      if (writes[index]!.length === 1)
                        await new Promise((resolve) =>
                          setTimeout(resolve, 100),
                        );
                    }
                    return result;
                  };
                },
              });
              const view = new Proxy(tx, {
                get(target, key) {
                  return key === "outboxEvent"
                    ? table
                    : Reflect.get(target, key, target);
                },
              });
              await storeOver(view).appendOutboxEvents(
                runIds.flatMap((workflowRunId) =>
                  [1, 2].map((sequence) => ({
                    workflowRunId,
                    eventType: "workflow:created",
                    payload: { sequence },
                    occurredAt: clock.now(),
                    causationId: "opposite-orders",
                  })),
                ),
              );
            }),
          ),
        );
        expect(writes).toEqual([
          ["a", "z"],
          ["a", "z"],
        ]);
        const rows = await client.outboxEvent.findMany({
          orderBy: [{ workflowRunId: "asc" }, { sequence: "asc" }],
        });
        expect(rows.map((r: { sequence: number }) => r.sequence)).toEqual([
          1, 2, 3, 4, 1, 2, 3, 4,
        ]);
      },
    );

    it("attempts a ready run without waiting for another run's slow sink", async () => {
      await seedEvent("a-slow");
      await seedEvent("z-ready");
      const slow = deferred();
      const slowEntered = deferred();
      const healthy = deferred();
      const pending = make({
        async emit(_, meta) {
          if (meta!.workflowRunId === "a-slow") {
            slowEntered.release();
            await slow.promise;
          } else healthy.release();
        },
      }).dispatch({ type: "outbox.flush", maxEvents: 2, claimDurationMs: 100 });
      await slowEntered.promise;
      clock.advance(101);
      const outcome = await Promise.race([
        healthy.promise.then(() => "healthy"),
        new Promise((resolve) => setTimeout(() => resolve("blocked"), 1000)),
      ]);
      slow.release();
      await pending;
      expect(outcome).toBe("healthy");
    });

    it("rotates across fresh adapters despite busy earlier runs refilling", async () => {
      for (const id of ["a", "b", "c", "z"]) await seedEvent(id);
      const calls: string[] = [];
      const sink = {
        async emit(_, meta) {
          const runId = meta!.workflowRunId;
          calls.push(runId);
          if (runId === "z") return;
          await persistence.appendOutboxEvents([
            {
              workflowRunId: runId,
              eventType: "workflow:created",
              payload: {},
              occurredAt: clock.now(),
              causationId: "refill",
            },
          ]);
          if (runId === "a") throw new Error("failing lower run");
        },
      } satisfies NonNullable<Parameters<typeof createKernel>[0]["eventSink"]>;
      for (let i = 0; i < 4; i++) {
        await make(sink, storeOver(client)).dispatch({
          type: "outbox.flush",
          maxEvents: 1,
        });
      }
      expect(calls).toEqual(["a", "b", "c", "z"]);
    });

    it("reaches the 101st run on the second cold default-size page", async () => {
      const hotRuns = Array.from(
        { length: 100 },
        (_, i) => `a-${String(i).padStart(3, "0")}`,
      );
      await persistence.appendOutboxEvents(
        [...hotRuns.flatMap((runId) => Array(10).fill(runId)), "z"].map(
          (workflowRunId) => ({
            workflowRunId,
            eventType: "workflow:created",
            payload: {},
            occurredAt: clock.now(),
            causationId: "cold-default-page",
          }),
        ),
      );
      const attempted: string[] = [];
      const sink: NonNullable<Parameters<typeof createKernel>[0]["eventSink"]> =
        {
          async emit(_, meta) {
            attempted.push(meta!.workflowRunId);
          },
        };
      await make(sink, storeOver(client)).dispatch({ type: "outbox.flush" });
      expect(attempted).not.toContain("z");
      await make(sink, storeOver(client)).dispatch({ type: "outbox.flush" });
      expect(attempted).toContain("z");
    });

    it.skipIf(sqlite)(
      "continues after the furthest run claimed by concurrent cold flushes",
      async () => {
        const runs = ["r0", "r1", "r2", "r3", "r4"];
        for (const runId of runs)
          await persistence.appendOutboxEvents(
            [1, 2].map(() => ({
              workflowRunId: runId,
              eventType: "workflow:created",
              payload: {},
              occurredAt: clock.now(),
              causationId: "cold-concurrent",
            })),
          );
        // Each claim commits only after every claim has run, so all three
        // statements start from the same (empty) cursor.
        const commit = deferred();
        const held = (entered: () => void) =>
          storeOver(
            new Proxy(client, {
              get(target, key) {
                if (key !== "$transaction")
                  return Reflect.get(target, key, target);
                return (
                  work: (tx: typeof client) => unknown,
                  options: unknown,
                ) =>
                  target.$transaction(async (tx: typeof client) => {
                    const result = await work(tx);
                    entered();
                    await commit.promise;
                    return result;
                  }, options);
              },
            }),
          );
        // Under a tie on rank, the earliest run's token would win the cursor.
        const pending: Promise<{ workflowRunId: string; id: string }[]>[] = [];
        for (const token of ["z", "y", "x"]) {
          const entered = deferred();
          pending.push(
            held(entered.release).claimOutboxDelivery(
              1,
              `2099-01-01T00:00:00.000Z|${token}`,
              clock.now(),
              [],
            ),
          );
          await entered.promise;
        }
        commit.release();
        const pages = await Promise.all(pending);
        expect(
          pages.map((page) => page.map((row) => row.workflowRunId)),
        ).toEqual([["r0"], ["r1"], ["r2"]]);
        for (const [index, [row]] of pages.entries())
          expect(
            await persistence.completeOutboxDelivery(
              row!.id,
              `2099-01-01T00:00:00.000Z|${["z", "y", "x"][index]}`,
              clock.now(),
            ),
          ).toBe(true);
        const [next] = await persistence.claimOutboxDelivery(
          1,
          "2099-01-01T00:00:00.000Z|next",
          clock.now(),
          [],
        );
        expect(next?.workflowRunId).toBe("r3");
      },
    );

    it("drains a run's backlog in one claim and few acknowledgements", async () => {
      await persistence.appendOutboxEvents(
        [...Array(50).fill("a-backlog"), "z-other"].map((workflowRunId) => ({
          workflowRunId,
          eventType: "workflow:created",
          payload: {},
          occurredAt: clock.now(),
          causationId: "backlog",
        })),
      );
      const counts = { claims: 0, settings: 0, reads: 0, acknowledgements: 0 };
      const counted = (prisma: typeof client): typeof client =>
        new Proxy(prisma, {
          get(target, key) {
            if (key === "$withColumns" && target.$withColumns)
              return (...args: unknown[]) =>
                counted(target.$withColumns(...args));
            if (key === "$transaction" && target.$transaction)
              return (work: (tx: typeof client) => unknown, options: unknown) =>
                target.$transaction(
                  (tx: typeof client) => work(counted(tx)),
                  options,
                );
            if (key === "$queryRawUnsafe" && target.$queryRawUnsafe)
              return (sql: string, ...args: unknown[]) => {
                if (sql.includes('SET "deliveryClaim"')) counts.claims++;
                if (sql.includes("set_config")) counts.settings++;
                return target.$queryRawUnsafe(sql, ...args);
              };
            if (key === "outboxEvent")
              return new Proxy(target.outboxEvent, {
                get(table, method) {
                  const call = Reflect.get(table, method);
                  if (method === "findMany")
                    return (args: unknown) => {
                      counts.reads++;
                      return call.call(table, args);
                    };
                  if (method === "updateMany")
                    return (args: { data: { publishedAt?: unknown } }) => {
                      if (args.data.publishedAt !== undefined)
                        counts.acknowledgements++;
                      return call.call(table, args);
                    };
                  return call;
                },
              });
            return Reflect.get(target, key, target);
          },
        });
      const accepted: string[] = [];
      const result = await make(
        {
          async emit(_, meta) {
            accepted.push(`${meta!.workflowRunId}:${meta!.sequence}`);
          },
        },
        storeOver(counted(client)),
      ).dispatch({ type: "outbox.flush" });
      expect(result.published).toBe(51);
      expect(accepted.filter((key) => key.startsWith("a-"))).toEqual(
        Array.from({ length: 50 }, (_, i) => `a-backlog:${i + 1}`),
      );
      // The page, then the empty claim that ends the flush; on SQLite the
      // read that finds no live row ends it without a claim.
      expect(counts.claims).toBe(sqlite ? 1 : 2);
      expect(counts.settings).toBe(sqlite ? 0 : 2);
      // No ownership read: the claim returns only the rows it owns.
      expect(counts.reads).toBe(0);
      expect(counts.acknowledgements).toBeGreaterThan(0);
      expect(counts.acknowledgements).toBeLessThanOrEqual(4);
    });

    it("keeps claiming and decoding owners after the rank saturates", async () => {
      await seedEvent("a-saturated");
      await client.outboxEvent.updateMany({
        where: { workflowRunId: "a-saturated" },
        data: {
          publishedAt: clock.now(),
          deliveryClaim: "r9223372036854775807|",
        },
      });
      await seedEvent("b-next");
      const lease = "2099-01-01T00:00:00.000Z|saturated";
      const [row] = await persistence.claimOutboxDelivery(
        1,
        lease,
        clock.now(),
        [],
      );
      expect(row?.workflowRunId).toBe("b-next");
      const stored = await client.outboxEvent.findFirst({
        where: { id: row!.id },
      });
      // Never below a stored rank, so it stays the latest acquisition.
      expect(stored.deliveryClaim).toBe(`r9223372036854775807|${lease}`);
      expect(
        await persistence.isOutboxDeliveryClaimActive(
          row!.id,
          lease,
          clock.now(),
        ),
      ).toBe(true);
      // The live claim blocks its run at the saturated rank too.
      expect(
        await persistence.claimOutboxDelivery(
          1,
          "2099-01-01T00:00:00.000Z|other",
          clock.now(),
          [],
        ),
      ).toEqual([]);
      expect(
        await persistence.completeOutboxDelivery(row!.id, lease, clock.now()),
      ).toBe(true);
    });

    it("ranks at the maximum when the walk skips more heads than a page at the ceiling", async () => {
      await seedEvent("a-ceiling");
      await client.outboxEvent.updateMany({
        where: { workflowRunId: "a-ceiling" },
        data: {
          publishedAt: clock.now(),
          deliveryClaim: "r9223372036854775679|",
        },
      });
      const leased = Array.from(
        { length: 129 },
        (_, i) => `b-leased-${String(i).padStart(3, "0")}`,
      );
      await persistence.appendOutboxEvents(
        [...leased, "c-ready-1", "c-ready-2"].map((workflowRunId) => ({
          workflowRunId,
          eventType: "probe",
          payload: {},
          causationId: workflowRunId,
          occurredAt: new Date(),
        })),
      );
      await client.outboxEvent.updateMany({
        where: { workflowRunId: { in: leased } },
        data: {
          deliveryClaim: "r0000000000000000001|2099-01-01T00:00:00.000Z|held",
        },
      });
      const lease = "2099-01-01T00:00:00.000Z|ceiling";
      const rows = await persistence.claimOutboxDelivery(
        2,
        lease,
        clock.now(),
        [],
      );
      expect(rows.map((row) => row.workflowRunId).sort()).toEqual([
        "c-ready-1",
        "c-ready-2",
      ]);
      const stored = await client.outboxEvent.findMany({
        where: { workflowRunId: { in: ["c-ready-1", "c-ready-2"] } },
      });
      expect(stored.map((row: any) => row.deliveryClaim)).toEqual([
        `r9223372036854775807|${lease}`,
        `r9223372036854775807|${lease}`,
      ]);
    });

    it.skipIf(sqlite)(
      "restores the delivery schema without waiting for a lock when nothing is missing",
      async () => {
        // Another session's open claim transaction holds the table's lock.
        let release!: () => void;
        const held = new Promise<void>((resolve) => {
          release = resolve;
        });
        let locked!: () => void;
        const lockTaken = new Promise<void>((resolve) => {
          locked = resolve;
        });
        const holder = client.$transaction(
          async (tx: typeof client) => {
            await tx.$executeRawUnsafe(
              'UPDATE "outbox_events" SET "retryCount" = "retryCount" WHERE false',
            );
            locked();
            await held;
          },
          { timeout: 15_000 },
        );
        await lockTaken;
        const start = performance.now();
        try {
          await restoreDeliverySchema();
          expect(performance.now() - start).toBeLessThan(1_000);
        } finally {
          release();
          await holder;
        }
      },
    );

    it("names the schema step when the delivery column or its indexes are missing, and keeps the events", async () => {
      await seedEvent("a-schema");
      const flusher = make({ async emit() {} });
      const flushOnce = () =>
        flusher.dispatch({ type: "outbox.flush", maxEvents: 5 });
      const missing = expect.objectContaining({
        code: "OUTBOX_SCHEMA_MISSING",
        message: expect.stringContaining("outbox schema migration"),
      });
      const rejection = (work: Promise<unknown>) =>
        work.then(
          () => undefined,
          (error: unknown) => error,
        );
      // The engine's read of unpublished events: rows, or the same error.
      const unpublished = () =>
        persistence.getUnpublishedOutboxEvents().then(
          (events) => events.length,
          (error: { code?: string }) => error.code ?? error,
        );
      const live = () =>
        client.outboxEvent.count({ where: { publishedAt: null } });
      // A rename keeps the column's position, so restored PostgreSQL row
      // types match the plans cached before.
      await alterSchema(
        'ALTER TABLE "outbox_events" RENAME COLUMN "deliveryClaim" TO "legacyClaim"',
      );
      try {
        const error = await rejection(flushOnce());
        expect(error).toEqual(missing);
        expect(error).toBeInstanceOf(OutboxSchemaMissingError);
        expect(error).toBeInstanceOf(RootSchemaMissingError);
        // Prisma 6 and 7 map the rows without the column; Prisma 8 checks
        // each row against the columns it declares. (On PostgreSQL 6 and 7 the
        // rename itself fails the cached `SELECT *` plan of earlier tests.)
        if (sqlite || major === "8")
          expect(await unpublished()).toBe(
            major === "8" ? "OUTBOX_SCHEMA_MISSING" : 1,
          );
      } finally {
        await restoreDeliverySchema();
      }
      expect(await live()).toBe(1);
      for (const [name] of DELIVERY_INDEXES)
        await alterSchema(`DROP INDEX "${name}"`);
      try {
        // PostgreSQL claims without them, on slower plans.
        if (sqlite) {
          await expect(flushOnce()).rejects.toThrow(missing);
          expect(await unpublished()).toBe("OUTBOX_SCHEMA_MISSING");
        } else {
          expect(await unpublished()).toBe(1);
          expect(await flushOnce()).toMatchObject({ published: 1 });
        }
        expect(await live()).toBe(sqlite ? 1 : 0);
      } finally {
        await restoreDeliverySchema();
      }
      expect(await flushOnce()).toMatchObject({ published: sqlite ? 1 : 0 });
      expect(await live()).toBe(0);
    });

    it("passes on any rejection of the claim unchanged, whatever its shape", async () => {
      await seedEvent("a-odd");
      const circular: Record<string, unknown> = {};
      circular.self = circular;
      const odd: unknown[] = [
        Object.create(null),
        Symbol("odd"),
        Object.defineProperty({}, "message", {
          get() {
            throw new Error("getter");
          },
        }),
        Object.assign(new Error("circular meta"), { meta: circular }),
        Object.assign(new Error("bigint meta"), { meta: { n: 1n } }),
      ];
      for (const value of odd) {
        // Rejects the claim's own statements only; every other read runs.
        const view = (target: typeof client): typeof client =>
          new Proxy(target, {
            get(prisma, key) {
              const member = Reflect.get(prisma, key, prisma);
              if (key === "$queryRaw" || key === "$queryRawUnsafe")
                return (...args: unknown[]) =>
                  /deliveryClaim/.test(
                    typeof args[0] === "string"
                      ? args[0]
                      : [...((args[0] as string[]) ?? [])].join(""),
                  )
                    ? Promise.reject(value)
                    : member.apply(prisma, args);
              if (key === "$withColumns" && typeof member === "function")
                return (...args: unknown[]) => view(member.apply(prisma, args));
              if (key === "$transaction" && typeof member === "function")
                return (work: unknown, ...rest: unknown[]) =>
                  member.call(
                    prisma,
                    typeof work === "function"
                      ? (tx: typeof client) => work(view(tx))
                      : work,
                    ...rest,
                  );
              return typeof member === "function"
                ? member.bind(prisma)
                : member;
            },
          });
        const flusher = make({ async emit() {} }, storeOver(view(client)));
        const caught = await flusher
          .dispatch({ type: "outbox.flush", maxEvents: 5 })
          .then(
            () => "resolved",
            (error: unknown) => error,
          );
        expect(caught).toBe(value);
      }
      expect(
        await client.outboxEvent.count({ where: { publishedAt: null } }),
      ).toBe(1);
    });

    it("releases only the failed run's claim when runs of a page share the maximum rank", async () => {
      await seedEvent("a-max");
      await client.outboxEvent.updateMany({
        where: { workflowRunId: "a-max" },
        data: {
          publishedAt: clock.now(),
          deliveryClaim: `r9223372036854775807|${clock.now().toISOString()}|seeded`,
        },
      });
      await persistence.appendOutboxEvents(
        ["z-1", "z-2"].flatMap((workflowRunId) =>
          [1, 2].map((n) => ({
            workflowRunId,
            eventType: "probe",
            payload: {},
            causationId: `${workflowRunId}-${n}`,
            occurredAt: new Date(),
          })),
        ),
      );
      const entered = deferred();
      const release = deferred();
      const first: string[] = [];
      const pending = make({
        async emit(_, meta) {
          const key = `${meta!.workflowRunId}#${meta!.sequence}`;
          first.push(key);
          if (key === "z-2#1") {
            entered.release();
            await release.promise;
          }
          if (key === "z-1#1") {
            await entered.promise;
            throw new Error("z-1 fails");
          }
        },
      }).dispatch({ type: "outbox.flush", maxEvents: 10 });
      await entered.promise;
      // z-1's failure is written while z-2#1 is still in the sink.
      await vi.waitFor(async () => {
        const failed = await client.outboxEvent.findFirst({
          where: { workflowRunId: "z-1", sequence: 1 },
        });
        expect(failed.retryCount).toBe(1);
      });
      const claims = await client.outboxEvent.findMany({
        where: { workflowRunId: "z-2" },
        select: { deliveryClaim: true },
      });
      expect(
        claims.every((row: { deliveryClaim: string }) =>
          row.deliveryClaim.startsWith("r9223372036854775807|20"),
        ),
      ).toBe(true);
      const second: string[] = [];
      await make({
        async emit(_, meta) {
          second.push(`${meta!.workflowRunId}#${meta!.sequence}`);
        },
      }).dispatch({ type: "outbox.flush", maxEvents: 10 });
      expect(second).toEqual(["z-1#1", "z-1#2"]);
      release.release();
      expect(await pending).toMatchObject({ published: 2, failed: 1 });
      expect(first).toEqual(["z-1#1", "z-2#1", "z-2#2"]);
    });

    it("keeps rotating once every rank is equal at the maximum", async () => {
      await seedEvent("a-max");
      await client.outboxEvent.updateMany({
        where: { workflowRunId: "a-max" },
        data: {
          publishedAt: clock.now(),
          deliveryClaim: `r9223372036854775807|${clock.now().toISOString()}|seeded`,
        },
      });
      const runs = ["d0", "d1", "d2", "d3", "d4", "d5"];
      await persistence.appendOutboxEvents(
        runs.flatMap((workflowRunId) =>
          [1, 2, 3].map((n) => ({
            workflowRunId,
            eventType: "probe",
            payload: {},
            causationId: `${workflowRunId}-${n}`,
            occurredAt: new Date(),
          })),
        ),
      );
      const pages: string[] = [];
      for (let i = 0; i < 9; i++) {
        const page: string[] = [];
        clock.advance(1);
        await make({
          async emit(_, meta) {
            page.push(meta!.workflowRunId);
          },
        }).dispatch({ type: "outbox.flush", maxEvents: 2 });
        pages.push(page.join(","));
      }
      expect(pages).toEqual(Array(3).fill(["d0,d1", "d2,d3", "d4,d5"]).flat());
      const ranks = await client.outboxEvent.findMany({
        where: { workflowRunId: { in: runs } },
        select: { deliveryClaim: true },
      });
      expect(
        ranks.every((row: { deliveryClaim: string }) =>
          row.deliveryClaim.startsWith("r9223372036854775807|"),
        ),
      ).toBe(true);
    });

    it.skipIf(sqlite)(
      "refuses a PostgreSQL root hiding raw reads when built, and passes 5,000 leased heads through each supported shape",
      async () => {
        for (const hidden of [
          ["$queryRaw", "$queryRawUnsafe"],
          ["$queryRaw", "$queryRawUnsafe", "$transaction"],
        ])
          expect(() => storeOver(omitClientMembers(...hidden))).toThrow(
            expect.objectContaining({ code: "OUTBOX_CLAIM_UNSUPPORTED" }),
          );
        expect(() =>
          storeOver(omitClientMembers("$queryRaw", "$queryRawUnsafe")),
        ).toThrow(OutboxClaimUnsupportedError);
        expect(() =>
          storeOver(omitClientMembers("$queryRaw", "$queryRawUnsafe")),
        ).toThrow(RootClaimUnsupportedError);
        // Records each raw statement and each claim transaction's timeout;
        // `hideRaw` gives a root that reads raw, with transaction views that
        // cannot.
        const statements: string[] = [];
        const timeouts: unknown[] = [];
        const observe = (
          prisma: typeof client,
          hideRaw: boolean,
          inTx = false,
        ): typeof client =>
          new Proxy(prisma, {
            get(target, key) {
              if (key === "$withColumns" && target.$withColumns)
                return (...args: unknown[]) =>
                  observe(target.$withColumns(...args), hideRaw, inTx);
              if (key === "$transaction" && !inTx)
                return (work: unknown, options?: { timeout?: number }) => {
                  if (typeof work !== "function")
                    return target.$transaction(work, options);
                  timeouts.push(options?.timeout);
                  return target.$transaction(
                    (tx: typeof client) => work(observe(tx, hideRaw, true)),
                    options,
                  );
                };
              if (key === "$queryRaw" || key === "$queryRawUnsafe") {
                if (inTx && hideRaw) return undefined;
                return (
                  sql: string | TemplateStringsArray,
                  ...args: unknown[]
                ) => {
                  statements.push(
                    typeof sql === "string" ? sql : sql.join("?"),
                  );
                  return target[key](sql, ...args);
                };
              }
              return Reflect.get(target, key, target);
            },
          });
        const store = storeOver(client);
        const seed = `INSERT INTO outbox_events
        (id, "workflowRunId", sequence, "eventType", payload, "causationId", "occurredAt", "deliveryClaim")
        SELECT 'd'||g, 'a'||lpad(g::text,6,'0'), 1, 'workflow:created', '{}', 'wide', now(), $1
        FROM generate_series(1,$2::int) g`;
        await client.$executeRawUnsafe(
          seed,
          "2099-01-01T00:00:00.000Z|held",
          // The claim walks every leased head before z-ready, in one statement.
          5000,
        );
        // The wrapper's claim runs on the root without planner settings, so
        // its plan follows the statistics (see kernel-and-ports.md).
        await client.$executeRawUnsafe("ANALYZE outbox_events");
        for (const shape of [
          storeOver(observe(client, false)),
          storeOver(observe(client, true)),
        ]) {
          await seedEvent("z-ready");
          statements.length = 0;
          timeouts.length = 0;
          await expect(
            make({ async emit() {} }, shape).dispatch({
              type: "outbox.flush",
              maxEvents: 1,
              claimDurationMs: 60_000,
            }),
          ).resolves.toMatchObject({ published: 1 });
          // Work, not wall time: one claim statement walks every leased head,
          // in a transaction bounded by the lease, not Prisma's 5 s default.
          expect(
            statements.filter((sql) => sql.startsWith("WITH RECURSIVE cursor")),
          ).toHaveLength(1);
          expect(timeouts).toContain(60_000);
          await client.outboxEvent.deleteMany({
            where: { workflowRunId: "z-ready" },
          });
          await client.workflowRun.deleteMany({ where: { id: "z-ready" } });
        }
        await client.outboxEvent.deleteMany({});
        await client.$executeRawUnsafe(seed, null, 12000);
        const claim = (suffix: string) =>
          store.claimOutboxDelivery(
            12000,
            `2099-01-01T00:00:00.000Z|${suffix}`,
            clock.now(),
            [],
          );
        const first = await claim("first");
        const second = await claim("second");
        expect(first).toHaveLength(128);
        expect(second).toHaveLength(128);
        expect(new Set([...first, ...second].map(({ id }) => id)).size).toBe(
          256,
        );
      },
      30_000,
    );

    it("counts a sink rejection at the Unix epoch for every raw-read shape", async () => {
      await seedEvent("epoch-dead-letter");
      clock.set(new Date(0));
      expect((await flush()).deadLettered).toBe(1);
      for (const hide of [[], ["$queryRaw"], ["$queryRawUnsafe"]]) {
        const result = await make(
          runner,
          storeOver(omitClientMembers(...hide)),
        ).dispatch({ type: "engine.stats" });
        expect(result.outbox).toMatchObject({
          deadLettered: 1,
          unpublished: 0,
        });
      }
    });

    it.each([
      false,
      true,
    ])("defers sink delivery in a caller transaction (commit: %s)", async (commit) => {
      await seedEvent("committed");
      const sink = {
        async emit(event: { workflowRunId?: string }) {
          delivered.push(event.workflowRunId!);
        },
      };
      const transaction = client.$transaction(async (tx: typeof client) => {
        const scoped = storeOver(tx);
        await scoped.appendOutboxEvents([
          {
            workflowRunId: "inside",
            eventType: "workflow:created",
            payload: { type: "workflow:created", workflowRunId: "inside" },
            causationId: "tx",
            occurredAt: clock.now(),
          },
        ]);
        const inner = make(sink, scoped);
        expect(await inner.dispatch({ type: "outbox.flush" })).toMatchObject({
          deferred: true,
          published: 0,
        });
        expect(
          await runMaintenanceTick(inner, { maxClaimsPerTick: 0 }),
        ).toMatchObject({
          eventsFlushed: 0,
          outboxDeferred: true,
          eventSinkStatus: "healthy",
        });
        expect(delivered).toEqual([]);
        if (!commit) throw new Error("roll back");
      });
      if (commit) await transaction;
      else await expect(transaction).rejects.toThrow("roll back");
      expect(
        (await make(sink).dispatch({ type: "outbox.flush" })).published,
      ).toBe(commit ? 2 : 1);
      expect([...delivered].sort()).toEqual(
        commit ? ["committed", "inside"] : ["committed"],
      );
    });

    it("records an unprintable rejection and delivers unrelated work", async () => {
      await seedEvent("a-poison");
      await seedEvent("z-healthy");
      const sink = {
        maxRetries: 1,
        async emit(event: { workflowRunId?: string }) {
          if (event.workflowRunId === "a-poison") throw Object.create(null);
          delivered.push(event.workflowRunId!);
        },
      };
      expect(await make(sink).dispatch({ type: "outbox.flush" })).toMatchObject(
        {
          deadLettered: 1,
          published: 1,
          eventSinkStatus: "degraded",
          eventSinkError: "Unprintable error",
        },
      );
      expect(delivered).toEqual(["z-healthy"]);
    });

    it("delivers a row dead-lettered by an operator after the claim once, keeps it dead-lettered, and delivers it again on replay", async () => {
      await seedEvent("operator-dlq");
      const row = await client.outboxEvent.findFirst({
        where: { workflowRunId: "operator-dlq" },
      });
      const entered = deferred();
      const resume = deferred();
      const seen: string[] = [];
      const page = make({
        async emit(_: unknown, delivery?: { eventId: string }) {
          seen.push(delivery!.eventId);
          entered.release();
          await resume.promise;
        },
      }).dispatch({ type: "outbox.flush" });
      await entered.promise;
      await persistence.moveOutboxEventToDLQ(row.id);
      resume.release();
      // The sink got it once; the fenced acknowledgement changed nothing.
      expect(await page).toMatchObject({ published: 0 });
      expect(seen).toEqual([row.id]);
      const stored = await client.outboxEvent.findUnique({
        where: { id: row.id },
      });
      expect(stored.publishedAt).toBeNull();
      expect(stored.dlqAt).not.toBeNull();
      shouldFail = false;
      expect((await flush()).published).toBe(0);
      expect((await replay()).replayed).toBe(1);
      expect((await flush()).published).toBe(1);
      expect(identities).toEqual([row.id]);
    });

    it("warns and skips an expired claim after awaiting claimOutboxDelivery", async () => {
      await seedEvent("expiry");
      const entered = deferred();
      const resume = deferred();
      const slow = storeOver(client);
      const claim = slow.claimOutboxDelivery.bind(slow);
      slow.claimOutboxDelivery = async (...args) => {
        const rows = await claim(...args);
        entered.release();
        await resume.promise;
        return rows;
      };
      const sink = (who: string) => ({
        async emit() {
          delivered.push(who);
        },
      });
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const old = make(sink("old"), slow).dispatch({
        type: "outbox.flush",
        claimDurationMs: 100,
      });
      try {
        await entered.promise;
        clock.advance(101);
        expect(
          (await make(sink("replacement")).dispatch({ type: "outbox.flush" }))
            .published,
        ).toBe(1);
      } finally {
        resume.release();
      }
      try {
        expect(await old).toMatchObject({
          published: 0,
          eventSinkStatus: "degraded",
        });
        expect(warn).toHaveBeenCalledWith(
          expect.stringContaining("claim expired"),
        );
        expect(delivered).toEqual(["replacement"]);
      } finally {
        warn.mockRestore();
      }
    });

    it.skipIf(!sqlite)(
      "returns the retry count written before the SQLite claimant acquires the row",
      async () => {
        await seedEvent("count");
        const entered = deferred();
        const resume = deferred();
        function gate(prisma: typeof client): typeof client {
          return new Proxy(prisma, {
            get(target, key) {
              if (key === "_engine") return undefined;
              if (key === "$withColumns" && target.$withColumns)
                return (...args: unknown[]) =>
                  gate(target.$withColumns(...args));
              if (key === "$queryRawUnsafe")
                return async (sql: string, ...args: unknown[]) => {
                  if (
                    sql.includes('SET "deliveryClaim"') &&
                    sql.includes("RETURNING")
                  ) {
                    entered.release();
                    await resume.promise;
                  }
                  return target.$queryRawUnsafe(sql, ...args);
                };
              return Reflect.get(target, key, target);
            },
          });
        }
        const sink = {
          async emit(_: unknown, delivery?: { attempt: number }) {
            delivered.push(String(delivery!.attempt));
          },
        };
        const pending = make(sink, storeOver(gate(client))).dispatch({
          type: "outbox.flush",
          maxEvents: 1,
        });
        try {
          await entered.promise;
          expect((await flush()).deadLettered).toBe(1);
          // Make the same row retryable with a recorded failure.
          expect((await replay()).replayed).toBe(1);
          (runner as { maxRetries: number }).maxRetries = 3;
          expect((await flush()).failed).toBe(1);
        } finally {
          resume.release();
        }
        expect((await pending).published).toBe(1);
        expect(delivered).toEqual(["2"]);
      },
    );

    it.skipIf(sqlite)(
      "honours cancellation after the planner settings and before acquisition",
      async () => {
        await seedEvent("cancel-after-select");
        const controller = new AbortController();
        const abortAfterSettings = (prisma: typeof client): typeof client =>
          new Proxy(prisma, {
            get(target, key) {
              if (key === "$withColumns" && target.$withColumns)
                return (...args: unknown[]) =>
                  abortAfterSettings(target.$withColumns(...args));
              if (key === "$transaction" && target.$transaction)
                return (
                  work: (tx: typeof client) => unknown,
                  options: unknown,
                ) =>
                  target.$transaction(
                    (tx: typeof client) => work(abortAfterSettings(tx)),
                    options,
                  );
              if (key === "$queryRawUnsafe" && target.$queryRawUnsafe)
                return async (sql: string, ...args: unknown[]) => {
                  const result = await target.$queryRawUnsafe(sql, ...args);
                  if (sql.includes("set_config")) controller.abort();
                  return result;
                };
              return Reflect.get(target, key, target);
            },
          });
        await expect(
          make(runner, storeOver(abortAfterSettings(client))).dispatch({
            type: "outbox.flush",
            signal: controller.signal,
          }),
        ).resolves.toMatchObject({ published: 0, eventSinkStatus: "degraded" });
        expect(controller.signal.aborted).toBe(true);
        const row = await client.outboxEvent.findFirst({
          where: { workflowRunId: "cancel-after-select" },
        });
        expect(row.deliveryClaim).toBeNull();
      },
    );

    it.skipIf(sqlite)(
      "never claims a successor past a PostgreSQL row lock",
      async () => {
        await seedEvent("locked-head");
        await persistence.appendOutboxEvents([
          {
            workflowRunId: "locked-head",
            eventType: "workflow:created",
            payload: {},
            causationId: "second",
            occurredAt: clock.now(),
          },
        ]);
        const entered = deferred();
        const release = deferred();
        const locker = client.$transaction(async (tx: typeof client) => {
          await rawFor(tx, { id: "text" }).$queryRawUnsafe(
            'SELECT id FROM outbox_events WHERE "workflowRunId" = $1 AND sequence = 1 FOR UPDATE',
            "locked-head",
          );
          entered.release();
          await release.promise;
        });
        const accepted: number[] = [];
        const dispatcher = make({
          async emit(_, metadata) {
            accepted.push(metadata!.sequence);
          },
        });
        try {
          await entered.promise;
          expect(
            (await dispatcher.dispatch({ type: "outbox.flush" })).published,
          ).toBe(0);
          expect(accepted).toEqual([]);
        } finally {
          release.release();
          await locker;
        }
        expect(
          (await dispatcher.dispatch({ type: "outbox.flush" })).published,
        ).toBe(2);
        expect(accepted).toEqual([1, 2]);
      },
    );

    it("preserves per-run order with eight concurrent flushers", async () => {
      const accepted = new Map<string, number[]>();
      const ids = new Set<string>();
      for (let run = 0; run < 6; run++) {
        await persistence.appendOutboxEvents(
          Array.from({ length: 5 }, () => ({
            workflowRunId: `race-${run}`,
            eventType: "workflow:created",
            payload: {},
            causationId: "race",
            occurredAt: clock.now(),
          })),
        );
      }
      const sink = {
        async emit(
          _: unknown,
          delivery?: {
            eventId: string;
            workflowRunId: string;
            sequence: number;
          },
        ) {
          const { eventId, workflowRunId, sequence } = delivery!;
          const rows = accepted.get(workflowRunId) ?? [];
          rows.push(sequence);
          accepted.set(workflowRunId, rows);
          expect(ids.has(eventId)).toBe(false);
          ids.add(eventId);
        },
      };
      const workers = Array.from({ length: 8 }, () =>
        make(sink, storeOver(client)),
      );
      for (let pass = 0; pass < 30 && ids.size < 30; pass++) {
        await Promise.all(
          workers.map((worker) =>
            worker.dispatch({ type: "outbox.flush", maxEvents: 2 }),
          ),
        );
      }
      expect(accepted.size).toBe(6);
      for (const sequences of accepted.values())
        expect(sequences).toEqual([1, 2, 3, 4, 5]);
      expect(ids.size).toBe(30);
    });

    it("retries an ambiguous sink acknowledgement using the same outbox identity", async () => {
      await seedEvent("ambiguous");
      const accepted: Array<{ id: string; attempt: number }> = [];
      const sink = {
        async emit(
          _: unknown,
          delivery?: { eventId: string; attempt: number },
        ) {
          accepted.push({ id: delivery!.eventId, attempt: delivery!.attempt });
          if (accepted.length === 1) throw new Error("lost acknowledgement");
        },
      };
      const dispatcher = make(sink);
      expect((await dispatcher.dispatch({ type: "outbox.flush" })).failed).toBe(
        1,
      );
      expect(
        (await dispatcher.dispatch({ type: "outbox.flush" })).published,
      ).toBe(1);
      expect(accepted.map(({ attempt }) => attempt)).toEqual([1, 2]);
      expect(accepted[0]?.id).toBe(accepted[1]?.id);
    });

    it("delivers already claimed successors before replay and unclaimed successors after replay", async () => {
      await seedEvent("replay-order");
      await persistence.appendOutboxEvents([
        ...[2, 3].map((sequence) => ({
          workflowRunId: "replay-order",
          eventType: "workflow:created",
          payload: { type: "workflow:created", workflowRunId: "replay-order" },
          causationId: `successor-${sequence}`,
          occurredAt: clock.now(),
        })),
      ]);
      expect((await flush()).deadLettered).toBe(1);
      const entered = deferred();
      const resume = deferred();
      const store = storeOver(client);
      const claim = store.claimOutboxDelivery.bind(store);
      store.claimOutboxDelivery = async (...args) => {
        const rows = await claim(...args);
        entered.release();
        await resume.promise;
        return rows;
      };
      const accepted: number[] = [];
      const sink = {
        async emit(_: unknown, delivery?: { sequence: number }) {
          accepted.push(delivery!.sequence);
        },
      };
      const later = make(sink, store).dispatch({
        type: "outbox.flush",
        maxEvents: 1,
      });
      try {
        await entered.promise;
        expect((await replay()).replayed).toBe(1);
        expect(
          (await make(sink).dispatch({ type: "outbox.flush" })).published,
        ).toBe(0);
      } finally {
        resume.release();
      }
      expect((await later).published).toBe(1);
      expect(
        (await make(sink).dispatch({ type: "outbox.flush" })).published,
      ).toBe(2);
      expect(accepted).toEqual([2, 1, 3]);
    });

    it.each([
      "$queryRaw",
      "$queryRawUnsafe",
    ] as const)("reads and claims through the single %s capability", async (available) => {
      const statements: string[] = [];
      const singleRead = (prisma: typeof client): typeof client =>
        new Proxy(prisma, {
          get(target, key) {
            if (key === "$withColumns" && target.$withColumns)
              return (...args: unknown[]) =>
                singleRead(target.$withColumns(...args));
            if (key === "$transaction" && target.$transaction)
              return (work: (tx: typeof client) => unknown, options: unknown) =>
                target.$transaction(
                  (tx: typeof client) => work(singleRead(tx)),
                  options,
                );
            if (key === "$queryRaw" || key === "$queryRawUnsafe") {
              if (key !== available) return undefined;
              return (
                sql: string | TemplateStringsArray,
                ...args: unknown[]
              ) => {
                statements.push(typeof sql === "string" ? sql : sql.join("?"));
                return target[key](sql, ...args);
              };
            }
            return Reflect.get(target, key, target);
          },
        });
      const store = storeOver(singleRead(client));
      const append = () =>
        store.appendOutboxEvents([
          {
            workflowRunId: "a-selected",
            eventType: "workflow:created",
            payload: { workflowRunId: "a-selected" },
            causationId: "single-read",
            occurredAt: clock.now(),
          },
        ]);
      await append();
      await append();
      await seedEvent("z-excluded");
      expect((await store.getUnpublishedOutboxEvents(1))[0]?.sequence).toBe(1);
      const lease = "2099-01-01T00:00:00.000Z|single-read";
      const claim = () =>
        store.claimOutboxDelivery(2, lease, clock.now(), ["z-excluded"]);
      // The one run takes the whole page: its head and its successor.
      const [first, second] = await claim();
      expect(first).toMatchObject({ workflowRunId: "a-selected", sequence: 1 });
      expect(second).toMatchObject({
        workflowRunId: "a-selected",
        sequence: 2,
      });
      expect(await claim()).toEqual([]);
      expect(
        await store.isOutboxDeliveryClaimActive(first!.id, lease, clock.now()),
      ).toBe(true);
      expect(
        await store.failOutboxDelivery(first!.id, lease, 2, clock.now()),
      ).toBe("retry");
      // The failure released the successor with the head.
      const [retry, next] = await claim();
      expect(retry).toMatchObject({ id: first!.id, retryCount: 1 });
      expect(next).toMatchObject({ id: second!.id });
      expect(
        await store.completeOutboxDelivery(retry!.id, lease, clock.now()),
      ).toBe(true);
      expect(
        await store.completeOutboxDeliveries!([next!.id], lease, clock.now()),
      ).toBe(1);
      expect(await claim()).toEqual([]);
      expect(
        statements.some((sql) => sql.startsWith("WITH RECURSIVE cursor")),
      ).toBe(true);
      expect(
        statements.some((sql) => sql.includes('SET "deliveryClaim"')),
      ).toBe(true);
    });

    it.skipIf(!sqlite)(
      "refuses a SQLite root hiding its raw reads when built, before reading or writing",
      async () => {
        await seedEvent("unverified");
        const row = await client.outboxEvent.findFirst();
        // `deep`: column-typed reads (`$withColumns`, Prisma 8) hide them too;
        // otherwise they still reach raw SQL, so the storage check passes.
        const withoutRawReads = (
          prisma: typeof client,
          deep: boolean,
        ): typeof client =>
          new Proxy(prisma, {
            get(target, key) {
              if (key === "$queryRaw" || key === "$queryRawUnsafe")
                return undefined;
              if (deep && key === "$withColumns" && target.$withColumns)
                return (...args: unknown[]) =>
                  withoutRawReads(target.$withColumns(...args), deep);
              return Reflect.get(target, key, target);
            },
          });
        for (const deep of [true, false])
          expect(() => storeOver(withoutRawReads(client, deep))).toThrow(
            expect.objectContaining({ code: "OUTBOX_CLAIM_UNSUPPORTED" }),
          );
        expect(await client.outboxEvent.findMany()).toEqual([row]);
      },
    );

    it("retains claimed, published and dead-lettered rows after purging their runs", async () => {
      for (const id of ["purged-claimed", "purged-published", "purged-dead"])
        await seedEvent(id);
      const events = await client.outboxEvent.findMany({
        orderBy: { workflowRunId: "asc" },
      });
      const published = events.find(
        (row: { workflowRunId: string }) =>
          row.workflowRunId === "purged-published",
      );
      const dead = events.find(
        (row: { workflowRunId: string }) => row.workflowRunId === "purged-dead",
      );
      await persistence.markOutboxEventsPublished([published.id]);
      await persistence.moveOutboxEventToDLQ(dead.id);
      const expiry = new Date(clock.now().getTime() + 1_000);
      await persistence.claimOutboxDelivery(
        10,
        `${expiry.toISOString()}|purge`,
        clock.now(),
        [],
      );
      await client.workflowRun.updateMany({
        data: { status: "COMPLETED", completedAt: clock.now() },
      });
      expect(
        (
          await kernel.dispatch({
            type: "run.purge",
            olderThan: new Date(clock.now().getTime() + 1),
          })
        ).purged,
      ).toBe(3);
      shouldFail = false;
      expect((await flush()).published).toBe(0);
      expect((await replay()).replayed).toBe(1);
      expect((await flush()).published).toBe(1);
      clock.advance(1_001);
      expect((await flush()).published).toBe(1);
      expect(await client.outboxEvent.count()).toBe(3);
      expect(delivered).toHaveLength(2);
    });

    it("delivers legacy unstamped rows after the schema-only upgrade", async () => {
      await seedEvent("legacy-stamped");
      await client.outboxEvent.updateMany({
        data: { publishedAt: clock.now() },
      });
      await alterSchema(
        'ALTER TABLE outbox_events RENAME COLUMN "deliveryClaim" TO "preUpgradeClaim"',
      );
      try {
        const workflow = defineWorkflow("migration-test", {
          input: z.object({}),
        })
          .stage("stage", {
            schemas: {
              input: z.object({}),
              output: z.object({}),
              config: z.object({}),
            },
            async execute() {
              return { output: {} };
            },
          })
          .build();
        const legacy = createKernel({
          persistence,
          eventSink: runner,
          clock,
          blobStore: new InMemoryBlobStore(),
          jobTransport: new InMemoryJobQueue("migration"),
          registry: { getWorkflow: () => workflow },
        });
        await legacy.dispatch({
          type: "run.create",
          workflowId: workflow.id,
          input: {},
          idempotencyKey: `outbox-legacy-${crypto.randomUUID()}`,
        });
        expect(
          (await legacy.dispatch({ type: "engine.stats" })).outbox,
        ).toMatchObject({ unpublished: 1 });
        await expect(legacy.dispatch({ type: "outbox.flush" })).rejects.toThrow(
          /deliveryClaim/i,
        );
      } finally {
        await restoreDeliverySchema();
      }
      shouldFail = false;
      expect((await flush()).published).toBe(1);
      expect(delivered).toEqual(["workflow:created"]);
    });

    it.skipIf(!sqlite).each(["wal", "delete"])(
      "discards the guide's SQLite upgrade block when its process is killed between statements (%s journal)",
      async (journal) => {
        const guide = await readFile(
          new URL(
            "../../../skills/workflow-engine/migrations/migrate-0.13-to-1.0.md",
            import.meta.url,
          ),
          "utf8",
        );
        const block = guide.match(
          /```sql\n\s*(BEGIN IMMEDIATE;[\s\S]*?COMMIT;)\n/,
        )![1]!;
        const statements = block
          .split(/;\s*\n\s*/)
          .map((s) => s.replace(/;$/, ""));
        expect(statements[0]).toBe("BEGIN IMMEDIATE");
        expect(statements.at(-1)).toBe("COMMIT");
        // node:sqlite needs Node 22.13; below it (CI's Prisma 6/7 floor) use the
        // better-sqlite3 that the Prisma 7 fixture installs. Both APIs fit here.
        const sqliteModule: string = process.getBuiltinModule?.("node:sqlite")
          ? "node:sqlite"
          : createRequire(
              createRequire(
                new URL(
                  "../../../../prisma-fixtures/v7/package.json",
                  import.meta.url,
                ),
              ).resolve("@prisma/adapter-better-sqlite3"),
            ).resolve("better-sqlite3");
        const sqliteLib = createRequire(import.meta.url)(sqliteModule);
        const DatabaseSync = sqliteLib.DatabaseSync ?? sqliteLib;
        // In the child: apply the statements, stop after one of them and wait
        // to be killed. A one-page cache spills the uncommitted pages to disk.
        const child = `const lib = require(${JSON.stringify(sqliteModule)});
          const DatabaseSync = lib.DatabaseSync ?? lib;
          const [file, journal, stop, json] = process.argv.slice(1);
          const db = new DatabaseSync(file);
          db.exec("PRAGMA journal_mode = " + journal + "; PRAGMA cache_size = 1");
          for (const [i, sql] of JSON.parse(json).entries()) {
            db.exec(sql);
            if (i === Number(stop)) {
              process.stdout.write("held\\n");
              setInterval(() => {}, 60000);
              break;
            }
          }`;
        const columns = (db: any) =>
          db
            .prepare("SELECT name FROM pragma_table_info('outbox_events')")
            .all()
            .map((row: { name: string }) => row.name);
        const indexes = (db: any) =>
          db
            .prepare(
              "SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'outbox_events_%' ORDER BY name",
            )
            .all()
            .map((row: { name: string }) => row.name);
        const killAfter = async (file: string, stop: number, sql: string[]) => {
          const proc = spawn(
            process.execPath,
            ["-e", child, file, journal, String(stop), JSON.stringify(sql)],
            { stdio: ["ignore", "pipe", "inherit"] },
          );
          const exited = new Promise((resolve) => proc.on("exit", resolve));
          await Promise.race([
            new Promise<void>((resolve) =>
              proc.stdout.on("data", (chunk) => {
                if (String(chunk).includes("held")) resolve();
              }),
            ),
            exited.then(() => {
              throw new Error("migration process exited before the kill");
            }),
            new Promise((_, reject) =>
              setTimeout(
                () => reject(new Error("no held line in 10 s")),
                10_000,
              ),
            ),
          ]);
          proc.kill("SIGKILL");
          await exited;
        };
        const legacyFile = async (name: string) => {
          const file = join(directory!, `${journal}-${name}.db`);
          const db = new DatabaseSync(file);
          db.exec(`PRAGMA journal_mode = ${journal};
            CREATE TABLE "outbox_events" (id TEXT PRIMARY KEY, "workflowRunId" TEXT NOT NULL,
              sequence INTEGER NOT NULL, "publishedAt" DATETIME, "dlqAt" DATETIME);
            WITH RECURSIVE g(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM g WHERE n < 3000)
            INSERT INTO "outbox_events" SELECT 'e' || n, 'run' || (n % 300), n, NULL, NULL FROM g;`);
          db.close();
          return file;
        };
        const added = [
          "outbox_events_delivery_cursor_idx",
          "outbox_events_delivery_run_idx",
          "outbox_events_live_run_sequence_idx",
        ];

        // Killed inside the transaction after each statement but COMMIT: no
        // trace of the upgrade remains and the block then runs again.
        for (let stop = 1; stop < statements.length - 1; stop++) {
          const file = await legacyFile(`stop-${stop}`);
          await killAfter(file, stop, statements);
          // An index build spills uncommitted pages to disk, which the kill
          // leaves for the next open to undo.
          if (stop > 1)
            expect(
              (await stat(`${file}-${journal === "wal" ? "wal" : "journal"}`))
                .size,
            ).toBeGreaterThan(0);
          const db = new DatabaseSync(file);
          expect(db.prepare("PRAGMA integrity_check").get()).toEqual({
            integrity_check: "ok",
          });
          expect(columns(db)).not.toContain("deliveryClaim");
          expect(indexes(db)).toEqual([]);
          db.exec(`${block}`);
          expect(columns(db)).toContain("deliveryClaim");
          expect(indexes(db)).toEqual(added);
          db.close();
        }

        // Statements run outside a transaction can leave a partial state:
        // the guide's recovery finishes it.
        const file = await legacyFile("unwrapped");
        await killAfter(file, 1, statements.slice(1, -1));
        const db = new DatabaseSync(file);
        expect(columns(db)).toContain("deliveryClaim");
        expect(indexes(db)).toEqual(["outbox_events_delivery_run_idx"]);
        db.exec(
          block
            .replace(/\s*ALTER TABLE[^;]*;/, "")
            .replaceAll("CREATE INDEX", "CREATE INDEX IF NOT EXISTS"),
        );
        expect(indexes(db)).toEqual(added);
        db.close();
      },
      60_000,
    );
    it.skipIf(sqlite)(
      "reserves contiguous sequences across concurrent PostgreSQL appends",
      async () => {
        const events = (cause: string) =>
          [1, 2, 3].map(() => ({
            workflowRunId: "append-race",
            eventType: "workflow:created",
            payload: {},
            causationId: cause,
            occurredAt: clock.now(),
          }));
        const read = deferred();
        let readers = 0;
        const append = (cause: string) =>
          client.$transaction(async (tx: typeof client) => {
            const wrapped = new Proxy(tx, {
              get(target, key) {
                if (key !== "outboxEvent") return Reflect.get(target, key);
                return new Proxy(target.outboxEvent, {
                  get(delegate, method) {
                    if (method !== "findFirst")
                      return Reflect.get(delegate, method);
                    return async (args: unknown) => {
                      const row = await delegate.findFirst(args);
                      if (++readers === 2) read.release();
                      await read.promise;
                      return row;
                    };
                  },
                });
              },
            });
            await storeOver(wrapped).appendOutboxEvents(events(cause));
          });
        await Promise.all([append("a"), append("b")]);
        const rows = await client.outboxEvent.findMany({
          where: { workflowRunId: "append-race" },
          orderBy: { sequence: "asc" },
        });
        expect(rows.map((row: { sequence: number }) => row.sequence)).toEqual([
          1, 2, 3, 4, 5, 6,
        ]);
        expect(
          rows
            .slice(0, 3)
            .map((row: { causationId: string }) => row.causationId),
        ).toEqual(Array(3).fill(rows[0].causationId));
        expect(
          rows.slice(3).map((row: { causationId: string }) => row.causationId),
        ).toEqual(Array(3).fill(rows[3].causationId));
        expect(rows[0].causationId).not.toBe(rows[3].causationId);
      },
    );

    it("derives the next head after SQL changes the earliest unpublished row", async () => {
      await seedEvent("operator");
      await persistence.appendOutboxEvents([
        {
          workflowRunId: "operator",
          eventType: "workflow:created",
          payload: {},
          causationId: "successor",
          occurredAt: clock.now(),
        },
      ]);
      const head = await client.outboxEvent.findFirst({
        where: { workflowRunId: "operator" },
        orderBy: { sequence: "asc" },
      });
      await client.outboxEvent.delete({ where: { id: head.id } });
      const sequences: number[] = [];
      const kernel = make({
        async emit(_, delivery) {
          sequences.push(delivery!.sequence);
        },
      });
      expect((await kernel.dispatch({ type: "outbox.flush" })).published).toBe(
        1,
      );
      expect(sequences).toEqual([2]);
    });

    it("reuses a sequence after an operator deletes the newest row, with a new event ID", async () => {
      await seedEvent("sequence-reuse");
      const append = () =>
        persistence.appendOutboxEvents([
          {
            workflowRunId: "sequence-reuse",
            eventType: "workflow:created",
            payload: {
              type: "workflow:created",
              workflowRunId: "sequence-reuse",
            },
            causationId: "sequence",
            occurredAt: clock.now(),
          },
        ]);
      await append();
      const latest = await client.outboxEvent.findFirst({
        where: { workflowRunId: "sequence-reuse" },
        orderBy: { sequence: "desc" },
      });
      await client.outboxEvent.delete({ where: { id: latest.id } });
      await append();
      const replacement = await client.outboxEvent.findFirst({
        where: { workflowRunId: "sequence-reuse" },
        orderBy: { sequence: "desc" },
      });
      expect(replacement.sequence).toBe(latest.sequence);
      expect(replacement.id).not.toBe(latest.id);
    });
  },
);
