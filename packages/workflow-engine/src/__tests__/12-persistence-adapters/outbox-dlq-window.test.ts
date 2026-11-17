/**
 * Crash, replay and concurrent delivery checks through kernel.dispatch on
 * real SQLite and PostgreSQL adapters for Prisma 6, 7 and 8.
 */

import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
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

    it.each([
      ["publication", false],
      ["publication", true],
      ["retry release", false],
      ["retry release", true],
      ["dead letter", false],
      ["dead letter", true],
    ] as const)("recovers three claimed events after a live-process %s error (committed: %s)", async (operation, committed) => {
      for (let i = 0; i < 3; i++) await seedEvent(`write-error-${i}`);
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
              if (!targetWrite) return target.updateMany(args);
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
        operation === "retry release" && committed ? 1 : 0,
      );
      if (operation === "dead letter" && committed)
        expect((await replay()).replayed).toBe(1);
      clock.advance(60_001);
      await flush();
      expect(new Set(identities).size).toBe(3);
      expect(
        (await rows()).every(
          (row: { publishedAt: Date | null }) => row.publishedAt !== null,
        ),
      ).toBe(true);
      expect(delivered).toHaveLength(
        operation === "publication" && !committed ? 4 : 3,
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
      expect(delivered).toEqual(
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

    it.each([
      "claimOutboxDelivery",
      "isOutboxDeliveryClaimActive",
    ] as const)("warns and skips an expired claim after awaiting %s", async (point) => {
      await seedEvent("expiry");
      const entered = deferred();
      const resume = deferred();
      const slow = storeOver(client);
      const claim = slow.claimOutboxDelivery.bind(slow);
      const check = slow.isOutboxDeliveryClaimActive.bind(slow);
      const wait = async <T>(value: T) => {
        entered.release();
        await resume.promise;
        return value;
      };
      if (point === "claimOutboxDelivery")
        slow.claimOutboxDelivery = async (...args) =>
          wait(await claim(...args));
      else
        slow.isOutboxDeliveryClaimActive = async (...args) =>
          wait(await check(...args));
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

    it("allows a claimed successor to arrive after a dead letter is replayed", async () => {
      await seedEvent("replay-order");
      await persistence.appendOutboxEvents([
        {
          workflowRunId: "replay-order",
          eventType: "workflow:created",
          payload: { type: "workflow:created", workflowRunId: "replay-order" },
          causationId: "second",
          occurredAt: clock.now(),
        },
      ]);
      expect((await flush()).deadLettered).toBe(1);
      const entered = deferred();
      const resume = deferred();
      const store = storeOver(client);
      const check = store.isOutboxDeliveryClaimActive.bind(store);
      store.isOutboxDeliveryClaimActive = async (...args) => {
        const active = await check(...args);
        entered.release();
        await resume.promise;
        return active;
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
      ).toBe(1);
      expect(accepted).toEqual([2, 1]);
    });

    it("claims an independent run through a delegate-only client despite a large blocked run", async () => {
      await seedEvent("a-blocked");
      await persistence.appendOutboxEvents(
        Array.from({ length: 100 }, (_, i) => ({
          workflowRunId: "a-blocked",
          eventType: "workflow:created",
          payload: {},
          causationId: String(i),
          occurredAt: clock.now(),
        })),
      );
      await seedEvent("z-ready");
      const token = "2099-01-01T00:00:00.000Z|held";
      expect(
        (
          await persistence.claimOutboxDelivery(1, token, clock.now(), [
            "z-ready",
          ])
        )[0]?.workflowRunId,
      ).toBe("a-blocked");
      const wrapper = new Proxy(client, {
        get(target, key) {
          if (key === "$queryRawUnsafe") return undefined;
          return Reflect.get(target, key, target);
        },
      });
      const sink = {
        async emit(event: { workflowRunId?: string }) {
          delivered.push(event.workflowRunId!);
        },
      };
      expect(
        (
          await make(sink, storeOver(wrapper)).dispatch({
            type: "outbox.flush",
          })
        ).published,
      ).toBe(1);
      expect(delivered).toEqual(["z-ready"]);
    });

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

    it("lets the old schema commit events, fails the first flush, and schedules live rows during upgrade", async () => {
      const names = sqlite
        ? ["insert", "resolve", "replay", "delete"].map(
            (suffix) => `workflow_engine_outbox_${suffix}`,
          )
        : ["workflow_engine_outbox_head"];
      const companion = fileURLToPath(
        new URL(
          `../../../prisma/outbox-heads.${sqlite ? "sqlite" : "postgresql"}.sql`,
          import.meta.url,
        ),
      );
      const migrate = async () => {
        await client.$executeRawUnsafe(
          'ALTER TABLE outbox_events RENAME COLUMN "preUpgradeClaim" TO "deliveryClaim"',
        );
        if (sqlite) {
          const fixture = createRequire(import.meta.url)(
            "../../../../prisma-fixtures/schema.cjs",
          );
          fixture.installOutboxHeads(join(directory!, "dlq.db"));
        } else {
          execFileSync(
            "psql",
            [
              databaseUrl!,
              "-v",
              "ON_ERROR_STOP=1",
              "--single-transaction",
              "-f",
              companion,
            ],
            { stdio: "pipe" },
          );
        }
      };
      await seedEvent("legacy-stamped");
      await client.outboxEvent.updateMany({
        data: { publishedAt: clock.now() },
      });
      for (const name of names)
        await client.$executeRawUnsafe(
          `DROP TRIGGER ${name}${sqlite ? "" : " ON outbox_events"}`,
        );
      await client.$executeRawUnsafe(
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
          idempotencyKey: "outbox-legacy",
        });
        expect(
          (await legacy.dispatch({ type: "engine.stats" })).outbox,
        ).toMatchObject({ unpublished: 1 });
        await expect(legacy.dispatch({ type: "outbox.flush" })).rejects.toThrow(
          /deliveryClaim/i,
        );
      } finally {
        await migrate();
      }
      shouldFail = false;
      expect((await flush()).published).toBe(1);
      expect(delivered).toEqual(["workflow:created"]);
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
