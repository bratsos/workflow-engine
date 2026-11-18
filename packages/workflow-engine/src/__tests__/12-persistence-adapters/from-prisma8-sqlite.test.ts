/** The Prisma 8 shim against the full engine contract on real SQLite files. */
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  onTestFinished,
  vi,
} from "vitest";
import { createPrismaAICallLogger } from "../../persistence/prisma/ai-logger.js";
import {
  fromPrisma8,
  rowsOf,
  Sql,
} from "../../persistence/prisma/from-prisma8.js";
import { createPrismaJobQueue } from "../../persistence/prisma/job-queue.js";
import {
  isSerializationFailure,
  isSqliteBusy,
  isUniqueViolation,
} from "../../persistence/prisma/sql-errors.js";

const require = createRequire(import.meta.url);
// Every suite here is for Prisma 8. The Prisma 6 and 7 floor (Node 22.12) has
// no node:sqlite to load, and a skipped suite still evaluates this file.
const prisma8 = process.env.PRISMA_MAJOR === "8";
const { DatabaseSync } = prisma8 ? require("node:sqlite") : ({} as any);
const fixtureDir = process.env.PRISMA8_SQLITE_FIXTURE
  ? resolve(process.env.PRISMA8_SQLITE_FIXTURE)
  : join(
      dirname(require.resolve("../../../../prisma-fixtures/index.cjs")),
      "v8-sqlite",
    );
// node:sqlite reads TEXT back cut at a NUL before Node 24.16 and 26.1 (every
// 22.x), nodejs/node#61954: there the adapter refuses a NUL in any statement.
const nulCut =
  prisma8 &&
  (() => {
    const probe = new DatabaseSync(":memory:");
    try {
      return probe.prepare("SELECT ? AS v").get("a\0b").v !== "a\0b";
    } finally {
      probe.close();
    }
  })();
const NUL = "a\0b";
// Past SQLite's 32,766 binds, so the write is split into chunks.
const bulk = (last: string) =>
  Array.from({ length: 5000 }, (_, i) => run(i === 4999 ? last : `bulk-${i}`));
// Every way the adapter sends text to SQLite, as a call on a client.
const nulWrites: Array<[string, (c: any) => unknown]> = [
  ["create", (c) => c.workflowRun.create({ data: run(`id-${NUL}`) })],
  [
    "createMany",
    (c) => c.workflowRun.createMany({ data: [run("ok"), run(`id-${NUL}`)] }),
  ],
  [
    "createMany with skipDuplicates",
    (c) =>
      c.workflowRun.createMany({
        data: [run(`id-${NUL}`)],
        skipDuplicates: true,
      }),
  ],
  [
    "createMany in two chunks, NUL in the last",
    (c) => c.workflowRun.createMany({ data: bulk(`id-${NUL}`) }),
  ],
  [
    "createMany in two chunks, NUL in the first",
    (c) =>
      c.workflowRun.createMany({
        data: [run(`id-${NUL}`), ...bulk("bulk-last").slice(1)],
      }),
  ],
  [
    "update data",
    (c) =>
      c.workflowRun.update({
        where: { id: "seed" },
        data: { workflowName: NUL },
      }),
  ],
  [
    "updateMany data",
    (c) =>
      c.workflowRun.updateMany({
        where: { id: "seed" },
        data: { workflowName: NUL },
      }),
  ],
  [
    "upsert create",
    (c) =>
      c.workflowRun.upsert({
        where: { id: `id-${NUL}` },
        create: run(`id-${NUL}`),
        update: { priority: 1 },
      }),
  ],
  [
    "upsert update",
    (c) =>
      c.workflowRun.upsert({
        where: { id: "seed" },
        create: run("seed"),
        update: { workflowName: NUL },
      }),
  ],
  ["where equals", (c) => c.workflowRun.findMany({ where: { id: NUL } })],
  [
    "where startsWith",
    (c) => c.workflowRun.findMany({ where: { id: { startsWith: NUL } } }),
  ],
  ["deleteMany where", (c) => c.workflowRun.deleteMany({ where: { id: NUL } })],
  [
    "$executeRaw",
    (c) =>
      c.$executeRaw`UPDATE workflow_runs SET workflowName = ${NUL} WHERE id = ${"seed"}`,
  ],
  [
    "$executeRawUnsafe",
    (c) =>
      c.$executeRawUnsafe(
        "UPDATE workflow_runs SET workflowName = $1 WHERE id = $2",
        NUL,
        "seed",
      ),
  ],
  [
    "$queryRaw",
    (c) => c.$withColumns({ v: "text" }).$queryRaw`SELECT ${NUL} AS v`,
  ],
  [
    "$queryRawUnsafe",
    (c) => c.$withColumns({ v: "text" }).$queryRawUnsafe("SELECT $1 AS v", NUL),
  ],
];
const run = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  workflowId: "wf",
  workflowName: "wf",
  workflowType: "t",
  input: {},
  ...extra,
});
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const jsonRows: Array<[string, unknown]> = [
  ["text", { k: "x" }],
  ["num", { k: 1 }],
  ["real", { k: 1.5 }],
  ["string-num", { k: "1" }],
  ["true", { k: true }],
  ["false", { k: false }],
  ["zero", { k: 0 }],
  ["string-true", { k: "true" }],
  ["null", { k: null }],
  ["missing", {}],
  ["sql-null", undefined],
  ["root-null", null],
  ["object", { k: { a: 1, b: 2 } }],
  ["reversed-object", { k: { b: 2, a: 1 } }],
  ["string-object", { k: '{"a":1,"b":2}' }],
  ["array", { k: [1, 2] }],
  ["string-array", { k: "[1,2]" }],
  [
    "deep",
    {
      nested: [{ value: "first" }, { value: "last" }],
      "a.b": "it's exact",
      "we'ird": "bound",
      "": 17,
    },
  ],
];
// Expected ids observed through the real Prisma 6 SQLite client on these rows.
const jsonPaths: Array<[string, string, unknown, string[]]> = [
  ["text", "$.k", "x", ["text"]],
  ["number", "$.k", 1, ["num"]],
  ["real", "$.k", 1.5, ["real"]],
  ["numeric string", "$.k", "1", ["string-num"]],
  ["true", "$.k", true, ["true"]],
  ["false", "$.k", false, ["false"]],
  ["zero", "$.k", 0, ["zero"]],
  ["boolean string", "$.k", "true", ["string-true"]],
  ["JSON null", "$.k", null, ["null"]],
  ["root JSON null", "$", null, ["root-null"]],
  ["missing", "$.absent", null, []],
  ["object", "$.k", { a: 1, b: 2 }, ["object"]],
  ["object key order", "$.k", { b: 2, a: 1 }, ["reversed-object"]],
  ["object string", "$.k", '{"a":1,"b":2}', ["string-object"]],
  ["array", "$.k", [1, 2], ["array"]],
  ["array string", "$.k", "[1,2]", ["string-array"]],
  ["nested array", "$.nested[1].value", "last", ["deep"]],
  ["negative array index", "$.nested[#-1].value", "last", ["deep"]],
  ["quoted key", '$."a.b"', "it's exact", ["deep"]],
  ["apostrophe in key", '$."we\'ird"', "bound", ["deep"]],
  ["empty key", '$.""', 17, ["deep"]],
  ["shorthand key", "k", 1, ["num"]],
];

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

    const queueCycle = async (id: string) => {
      const queue = createPrismaJobQueue(prisma, {
        databaseType: "sqlite",
        workerId: "recovery",
      });
      const jobId = await queue.enqueue({
        workflowRunId: id,
        workflowId: "wf",
        stageId: "recovery",
        payload: { recovered: true },
      });
      const job = await queue.dequeue();
      expect(job?.jobId).toBe(jobId);
      expect(
        await queue.complete(jobId, {
          attempt: job!.attempt,
          startedAt: job!.startedAt,
        }),
      ).toBe("acknowledged");
      expect(
        await prisma.jobQueue.findUnique({
          where: { id: jobId },
          select: { status: true },
        }),
      ).toEqual({ status: "COMPLETED" });
      const [row] = await prisma
        .$withColumns({ status: "text" })
        .$queryRawUnsafe("SELECT status FROM job_queue WHERE id = $1", jobId);
      expect(row.status).toBe("COMPLETED");
    };

    it.each([
      "raw",
      "raw-json",
      "raw-text",
      "raw-float",
      "delegate",
      "aggregate",
      "returning",
    ])("recovers a valid queue cycle after a rejected %s INTEGER read", async (kind) => {
      await prisma.workflowRun.create({ data: run("recovery") });
      expect(
        await prisma.$executeRawUnsafe(
          "UPDATE workflow_runs SET totalTokens = $1 WHERE id = $2",
          9007199254740993n,
          "recovery",
        ),
      ).toBe(1);
      const [stored] = await prisma
        .$withColumns({ value: "text", storage: "text" })
        .$queryRawUnsafe(
          "SELECT CAST(totalTokens AS TEXT) AS value, typeof(totalTokens) AS storage FROM workflow_runs WHERE id = $1",
          "recovery",
        );
      expect(stored).toEqual({ value: "9007199254740993", storage: "integer" });
      const reads: Record<string, () => Promise<unknown>> = {
        raw: () =>
          prisma
            .$withColumns({ totalTokens: "int" })
            .$queryRawUnsafe(
              "SELECT totalTokens FROM workflow_runs WHERE id = $1; -- read",
              "recovery",
            ),
        "raw-json": () =>
          prisma
            .$withColumns({ totalTokens: "json" })
            .$queryRawUnsafe(
              "SELECT totalTokens FROM workflow_runs WHERE id = $1",
              "recovery",
            ),
        "raw-text": () =>
          prisma
            .$withColumns({ totalTokens: "text" })
            .$queryRawUnsafe(
              "SELECT totalTokens FROM workflow_runs WHERE id = $1",
              "recovery",
            ),
        "raw-float": () =>
          prisma
            .$withColumns({ totalTokens: "float" })
            .$queryRawUnsafe(
              "SELECT totalTokens FROM workflow_runs WHERE id = $1",
              "recovery",
            ),
        delegate: () =>
          prisma.workflowRun.findUnique({ where: { id: "recovery" } }),
        aggregate: () =>
          prisma.workflowRun.aggregate({ _max: { totalTokens: true } }),
        returning: () =>
          prisma
            .$withColumns({ value: "int" })
            .$queryRawUnsafe(
              "UPDATE workflow_runs SET priority = 7 WHERE id = $1 RETURNING totalTokens AS value",
              "recovery",
            ),
      };
      await expect(reads[kind]!()).rejects.toThrow();
      await queueCycle("recovery");
      await prisma.$executeRaw`UPDATE workflow_runs SET totalTokens = ${3} WHERE id = ${"recovery"}`;
      expect(
        (await prisma.workflowRun.findUnique({ where: { id: "recovery" } }))
          .totalTokens,
      ).toBe(3);
    });

    it.each([
      "raw-json",
      "delegate-json",
      "raw-date",
      "delegate-date",
      "sql",
    ])("recovers a valid queue cycle after a rejected %s decode", async (kind) => {
      await prisma.workflowRun.create({ data: run("recovery") });
      const json = kind.includes("json"),
        field = json ? "input" : "startedAt";
      if (kind !== "sql")
        await prisma.$executeRawUnsafe(
          `UPDATE workflow_runs SET "${field}" = $1 WHERE id = $2`,
          "invalid",
          "recovery",
        );
      const read =
        kind === "sql"
          ? () =>
              prisma
                .$withColumns({ value: "json" })
                .$queryRawUnsafe(
                  "SELECT json_extract('invalid', '$') AS value FROM workflow_runs",
                )
          : kind.startsWith("raw")
            ? () =>
                prisma
                  .$withColumns({ [field]: json ? "json" : "timestamp" })
                  .$queryRawUnsafe(
                    `SELECT "${field}" FROM workflow_runs WHERE id = $1`,
                    "recovery",
                  )
            : () =>
                prisma.workflowRun.findUnique({ where: { id: "recovery" } });
      await expect(read()).rejects.toThrow();
      await queueCycle("recovery");
      if (kind !== "sql")
        await prisma.$executeRawUnsafe(
          `UPDATE workflow_runs SET "${field}" = $1 WHERE id = $2`,
          json ? "{}" : "2026-01-01T00:00:00.000Z",
          "recovery",
        );
      const row = await prisma.workflowRun.findUnique({
        where: { id: "recovery" },
      });
      expect(row.input).toEqual({});
      if (!json && kind !== "sql")
        expect(row.startedAt).toEqual(new Date("2026-01-01T00:00:00.000Z"));
    });

    it("keeps every signed 64-bit BigInt exact and rejects out-of-range binds without mutation or poisoning", async () => {
      await prisma.workflowRun.create({ data: run("bigints") });
      const raw = prisma.$withColumns({ value: "bigint", storage: "text" });
      for (const value of [
        0n,
        -1n,
        9007199254740993n,
        -9007199254740993n,
        (1n << 63n) - 1n,
        -(1n << 63n),
      ]) {
        expect(
          await raw.$queryRaw`SELECT ${value} AS value, typeof(${value}) AS storage`,
        ).toEqual([{ value, storage: "integer" }]);
        await prisma.$executeRawUnsafe(
          "UPDATE workflow_runs SET totalTokens = $1 WHERE id = $2",
          value,
          "bigints",
        );
        expect(
          await prisma
            .$withColumns({ totalTokens: "bigint" })
            .$queryRawUnsafe(
              "SELECT totalTokens FROM workflow_runs WHERE id = $1",
              "bigints",
            ),
        ).toEqual([{ totalTokens: value }]);
      }
      await prisma.$executeRawUnsafe(
        "UPDATE workflow_runs SET totalTokens = $1 WHERE id = $2",
        9n,
        "bigints",
      );
      for (const value of [1n << 63n, -(1n << 63n) - 1n]) {
        await expect(
          prisma.$executeRawUnsafe(
            "UPDATE workflow_runs SET totalTokens = $1 WHERE id = $2",
            value,
            "bigints",
          ),
        ).rejects.toThrow();
        expect(
          (await prisma.workflowRun.findUnique({ where: { id: "bigints" } }))
            .totalTokens,
        ).toBe(9);
      }
      expect(() =>
        prisma.$executeRawUnsafe(
          "UPDATE workflow_runs SET workflowName = $1 WHERE id = $2",
          ["invalid"],
          "bigints",
        ),
      ).toThrow(/arrays/);
      await queueCycle("bigints");
      // Root connection state and valid floating point reads survive too.
      const state = prisma.$withColumns({ changed: "int", fraction: "float" });
      await prisma.$executeRawUnsafe(
        "UPDATE workflow_runs SET priority = 8 WHERE id = $1",
        "bigints",
      );
      expect(
        await state.$queryRaw`SELECT changes() AS changed, ${1.0000000000000002} AS fraction`,
      ).toEqual([{ changed: 1, fraction: 1.0000000000000002 }]);
      await prisma.$executeRawUnsafe(
        'CREATE TEMP TABLE "__prisma8_read" (value INTEGER)',
      );
      try {
        await prisma.$executeRawUnsafe(
          'INSERT INTO "__prisma8_read" VALUES (3)',
        );
        expect(
          await prisma
            .$withColumns({ value: "int" })
            .$queryRawUnsafe('SELECT value FROM "__prisma8_read"'),
        ).toEqual([{ value: 3 }]);
      } finally {
        await prisma.$executeRawUnsafe('DROP TABLE "__prisma8_read"');
      }
    });

    it("keeps RETURNING aliases, expressions, wildcards and bind counts intact", async () => {
      await prisma.workflowRun.create({ data: run("returning") });
      const raw = prisma.$withColumns({ value: "int" });
      for (const projection of [
        "totalTokens AS value",
        "totalTokens value",
        "totalTokens + $2 AS value",
        'totalTokens AS "value" -- comment',
      ]) {
        expect(
          await raw.$queryRawUnsafe(
            `UPDATE workflow_runs SET totalTokens = 3 WHERE id = $1 RETURNING ${projection}`,
            "returning",
            0,
          ),
        ).toEqual([{ value: 3 }]);
      }
      for (const projection of [
        "(totalTokens)",
        "(( totalTokens ))",
        "totalTokens /* comment */",
        "workflow_runs.totalTokens",
      ]) {
        expect(
          await prisma
            .$withColumns({ totalTokens: "int" })
            .$queryRawUnsafe(
              `UPDATE workflow_runs SET totalTokens = 3 WHERE id = $1 RETURNING ${projection}`,
              "returning",
            ),
        ).toEqual([{ totalTokens: 3 }]);
      }
      expect(
        (
          await prisma
            .$withColumns("workflow_runs")
            .$queryRawUnsafe(
              "UPDATE workflow_runs SET totalTokens = 4 WHERE id = $1 RETURNING *",
              "returning",
            )
        )[0].totalTokens,
      ).toBe(4);
      const values = Array.from({ length: 5000 }, (_, i) => i);
      expect(
        await raw.$queryRawUnsafe(
          `UPDATE workflow_runs SET priority = 5 WHERE id = $1 RETURNING totalTokens IN (${values.map((_, i) => `$${i + 2}`).join(", ")}) AS value`,
          "returning",
          ...values,
        ),
      ).toEqual([{ value: 1 }]);
    });

    it("retains explicit empty raw specs for reads and RETURNING, while requiring a declaration", async () => {
      const empty = prisma.$withColumns({});
      expect(await empty.$queryRawUnsafe("SELECT 1 AS value")).toEqual([{}]);
      await prisma.workflowRun.createMany({
        data: [run("empty-1"), run("empty-2")],
      });
      expect(
        await empty.$queryRawUnsafe("SELECT * FROM workflow_runs"),
      ).toEqual([{}, {}]);
      expect(
        await empty.$queryRawUnsafe(
          "UPDATE workflow_runs SET priority = 7 RETURNING *",
        ),
      ).toEqual([{}, {}]);
      expect(
        await empty.$queryRawUnsafe(
          "UPDATE workflow_runs SET priority = 8 WHERE id = $1 RETURNING priority",
          "empty-1",
        ),
      ).toEqual([{}]);
      expect(
        (await prisma.workflowRun.findUnique({ where: { id: "empty-1" } }))
          .priority,
      ).toBe(8);
      await expect(prisma.$queryRawUnsafe("SELECT 1 AS value")).rejects.toThrow(
        /declare its result columns/,
      );
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
      expect(await ids({ input: { path: "$.batch", equals: "two" } })).toEqual([
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

    it.each(
      jsonPaths,
    )("matches Prisma 6 SQLite JSON-path equality for %s", async (_name, path, equals, expected) => {
      await prisma.workflowRun.createMany({
        data: jsonRows.map(([id, metadata]) => run(id, { metadata })),
      });
      const rows = await prisma.workflowRun.findMany({
        where: { metadata: { path, equals } },
        select: { id: true },
        orderBy: { id: "asc" },
      });
      expect(rows.map((row: { id: string }) => row.id)).toEqual(expected);
    });

    it("binds arbitrary JSON paths and rejects unsupported path filters", async () => {
      await prisma.workflowRun.create({
        data: run("safe", { metadata: { "x') OR 1=1 --": "bound" } }),
      });
      expect(
        await prisma.workflowRun.count({
          where: {
            metadata: { path: '$."x\') OR 1=1 --"', equals: "bound" },
          },
        }),
      ).toBe(1);
      for (const filter of [
        { path: ["k"], equals: 1 },
        { path: "$.k" },
        { path: "$.k", equals: undefined },
        { path: "$.k", equals: 1, not: 2 },
        { path: 1, equals: 1 },
      ])
        await expect(
          prisma.workflowRun.count({ where: { metadata: filter } }),
        ).rejects.toThrow(/only \{ path, equals \}/);
      await expect(
        prisma.workflowRun.count({
          where: { metadata: { path: "", equals: 1 } },
        }),
      ).rejects.toThrow(/JSON path/i);
    });

    it("checks logger batches through both dedicated columns and legacy SQLite JSON paths", async () => {
      const createLogger: (
        client: Parameters<typeof createPrismaAICallLogger>[0],
        options: { databaseType: "sqlite" },
      ) => ReturnType<typeof createPrismaAICallLogger> =
        createPrismaAICallLogger;
      const logger = createLogger(prisma, { databaseType: "sqlite" });
      expect(await logger.isRecorded("x")).toBe(false);
      const call = {
        topic: "t",
        callType: "c",
        modelKey: "m",
        modelId: "m",
        prompt: "p",
        response: "r",
        inputTokens: 1,
        outputTokens: 1,
        cost: 0,
      };
      await prisma.aICall.createMany({
        data: [
          { ...call, metadata: { batchId: "x" } },
          { ...call, batchId: "column", metadata: {} },
          { ...call, metadata: { batchId: 1 } },
          { ...call, metadata: { batchId: true } },
          { ...call, metadata: { batchId: null } },
        ],
      });
      expect(await logger.isRecorded("x")).toBe(true);
      expect(await logger.isRecorded("column")).toBe(true);
      for (const value of ["missing", "1", "true", "null", "x' OR 1=1 --"]) {
        expect(await logger.isRecorded(value)).toBe(false);
      }
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
      // Every form that only reads runs without waiting for the queue.
      for (const sql of [
        "VALUES (1)",
        "WITH q AS (SELECT 1) VALUES (1)",
        "EXPLAIN QUERY PLAN SELECT 1",
        "EXPLAIN UPDATE workflow_runs SET version = 0 RETURNING id",
      ])
        expect(
          await Promise.race([
            prisma
              .$withColumns({})
              .$queryRawUnsafe(sql)
              .then(() => `${sql}: ran`),
            pause(1000).then(() => `${sql}: queued`),
          ]),
        ).toBe(`${sql}: ran`);
      // A PRAGMA runs while it is prepared, so under EXPLAIN too, and an
      // identifier may hold `$` or non-ASCII letters: these may write, and wait.
      const waiting = [
        "EXPLAIN PRAGMA busy_timeout = 5000",
        "EXPLAIN QUERY PLAN PRAGMA busy_timeout = 5000",
        "WITH daily$values AS (SELECT 1) UPDATE workflow_runs SET version = version WHERE 0",
        "WITH dailyévalues AS (SELECT 1) UPDATE workflow_runs SET version = version WHERE 0",
      ].map((sql) => {
        let ran = false;
        const done = prisma
          .$withColumns({})
          .$queryRawUnsafe(sql)
          .then(() => (ran = true));
        return { sql, done, ran: () => ran };
      });
      await pause(200);
      expect(
        waiting.filter((form) => form.ran()).map((form) => form.sql),
      ).toEqual([]);
      release();
      await transaction;
      await Promise.all(waiting.map((form) => form.done));
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

// A file of its own: these tests read the file through a second connection and
// load a fresh copy of the adapter, so they share nothing with the tests above.
describe.skipIf(process.env.PRISMA_MAJOR !== "8")(
  "Prisma 8 SQLite on a file of its own",
  () => {
    let dir: string;
    let file: string;
    let db: any;
    let prisma: any;
    beforeAll(async () => {
      dir = mkdtempSync(join(tmpdir(), "workflow-prisma8-own-"));
      file = join(dir, "engine.db");
      db = await require(join(fixtureDir, "index.cjs")).createSqliteDb(file);
      prisma = fromPrisma8(db);
    }, 30_000);
    afterAll(async () => {
      await db?.close();
      if (dir) rmSync(dir, { recursive: true, force: true });
    });
    beforeEach(async () => {
      await prisma.workflowRun.deleteMany({});
      await prisma.workflowRun.create({ data: run("seed") });
    });

    describe.runIf(nulCut)("a NUL where node:sqlite reads it back cut", () => {
      // The executor a statement runs on differs by entry point; each is listed.
      const clients: Array<[string, (work: (c: any) => unknown) => unknown]> = [
        ["the root client", (work) => work(prisma)],
        [
          "$transaction(callback)",
          (work) => prisma.$transaction((tx: any) => work(tx)),
        ],
        [
          "$transaction([...])",
          (work) => prisma.$transaction([work(prisma)] as any),
        ],
        [
          "a consumer's db.transaction",
          (work) =>
            db.transaction((tx: any) =>
              work(fromPrisma8(tx, { contract: db.contract })),
            ),
        ],
      ];
      for (const [client, on] of clients)
        it.each(nulWrites)(`refuses %s on ${client}`, async (_, write) => {
          await expect(on(write)).rejects.toThrow(/NUL character/);
          expect(
            (await prisma.workflowRun.findMany()).map(
              (r: any) => `${r.id}:${r.workflowName}`,
            ),
          ).toEqual(["seed:wf"]);
        });
    });

    it("refuses a NUL when the probe cannot run, on any Node", async () => {
      const { getBuiltinModule } = process;
      vi.resetModules();
      const fresh = await import("../../persistence/prisma/from-prisma8.js");
      process.getBuiltinModule = undefined as any;
      try {
        await expect(
          fresh.fromPrisma8(db).workflowRun.create({ data: run(NUL) }),
        ).rejects.toThrow(/NUL character/);
      } finally {
        process.getBuiltinModule = getBuiltinModule;
      }
    });

    it.skipIf(nulCut)(
      "stores a NUL whole, also through a two-chunk createMany",
      async () => {
        const last = `id-${NUL}`;
        await prisma.workflowRun.createMany({ data: bulk(last) });
        expect(
          (await prisma.workflowRun.findUnique({ where: { id: last } }))?.id,
        ).toBe(last);
        await prisma.$transaction((tx: any) =>
          tx.workflowRun.createMany({
            data: bulk(`id-tx${NUL}`).map((r) => ({ ...r, id: `tx-${r.id}` })),
          }),
        );
        expect(
          (
            await prisma.workflowRun.findUnique({
              where: { id: `tx-id-tx${NUL}` },
            })
          )?.id,
        ).toBe(`tx-id-tx${NUL}`);
        expect(await prisma.workflowRun.count()).toBe(10_001);
      },
    );

    // node:sqlite leaves a statement that failed SQLITE_BUSY at its first step
    // active on the shared root connection; every later root write then reports
    // success, is not committed and is rolled back when the statement object is
    // collected. The root takes the write lock first, so the failure leaves nothing.
    it("commits the root writes that follow a root write that failed BUSY", async () => {
      const observer = new DatabaseSync(file);
      observer.exec("PRAGMA busy_timeout = 50");
      const committed = () =>
        observer
          .prepare("SELECT id, priority FROM workflow_runs ORDER BY id")
          .all()
          .map((r: any) => `${r.id}:${r.priority}`);
      const timeout = (ms: number) =>
        prisma
          .$withColumns({ timeout: "int" })
          .$queryRawUnsafe(`PRAGMA busy_timeout = ${ms}`);
      try {
        await timeout(1);
        let error: unknown;
        await db.transaction(async (tx: any) => {
          await fromPrisma8(tx, { contract: db.contract }).workflowRun.update({
            where: { id: "seed" },
            data: { priority: 8 },
          });
          error = await prisma.workflowRun
            .update({ where: { id: "seed" }, data: { priority: 9 } })
            .catch((e: unknown) => e);
        });
        expect(error).toMatchObject({ transient: true });
        await timeout(5000);

        await prisma.workflowRun.create({ data: run("created") });
        await prisma.workflowRun.update({
          where: { id: "seed" },
          data: { priority: 3 },
        });
        await prisma.workflowRun.upsert({
          where: { id: "upserted" },
          create: run("upserted"),
          update: {},
        });
        await prisma
          .$withColumns({ id: "text" })
          .$queryRawUnsafe(
            "UPDATE workflow_runs SET priority = 4 WHERE id = $1 RETURNING id",
            "created",
          );
        await prisma.workflowRun.deleteMany({ where: { id: "upserted" } });

        const expected = ["created:4", "seed:3"];
        expect(committed()).toEqual(expected);
        // No write lock is left on the root connection, and the next transaction sees the rows.
        expect(() => {
          observer.exec("BEGIN IMMEDIATE");
          observer.exec("ROLLBACK");
        }).not.toThrow();
        expect(
          (
            await prisma.$transaction((tx: any) =>
              tx.workflowRun.findMany({ orderBy: { id: "asc" } }),
            )
          ).map((r: any) => `${r.id}:${r.priority}`),
        ).toEqual(expected);
      } finally {
        await timeout(5000);
        observer.close();
      }
    });

    // The driver's own executor was never given to fromPrisma8: what is decided
    // about SQLite reads must come from the plan, not from which executor runs it.
    it("reads rows through an executor the adapter never saw", async () => {
      const integer = (n: string) =>
        new Sql().t(`SELECT ${n} AS n`) as InstanceType<typeof Sql>;
      await db.transaction(async (tx: any) => {
        expect(
          await rowsOf(tx, integer("7"), { n: "sqlite/integer@1" }),
        ).toEqual([{ n: 7 }]);
        // Past 2^53, node:sqlite's iterator throws; the adapter reads it as text instead.
        expect(
          await rowsOf(tx, integer("9007199254740993"), {
            n: "sqlite/bigint@1",
          }),
        ).toEqual([{ n: 9007199254740993n }]);
        // A write that returns rows, on an executor that is already in a transaction.
        expect(
          await rowsOf(
            tx,
            new Sql().t(
              "UPDATE workflow_runs SET priority = 6 WHERE id = 'seed' RETURNING priority",
            ),
            { priority: "sqlite/integer@1" },
          ),
        ).toEqual([{ priority: 6 }]);
      });
      expect(
        (await prisma.workflowRun.findUnique({ where: { id: "seed" } }))
          ?.priority,
      ).toBe(6);
    });

    // Only the root's write queue may open a transaction on the root
    // connection. An EXPLAIN reads: it neither waits in the queue nor takes the
    // lock, so a queued write never runs inside it and never goes with its error.
    it("never takes another caller's write into a raw EXPLAIN", async () => {
      const observer = new DatabaseSync(file);
      try {
        const explain =
          "EXPLAIN UPDATE workflow_runs SET priority = 9 WHERE id = 'seed' RETURNING id";
        for (const columns of [{}, { missing: "int" }]) {
          await prisma.workflowRun.upsert({
            where: { id: "seed" },
            create: run("seed"),
            update: {},
          });
          const [plan, removed] = await Promise.allSettled([
            prisma.$withColumns(columns).$queryRawUnsafe(explain),
            prisma.workflowRun.deleteMany({ where: { id: "seed" } }),
          ]);
          expect(removed).toEqual({ status: "fulfilled", value: { count: 1 } });
          expect(
            observer
              .prepare("SELECT id FROM workflow_runs WHERE id = 'seed'")
              .all(),
          ).toEqual([]);
          expect(plan.status).toBe(
            "missing" in columns ? "rejected" : "fulfilled",
          );
        }
      } finally {
        observer.close();
      }
    });

    // Every raw form that may write waits in the queue and leaves nothing active
    // on the root when it fails BUSY: the next root write is committed.
    it.each([
      "WITH q AS (SELECT 1) UPDATE workflow_runs SET priority = 9 WHERE id = 'seed'",
      "WITH q AS (SELECT 1) UPDATE workflow_runs SET priority = 9 WHERE id = 'seed' RETURNING id",
      "UPDATE workflow_runs SET priority = 9 WHERE id = 'seed'",
      "/* c */ -- c\n (UPDATE workflow_runs SET priority = 9 WHERE id = 'seed') RETURNING id",
      "REPLACE INTO workflow_runs (id, \"workflowId\", \"workflowName\", \"workflowType\", input) VALUES ('seed', 'wf', 'wf', 't', '{}') RETURNING id",
      "INSERT OR IGNORE INTO workflow_runs (id, \"workflowId\", \"workflowName\", \"workflowType\", input) VALUES ('other', 'wf', 'wf', 't', '{}') RETURNING id",
      "PRAGMA user_version = 7",
      "CREATE TABLE IF NOT EXISTS raw_probe (n INTEGER)",
    ])("commits the root write after %s failed BUSY", async (sql) => {
      const observer = new DatabaseSync(file);
      const timeout = (ms: number) =>
        prisma
          .$withColumns({ timeout: "int" })
          .$queryRawUnsafe(`PRAGMA busy_timeout = ${ms}`);
      try {
        observer.exec("BEGIN IMMEDIATE");
        await timeout(1);
        const error = await prisma
          .$withColumns({ id: "text" })
          .$queryRawUnsafe(sql)
          .catch((e: unknown) => e);
        observer.exec("ROLLBACK");
        await timeout(5000);
        expect(isSqliteBusy(error) || /syntax error/.test(String(error))).toBe(
          true,
        );
        expect(
          await prisma.workflowRun.deleteMany({ where: { id: "seed" } }),
        ).toEqual({ count: 1 });
        expect(observer.prepare("SELECT id FROM workflow_runs").all()).toEqual(
          [],
        );
      } finally {
        await timeout(5000);
        observer.close();
      }
    });

    it("refuses opening a transaction on the root, from any wrapper or the client's own API, and never ending one", async () => {
      const other: any = fromPrisma8(db);
      for (const sql of [
        "BEGIN",
        " /* x */ BEGIN IMMEDIATE",
        "SAVEPOINT app",
      ]) {
        expect(() => other.$executeRawUnsafe(sql)).toThrow(/Use \$transaction/);
        expect(() => prisma.$withColumns({}).$queryRawUnsafe(sql)).toThrow(
          /Use \$transaction/,
        );
      }
      // Ending one is never refused: with none open, SQLite answers.
      const none = /no transaction is active|no such savepoint/;
      for (const sql of ["RELEASE app", "ROLLBACK", "COMMIT", "END"]) {
        await expect(other.$executeRawUnsafe(sql)).rejects.toThrow(none);
        await expect(
          prisma.$withColumns({}).$queryRawUnsafe(sql),
        ).rejects.toThrow(none);
        await expect(
          db.execute(
            db.raw
              .sql([sql] as any)
              .affectedCount()
              .build(),
          ),
        ).rejects.toThrow(none);
      }
      await expect(
        db.execute(db.raw.sql`BEGIN`.affectedCount().build()),
      ).rejects.toThrow(/BEGIN on the root client/);
      await expect(
        db.execute(db.raw.sql`SAVEPOINT app`.affectedCount().build()),
      ).rejects.toThrow(/SAVEPOINT on the root client/);
      // Inside a transaction a savepoint is the caller's own.
      await prisma.$transaction(async (tx: any) => {
        await tx.$executeRawUnsafe("SAVEPOINT app");
        await tx.$executeRawUnsafe("RELEASE app");
      });
      await other.workflowRun.create({ data: run("after") });
      const observer = new DatabaseSync(file);
      onTestFinished(() => observer.close());
      expect(
        observer.prepare("SELECT count(*) AS n FROM workflow_runs").get(),
      ).toEqual({ n: 2 });
    });

    // A write through the client's own API is not run inside the adapter's
    // root transaction, where a failed COMMIT would take it back after its
    // caller saw it succeed.
    it("keeps a write through db.orm out of a root write that then fails", async () => {
      const observer = new DatabaseSync(file);
      onTestFinished(() => {
        observer.exec(
          "DROP TABLE IF EXISTS totals; DROP TABLE IF EXISTS allowed",
        );
        observer.close();
      });
      observer.exec(
        "CREATE TABLE allowed (v INTEGER PRIMARY KEY); INSERT INTO allowed VALUES (0); CREATE TABLE totals (v INTEGER REFERENCES allowed DEFERRABLE INITIALLY DEFERRED); WITH RECURSIVE r(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM r WHERE n < 400) INSERT INTO totals SELECT 0 FROM r",
      );
      // Fails at COMMIT: the deferred key is checked there.
      const failing = prisma
        .$withColumns({ v: "int" })
        .$queryRawUnsafe("UPDATE totals SET v = 1 RETURNING v")
        .then(
          () => "stored",
          (error: Error) => error.message,
        );
      // Start it once the root write holds its lock (the observer cannot take one).
      observer.exec("PRAGMA busy_timeout = 0");
      const locked = () => {
        try {
          observer.exec("BEGIN IMMEDIATE; ROLLBACK");
          return false;
        } catch {
          return true;
        }
      };
      for (let i = 0; i < 10_000 && !locked(); i++) await Promise.resolve();
      expect(locked()).toBe(true);
      const creating = db.orm.WorkflowLog.create({
        level: "INFO",
        message: "beside a failing write",
      });
      // A write that returns no rows goes through the driver's execute.
      const inserting = db.execute(
        db.raw
          .sql`INSERT INTO workflow_logs (id, level, message, "createdAt") VALUES ('beside', 'INFO', 'beside a failing write', CURRENT_TIMESTAMP)`
          .affectedCount()
          .build(),
      );
      let seen = false;
      for (let i = 0; i < 20; i++) {
        const [row] = await prisma
          .$withColumns({ v: "int" })
          .$queryRawUnsafe("SELECT max(v) AS v FROM totals");
        if (row.v === 1) seen = true;
      }
      const created = await creating;
      expect(await inserting).toMatchObject({ affectedRows: 1 });
      expect(await failing).toMatch(/FOREIGN KEY constraint failed/);
      expect(seen).toBe(false);
      expect(
        observer
          .prepare(
            "SELECT count(*) AS n FROM workflow_logs WHERE message = 'beside a failing write'",
          )
          .get(),
      ).toEqual({ n: 2 });
      expect(created).toBeTruthy();
    });

    it("runs a raw statement SQLite cannot run in a transaction", async () => {
      await expect(
        prisma.$withColumns({}).$queryRawUnsafe("VACUUM"),
      ).resolves.toEqual([]);
      await expect(
        prisma
          .$withColumns({ busy: "int", log: "int", checkpointed: "int" })
          .$queryRawUnsafe("PRAGMA wal_checkpoint(PASSIVE)"),
      ).resolves.toEqual([{ busy: 0, log: -1, checkpointed: -1 }]);
      // An empty statement before it changes nothing: still not in a transaction.
      await expect(
        prisma
          .$withColumns({ journal_mode: "text" })
          .$queryRawUnsafe("; PRAGMA journal_mode = WAL"),
      ).resolves.toEqual([{ journal_mode: "wal" }]);
      await prisma
        .$withColumns({ journal_mode: "text" })
        .$queryRawUnsafe("PRAGMA journal_mode = DELETE");
    });

    // The same rule, from the inside: a statement that may write, sent to the
    // root by anything but its queue turn, is refused before it runs.
    it("refuses a root statement that may write outside the write queue", async () => {
      const observer = new DatabaseSync(file);
      onTestFinished(() => observer.close());
      const update = new Sql().t(
        "UPDATE workflow_runs SET priority = 77 WHERE id = 'seed' RETURNING priority",
      ) as InstanceType<typeof Sql>;
      await expect(
        rowsOf(db, update, { priority: "sqlite/integer@1" }),
      ).rejects.toThrow(/outside its write queue/);
      expect(
        await rowsOf(
          db,
          new Sql().t("SELECT 1 AS n") as InstanceType<typeof Sql>,
          {
            n: "sqlite/integer@1",
          },
        ),
      ).toEqual([{ n: 1 }]);
      expect(
        observer.prepare("SELECT priority FROM workflow_runs").all(),
      ).toEqual([{ priority: 5 }]);
    });
  },
);

// A root read that fails SQLITE_BUSY at its first step stays active on the
// root connection until the statement object is garbage collected (node:sqlite
// does not reset the iterator, and the adapter cannot reach it). That is a
// documented limit: other connections cannot commit (rollback journal), or the
// root reads a stale snapshot and fails its writes with SQLITE_BUSY_SNAPSHOT
// (WAL). These tests hold the rule that matters: no root write is acknowledged
// and then lost, on either journal mode.
describe
  .skipIf(process.env.PRISMA_MAJOR !== "8")
  .each(["delete", "wal"] as const)(
  "the root connection after a read that failed BUSY, journal mode %s",
  (mode) => {
    let dir: string;
    let file: string;
    let db: any;
    let prisma: any;
    let observer: any;
    beforeAll(async () => {
      dir = mkdtempSync(join(tmpdir(), "workflow-prisma8-busy-read-"));
      file = join(dir, "engine.db");
      db = await require(join(fixtureDir, "index.cjs")).createSqliteDb(file);
      prisma = fromPrisma8(db);
      observer = new DatabaseSync(file);
      observer.exec("PRAGMA busy_timeout = 50");
      observer.exec("CREATE TABLE probe (n INTEGER)");
      await prisma.workflowRun.create({ data: run("seed") });
    }, 30_000);
    afterAll(async () => {
      observer?.close();
      await db?.close();
      if (dir) rmSync(dir, { recursive: true, force: true });
    });

    it("acknowledges no root write it then loses", async () => {
      const timeout = (ms: number) =>
        prisma
          .$withColumns({ timeout: "int" })
          .$queryRawUnsafe(`PRAGMA busy_timeout = ${ms}`);
      // Another connection keeps the root out: it holds the file (rollback
      // journal), or takes it over to switch to WAL with exclusive locking, as
      // another process starting on the file would.
      const holder = new DatabaseSync(file);
      if (mode === "delete") holder.exec("BEGIN EXCLUSIVE");
      else {
        holder.exec("PRAGMA journal_mode = WAL");
        holder.exec("PRAGMA locking_mode = EXCLUSIVE");
        holder.prepare("SELECT count(*) FROM sqlite_master").all();
      }
      await timeout(1);
      expect(
        isSqliteBusy(
          await prisma.workflowRun.findMany().catch((e: unknown) => e),
        ),
      ).toBe(true);
      // A write that needs no rows back fails BUSY too, and leaves nothing behind.
      expect(
        isSqliteBusy(
          await prisma
            .$withColumns({})
            .$queryRawUnsafe(
              "WITH q AS (SELECT 1) UPDATE workflow_runs SET priority = 9 WHERE id = 'seed'",
            )
            .catch((e: unknown) => e),
        ),
      ).toBe(true);
      if (mode === "delete") holder.exec("COMMIT");
      holder.close();
      // In WAL another connection commits after the root's snapshot was pinned.
      if (mode === "wal") observer.exec("INSERT INTO probe VALUES (1)");
      await timeout(5000);

      const writes: Array<[string, () => Promise<unknown>]> = [
        ["create", () => prisma.workflowRun.create({ data: run("created") })],
        [
          "raw RETURNING",
          () =>
            prisma
              .$withColumns({ id: "text" })
              .$queryRawUnsafe(
                "UPDATE workflow_runs SET priority = 4 WHERE id = 'seed' RETURNING id",
              ),
        ],
        [
          "raw CTE",
          () =>
            prisma
              .$withColumns({})
              .$queryRawUnsafe(
                "WITH q AS (SELECT 1) UPDATE workflow_runs SET \"workflowName\" = 'cte' WHERE id = 'seed'",
              ),
        ],
        [
          "deleteMany",
          () => prisma.workflowRun.deleteMany({ where: { id: "created" } }),
        ],
      ];
      const committed = () =>
        observer
          .prepare(
            'SELECT id, priority, "workflowName" AS name FROM workflow_runs ORDER BY id',
          )
          .all()
          .map((r: any) => `${r.id}:${r.priority}:${r.name}`);
      const outcomes: string[] = [];
      for (const [name, write] of writes) {
        const before = committed();
        const error = await write().then(
          () => undefined,
          (e: unknown) => e,
        );
        // Acknowledged means committed; refused means nothing changed.
        if (error) {
          expect(isSqliteBusy(error)).toBe(true);
          expect(committed()).toEqual(before);
        } else expect(committed()).not.toEqual(before);
        outcomes.push(`${name}:${error ? "refused" : "committed"}`);
      }
      // With a rollback journal the root still holds its read lock and can
      // upgrade: every write commits. In WAL a write may be refused while the
      // stale snapshot lasts, never acknowledged and dropped.
      if (mode === "delete")
        expect(outcomes).toEqual([
          "create:committed",
          "raw RETURNING:committed",
          "raw CTE:committed",
          "deleteMany:committed",
        ]);
    });
  },
);

// A write that waits for the root reads in flight (an adapter commit on a
// rollback journal, a root write retrying after SQLITE_BUSY_SNAPSHOT in WAL)
// must not wait for reads that start after it: those queue behind it. The
// driver's root `query` is gated here, so each read holds its first row until
// the test releases it, and each read starts before the previous one ends.
describe
  .skipIf(process.env.PRISMA_MAJOR !== "8")
  .each(["delete", "wal"] as const)(
  "a waiting write on a %s file with overlapping root reads",
  (mode) => {
    let dir: string;
    let db: any;
    beforeAll(async () => {
      dir = mkdtempSync(join(tmpdir(), "workflow-prisma8-starve-"));
      const file = join(dir, "engine.db");
      db = await require(join(fixtureDir, "index.cjs")).createSqliteDb(file);
      const raw = new DatabaseSync(file);
      raw.exec(`PRAGMA journal_mode = ${mode}`);
      raw.close();
    }, 30_000);
    afterAll(async () => {
      await db?.close();
      if (dir) rmSync(dir, { recursive: true, force: true });
    });

    it("finishes after the read it waited for, and later reads run after it", async () => {
      const held: Array<() => void> = [];
      let armed = false;
      let waiting = false;
      const staleSnapshot = (error: any) => {
        for (let e = error; e; e = e.cause) if (e.errcode === 517) return true;
        return false;
      };
      const gated = new Proxy(db, {
        get(target, prop) {
          if (prop === "query")
            return (plan: unknown) => {
              const result = target.query(plan);
              if (!armed) return result;
              return {
                toArray: async () => {
                  const it = result[Symbol.asyncIterator]();
                  const rows: unknown[] = [];
                  let step = await it.next();
                  if (!step.done) rows.push(step.value);
                  await new Promise<void>((release) => held.push(release));
                  while (!(step = await it.next()).done) rows.push(step.value);
                  return rows;
                },
              };
            };
          if (prop === "execute")
            return (plan: unknown) =>
              target.execute(plan).catch((error: unknown) => {
                if (staleSnapshot(error)) waiting = true;
                throw error;
              });
          // The adapter closes its read gate right after reading the journal mode.
          if (prop === "transaction")
            return (fn: (raw: any) => Promise<unknown>) =>
              target.transaction((raw: any) =>
                fn(
                  new Proxy(raw, {
                    get(t, p) {
                      const value = Reflect.get(t, p, t);
                      if (p !== "query") return value;
                      return (plan: unknown) => {
                        const result = value.call(t, plan);
                        if (!JSON.stringify(plan).includes("journal_mode"))
                          return result;
                        return {
                          toArray: () =>
                            result.toArray().finally(() => {
                              if (mode === "delete") waiting = true;
                            }),
                        };
                      };
                    },
                  }),
                ),
              );
          const value = Reflect.get(target, prop, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      const prisma: any = fromPrisma8(gated);
      await prisma.workflowRun.deleteMany({});
      await prisma.workflowRun.createMany({
        data: [run("a"), run("b"), run("c")],
      });
      // Runs every callback already queued; no clock is involved.
      const drain = async () => {
        for (let i = 0; i < 20; i++)
          await new Promise<void>((resolve) => setImmediate(resolve));
      };
      const events: string[] = [];
      const read = (n: number) =>
        prisma.workflowRun
          .findMany()
          .then((rows: unknown[]) => events.push(`read ${n}: ${rows.length}`));

      armed = true;
      const reads = [read(0)];
      await drain();
      expect(held).toHaveLength(1);
      // delete: an adapter commit waits for read 0. wal: the commit does not
      // wait, and the root write behind it fails 517 and then waits for read 0.
      let done = false;
      const write = (async () => {
        await prisma.$transaction((tx: any) =>
          tx.workflowRun.create({ data: run("d") }),
        );
        if (mode === "wal")
          await prisma.workflowRun.updateMany({ data: { priority: 9 } });
      })().then(() => {
        done = true;
        events.push("write");
      });
      try {
        await drain();
        expect(waiting).toBe(true);
        expect(done).toBe(false);
        let started = 0;
        while (!done && started < 5) {
          reads.push(read(++started));
          await drain();
          held[started - 1]!();
          await drain();
        }
        // Without the queue every new read holds the gate open: still waiting.
        expect({ done, started }).toEqual({ done: true, started: 1 });
      } finally {
        armed = false;
        while (held.length) {
          held.shift()!();
          await drain();
        }
        await write;
        await Promise.all(reads);
      }
      expect(events.slice(0, 2)).toEqual(["read 0: 3", "write"]);
      expect(events[2]).toMatch(/^read 1: 4$/);
      expect(
        (await prisma.workflowRun.findMany()).map((r: any) => r.priority),
      ).toEqual(mode === "wal" ? [9, 9, 9, 9] : [5, 5, 5, 5]);
    }, 30_000);

    // A read that does not end (a driver step that never returns) is waited
    // for at most the busy timeout, and the write then fails no later than it
    // would have without the wait; every caller after it runs.
    it("gives up on a read that does not end, at the busy timeout, and lets later callers through", async () => {
      const held: Array<() => void> = [];
      let armed = false;
      const gated = new Proxy(db, {
        get(target, prop) {
          if (prop === "query")
            return (plan: unknown) => {
              const result = target.query(plan);
              if (!armed) return result;
              armed = false;
              return {
                toArray: async () => {
                  const it = result[Symbol.asyncIterator]();
                  const rows: unknown[] = [];
                  let step = await it.next();
                  if (!step.done) rows.push(step.value);
                  await new Promise<void>((release) => held.push(release));
                  while (!(step = await it.next()).done) rows.push(step.value);
                  return rows;
                },
              };
            };
          const value = Reflect.get(target, prop, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      const prisma: any = fromPrisma8(gated);
      await prisma.workflowRun.deleteMany({});
      await prisma.workflowRun.createMany({ data: [run("a"), run("b")] });
      armed = true;
      // Started now: the adapter's calls run when awaited, as Prisma's do.
      const stuck = prisma.workflowRun
        .findMany()
        .then((rows: unknown[]) => rows);
      while (held.length === 0) await pause(1);
      const timed = async (work: Promise<unknown>) => {
        const start = Date.now();
        const outcome = await work.then(
          () => "ok",
          (error: Error) => error.message,
        );
        return { outcome, ms: Date.now() - start };
      };
      try {
        // wal: a commit from another connection makes the read's snapshot
        // stale, so the root write after it fails 517 and waits for the read.
        if (mode === "wal")
          await prisma.$transaction((tx: any) =>
            tx.workflowRun.create({ data: run("c") }),
          );
        const write = await timed(
          mode === "delete"
            ? prisma.$transaction((tx: any) =>
                tx.workflowRun.create({ data: run("c") }),
              )
            : prisma.workflowRun.updateMany({ data: { priority: 3 } }),
        );
        // delete: COMMIT gets what is left of the one 5 s wait. wal: the
        // retry after the wait meets the same snapshot. Both fail, as they
        // would at once without the wait.
        expect(write.outcome).not.toBe("ok");
        expect(write.ms).toBeLessThan(7000);
        expect(write.ms).toBeGreaterThan(4000);
        const later = await timed(prisma.workflowRun.count());
        expect(later).toMatchObject({ outcome: "ok" });
        expect(later.ms).toBeLessThan(1000);
      } finally {
        for (const release of held) release();
      }
      expect(await stuck).toHaveLength(2);
      await expect(
        prisma.workflowRun.create({ data: run("d") }),
      ).resolves.toBeTruthy();
    }, 30_000);
  },
);

// Constructing the adapter must change nothing on the client: `db.runtime()`
// starts its connection, so the adapter looks the driver up at first use.
describe.skipIf(process.env.PRISMA_MAJOR !== "8")(
  "fromPrisma8 and the client's own connection",
  () => {
    let dir: string;
    let file: string;
    let sqlite: (options: object) => any;
    let contract: unknown;
    const clients: any[] = [];
    const client = (withPath = true) => {
      const db = sqlite(withPath ? { contract, path: file } : { contract });
      clients.push(db);
      return db;
    };
    beforeAll(async () => {
      dir = mkdtempSync(join(tmpdir(), "workflow-prisma8-connect-"));
      file = join(dir, "engine.db");
      const fixture = require(join(fixtureDir, "index.cjs"));
      const db = await fixture.createSqliteDb(file);
      contract = db.contract;
      await db.close();
      sqlite = createRequire(join(fixtureDir, "index.cjs"))(
        "@prisma/orm-sqlite/runtime",
      ).default;
    }, 30_000);
    afterAll(async () => {
      for (const db of clients) await db.close().catch(() => {});
      if (dir) rmSync(dir, { recursive: true, force: true });
    });

    it("leaves connect() to the client, before or after the adapter is built", async () => {
      const after = client();
      const adapter = fromPrisma8(after);
      await expect(after.connect()).resolves.toBeTruthy();
      expect(await adapter.workflowRun.count()).toBe(0);

      const before = client();
      await before.connect();
      expect(await fromPrisma8(before).workflowRun.count()).toBe(0);

      const lazy = client(false);
      const late = fromPrisma8(lazy);
      await lazy.connect({ path: file });
      expect(await late.workflowRun.count()).toBe(0);

      // Never connected explicitly: the first call connects, as the client's own would.
      expect(await fromPrisma8(client()).workflowRun.count()).toBe(0);
    });

    it("fails as the client does once the client is closed", async () => {
      const db = client();
      const adapter = fromPrisma8(db);
      await db.close();
      await expect(adapter.workflowRun.count()).rejects.toThrow(/closed/);
      await expect(db.orm.WorkflowRun.all().toArray()).rejects.toThrow(
        /closed/,
      );
    });

    it("warns once when the client exposes no root driver", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const db = client();
        for (let i = 0; i < 2; i++) {
          const bare = fromPrisma8(
            Object.create(db, { runtime: { value: () => ({}) } }),
          );
          expect(await bare.workflowRun.count()).toBe(i);
          await bare.workflowRun.create({ data: run(`bare-${i}`) });
        }
        const warned = warn.mock.calls.filter(([m]) =>
          String(m).includes("no root driver"),
        );
        expect(warned).toHaveLength(1);
        expect(String(warned[0]![0])).toMatch(
          /not coordinated.*Transaction commit failed.*not queued.*not refused/s,
        );
      } finally {
        warn.mockRestore();
      }
    });
  },
);
