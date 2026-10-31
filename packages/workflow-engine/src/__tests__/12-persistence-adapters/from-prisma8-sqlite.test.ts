/** The Prisma 8 shim against the full engine contract on real SQLite files. */
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { fromPrisma8 } from "../../persistence/prisma/from-prisma8.js";
import {
  isSerializationFailure,
  isUniqueViolation,
} from "../../persistence/prisma/sql-errors.js";

const require = createRequire(import.meta.url);
const fixtureDir = process.env.PRISMA8_SQLITE_FIXTURE
  ? resolve(process.env.PRISMA8_SQLITE_FIXTURE)
  : join(
      dirname(require.resolve("../../../../prisma-fixtures/index.cjs")),
      "v8-sqlite",
    );
const run = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  workflowId: "wf",
  workflowName: "wf",
  workflowType: "t",
  input: {},
  ...extra,
});
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe.skipIf(process.env.PRISMA_MAJOR !== "8")(
  "fromPrisma8 on SQLite",
  () => {
    let dir: string;
    let db: any;
    let prisma: any;
    beforeAll(async () => {
      dir = mkdtempSync(join(tmpdir(), "workflow-prisma8-shim-"));
      const file = join(dir, "engine.db");
      db = await require(join(fixtureDir, "index.cjs")).createSqliteDb(file);
      prisma = fromPrisma8(db);
    }, 30_000);
    afterAll(async () => {
      await db?.close();
      if (dir) rmSync(dir, { recursive: true, force: true });
    });
    beforeEach(async () => {
      for (const model of [
        "workflowAnnotation",
        "workflowArtifact",
        "workflowLog",
        "workflowStep",
        "workflowStage",
        "workflowRun",
        "outboxEvent",
        "idempotencyKey",
        "jobQueue",
        "aICall",
        "workflowDefinition",
        "workflowBlob",
      ])
        await prisma[model].deleteMany({});
    });

    it("exposes readonly target metadata on roots, transactions and raw views", async () => {
      expect(prisma.$databaseType).toBe("sqlite");
      expect(prisma.$withColumns("workflow_runs").$databaseType).toBe("sqlite");
      expect(() => {
        prisma.$databaseType = "postgresql";
      }).toThrow();
      await prisma.$transaction(
        async (tx: any) => {
          expect(tx.$databaseType).toBe("sqlite");
          expect(tx.$withColumns({ n: "int" }).$databaseType).toBe("sqlite");
          expect(tx.$transaction).toBeUndefined();
        },
        { isolationLevel: "Serializable" },
      );
      await expect(
        prisma.$transaction(async () => {}, {
          isolationLevel: "ReadCommitted",
        }),
      ).rejects.toThrow(/SQLite.*Serializable/);
    });

    it("uses the full contract's id and timestamp generators, defaults and update hooks", async () => {
      const first = await prisma.workflowRun.create({ data: run("defaults") });
      expect(first).toMatchObject({
        status: "PENDING",
        priority: 5,
        config: {},
        version: 1,
      });
      expect(first.createdAt).toBeInstanceOf(Date);
      expect(first.updatedAt).toBeInstanceOf(Date);
      const [a, b] = await Promise.all(
        ["a", "b"].map((message) =>
          prisma.workflowLog.create({ data: { level: "INFO", message } }),
        ),
      );
      expect(a.id < b.id).toBe(true);
      await pause(5);
      const changed = await prisma.workflowRun.update({
        where: { id: first.id },
        data: { priority: 9.9 },
      });
      expect(changed.priority).toBe(9);
      expect(changed.updatedAt.getTime()).toBeGreaterThan(
        first.updatedAt.getTime(),
      );

      const stage = await prisma.workflowStage.create({
        data: {
          workflowRunId: first.id,
          stageId: "s",
          stageName: "s",
          stageNumber: 1,
          executionGroup: 1,
        },
      });
      const data: Record<string, Record<string, unknown>> = {
        workflowStep: {
          stageRecordId: stage.id,
          stepId: "step",
          seq: 1,
          kind: "run",
          status: "PENDING",
        },
        workflowArtifact: {
          workflowRunId: first.id,
          key: "artifact",
          type: "json",
          data: {},
          size: 2,
        },
        workflowAnnotation: {
          workflowRunId: first.id,
          scope: "run",
          key: "k",
          value: {},
        },
        jobQueue: { workflowRunId: first.id, stageId: "s" },
        outboxEvent: {
          workflowRunId: first.id,
          sequence: 1,
          eventType: "started",
          payload: {},
          causationId: "c",
          occurredAt: new Date(),
        },
        idempotencyKey: { key: "k", commandType: "c", result: {} },
        aICall: {
          topic: "t",
          callType: "c",
          modelKey: "m",
          modelId: "m",
          prompt: "p",
          response: "r",
          inputTokens: 1,
          outputTokens: 1,
          cost: 0,
        },
        workflowDefinition: {
          workflowId: "wf",
          version: "v",
          snapshot: {},
          structureHash: "h",
        },
        workflowBlob: { key: "blob", data: {} },
      };
      for (const [model, row] of Object.entries(data)) {
        const created = await prisma[model].create({ data: row });
        expect(created.createdAt).toBeInstanceOf(Date);
        if ("updatedAt" in created)
          expect(created.updatedAt).toBeInstanceOf(Date);
        if ("id" in created) expect(typeof created.id).toBe("string");
      }
    });

    it("accepts a contract without execution defaults when values are supplied", async () => {
      const contract = structuredClone(db.contract);
      delete contract.execution;
      const own: any = fromPrisma8(
        Object.create(db, { contract: { value: contract } }),
      );
      const at = new Date("2026-04-01T12:34:56.789Z");
      const row = await own.workflowRun.create({
        data: run("explicit", { createdAt: at, updatedAt: at }),
      });
      expect(row.createdAt).toEqual(at);
      expect(row.updatedAt).toEqual(at);
    });

    it("names the SQLite namespace, timestamp and text-status contract requirements", () => {
      const changed = (change: (contract: any) => void) => {
        const contract = structuredClone(db.contract);
        change(contract);
        return () =>
          fromPrisma8(Object.create(db, { contract: { value: contract } }));
      };
      expect(
        changed((c) => {
          c.target = "other";
        }),
      ).toThrow(/unsupported contract target/);
      expect(
        changed((c) => {
          delete c.domain.namespaces.__unbound__;
        }),
      ).toThrow(/`__unbound__`/);
      expect(
        changed((c) => {
          c.storage.namespaces.__unbound__.entries.table.workflow_runs.columns.createdAt.codecId =
            "pg/timestamp-string@1";
        }),
      ).toThrow(/workflow_runs.createdAt.*DateTime/);
      expect(
        changed((c) => {
          c.storage.namespaces.__unbound__.entries.table.job_queue.columns.status.codecId =
            "sqlite/integer@1";
        }),
      ).toThrow(/job_queue.status.*String/);
    });

    it("binds dates without losing milliseconds and returns native raw types", async () => {
      const at = new Date("2026-04-01T12:34:56.789Z");
      await prisma.workflowRun.create({
        data: run("instant", { startedAt: at }),
      });
      const raw = prisma.$withColumns({
        startedAt: "timestamp",
        total: "bigint",
        yes: "bool",
        cost: "float",
        doc: "json",
        missing: "text",
      });
      expect(
        await raw.$queryRaw`
      SELECT ${at} AS startedAt, CAST(9007199254740993 AS TEXT) AS total, ${true} AS yes,
             1.25 AS cost, '{"a":1}' AS doc, ${null} AS missing`,
      ).toEqual([
        {
          startedAt: at,
          total: 9007199254740993n,
          yes: true,
          cost: 1.25,
          doc: { a: 1 },
          missing: null,
        },
      ]);
      expect(
        (
          await prisma
            .$withColumns("workflow_runs")
            .$queryRawUnsafe('SELECT * FROM "workflow_runs"')
        )[0].startedAt,
      ).toEqual(at);
      expect(
        await prisma.workflowRun.count({
          where: { startedAt: { equals: at } },
        }),
      ).toBe(1);
      expect(
        await prisma.workflowRun.count({ where: { startedAt: { in: [at] } } }),
      ).toBe(1);
      const [repeated] = await prisma
        .$withColumns({ a: "text", b: "text" })
        .$queryRawUnsafe("SELECT $1 AS a, $2 || $1 AS b", "x", "y");
      expect(repeated).toEqual({ a: "x", b: "yx" });
      await expect(prisma.$queryRaw`SELECT 1`).rejects.toThrow(
        /declare its result columns/,
      );
    });

    it("compiles text, numeric, nullable, JSON and relation filters and aggregates", async () => {
      await prisma.workflowRun.createMany({
        data: [
          run("a", { priority: 1, status: "PENDING", input: { batch: "one" } }),
          run("b", {
            priority: 3,
            status: "RUNNING",
            startedAt: new Date(),
            input: { batch: "two" },
          }),
          run("c", { priority: 5, workflowId: "other" }),
        ],
      });
      const ids = async (where: any) =>
        (
          await prisma.workflowRun.findMany({
            where,
            select: { id: true },
            orderBy: { id: "asc" },
          })
        ).map((r: any) => r.id);
      expect(await ids({ status: { in: ["PENDING"] } })).toEqual(["a", "c"]);
      expect(await ids({ status: { in: [] } })).toEqual([]);
      expect(await ids({ status: { notIn: [] } })).toEqual(["a", "b", "c"]);
      expect(await ids({ priority: { gt: 1, lte: 3 } })).toEqual(["b"]);
      expect(
        await ids({ OR: [{ startedAt: { not: null } }, { priority: 5 }] }),
      ).toEqual(["b", "c"]);
      expect(
        await ids({ workflowId: { startsWith: "wf" }, startedAt: null }),
      ).toEqual(["a"]);
      expect(await ids({ input: { equals: { batch: "one" } } })).toEqual(["a"]);
      expect(await ids({ input: { path: ["batch"], equals: "two" } })).toEqual([
        "b",
      ]);
      await prisma.workflowStage.create({
        data: {
          workflowRunId: "a",
          stageId: "s",
          stageName: "s",
          stageNumber: 1,
          executionGroup: 1,
        },
      });
      expect(await ids({ stages: { none: {} } })).toEqual(["b", "c"]);
      expect(
        await prisma.workflowStage.findUnique({
          where: {
            workflowRunId_stageId: { workflowRunId: "a", stageId: "s" },
          },
          select: { status: true },
        }),
      ).toEqual({ status: "PENDING" });
      expect(
        await prisma.workflowRun.findUnique({
          where: { id: "a" },
          select: { stages: { select: { stageId: true } } },
        }),
      ).toEqual({ stages: [{ stageId: "s" }] });
      expect(
        await prisma.workflowRun.aggregate({
          _max: { priority: true },
          _count: { _all: true },
        }),
      ).toEqual({ _max: { priority: 5 }, _count: { _all: 3 } });
      expect(
        await prisma.workflowRun.groupBy({
          by: ["workflowId"],
          _count: { _all: true },
        }),
      ).toEqual(
        expect.arrayContaining([
          { workflowId: "wf", _count: { _all: 2 } },
          { workflowId: "other", _count: { _all: 1 } },
        ]),
      );
    });

    it("fills omitted values in heterogeneous createMany rows and skips duplicate keys", async () => {
      await prisma.workflowRun.createMany({
        data: [run("one"), run("two", { priority: 2, metadata: { k: 1 } })],
      });
      expect(
        await prisma.workflowRun.findUnique({ where: { id: "one" } }),
      ).toMatchObject({ priority: 5, metadata: null });
      expect(
        await prisma.workflowRun.createMany({
          data: [run("one")],
          skipDuplicates: true,
        }),
      ).toEqual({ count: 0 });
      expect(
        await prisma.workflowRun.upsert({
          where: { id: "one" },
          create: run("one"),
          update: { version: { increment: 1 }, priority: { decrement: 1 } },
        }),
      ).toMatchObject({ version: 2, priority: 4 });
      const row = { key: "k", commandType: "c", result: {} };
      const where = { key_commandType: { key: "k", commandType: "c" } };
      await prisma.idempotencyKey.upsert({
        where,
        create: row,
        update: { result: { value: 1 } },
      });
      expect(
        (
          await prisma.idempotencyKey.upsert({
            where,
            create: row,
            update: { result: { value: 2 } },
          })
        ).result,
      ).toEqual({ value: 2 });
    });

    it("chunks at SQLite's 32766 binds and rolls back every chunk on a later violation", async () => {
      const data = Array.from({ length: 5000 }, (_, i) => run(`chunk-${i}`));
      await prisma.workflowRun.create({ data: run("chunk-4999") });
      await expect(prisma.workflowRun.createMany({ data })).rejects.toSatisfy(
        isUniqueViolation,
      );
      expect(await prisma.workflowRun.count()).toBe(1);
      expect(
        await prisma.workflowRun.createMany({ data, skipDuplicates: true }),
      ).toEqual({ count: 4999 });
      expect(await prisma.workflowRun.count()).toBe(5000);
      expect(
        await prisma.workflowRun.count({
          where: {
            id: {
              in: [
                "chunk-1",
                ...Array.from({ length: 40_000 }, (_, i) => `missing-${i}`),
              ],
            },
          },
        }),
      ).toBe(1);
    });

    it("preserves unique and foreign key errors and maps missing mutations to P2025", async () => {
      await prisma.workflowRun.create({ data: run("duplicate") });
      await expect(
        prisma.workflowRun.create({ data: run("duplicate") }),
      ).rejects.toSatisfy(isUniqueViolation);
      await prisma.workflowRun.create({ data: run("second") });
      await expect(
        prisma.$executeRawUnsafe(
          "UPDATE workflow_runs SET id = $1 WHERE id = $2",
          "duplicate",
          "second",
        ),
      ).rejects.toSatisfy(isUniqueViolation);
      await expect(
        prisma.workflowStage.create({
          data: {
            workflowRunId: "missing",
            stageId: "s",
            stageName: "s",
            stageNumber: 1,
            executionGroup: 1,
          },
        }),
      ).rejects.toMatchObject({ sqlState: "23503" });
      await expect(
        prisma.workflowRun.update({
          where: { id: "missing" },
          data: { priority: 2 },
        }),
      ).rejects.toMatchObject({ code: "P2025" });
      await expect(
        prisma.workflowRun.delete({ where: { id: "missing" } }),
      ).rejects.toMatchObject({ code: "P2025" });
      expect(
        await prisma.workflowRun.findUnique({ where: { id: "missing" } }),
      ).toBeNull();
      expect(
        await prisma.workflowRun.updateMany({
          where: { id: "missing" },
          data: { priority: 2 },
        }),
      ).toEqual({ count: 0 });
    });

    it("shares one write queue across repeated wrappers, views and every root write path", async () => {
      await prisma.workflowRun.create({ data: run("counter") });
      let release!: () => void;
      let entered!: () => void;
      const ready = new Promise<void>((r) => {
        entered = r;
      });
      const held = new Promise<void>((r) => {
        release = r;
      });
      const transaction = prisma.$transaction(async (tx: any) => {
        await tx.workflowRun.update({
          where: { id: "counter" },
          data: { version: { increment: 1 } },
        });
        entered();
        await held;
      });
      await ready;
      const writes = Array.from({ length: 120 }, (_, i) => {
        const own: any = fromPrisma8(db);
        if (i % 5 === 0)
          return own.workflowRun.update({
            where: { id: "counter" },
            data: { version: { increment: 1 } },
          });
        if (i % 5 === 1)
          return own
            .$withColumns("workflow_runs")
            .$executeRawUnsafe(
              "UPDATE workflow_runs SET version = version + 1 WHERE id = $1",
              "counter",
            );
        if (i % 5 === 2)
          return own.$executeRaw`UPDATE workflow_runs SET version = version + 1 WHERE id = ${"counter"}`;
        if (i % 5 === 3)
          return own
            .$withColumns({ version: "int" })
            .$queryRawUnsafe(
              "WITH selected AS (SELECT id FROM workflow_runs WHERE id = $1) UPDATE workflow_runs SET version = version + 1 WHERE id IN (SELECT id FROM selected) RETURNING version",
              "counter",
            );
        return own
          .$withColumns({ version: "int" })
          .$queryRawUnsafe(
            "/* write */ UPDATE workflow_runs SET version = version + 1 WHERE id = $1 RETURNING version",
            "counter",
          );
      });
      const pending = Promise.all(writes);
      // A root read proceeds while the uncommitted transaction holds the queue.
      expect(
        (await prisma.workflowRun.findUnique({ where: { id: "counter" } }))
          .version,
      ).toBe(1);
      expect(
        await prisma
          .$withColumns({ version: "int" })
          .$queryRawUnsafe(
            "-- root read\n WITH selected AS (SELECT version FROM workflow_runs WHERE id = $1) SELECT version FROM selected",
            "counter",
          ),
      ).toEqual([{ version: 1 }]);
      release();
      await transaction;
      expect(await pending).toHaveLength(120);
      expect(
        (await prisma.workflowRun.findUnique({ where: { id: "counter" } }))
          .version,
      ).toBe(122);
    });

    it("serializes 120 full callback transactions, including their async pauses", async () => {
      await prisma.workflowRun.create({ data: run("counter") });
      const results = await Promise.all(
        Array.from({ length: 120 }, (_, i) => {
          const own: any = fromPrisma8(db);
          return own.$transaction(
            async (tx: any) => {
              await tx.workflowRun.update({
                where: { id: "counter" },
                data: { version: { increment: 1 } },
              });
              await pause(1);
              return (
                await tx.workflowRun.findUnique({ where: { id: "counter" } })
              ).version;
            },
            { isolationLevel: "Serializable" },
          );
        }),
      );
      expect(results).toEqual(Array.from({ length: 120 }, (_, i) => i + 2));
    });

    it("queues 100 lazy batches, including raw writes, and rolls a failed batch back", async () => {
      await prisma.workflowRun.create({ data: run("counter") });
      await Promise.all(
        Array.from({ length: 100 }, () =>
          prisma.$transaction([
            prisma.workflowRun.update({
              where: { id: "counter" },
              data: { version: { increment: 1 } },
            }),
            prisma.$executeRaw`UPDATE workflow_runs SET version = version + 1 WHERE id = ${"counter"}`,
          ]),
        ),
      );
      expect(
        (await prisma.workflowRun.findUnique({ where: { id: "counter" } }))
          .version,
      ).toBe(201);
      const lazy = prisma.workflowRun.create({ data: run("rolled-back") });
      expect(await prisma.workflowRun.count()).toBe(1);
      await expect(
        prisma.$transaction([
          lazy,
          prisma.workflowRun.create({ data: run("counter") }),
        ]),
      ).rejects.toSatisfy(isUniqueViolation);
      expect(await prisma.workflowRun.count()).toBe(1);
    });

    it.each([
      "delegate",
      "raw",
      "transaction",
      "batch",
    ])("expires a same-queue %s deadlock through P2028 without a delayed write", async (kind) => {
      let attempted = false;
      await expect(
        prisma.$transaction(
          async (tx: any) => {
            await tx.workflowRun.create({ data: run("rolled-back") });
            const own: any = fromPrisma8(db).$withColumns("workflow_runs");
            attempted = true;
            if (kind === "delegate")
              await own.workflowRun.create({ data: run("late") });
            if (kind === "raw")
              await own.$executeRaw`DELETE FROM workflow_runs`;
            if (kind === "transaction")
              await own.$transaction(async (inner: any) =>
                inner.workflowRun.create({ data: run("late") }),
              );
            if (kind === "batch")
              await own.$transaction([
                own.workflowRun.create({ data: run("late") }),
              ]);
          },
          { timeout: 100 },
        ),
      ).rejects.toMatchObject({ code: "P2028" });
      expect(attempted).toBe(true);
      // Flush the queue, proving the timed-out root operation cannot run later.
      await prisma.workflowLog.create({
        data: { level: "INFO", message: "after" },
      });
      expect(await prisma.workflowRun.count()).toBe(0);
      await prisma.workflowRun.create({ data: run("recovered") });
      expect(await prisma.workflowRun.count()).toBe(1);
    });

    it("guards the transaction client after a timeout and rolls back callback errors", async () => {
      let tx: any;
      await expect(
        prisma.$transaction(
          async (bound: any) => {
            tx = bound;
            await bound.workflowRun.create({ data: run("expired") });
            await pause(40);
            await bound.workflowRun.count();
          },
          { timeout: 15 },
        ),
      ).rejects.toMatchObject({ code: "P2028" });
      await expect(tx.workflowRun.count()).rejects.toMatchObject({
        code: "P2028",
      });
      await expect(
        prisma.$transaction(async (bound: any) => {
          await bound.workflowRun.create({ data: run("callback") });
          throw new Error("stop");
        }),
      ).rejects.toThrow("stop");
      expect(await prisma.workflowRun.count()).toBe(0);
    });

    it("joins a consumer's db.transaction for atomic ORM, delegate and raw writes", async () => {
      const work = async (tx: any) => {
        await tx.orm.WorkflowLog.create({ level: "INFO", message: "consumer" });
        const own: any = fromPrisma8(tx, { contract: db.contract });
        expect(own.$databaseType).toBe("sqlite");
        await own.workflowRun.create({ data: run("consumer") });
        await own.$executeRaw`UPDATE workflow_runs SET priority = ${7} WHERE id = ${"consumer"}`;
        expect(
          (
            await own
              .$withColumns("workflow_runs")
              .$queryRawUnsafe("SELECT * FROM workflow_runs")
          )[0].priority,
        ).toBe(7);
      };
      await expect(
        db.transaction(async (tx: any) => {
          await work(tx);
          throw new Error("stop");
        }),
      ).rejects.toThrow("stop");
      expect(await prisma.workflowRun.count()).toBe(0);
      expect(await prisma.workflowLog.count()).toBe(0);
      await db.transaction(work);
      expect(await prisma.workflowRun.count()).toBe(1);
      expect(await prisma.workflowLog.count()).toBe(1);
    });

    it("preserves the driver's transient lock error from an unwrapped consumer transaction", async () => {
      await prisma.workflowRun.create({ data: run("lock") });
      await prisma
        .$withColumns({ timeout: "int" })
        .$queryRawUnsafe("PRAGMA busy_timeout = 1");
      try {
        await db.transaction(async (tx: any) => {
          const own: any = fromPrisma8(tx, { contract: db.contract });
          await own.workflowRun.update({
            where: { id: "lock" },
            data: { priority: 8 },
          });
          const error = await prisma.workflowRun
            .update({ where: { id: "lock" }, data: { priority: 9 } })
            .catch((e: unknown) => e);
          expect(error).toMatchObject({ transient: true });
          expect(isSerializationFailure(error)).toBe(false);
        });
        expect(
          (await prisma.workflowRun.findUnique({ where: { id: "lock" } }))
            .priority,
        ).toBe(8);
      } finally {
        await prisma
          .$withColumns({ timeout: "int" })
          .$queryRawUnsafe("PRAGMA busy_timeout = 5000");
      }
    });
  },
);
