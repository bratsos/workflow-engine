/**
 * The adapters refuse a SQLite file whose dates are stored the way another
 * Prisma major stores them (see `persistence/prisma/sqlite-date-guard.ts`).
 *
 * The first part needs no database: it drives the check with clients that
 * answer the probe with a fixed row. The second part (`SQLITE8_KERNEL_SQLITE=1`,
 * Prisma 6, 7 or 8) uses a real SQLite file written through the current major,
 * then rewrites the stored dates into the other storage class with SQL: what
 * another major would have written. Real files written by two different majors
 * were checked by hand (see the lane report); a test cannot load two Prisma
 * clients in one process.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  CollectingEventSink,
  FakeClock,
  InMemoryBlobStore,
} from "../../kernel/testing/index.js";
import { createKernel, runMaintenanceTick } from "../../kernel/index.js";
import {
  createPrismaJobQueue,
  createPrismaWorkflowPersistence,
  fromPrisma8,
  PrismaJobQueue,
  PrismaWorkflowPersistence,
  SQLITE_DATE_STORAGE_DOCS,
  SqliteDateStorageError,
} from "../../persistence/prisma/index.js";
import { rawFor } from "../../persistence/prisma/prisma-client-type.js";
import {
  sqliteDateGuard,
  unguarded,
  verifySqliteDates,
} from "../../persistence/prisma/sqlite-date-guard.js";

/** A client whose probe answers `rows` (or throws), counting the probes. */
function fakeClient(answer: () => unknown) {
  const calls = { n: 0 };
  const run = {
    $queryRaw: async () => {
      calls.n++;
      return answer();
    },
  };
  const client: any = { ...run, $withColumns: () => run };
  return { client, calls };
}

describe("sqlite date guard: the check", () => {
  const probe = (lo: string, hi: string, bound: string) => [{ lo, hi, bound }];

  it("refuses stored dates of the other storage class and names the cause", async () => {
    const { client } = fakeClient(() => probe("integer", "integer", "text"));
    const error = await verifySqliteDates(
      client,
      sqliteDateGuard(client),
    ).catch((e) => e);
    expect(error).toBeInstanceOf(SqliteDateStorageError);
    expect(error.code).toBe("SQLITE_DATE_STORAGE_MISMATCH");
    expect(error.stored).toBe("integer");
    expect(error.bound).toBe("text");
    expect(error.message).toContain("different Prisma major");
    expect(error.message).toContain(SQLITE_DATE_STORAGE_DOCS);
    expect(SQLITE_DATE_STORAGE_DOCS).toMatch(
      /prisma-setup\.md#a-sqlite-file-belongs-to-the-prisma-major-that-created-it$/,
    );
  });

  it("refuses a file that is mixed (the oldest and the newest differ), either way round", async () => {
    for (const [lo, hi, bound, stored] of [
      ["integer", "text", "text", "integer"],
      ["integer", "text", "integer", "text"],
    ] as const) {
      const { client } = fakeClient(() => probe(lo, hi, bound));
      await expect(
        verifySqliteDates(client, sqliteDateGuard(client)),
      ).rejects.toMatchObject({ stored });
    }
  });

  it("does not refuse an empty table, a file of the same class or a client without raw queries", async () => {
    for (const answer of [
      probe("null", "null", "text"),
      probe("text", "text", "text"),
      probe("integer", "integer", "integer"),
      [],
    ]) {
      const { client } = fakeClient(() => answer);
      await expect(
        verifySqliteDates(client, sqliteDateGuard(client)),
      ).resolves.toBeUndefined();
    }
    const bare: any = { $withColumns: () => ({}) };
    await expect(
      verifySqliteDates(bare, sqliteDateGuard(bare)),
    ).resolves.toBeUndefined();
  });

  it("asks once per client, and retries only a probe that failed", async () => {
    const { client, calls } = fakeClient(() => probe("text", "text", "text"));
    const guard = sqliteDateGuard(client);
    await Promise.all(
      Array.from({ length: 20 }, () => verifySqliteDates(client, guard)),
    );
    await verifySqliteDates(client, guard);
    expect(calls.n).toBe(1);
    expect(sqliteDateGuard(client)).toBe(guard);

    // A schema that is not pushed yet: not a refusal, asked again next time.
    let failing = true;
    const unpushed = fakeClient(() => {
      if (failing) throw new Error("no such table: workflow_runs");
      return probe("text", "text", "text");
    });
    const g = sqliteDateGuard(unpushed.client);
    await expect(
      verifySqliteDates(unpushed.client, g),
    ).resolves.toBeUndefined();
    await expect(
      verifySqliteDates(unpushed.client, g),
    ).resolves.toBeUndefined();
    expect(unpushed.calls.n).toBe(2);
    failing = false;
    await verifySqliteDates(unpushed.client, g);
    await verifySqliteDates(unpushed.client, g);
    expect(unpushed.calls.n).toBe(3);
  });
});

const major = process.env.PRISMA_MAJOR ?? "7";
const sqlite = process.env.SQLITE8_KERNEL_SQLITE === "1";
const fixtures = createRequire(import.meta.url)(
  "../../../../prisma-fixtures/index.cjs",
);

/**
 * Methods that are not `async` and so are not guarded: constructors, mappers
 * and query builders that never touch the database, and the few synchronous
 * accessors. A method that returns a promise must be `async`, or it would
 * skip the check: this list is what makes adding one a deliberate decision.
 */
const SYNC_PERSISTENCE = [
  "buildRunUpdateData",
  "buildStageUpdateData",
  "constructor",
  "mapDefinition",
  "mapOutboxEvent",
  "mapWorkflowAnnotation",
  "mapWorkflowArtifact",
  "mapWorkflowRun",
  "mapWorkflowStage",
  "purgeable",
  "servesFilter",
  "supportsDefinitionVersioning",
];
const SYNC_QUEUE = [
  "ackOutcome",
  "adoptWorkerId",
  "constructor",
  "enqueueData",
  "enqueueDeleteFilter",
  "fenceWhere",
  "getWorkerId",
  "servesParams",
  "servesPayload",
  "transactionReads",
];

describe.skipIf(!sqlite)(`sqlite date guard on Prisma ${major}`, () => {
  let directory: string;
  const clients: any[] = [];

  async function open(file: string, existing = false) {
    const client: any =
      major === "8"
        ? await (async () => {
            const db = existing
              ? fixtures.openSqliteDb(file)
              : await fixtures.createSqliteDb(file);
            return Object.assign(fromPrisma8(db), {
              $disconnect: () => db.close(),
            });
          })()
        : fixtures.createSqliteClient(file);
    clients.push(client);
    return client;
  }

  /** A persistence, a queue and a kernel on one client. */
  function stack(client: any) {
    const options = { databaseType: "sqlite" as const };
    const persistence = createPrismaWorkflowPersistence(client, options);
    const queue = createPrismaJobQueue(client, {
      ...options,
      workerId: "guard-worker",
    });
    const kernel = createKernel({
      persistence,
      blobStore: new InMemoryBlobStore(),
      jobTransport: queue,
      eventSink: new CollectingEventSink(),
      clock: new FakeClock(),
      registry: { getWorkflow: () => undefined },
    });
    return { persistence, queue, kernel };
  }

  const classOf = async (client: any, column: string) => {
    const rows = await rawFor(client, { t: "text" }).$queryRawUnsafe(
      `SELECT typeof(MIN("${column}")) AS t FROM "workflow_runs"`,
    );
    return String(rows[0].t);
  };

  const runInput = (id: string) => ({
    id,
    workflowId: "guard",
    workflowName: "guard",
    workflowType: "guard",
    input: {},
  });

  /**
   * A file holding a run completed a moment ago ("done") and a RUNNING run
   * updated a moment ago ("running"), whose dates are in the storage class
   * this major does not write (the older run's only, with `mixed`). Prisma 6
   * and 7 write the file, then SQL rewrites the stored dates into the other
   * class. Prisma 8's tables have text affinity, which turns an integer back
   * into text, so there the tables are hand-built with the affinity of a
   * Prisma 6 file and opened through Prisma 8.
   */
  async function otherClassFile(name: string, mixed = false) {
    const file = join(directory, name);
    if (major === "8") {
      const { DatabaseSync } = await import("node:sqlite");
      const db = new DatabaseSync(file);
      db.exec(`CREATE TABLE "workflow_runs" (
        "id" TEXT NOT NULL PRIMARY KEY, "status" TEXT NOT NULL,
        "createdAt" DATETIME NOT NULL, "updatedAt" DATETIME NOT NULL, "completedAt" DATETIME);
        CREATE INDEX "workflow_runs_createdAt_id_idx" ON "workflow_runs"("createdAt" DESC, "id" DESC);`);
      const now = Date.now();
      const iso = (ms: number) => new Date(ms).toISOString();
      const insert = db.prepare(
        `INSERT INTO "workflow_runs" VALUES (?, ?, ?, ?, ?)`,
      );
      insert.run("done", "COMPLETED", now - 20, now - 20, now - 20);
      insert.run(
        "running",
        "RUNNING",
        mixed ? iso(now - 10) : now - 10,
        mixed ? iso(now - 10) : now - 10,
        null,
      );
      db.close();
      return file;
    }
    const writer = await open(file);
    const { persistence } = stack(writer);
    await persistence.createRun(runInput("done"));
    await persistence.updateRun("done", {
      status: "COMPLETED",
      completedAt: new Date(),
    });
    await new Promise((r) => setTimeout(r, 15));
    await persistence.createRun(runInput("running"));
    await persistence.updateRun("running", { status: "RUNNING" });
    const toText = (await classOf(writer, "createdAt")) === "integer";
    // The older run only when mixed, every run otherwise.
    const where = mixed ? `id = 'done'` : "1 = 1";
    for (const column of ["createdAt", "updatedAt", "completedAt"]) {
      await writer.$executeRawUnsafe(
        toText
          ? `UPDATE "workflow_runs" SET "${column}" = strftime('%Y-%m-%dT%H:%M:%f', "${column}" / 1000.0, 'unixepoch') || 'Z' WHERE "${column}" IS NOT NULL AND ${where}`
          : `UPDATE "workflow_runs" SET "${column}" = CAST(ROUND((julianday(substr("${column}", 1, 23)) - 2440587.5) * 86400000) AS INTEGER) WHERE "${column}" IS NOT NULL AND ${where}`,
      );
    }
    return file;
  }

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), `sqlite-date-guard-${major}-`));
  });
  afterAll(async () => {
    for (const client of clients) await client.$disconnect();
    await rm(directory, { recursive: true, force: true });
  });

  it("lets an empty file and a file written by this major through", async () => {
    const file = join(directory, "same.db");
    const { persistence, queue } = stack(await open(file));
    expect(await persistence.getRun("nothing")).toBeNull();
    await persistence.createRun(runInput("done"));
    await persistence.updateRun("done", {
      status: "COMPLETED",
      completedAt: new Date(),
    });
    await queue.enqueueParallel([
      { workflowRunId: "done", workflowId: "guard", stageId: "a" },
    ]);
    expect((await persistence.getRun("done"))?.status).toBe("COMPLETED");
    // Another client on the same file, as a second process would open it.
    const again = stack(await open(file, true));
    expect((await again.persistence.getRun("done"))?.status).toBe("COMPLETED");
    expect(await again.queue.dequeue()).not.toBeNull();
  }, 60_000);

  it("refuses a file stored in the other storage class before the engine acts on it", async () => {
    const reader = await open(await otherClassFile("other.db"), true);
    const { persistence, queue, kernel } = stack(reader);
    const hourAgo = new Date(Date.now() - 3_600_000);
    const refused = (call: () => Promise<unknown>) =>
      expect(call()).rejects.toBeInstanceOf(SqliteDateStorageError);

    await refused(() => persistence.getRun("done"));
    // What the engine acts on (retention, the reaper), the poll and the lease sweeps.
    await refused(() =>
      persistence.listRunsForPurge(hourAgo, ["COMPLETED"], 10),
    );
    await refused(() => persistence.getStuckRuns(hourAgo));
    await refused(() => persistence.getSuspendedStages(new Date()));
    await refused(() => queue.dequeue());
    await refused(() => queue.releaseStaleJobs(1));
    await refused(() => persistence.withTransaction(async () => "never"));
    await refused(() =>
      kernel.dispatch({ type: "run.reapStuck", stuckThresholdMs: 3_600_000 }),
    );
    await refused(() =>
      kernel.dispatch({ type: "run.purge", olderThan: hourAgo }),
    );

    // A host's tick: every command fails with the clear error and acts on nothing.
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await runMaintenanceTick(kernel, {
        workerId: "guard-worker",
        retention: { olderThanMs: 3_600_000 },
        logPrefix: "[Guard]",
      });
      const messages = logged.mock.calls.map((args) =>
        args.map(String).join(" "),
      );
      expect(
        messages.filter((m) => m.includes("different Prisma major")).length,
      ).toBeGreaterThanOrEqual(3);
    } finally {
      logged.mockRestore();
    }

    // Nothing was deleted, reaped or changed.
    const rows = await rawFor(reader, {
      id: "text",
      status: "text",
    }).$queryRawUnsafe(`SELECT id, status FROM "workflow_runs" ORDER BY id`);
    expect(rows.map((r: any) => `${r.id}:${r.status}`)).toEqual([
      "done:COMPLETED",
      "running:RUNNING",
    ]);
  }, 60_000);

  it("refuses a file that two majors have both written to", async () => {
    const { persistence } = stack(
      await open(await otherClassFile("mixed.db", true), true),
    );
    await expect(persistence.getRun("running")).rejects.toBeInstanceOf(
      SqliteDateStorageError,
    );
  }, 60_000);

  it("asks one cheap question: the probe is answered from an index", async () => {
    const client = await open(join(directory, "plan.db"));
    const rows = await rawFor(client, { detail: "text" }).$queryRawUnsafe(
      `EXPLAIN QUERY PLAN SELECT typeof((SELECT MIN("createdAt") FROM "workflow_runs")) AS lo, typeof((SELECT MAX("createdAt") FROM "workflow_runs")) AS hi, typeof(0) AS bound`,
    );
    const plan = rows.map((r: any) => String(r.detail)).join("\n");
    expect(plan).toMatch(/SEARCH workflow_runs USING (COVERING )?INDEX/);
    expect(plan).not.toMatch(/SCAN workflow_runs/);
  }, 60_000);

  it("guards every method of both adapters, and the unguarded ones are the listed ones", async () => {
    const { persistence, queue } = stack(
      await open(await otherClassFile("audit.db"), true),
    );

    for (const [instance, klass, sync, atLeast] of [
      [persistence, PrismaWorkflowPersistence, SYNC_PERSISTENCE, 40],
      [queue, PrismaJobQueue, SYNC_QUEUE, 10],
    ] as const) {
      const asyncNames: string[] = [];
      const other: string[] = [];
      for (const name of Object.getOwnPropertyNames(klass.prototype)) {
        const original = unguarded(
          Object.getOwnPropertyDescriptor(klass.prototype, name)?.value,
        );
        if (typeof original !== "function") continue;
        if (original.constructor.name === "AsyncFunction")
          asyncNames.push(name);
        else other.push(name);
      }
      // A method that returns a promise must be `async`, or it is not guarded.
      expect(other.sort(), klass.name).toEqual(sync);
      expect(asyncNames.length, klass.name).toBeGreaterThan(atLeast);
      for (const name of asyncNames) {
        await expect(
          (instance as any)[name](),
          `${klass.name}.${name}`,
        ).rejects.toBeInstanceOf(SqliteDateStorageError);
      }
    }
  }, 60_000);
});
