/**
 * `fromPrisma8` against a real Prisma 8 client and Postgres: the filter
 * compiler, raw parameters, lazy `$transaction([...])` batches and the
 * construction checks. The adapters' own suites cover the rest on every major;
 * this file only runs on PRISMA_MAJOR=8 with DATABASE_URL set.
 */
import { createRequire } from "node:module";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createPrismaJobQueue,
  createPrismaWorkflowPersistence,
  fromPrisma8,
} from "../../persistence/prisma/index.js";
import { rawFor } from "../../persistence/prisma/prisma-client-type.js";
import { createPostgresClient, isPrisma8 } from "../utils/postgres-client.js";

const DATABASE_URL = process.env.DATABASE_URL as string;

describe.skipIf(!DATABASE_URL || !isPrisma8)(
  "I want fromPrisma8 to behave like a Prisma client",
  () => {
    let prisma: any;
    beforeAll(() => {
      prisma = createPostgresClient(DATABASE_URL);
    });
    afterAll(() => prisma?.$disconnect());
    beforeEach(async () => {
      await prisma.$executeRawUnsafe(
        `TRUNCATE TABLE "job_queue", "workflow_annotations", "workflow_stages", "workflow_runs", "ai_calls", "idempotency_keys", "outbox_events" RESTART IDENTITY CASCADE`,
      );
    });

    const run = (id: string, extra: Record<string, unknown> = {}) => ({
      id,
      workflowId: "wf",
      workflowName: "wf",
      workflowType: "t",
      input: {},
      ...extra,
    });
    const ids = async (where: Record<string, unknown>) =>
      (
        await prisma.workflowRun.findMany({
          where,
          select: { id: true },
          orderBy: { id: "asc" },
        })
      ).map((row: { id: string }) => row.id);

    describe("raw SQL", () => {
      it("binds arrays as Postgres array literals with quotes, commas and backslashes intact", async () => {
        const tricky = ["a,b", 'say "hi"', "back\\slash", "", "NULL", "{x}"];
        const rows = await rawFor(prisma, { item: "text" }).$queryRaw`
          SELECT item FROM unnest(${tricky}::text[]) WITH ORDINALITY AS t(item, i) ORDER BY i`;
        expect(rows.map((row: { item: string }) => row.item)).toEqual(tricky);
        const [empty] = await rawFor(prisma, { n: "int" }).$queryRaw`
          SELECT cardinality(${[]}::text[]) AS n`;
        expect(empty.n).toBe(0);
      });

      it("binds a repeated $n to the same value", async () => {
        const [row] = await rawFor(prisma, {
          a: "text",
          b: "text",
        }).$queryRawUnsafe(
          "SELECT $1::text AS a, $2::text || $1::text AS b",
          "x",
          "y",
        );
        expect(row).toEqual({ a: "x", b: "yx" });
      });

      it("binds a Date as its instant and null as NULL, and returns timestamps as Date and int8 as bigint", async () => {
        const when = new Date("2026-03-01T12:00:00.000Z");
        const [row] = await rawFor(prisma, {
          at: "timestamp",
          missing: "text",
          total: "bigint",
          doc: "json",
        }).$queryRaw`
          SELECT (${when}::timestamptz AT TIME ZONE 'UTC') AS at, ${null}::text AS missing,
                 count(*) AS total, '{"a":1}'::jsonb AS doc FROM workflow_runs`;
        expect(row).toEqual({
          at: when,
          missing: null,
          total: 0n,
          doc: { a: 1 },
        });
      });

      it("throws, rather than returning empty rows, when a raw read declares no columns", async () => {
        await expect(prisma.$queryRaw`SELECT 1 AS x`).rejects.toThrow(
          /declare its result columns/,
        );
      });

      it("derives a table's columns from the contract", async () => {
        await prisma.workflowRun.create({ data: run("derived") });
        const [row] = await rawFor(prisma, "workflow_runs").$queryRawUnsafe(
          `SELECT * FROM "workflow_runs"`,
        );
        expect(row).toMatchObject({
          id: "derived",
          status: "PENDING",
          priority: 5,
          input: {},
        });
        expect(row.createdAt).toBeInstanceOf(Date);
      });
    });

    describe("delegates", () => {
      it("compiles every filter the adapters use", async () => {
        await prisma.workflowRun.createMany({
          data: [
            run("a", { priority: 1, workflowId: "wf-a", status: "PENDING" }),
            run("b", {
              priority: 2,
              workflowId: "wf-b",
              status: "RUNNING",
              startedAt: new Date("2026-03-01T10:00:00.000Z"),
              input: { k: 1 },
            }),
            run("c", { priority: 3, workflowId: "other", status: "FAILED" }),
          ],
        });
        await prisma.workflowStage.create({
          data: {
            workflowRunId: "a",
            stageId: "s",
            stageName: "s",
            stageNumber: 1,
            executionGroup: 1,
            status: "FAILED",
          },
        });

        expect(await ids({ priority: 2 })).toEqual(["b"]);
        expect(await ids({ priority: { gt: 1, lte: 3 } })).toEqual(["b", "c"]);
        expect(await ids({ priority: { lt: 2 } })).toEqual(["a"]);
        expect(await ids({ priority: { gte: 2 } })).toEqual(["b", "c"]);
        expect(await ids({ status: { in: ["PENDING", "RUNNING"] } })).toEqual([
          "a",
          "b",
        ]);
        expect(await ids({ status: { in: [] } })).toEqual([]);
        expect(await ids({ status: { notIn: ["PENDING"] } })).toEqual([
          "b",
          "c",
        ]);
        expect(await ids({ status: { not: "FAILED" } })).toEqual(["a", "b"]);
        expect(await ids({ startedAt: null })).toEqual(["a", "c"]);
        expect(await ids({ startedAt: { not: null } })).toEqual(["b"]);
        expect(
          await ids({
            startedAt: { lte: new Date("2026-03-01T10:00:00.000Z") },
          }),
        ).toEqual(["b"]);
        expect(
          await ids({ OR: [{ priority: 1 }, { workflowId: "wf-b" }] }),
        ).toEqual(["a", "b"]);
        expect(await ids({ OR: [] })).toEqual([]);
        expect(await ids({ workflowId: { startsWith: "wf-" } })).toEqual([
          "a",
          "b",
        ]);
        expect(await ids({ workflowId: { contains: "ther" } })).toEqual(["c"]);
        expect(await ids({ input: { equals: { k: 1 } } })).toEqual(["b"]);
        // A relation with no row matching, and a filter on the related row.
        expect(await ids({ stages: { none: {} } })).toEqual(["b", "c"]);
        expect(await ids({ stages: { none: { status: "RUNNING" } } })).toEqual([
          "a",
          "b",
          "c",
        ]);
        expect(
          (
            await prisma.workflowStage.findMany({
              where: { workflowRun: { workflowId: "wf-a" } },
            })
          ).map((stage: { workflowRunId: string }) => stage.workflowRunId),
        ).toEqual(["a"]);
        // Compound unique keys.
        expect(
          await prisma.workflowStage.findUnique({
            where: {
              workflowRunId_stageId: { workflowRunId: "a", stageId: "s" },
            },
            select: { status: true },
          }),
        ).toEqual({ status: "FAILED" });
      });

      it("compiles the JSON path filter", async () => {
        await prisma.aICall.createMany({
          data: ["one", "two"].map((batch) => ({
            topic: "t",
            callType: "c",
            modelKey: "m",
            modelId: "m",
            prompt: "p",
            response: "r",
            inputTokens: 1,
            outputTokens: 1,
            cost: 0,
            metadata: { batchId: batch },
          })),
        });
        const count = (batch: string) =>
          prisma.aICall.count({
            where: { metadata: { path: ["batchId"], equals: batch } },
          });
        expect(await count("one")).toBe(1);
        expect(await count("three")).toBe(0);
      });

      it("increments in one statement, so concurrent writers never lose an update", async () => {
        await prisma.workflowRun.create({ data: run("counter") });
        await Promise.all(
          Array.from({ length: 20 }, () =>
            prisma.workflowRun.update({
              where: { id: "counter" },
              data: { version: { increment: 1 } },
            }),
          ),
        );
        const fenced = await Promise.all(
          Array.from({ length: 5 }, () =>
            prisma.workflowRun.updateMany({
              where: { id: "counter", version: 21 },
              data: { version: { increment: 1 }, priority: { decrement: 1 } },
            }),
          ),
        );
        expect(fenced.filter(({ count }) => count === 1)).toHaveLength(1);
        expect(
          await prisma.workflowRun.findUnique({ where: { id: "counter" } }),
        ).toMatchObject({
          version: 22,
          priority: 4,
        });
      });

      it("fills id and timestamps on create, in creation order, and moves updatedAt on update", async () => {
        const first = await prisma.workflowRun.create({ data: run("x") });
        const [a, b] = await Promise.all([
          prisma.workflowLog.create({ data: { level: "INFO", message: "a" } }),
          prisma.workflowLog.create({ data: { level: "INFO", message: "b" } }),
        ]);
        expect(first.createdAt).toBeInstanceOf(Date);
        expect(a.id < b.id).toBe(true);
        await new Promise((resolve) => setTimeout(resolve, 5));
        const updated = await prisma.workflowRun.update({
          where: { id: "x" },
          data: { priority: 9 },
        });
        expect(updated.updatedAt.getTime()).toBeGreaterThan(
          first.updatedAt.getTime(),
        );
      });

      it("answers a missing row like Prisma: null, P2025, a zero count", async () => {
        expect(
          await prisma.workflowRun.findUnique({ where: { id: "none" } }),
        ).toBeNull();
        await expect(
          prisma.workflowRun.update({
            where: { id: "none" },
            data: { priority: 1 },
          }),
        ).rejects.toMatchObject({ code: "P2025" });
        await expect(
          prisma.workflowRun.delete({ where: { id: "none" } }),
        ).rejects.toMatchObject({
          code: "P2025",
        });
        expect(
          await prisma.workflowRun.updateMany({
            where: { id: "none" },
            data: { priority: 1 },
          }),
        ).toEqual({ count: 0 });
        expect(
          await prisma.workflowRun.deleteMany({ where: { id: "none" } }),
        ).toEqual({ count: 0 });
      });

      it("skips duplicates with createMany, upserts on a compound key, and groups", async () => {
        const row = { key: "k", commandType: "c", result: {} };
        expect(await prisma.idempotencyKey.createMany({ data: [row] })).toEqual(
          { count: 1 },
        );
        expect(
          await prisma.idempotencyKey.createMany({
            data: [row],
            skipDuplicates: true,
          }),
        ).toEqual({ count: 0 });
        await expect(
          prisma.idempotencyKey.createMany({ data: [row] }),
        ).rejects.toMatchObject({
          sqlState: "23505",
        });

        const where = { key_commandType: { key: "k", commandType: "c" } };
        const upsert = (value: number) =>
          prisma.idempotencyKey.upsert({
            where,
            create: { ...row, result: { value } },
            update: { result: { value } },
          });
        await upsert(1);
        expect((await upsert(2)).result).toEqual({ value: 2 });
        expect(await prisma.idempotencyKey.count()).toBe(1);

        await prisma.workflowRun.createMany({
          data: [run("g1", { priority: 2 }), run("g2", { priority: 7 })],
        });
        expect(
          await prisma.workflowRun.aggregate({ _max: { priority: true } }),
        ).toEqual({ _max: { priority: 7 } });
        expect(
          await prisma.workflowRun.groupBy({
            by: ["workflowId"],
            _count: { _all: true },
            _min: { createdAt: true },
          }),
        ).toEqual([
          {
            workflowId: "wf",
            _count: { _all: 2 },
            _min: { createdAt: expect.any(Date) },
          },
        ]);
      });

      it("loads a selected relation with its parents", async () => {
        await prisma.workflowRun.createMany({ data: [run("p1"), run("p2")] });
        await prisma.workflowStage.create({
          data: {
            workflowRunId: "p1",
            stageId: "s",
            stageName: "s",
            stageNumber: 1,
            executionGroup: 1,
          },
        });
        const runs = await prisma.workflowRun.findMany({
          select: { id: true, stages: { select: { stageId: true } } },
          orderBy: { id: "asc" },
        });
        expect(runs).toEqual([
          { id: "p1", stages: [{ stageId: "s" }] },
          { id: "p2", stages: [] },
        ]);
        const [stage] = await prisma.workflowStage.findMany({
          include: { workflowRun: { select: { workflowType: true } } },
        });
        expect(stage.workflowRun).toEqual({ workflowType: "t" });
        expect(stage.stageId).toBe("s");
      });

      it("throws on an argument outside the supported subset", async () => {
        await expect(prisma.workflowRun.findMany({ skip: 1 })).rejects.toThrow(
          /skip/,
        );
        await expect(
          prisma.workflowRun.findMany({ where: { AND: [] } }),
        ).rejects.toThrow(/AND/);
        await expect(
          prisma.workflowRun.findMany({
            where: { priority: { between: [1, 2] } },
          }),
        ).rejects.toThrow(/between/);
        await expect(
          prisma.workflowRun.updateMany({
            data: { priority: { multiply: 2 } },
          }),
        ).rejects.toThrow(/multiply/);
      });
    });

    describe("transactions", () => {
      it("runs a delegate call when it is awaited, and not before", async () => {
        const pending = prisma.workflowRun.create({ data: run("lazy") });
        expect(await prisma.workflowRun.count()).toBe(0);
        await pending;
        expect(await prisma.workflowRun.count()).toBe(1);
      });

      it("runs a $transaction([...]) batch in order in one transaction, and rolls it back whole", async () => {
        const results = await prisma.$transaction([
          prisma.workflowRun.create({ data: run("t1") }),
          prisma.workflowRun.deleteMany({ where: { id: "t1" } }),
          prisma.workflowRun.create({ data: run("t2") }),
        ]);
        expect(results.map((result: any) => result.id ?? result.count)).toEqual(
          ["t1", 1, "t2"],
        );

        await expect(
          prisma.$transaction([
            prisma.workflowRun.create({ data: run("t3") }),
            prisma.workflowRun.create({ data: run("t2") }),
          ]),
        ).rejects.toMatchObject({ sqlState: "23505" });
        expect(await ids({})).toEqual(["t2"]);
      });

      it("honours isolationLevel and timeout, and gives the callback a client without $transaction", async () => {
        const seen = await prisma.$transaction(
          async (tx: any) => {
            const [row] = await rawFor(tx, { level: "text" }).$queryRaw`
              SELECT current_setting('transaction_isolation') AS level`;
            return { level: row.level, nested: tx.$transaction };
          },
          { isolationLevel: "Serializable", timeout: 5_000 },
        );
        expect(seen).toEqual({ level: "serializable", nested: undefined });

        await expect(
          prisma.$transaction(
            async (tx: any) => {
              await new Promise((resolve) => setTimeout(resolve, 30));
              await tx.workflowRun.count();
            },
            { timeout: 5 },
          ),
        ).rejects.toMatchObject({ code: "P2028" });
        await expect(
          prisma.$transaction(async () => {}, { maxWait: 1 }),
        ).rejects.toThrow(/maxWait/);
      });

      it("rolls back when the callback throws", async () => {
        await expect(
          prisma.$transaction(async (tx: any) => {
            await tx.workflowRun.create({ data: run("rolled-back") });
            throw new Error("stop");
          }),
        ).rejects.toThrow("stop");
        expect(await prisma.workflowRun.count()).toBe(0);
      });
    });

    describe("construction", () => {
      const fixture = () =>
        createRequire(import.meta.url)("../../../../prisma-fixtures/index.cjs");
      // The raw client with its contract changed by `change`.
      const withContract = (change: (contract: any) => void) => {
        const db = fixture().createPostgresDb(DATABASE_URL);
        const contract = structuredClone(db.contract);
        change(contract);
        return Object.create(db, { contract: { value: contract } });
      };
      const table = (contract: any, name: string) =>
        contract.storage.namespaces.public.entries.table[name];

      it("names the fix when an engine table is missing", () => {
        const db = withContract(
          (c) => delete c.domain.namespaces.public.models.JobQueue,
        );
        expect(() => fromPrisma8(db)).toThrow(/"job_queue".*contract\.prisma/);
      });

      it("names the fix when timestamps are not TimestampString", () => {
        const db = withContract((c) => {
          table(c, "workflow_runs").columns.createdAt.codecId =
            "pg/timestamptz-temporal@1";
        });
        expect(() => fromPrisma8(db)).toThrow(
          /workflow_runs\.createdAt.*TimestampString/,
        );
      });

      it("names the fix when Status is not a native enum", () => {
        const db = withContract((c) => {
          table(c, "job_queue").columns.status.codecId = "pg/text@1";
        });
        expect(() => fromPrisma8(db)).toThrow(/job_queue\.status.*native/);
      });

      it("fails clearly for a SQLite adapter over a Prisma 8 client", () => {
        expect(() =>
          createPrismaWorkflowPersistence(prisma, { databaseType: "sqlite" }),
        ).toThrow(/SQLite|sqlite.*Prisma 8/);
        expect(() =>
          createPrismaJobQueue(prisma, { databaseType: "sqlite" }),
        ).toThrow(/Prisma 8/);
      });
    });
  },
);
