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
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createKernel, runMaintenanceTick } from "../../kernel/index.js";
import {
  CollectingEventSink,
  FakeClock,
  InMemoryBlobStore,
} from "../../kernel/testing/index.js";
import {
  createPrismaAICallLogger,
  createPrismaJobQueue,
  createPrismaStepLedger,
  createPrismaWorkflowPersistence,
  fromPrisma8,
  PrismaAICallLogger,
  PrismaJobQueue,
  PrismaStepLedger,
  PrismaWorkflowPersistence,
  SQLITE_DATE_STORAGE_DOCS,
  SqliteDateStorageError,
  SqliteDateStorageUnverifiedError,
} from "../../persistence/prisma/index.js";
import { rawFor } from "../../persistence/prisma/prisma-client-type.js";
import {
  assertSqliteDateStorage,
  sqliteDateGuard,
  verifySqliteDates,
} from "../../persistence/prisma/sqlite-date-guard.js";
import { InMemoryJobQueue } from "../../testing/index.js";

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
  const PLUS = "2026-11-17T16:48:54.224+00:00";
  const ZED = "2026-11-17T16:48:54.224Z";
  /**
   * What the probe returns: the oldest and newest `workflow_runs.createdAt`
   * (`lo`, `hi`, and their text) and the bound `Date`; `extra` adds rows for
   * other probed columns.
   */
  const probe = (
    lo: string,
    hi: string,
    bound: string,
    values: [string | null, string | null, string | null] = [PLUS, PLUS, PLUS],
    extra: {
      col: string;
      lo: string;
      loValue: string | null;
      hi: string;
      hiValue: string | null;
    }[] = [],
  ) => [
    {
      col: "workflow_runs.createdAt",
      lo,
      loValue: values[0],
      hi,
      hiValue: values[1],
    },
    ...extra,
    {
      col: "bound",
      lo: bound,
      loValue: values[2],
      hi: bound,
      hiValue: values[2],
    },
  ];

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

  it("refuses text dates written in the other form (Prisma 7 against 8), either way round, and says so", async () => {
    for (const [values, stored, bound] of [
      [[PLUS, PLUS, ZED], PLUS, ZED],
      [[ZED, ZED, PLUS], ZED, PLUS],
      // Only the newest stored date differs from the oldest: a file two majors wrote.
      [[PLUS, ZED, PLUS], ZED, PLUS],
    ] as const) {
      const { client } = fakeClient(() =>
        probe("text", "text", "text", [...values] as [string, string, string]),
      );
      const error = await verifySqliteDates(
        client,
        sqliteDateGuard(client),
      ).catch((e) => e);
      expect(error).toBeInstanceOf(SqliteDateStorageError);
      expect(error.kind).toBe("form");
      expect(error.stored).toBe(`text like ${stored}`);
      expect(error.bound).toBe(`text like ${bound}`);
      expect(error.message).toContain("exact instant");
      expect(error.message).toContain(SQLITE_DATE_STORAGE_DOCS);
    }
  });

  it("does not refuse text dates of the same form at other times, or integers whatever their digits", async () => {
    for (const answer of [
      probe("text", "text", "text", [
        "2026-01-02T03:04:05.006+00:00",
        "2031-12-31T23:59:59.999+00:00",
        "1970-01-01T00:00:00.000+00:00",
      ]),
      probe("text", "text", "text", [ZED, "2031-12-31T23:59:59.999Z", ZED]),
      probe("integer", "integer", "integer", ["0", "1794934130124", "0"]),
    ]) {
      const { client } = fakeClient(() => answer);
      await expect(
        verifySqliteDates(client, sqliteDateGuard(client)),
      ).resolves.toBeUndefined();
    }
  });

  it("looks at the other indexed date columns too, and says which one differs", async () => {
    // The runs are in this client's class, the outbox and the stage polls are not.
    for (const [col, lo, loValue, hi, hiValue, kind] of [
      [
        "outbox_events.publishedAt",
        "integer",
        "1794934130124",
        "integer",
        "1794934130999",
        "class",
      ],
      [
        "workflow_stages.nextPollAt",
        "text",
        PLUS,
        "integer",
        "1794934130124",
        "class",
      ],
      ["job_queue.nextPollAt", "text", ZED, "text", ZED, "form"],
      ["outbox_events.dlqAt", "text", PLUS, "text", ZED, "form"],
    ] as const) {
      const { client } = fakeClient(() =>
        probe(
          "text",
          "text",
          "text",
          [PLUS, PLUS, PLUS],
          [{ col, lo, loValue, hi, hiValue }],
        ),
      );
      const error = await verifySqliteDates(
        client,
        sqliteDateGuard(client),
      ).catch((e) => e);
      expect(error, col).toBeInstanceOf(SqliteDateStorageError);
      expect(error.kind).toBe(kind);
      expect(error.column).toBe(col);
      expect(error.message).toContain(`(in ${col})`);
    }
    // Empty columns (the common case for the poll deadlines) say nothing.
    const { client } = fakeClient(() =>
      probe(
        "text",
        "text",
        "text",
        [PLUS, PLUS, PLUS],
        [
          {
            col: "job_queue.nextPollAt",
            lo: "null",
            loValue: null,
            hi: "null",
            hiValue: null,
          },
        ],
      ),
    );
    await expect(
      verifySqliteDates(client, sqliteDateGuard(client)),
    ).resolves.toBeUndefined();
  });

  it("does not refuse a file of the same class or form", async () => {
    for (const answer of [
      probe("text", "text", "text"),
      probe("integer", "integer", "integer", ["1", "2", "0"]),
    ]) {
      const { client } = fakeClient(() => answer);
      await expect(
        verifySqliteDates(client, sqliteDateGuard(client)),
      ).resolves.toBeUndefined();
    }
  });

  it("asks once per client after a conclusive pass", async () => {
    const { client, calls } = fakeClient(() => probe("text", "text", "text"));
    const guard = sqliteDateGuard(client);
    await Promise.all(
      Array.from({ length: 20 }, () => verifySqliteDates(client, guard)),
    );
    await verifySqliteDates(client, guard);
    expect(calls.n).toBe(1);
    expect(sqliteDateGuard(client)).toBe(guard);
  });

  it("fails the operation when the probe throws, keeps the cause, and probes again on the next call", async () => {
    let failing = true;
    const cause = new Error("no such table: job_queue");
    const { client, calls } = fakeClient(() => {
      if (failing) throw cause;
      return probe("text", "text", "text");
    });
    const guard = sqliteDateGuard(client);
    for (let i = 0; i < 2; i++) {
      const error = await verifySqliteDates(client, guard).catch((e) => e);
      expect(error).toBeInstanceOf(SqliteDateStorageUnverifiedError);
      expect(error.code).toBe("SQLITE_DATE_STORAGE_UNVERIFIED");
      expect(error.reason).toBe("probe-failed");
      expect(error.cause).toBe(cause);
      expect(error.message).toContain("no such table: job_queue");
    }
    expect(calls.n).toBe(2);
    failing = false;
    await verifySqliteDates(client, guard);
    await verifySqliteDates(client, guard);
    expect(calls.n).toBe(3);
  });

  it("never remembers a check that saw no stored date, and refuses the first foreign date written after it", async () => {
    // Every probed column empty: an empty file (only the bound row has a value).
    let answer = probe("null", "null", "text", [null, null, PLUS]);
    const { client, calls } = fakeClient(() => answer);
    const guard = sqliteDateGuard(client);
    await verifySqliteDates(client, guard);
    await verifySqliteDates(client, guard);
    expect(calls.n).toBe(2);
    expect(guard.verified).toBeNull();
    // Another major writes its first row: the next call sees it.
    answer = probe("integer", "integer", "text", ["1", "1", PLUS]);
    await expect(verifySqliteDates(client, guard)).rejects.toBeInstanceOf(
      SqliteDateStorageError,
    );
    // A sampled table alone (only an outbox row, say) is conclusive too.
    const outboxOnly = fakeClient(() =>
      probe(
        "null",
        "null",
        "text",
        [null, null, PLUS],
        [
          {
            col: "outbox_events.occurredAt",
            lo: "integer",
            loValue: "1",
            hi: "integer",
            hiValue: "1",
          },
        ],
      ),
    );
    await expect(
      verifySqliteDates(outboxOnly.client, sqliteDateGuard(outboxOnly.client)),
    ).rejects.toMatchObject({ column: "outbox_events.occurredAt" });
  });

  it("probes through $queryRawUnsafe when the client has no tagged $queryRaw, and refuses a client with neither", async () => {
    const seen: { sql: string; values: unknown[] }[] = [];
    const unsafeOnly: any = {
      $queryRawUnsafe: async (sql: string, ...values: unknown[]) => {
        seen.push({ sql, values });
        return probe("integer", "integer", "text");
      },
    };
    await expect(
      verifySqliteDates(unsafeOnly, sqliteDateGuard(unsafeOnly)),
    ).rejects.toBeInstanceOf(SqliteDateStorageError);
    expect(seen).toHaveLength(1);
    // Prisma 6 and 7 adapters take `?`; one parameter, the bound `Date`.
    expect(seen[0].sql).toContain("SELECT ? AS d");
    expect(seen[0].values).toEqual([new Date(0)]);

    const bare: any = { $withColumns: () => ({}) };
    const error = await verifySqliteDates(bare, sqliteDateGuard(bare)).catch(
      (e) => e,
    );
    expect(error).toBeInstanceOf(SqliteDateStorageUnverifiedError);
    expect(error.reason).toBe("no-raw-query");
    expect(error.message).toContain("$queryRaw");
    expect(error.message).toContain("$queryRawUnsafe");
  });
});

const major = process.env.PRISMA_MAJOR ?? "7";
const sqlite = process.env.SQLITE8_KERNEL_SQLITE === "1";
const fixtures = createRequire(import.meta.url)(
  "../../../../prisma-fixtures/index.cjs",
);

/**
 * The methods each adapter leaves unguarded because they are synchronous:
 * mappers and query builders that never touch the database, and a few
 * accessors. The source lists the same names (`guardSqliteAdapter(...)` after
 * each class); a method is guarded unless it is named there, whatever way the
 * code was compiled, so a new one needs no decision and a new synchronous
 * helper has to be named in both places.
 */
const SYNC_PERSISTENCE = [
  "buildRunUpdateData",
  "buildStageUpdateData",
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
  "enqueueData",
  "enqueueDeleteFilter",
  "fenceWhere",
  "getWorkerId",
  "servesParams",
  "servesPayload",
  "transactionReads",
];

/** The prototype's methods, split into the guarded ones and the ones left unguarded. */
function auditNames(prototype: object) {
  const guarded: string[] = [];
  const unguardedNames: string[] = [];
  for (const name of Object.getOwnPropertyNames(prototype)) {
    if (name === "constructor") continue;
    const method = Object.getOwnPropertyDescriptor(prototype, name)?.value;
    if (typeof method !== "function") continue;
    // The marker is a symbol each copy of the guard module makes for itself, so a
    // lowered bundle's is not the one this file imports: find it by description.
    const wrapped = Object.getOwnPropertySymbols(method).some(
      (symbol) => symbol.description === "sqliteDateGuard.original",
    );
    (wrapped ? guarded : unguardedNames).push(name);
  }
  return { guarded, unguardedNames: unguardedNames.sort() };
}

/**
 * The persistence adapters as a consumer's toolchain would ship them when it
 * lowers `async` (an ES2016 target): bundled from source with esbuild, which
 * turns every `async` method into a plain function returning a promise.
 */
async function loadLowered(): Promise<any> {
  const require = createRequire(import.meta.url);
  const esbuild = createRequire(require.resolve("tsup/package.json"))(
    "esbuild",
  );
  // Inside the package, so the bundle's bare imports resolve from its node_modules.
  const dir = await mkdtemp(
    join(
      fileURLToPath(new URL("../../../", import.meta.url)),
      "node_modules",
      ".lowered-",
    ),
  );
  try {
    const outfile = join(dir, "lowered.mjs");
    await esbuild.build({
      entryPoints: [
        fileURLToPath(
          new URL("../../persistence/prisma/index.ts", import.meta.url),
        ),
      ],
      bundle: true,
      format: "esm",
      platform: "node",
      target: "es2016",
      packages: "external",
      outfile,
      logLevel: "silent",
    });
    return await import(pathToFileURL(outfile).href);
  } finally {
    // The module is loaded; the files are not needed.
    await rm(dir, { recursive: true, force: true });
  }
}

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
   * Rewrites the stored dates of `columns` into what another major writes:
   * Prisma 6's integers into text, Prisma 7's text into integers (both a class
   * difference), Prisma 8's `Z` text into `+00:00` (a form difference; its
   * tables' text affinity keeps an integer as text).
   */
  async function foreignize(client: any, table: string, columns: string[]) {
    const to: Record<string, (c: string) => string> = {
      "6": (c) =>
        `strftime('%Y-%m-%dT%H:%M:%f', "${c}" / 1000.0, 'unixepoch') || '+00:00'`,
      "7": (c) =>
        `CAST(ROUND((julianday(substr("${c}", 1, 23)) - 2440587.5) * 86400000) AS INTEGER)`,
      "8": (c) => `replace("${c}", 'Z', '+00:00')`,
    };
    for (const column of columns) {
      await client.$executeRawUnsafe(
        `UPDATE "${table}" SET "${column}" = ${to[major](column)} WHERE "${column}" IS NOT NULL`,
      );
    }
  }

  /** A view of `client` without the named members, as a wrapper that does not forward them. */
  const without = (target: any, hidden: string[]): any =>
    new Proxy(target, {
      get(t, key) {
        if (hidden.includes(String(key))) return undefined;
        const value = Reflect.get(t, key);
        if (key === "$withColumns" && typeof value === "function")
          return (...args: unknown[]) => without(value.apply(t, args), hidden);
        return typeof value === "function" ? value.bind(t) : value;
      },
      has: (t, key) => !hidden.includes(String(key)) && Reflect.has(t, key),
    });

  /** A view of `client` whose first `n` raw probes throw `cause`. */
  const failingProbes = (target: any, n: number, cause: Error): any => {
    let left = n;
    const wrap = (inner: any): any =>
      new Proxy(inner, {
        get(t, key) {
          const value = Reflect.get(t, key);
          if (key === "$queryRaw" || key === "$queryRawUnsafe") {
            return (first: any, ...rest: unknown[]) => {
              const text = Array.isArray(first) ? first.join("?") : first;
              if (String(text).includes("'bound'") && left > 0) {
                left--;
                return Promise.reject(cause);
              }
              return value.call(t, first, ...rest);
            };
          }
          if (key === "$withColumns" && typeof value === "function")
            return (...args: unknown[]) => wrap(value.apply(t, args));
          return typeof value === "function" ? value.bind(t) : value;
        },
      });
    return wrap(target);
  };

  const statuses = async (client: any) =>
    (
      await rawFor(client, { id: "text", status: "text" }).$queryRawUnsafe(
        `SELECT id, status FROM "workflow_runs" ORDER BY id`,
      )
    ).map((r: any) => `${r.id}:${r.status}`);

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
        CREATE INDEX "workflow_runs_createdAt_id_idx" ON "workflow_runs"("createdAt" DESC, "id" DESC);
        CREATE TABLE "outbox_events" ("id" TEXT NOT NULL PRIMARY KEY, "occurredAt" DATETIME, "publishedAt" DATETIME, "dlqAt" DATETIME);
        CREATE INDEX "outbox_events_publishedAt_idx" ON "outbox_events"("publishedAt");
        CREATE INDEX "outbox_events_dlqAt_idx" ON "outbox_events"("dlqAt");
        CREATE TABLE "workflow_stages" ("id" TEXT NOT NULL PRIMARY KEY, "nextPollAt" DATETIME);
        CREATE INDEX "workflow_stages_nextPollAt_idx" ON "workflow_stages"("nextPollAt");
        CREATE TABLE "job_queue" ("id" TEXT NOT NULL PRIMARY KEY, "createdAt" DATETIME, "nextPollAt" DATETIME);
        CREATE INDEX "job_queue_nextPollAt_idx" ON "job_queue"("nextPollAt");
        CREATE TABLE "idempotency_keys" ("id" TEXT NOT NULL PRIMARY KEY, "createdAt" DATETIME NOT NULL);
        CREATE TABLE "ai_calls" ("id" TEXT NOT NULL PRIMARY KEY, "createdAt" DATETIME NOT NULL);`);
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

  /**
   * A file this major wrote, whose text dates are then rewritten into the other
   * text form (Prisma 7's `+00:00` into Prisma 8's `Z` and back), the older
   * run's only when `mixed`. Prisma 6 stores integers, which have no text form.
   */
  async function otherFormFile(name: string, mixed = false) {
    const file = join(directory, name);
    const writer = await open(file);
    const { persistence } = stack(writer);
    await persistence.createRun(runInput("done"));
    await new Promise((r) => setTimeout(r, 15));
    await persistence.createRun(runInput("running"));
    const where = mixed ? `id = 'done'` : "1 = 1";
    for (const column of ["createdAt", "updatedAt"]) {
      await writer.$executeRawUnsafe(
        major === "7"
          ? `UPDATE "workflow_runs" SET "${column}" = replace("${column}", '+00:00', 'Z') WHERE ${where}`
          : `UPDATE "workflow_runs" SET "${column}" = replace("${column}", 'Z', '+00:00') WHERE ${where}`,
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

  it.skipIf(major === "6")(
    "refuses a file whose text dates are in the other form, the path of a Prisma 7 to 8 upgrade",
    async () => {
      const { persistence, kernel } = stack(
        await open(await otherFormFile("form.db"), true),
      );
      const error = await persistence.getRun("done").catch((e) => e);
      expect(error).toBeInstanceOf(SqliteDateStorageError);
      expect(error.kind).toBe("form");
      expect(error.stored).toMatch(
        major === "7" ? /text like .*Z$/ : /text like .*\+00:00$/,
      );
      expect(error.bound).toMatch(
        major === "7" ? /text like .*\+00:00$/ : /text like .*Z$/,
      );
      await expect(
        kernel.dispatch({
          type: "run.reapStuck",
          stuckThresholdMs: 3_600_000,
        }),
      ).rejects.toBeInstanceOf(SqliteDateStorageError);
    },
    60_000,
  );

  it.skipIf(major === "6")(
    "refuses a file whose text dates are in both forms",
    async () => {
      const { persistence } = stack(
        await open(await otherFormFile("form-mixed.db", true), true),
      );
      await expect(persistence.getRun("running")).rejects.toBeInstanceOf(
        SqliteDateStorageError,
      );
    },
    60_000,
  );

  it("fails closed when the probe throws: the operation does not run, and the next call probes again", async () => {
    // Port of the deep review's single probe failure: a run completed a moment
    // ago, in the other class, offered to retention with a cutoff an hour ago.
    const file = await otherClassFile("probe-fails.db");
    const cause = new Error("disk I/O error");
    const reader = failingProbes(await open(file, true), 1, cause);
    const persistence = createPrismaWorkflowPersistence(reader, {
      databaseType: "sqlite",
    });
    const hourAgo = new Date(Date.now() - 3_600_000);
    const error = await persistence
      .deleteRun("done", hourAgo, ["COMPLETED"])
      .catch((e) => e);
    expect(error).toBeInstanceOf(SqliteDateStorageUnverifiedError);
    expect(error.cause).toBe(cause);
    expect(await statuses(reader)).toEqual([
      "done:COMPLETED",
      "running:RUNNING",
    ]);
    // Probed again, conclusively this time: refused, and still nothing deleted.
    await expect(
      persistence.deleteRun("done", hourAgo, ["COMPLETED"]),
    ).rejects.toBeInstanceOf(SqliteDateStorageError);
    expect(await statuses(reader)).toEqual([
      "done:COMPLETED",
      "running:RUNNING",
    ]);
  }, 60_000);

  it("fails closed on a real database error in the probe (a table it reads is missing)", async () => {
    // Port of the deep review's case: the kernel's job transport is not the
    // Prisma queue, the file has no job_queue table, and the reaper would
    // fail a run updated a moment ago.
    const file = await otherClassFile("no-queue.db");
    const reader = await open(file, true);
    await reader.$executeRawUnsafe(
      `ALTER TABLE "job_queue" RENAME TO "job_queue_offline"`,
    );
    const kernel = createKernel({
      persistence: createPrismaWorkflowPersistence(reader, {
        databaseType: "sqlite",
      }),
      blobStore: new InMemoryBlobStore(),
      jobTransport: new InMemoryJobQueue(),
      eventSink: new CollectingEventSink(),
      clock: new FakeClock(),
      registry: { getWorkflow: () => undefined },
    });
    const error = await kernel
      .dispatch({ type: "run.reapStuck", stuckThresholdMs: 3_600_000 })
      .catch((e) => e);
    expect(error).toBeInstanceOf(SqliteDateStorageUnverifiedError);
    expect(error.reason).toBe("probe-failed");
    expect(String(error.cause?.message)).toMatch(/job_queue/);
    expect(await statuses(reader)).toEqual([
      "done:COMPLETED",
      "running:RUNNING",
    ]);
  }, 60_000);

  it("re-checks a warm client that saw an empty file, and refuses once another major has written", async () => {
    // Two processes on one new file: this major's (warm) and another's.
    const file = join(directory, "warm.db");
    const warm = await open(file);
    const { kernel } = stack(warm);
    const stats = await kernel.dispatch({ type: "engine.stats" });
    expect(stats.runs).toMatchObject({ available: true });
    // The other major writes a RUNNING run, updated a moment ago.
    const other = await open(file, true);
    const writer = stack(other).persistence;
    await writer.createRun(runInput("running"));
    await writer.updateRun("running", { status: "RUNNING" });
    await foreignize(other, "workflow_runs", ["createdAt", "updatedAt"]);
    // The warm client checks again and refuses; the run is untouched.
    await expect(
      kernel.dispatch({ type: "run.reapStuck", stuckThresholdMs: 3_600_000 }),
    ).rejects.toBeInstanceOf(SqliteDateStorageError);
    await expect(
      kernel.dispatch({ type: "engine.stats" }),
    ).rejects.toBeInstanceOf(SqliteDateStorageError);
    expect(await statuses(warm)).toEqual(["running:RUNNING"]);
  }, 60_000);

  it("sees a file holding only rows no run implies: outbox events, idempotency keys, jobs, AI calls", async () => {
    const cases: [string, string, string[], (s: any) => Promise<void>][] = [
      [
        "outbox_events",
        "outbox_events.occurredAt",
        ["occurredAt", "createdAt"],
        ({ persistence }) =>
          persistence.appendOutboxEvents([
            {
              workflowRunId: "gone",
              eventType: "workflow:completed",
              payload: {},
              causationId: "c",
              occurredAt: new Date(),
            },
          ]),
      ],
      [
        "idempotency_keys",
        "idempotency_keys.createdAt",
        ["createdAt"],
        async ({ persistence }) => {
          await persistence.acquireIdempotencyKey("k", "run.create");
        },
      ],
      [
        "job_queue",
        "job_queue.createdAt",
        ["createdAt", "updatedAt"],
        async ({ queue }) => {
          await queue.enqueueParallel([
            { workflowRunId: "gone", workflowId: "guard", stageId: "a" },
          ]);
        },
      ],
      [
        "ai_calls",
        "ai_calls.createdAt",
        ["createdAt"],
        ({ ai }) =>
          ai.logBatchResults("b", [
            {
              topic: "t",
              callType: "text",
              modelKey: "m",
              modelId: "m",
              prompt: "p",
              response: "r",
              inputTokens: 1,
              outputTokens: 1,
              cost: 0,
              requestId: "r1",
            },
          ]),
      ],
    ];
    for (const [table, column, columns, write] of cases) {
      const file = join(directory, `only-${table}.db`);
      const writer = await open(file);
      const ws = stack(writer);
      await write({
        ...ws,
        ai: createPrismaAICallLogger(writer, { databaseType: "sqlite" }),
      });
      await foreignize(writer, table, columns);
      const reader = stack(await open(file, true));
      const error = await reader.kernel
        .dispatch({ type: "engine.stats" })
        .catch((e) => e);
      expect(error, table).toBeInstanceOf(SqliteDateStorageError);
      expect(error.column, table).toBe(column);
    }
  }, 120_000);

  it("checks a client that exposes only $queryRawUnsafe through it, and refuses a client with no raw read", async () => {
    const hourAgo = new Date(Date.now() - 3_600_000);
    // Port of the deep review's facade: delegates, $transaction and the
    // parameterized raw read, no tagged $queryRaw.
    const foreign = without(
      await open(await otherClassFile("facade.db"), true),
      ["$queryRaw"],
    );
    const f = stack(foreign);
    await expect(
      f.kernel.dispatch({ type: "run.reapStuck", stuckThresholdMs: 3_600_000 }),
    ).rejects.toBeInstanceOf(SqliteDateStorageError);
    await expect(
      f.persistence.listRunsForPurge(hourAgo, ["COMPLETED"], 10),
    ).rejects.toBeInstanceOf(SqliteDateStorageError);
    expect(await statuses(foreign)).toEqual([
      "done:COMPLETED",
      "running:RUNNING",
    ]);
    // The same facade on a file this major wrote passes, through the unsafe read.
    const file = join(directory, "facade-same.db");
    const own = stack(await open(file));
    await own.persistence.createRun(runInput("mine"));
    const same = stack(without(await open(file, true), ["$queryRaw"]));
    expect((await same.persistence.getRun("mine"))?.id).toBe("mine");
    // The adapters' own reads choose their path by which raw read the client
    // has (the SQLite write wrapper used to report both as present).
    for (const hidden of [["$queryRaw"], ["$queryRawUnsafe"]]) {
      const client = without(await open(file, true), hidden);
      const s: any = await stack(client).kernel.dispatch({
        type: "engine.stats",
      });
      expect(s.runs.byStatus.PENDING, hidden[0]).toBe(1);
    }
    expect(
      await createPrismaAICallLogger(
        without(await open(file, true), ["$queryRawUnsafe"]),
        { databaseType: "sqlite" },
      ).listCalls("t"),
    ).toEqual([]);

    // No raw read at all: the check is impossible, so the call is refused.
    const blind = stack(
      without(await open(file, true), ["$queryRaw", "$queryRawUnsafe"]),
    );
    const error = await blind.persistence.getRun("mine").catch((e) => e);
    expect(error).toBeInstanceOf(SqliteDateStorageUnverifiedError);
    expect(error.reason).toBe("no-raw-query");
    await expect(blind.queue.dequeue()).rejects.toBeInstanceOf(
      SqliteDateStorageUnverifiedError,
    );
  }, 60_000);

  it("asks one cheap question: index lookups and one row of each sampled table", async () => {
    const client = await open(join(directory, "plan.db"));
    // Capture the statement the guard sends, exactly as it sends it.
    let statement = "";
    const spy = (target: any): any =>
      new Proxy(target, {
        get(t, key) {
          const value = Reflect.get(t, key);
          if (key === "$queryRaw") {
            return (strings: TemplateStringsArray, ...values: unknown[]) => {
              statement = strings.join("?");
              return value.call(t, strings, ...values);
            };
          }
          if (key === "$withColumns" && typeof value === "function") {
            return (...args: unknown[]) => spy(value.apply(t, args));
          }
          return typeof value === "function" ? value.bind(t) : value;
        },
      });
    await assertSqliteDateStorage(spy(client));
    expect(statement).toContain("UNION ALL");
    const rows = await rawFor(client, { detail: "text" }).$queryRawUnsafe(
      `EXPLAIN QUERY PLAN ${statement.replace("?", "0")}`,
    );
    const plan = rows.map((r: any) => String(r.detail)).join("\n");
    // Two lookups (the oldest and the newest) in the index of each of five columns.
    expect(plan.match(/SEARCH \S+ USING (COVERING )?INDEX/g)).toHaveLength(10);
    // The four sampled tables are read from their first row (`LIMIT 1`), and
    // nothing else is scanned.
    expect(statement.match(/LIMIT 1\)/g)).toHaveLength(4);
    const scanned = (
      plan.match(
        /SCAN (workflow_\w+|outbox_events|job_queue|idempotency_keys|ai_calls)\b/g,
      ) ?? []
    ).map((line: string) => line.slice(5));
    expect(scanned.sort()).toEqual([
      "ai_calls",
      "idempotency_keys",
      "job_queue",
      "outbox_events",
    ]);
  }, 60_000);

  it("guards every method of the four adapters except the listed synchronous ones", async () => {
    const reader = await open(await otherClassFile("audit.db"), true);
    const { persistence, queue } = stack(reader);
    const ledger = createPrismaStepLedger(reader, { databaseType: "sqlite" });
    const ai = createPrismaAICallLogger(reader, { databaseType: "sqlite" });

    for (const [instance, klass, sync, atLeast] of [
      [persistence, PrismaWorkflowPersistence, SYNC_PERSISTENCE, 40],
      [queue, PrismaJobQueue, SYNC_QUEUE, 10],
      [ledger, PrismaStepLedger, ["transactionReads"], 6],
      [ai, PrismaAICallLogger, ["logCall", "transactionReads"], 3],
    ] as const) {
      const { guarded, unguardedNames } = auditNames(klass.prototype);
      expect(unguardedNames, `${klass.name}: unguarded methods`).toEqual(
        [...sync].sort(),
      );
      expect(guarded.length, klass.name).toBeGreaterThan(atLeast);
      for (const name of guarded) {
        await expect(
          (instance as any)[name](),
          `${klass.name}.${name}`,
        ).rejects.toBeInstanceOf(SqliteDateStorageError);
      }
    }

    // logCall returns nothing to await: it checks itself, writes nothing and logs the refusal.
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      ai.logCall({
        topic: "t",
        callType: "text",
        modelKey: "m",
        modelId: "m",
        prompt: "p",
        response: "r",
        inputTokens: 1,
        outputTokens: 1,
        cost: 0,
      });
      await vi.waitFor(() =>
        expect(
          logged.mock.calls.some((args) =>
            args.some((a) => a instanceof SqliteDateStorageError),
          ),
        ).toBe(true),
      );
    } finally {
      logged.mockRestore();
    }
    const calls = await rawFor(reader, { n: "int" }).$queryRawUnsafe(
      `SELECT COUNT(*) AS n FROM "ai_calls"`,
    );
    expect(Number(calls[0].n)).toBe(0);
  }, 60_000);

  it("guards the same methods when the toolchain lowers async below ES2017", async () => {
    const lowered = await loadLowered();
    const writer = await open(await otherClassFile("lowered.db"), true);
    // The very thing the old rule keyed on: after lowering, no method is an
    // AsyncFunction any more, so a rule that looked at that would guard none.
    for (const klass of [
      lowered.PrismaWorkflowPersistence,
      lowered.PrismaJobQueue,
    ]) {
      const { guarded } = auditNames(klass.prototype);
      expect(guarded.length).toBeGreaterThan(10);
      for (const name of guarded) {
        const wrapper = Object.getOwnPropertyDescriptor(klass.prototype, name)
          ?.value as Function;
        const symbol = Object.getOwnPropertySymbols(wrapper).find(
          (candidate) => candidate.description === "sqliteDateGuard.original",
        )!;
        const original = (wrapper as any)[symbol] as Function;
        expect(original.constructor.name, name).not.toBe("AsyncFunction");
      }
    }
    const persistence = lowered.createPrismaWorkflowPersistence(writer, {
      databaseType: "sqlite",
    });
    const queue = lowered.createPrismaJobQueue(writer, {
      databaseType: "sqlite",
      workerId: "lowered",
    });
    const hourAgo = new Date(Date.now() - 3_600_000);
    // The calls the engine acts on: refused, with the error code the package
    // exports (a lowered bundle has its own copy of the class).
    for (const call of [
      () => persistence.getStuckRuns(hourAgo),
      () => persistence.listRunsForPurge(hourAgo, ["COMPLETED"], 10),
      () => persistence.getSuspendedStages(new Date()),
      () => queue.dequeue(),
      () => queue.verifyStorage(),
    ]) {
      await expect(call()).rejects.toMatchObject({
        code: "SQLITE_DATE_STORAGE_MISMATCH",
      });
    }
    for (const [instance, klass] of [
      [persistence, lowered.PrismaWorkflowPersistence],
      [queue, lowered.PrismaJobQueue],
    ] as const) {
      for (const name of auditNames(klass.prototype).guarded) {
        await expect(
          (instance as any)[name](),
          `${klass.name}.${name}`,
        ).rejects.toMatchObject({ code: "SQLITE_DATE_STORAGE_MISMATCH" });
      }
    }
  }, 120_000);
});
