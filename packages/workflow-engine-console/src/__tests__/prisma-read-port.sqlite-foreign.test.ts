import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type ConsolePrismaClient,
  createPrismaConsoleReadPort,
} from "../prisma-read-port";

/**
 * The console's read port binds dates in its filters and keyset cursors, so on
 * a SQLite file another Prisma major wrote it would answer wrongly (a Prisma 6
 * file read by Prisma 7: "created in the last hour" listed nothing and
 * "created before an hour ago" listed everything). It runs the engine's check
 * and refuses instead. The file is written through the current major and its
 * stored dates are then rewritten into the other storage class with SQL; real
 * files written by two majors were checked by hand (see the lane report).
 */

const major = process.env.PRISMA_MAJOR ?? "7";
const isPrisma8 = major === "8";
const enginePersistence = "@bratsos/workflow-engine/persistence";
const engine = await import(enginePersistence);
const fixture = createRequire(import.meta.url)(
  "../../../prisma-fixtures/index.cjs",
);

const now = Date.now();
const HOUR = 3_600_000;

describe(`the console read port on a SQLite file another Prisma major wrote, on Prisma ${major}`, () => {
  let directory: string;
  const clients: any[] = [];

  async function open(
    file: string,
    existing: boolean,
  ): Promise<ConsolePrismaClient & Record<string, any>> {
    let client: any;
    if (isPrisma8) {
      const db = existing
        ? fixture.openSqliteDb(file)
        : await fixture.createSqliteDb(file);
      client = Object.assign(engine.fromPrisma8(db), {
        $disconnect: () => db.close(),
      });
    } else {
      client = fixture.createSqliteClient(file);
    }
    clients.push(client);
    return client;
  }

  const readerOn = (client: ConsolePrismaClient) =>
    createPrismaConsoleReadPort(client, { databaseType: "sqlite" });

  const run = (id: string, createdAt: Date) => ({
    id,
    workflowId: "wf",
    workflowName: "wf",
    workflowType: "wf",
    status: "COMPLETED",
    input: {},
    createdAt,
    updatedAt: createdAt,
  });

  /** A file this major wrote: two runs, the first created just now. */
  async function writtenByThisMajor(name: string) {
    const file = join(directory, name);
    const writer = await open(file, false);
    await writer.workflowRun.create({ data: run("recent", new Date(now)) });
    await writer.workflowRun.create({
      data: run("old", new Date(now - 5 * HOUR)),
    });
    return { file, writer };
  }

  /** The same file with its dates in the storage class the other majors use. */
  async function otherClass(name: string) {
    const { file, writer } = await writtenByThisMajor(name);
    const toText = major === "6";
    for (const column of ["createdAt", "updatedAt"]) {
      await writer.$executeRawUnsafe!(
        toText
          ? `UPDATE "workflow_runs" SET "${column}" = strftime('%Y-%m-%dT%H:%M:%f', "${column}" / 1000.0, 'unixepoch') || 'Z'`
          : `UPDATE "workflow_runs" SET "${column}" = CAST(ROUND((julianday(substr("${column}", 1, 23)) - 2440587.5) * 86400000) AS INTEGER)`,
      );
    }
    return file;
  }

  beforeAll(() => {
    directory = mkdtempSync(join(tmpdir(), "console-foreign-"));
  });
  afterAll(async () => {
    for (const client of clients) await client.$disconnect?.();
    rmSync(directory, { recursive: true, force: true });
  });

  it("answers from a file the current major wrote", async () => {
    const { writer } = await writtenByThisMajor("same.db");
    const page = await readerOn(writer).listRuns({
      filters: { createdAfter: new Date(now - HOUR) },
    });
    expect(page.runs.map((r) => r.id)).toEqual(["recent"]);
  }, 60_000);

  // Prisma 8's tables have text affinity, which turns a rewritten integer
  // back into text, so there the foreign file is hand-built (a Prisma 6 file's
  // affinity) and opened through Prisma 8.
  it.skipIf(isPrisma8)(
    "refuses every read on a file stored in the other storage class",
    async () => {
      const reader = readerOn(await open(await otherClass("other.db"), true));
      const refused = (call: () => Promise<unknown>) =>
        expect(call()).rejects.toBeInstanceOf(engine.SqliteDateStorageError);
      // The reads that bind a date: a filter and a keyset cursor.
      await refused(() =>
        reader.listRuns({ filters: { createdAfter: new Date(now - HOUR) } }),
      );
      await refused(() =>
        reader.listRuns({ filters: { createdBefore: new Date(now - HOUR) } }),
      );
      await refused(() => reader.listRuns({ limit: 1 }));
      await refused(() => reader.getQueueHealth());
      await refused(() => reader.listSuspendedStages());
    },
    60_000,
  );

  it.skipIf(!isPrisma8)(
    "refuses every read on a Prisma 6 style file opened through Prisma 8",
    async () => {
      const { DatabaseSync } = await import("node:sqlite");
      const file = join(directory, "p6style.db");
      const db = new DatabaseSync(file);
      db.exec(`CREATE TABLE "workflow_runs" ("id" TEXT NOT NULL PRIMARY KEY, "createdAt" DATETIME NOT NULL);
        CREATE INDEX "workflow_runs_createdAt_id_idx" ON "workflow_runs"("createdAt" DESC, "id" DESC);
        CREATE TABLE "outbox_events" ("id" TEXT NOT NULL PRIMARY KEY, "publishedAt" DATETIME, "dlqAt" DATETIME);
        CREATE INDEX "outbox_events_publishedAt_idx" ON "outbox_events"("publishedAt");
        CREATE INDEX "outbox_events_dlqAt_idx" ON "outbox_events"("dlqAt");
        CREATE TABLE "workflow_stages" ("id" TEXT NOT NULL PRIMARY KEY, "nextPollAt" DATETIME);
        CREATE INDEX "workflow_stages_nextPollAt_idx" ON "workflow_stages"("nextPollAt");
        CREATE TABLE "job_queue" ("id" TEXT NOT NULL PRIMARY KEY, "nextPollAt" DATETIME);
        CREATE INDEX "job_queue_nextPollAt_idx" ON "job_queue"("nextPollAt");`);
      db.prepare(`INSERT INTO "workflow_runs" VALUES (?, ?)`).run(
        "recent",
        now,
      );
      db.close();
      const reader = readerOn(await open(file, true));
      await expect(
        reader.listRuns({ filters: { createdAfter: new Date(now - HOUR) } }),
      ).rejects.toBeInstanceOf(engine.SqliteDateStorageError);
    },
    60_000,
  );

  it("does not run the check for PostgreSQL", async () => {
    // A client that would fail on any SQLite probe is untouched: the check is
    // only for databaseType "sqlite".
    const never = {
      $queryRaw: () => {
        throw new Error("probed");
      },
      $queryRawUnsafe: async () => [],
    } as unknown as ConsolePrismaClient;
    const reader = createPrismaConsoleReadPort(never, {
      databaseType: "postgresql",
    });
    await expect(reader.listRuns({ limit: 1 })).resolves.toMatchObject({
      runs: [],
    });
  });
});
