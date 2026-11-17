/**
 * Refuses a SQLite file whose dates are stored the way another Prisma major
 * stores them.
 *
 * Prisma 6 stores a `DateTime` in SQLite as integer epoch milliseconds,
 * Prisma 7 as ISO text ending in `+00:00` and Prisma 8 as ISO text ending in
 * `Z`. SQLite orders every integer before every text value, so a comparison
 * between a stored date of one kind and a bound parameter of the other is
 * decided by the type and not by the time: with a file Prisma 6 wrote, a
 * Prisma 7 client offers a run completed a moment ago to `run.purge` and a
 * run updated a moment ago to `run.reapStuck`, which act on what they are
 * offered. Two text forms agree except at an exact instant (`+00:00` sorts
 * before `Z`), which is the path a Prisma 7 to 8 upgrade takes.
 *
 * This module reads the oldest and the newest stored value of every date
 * column that has an index leading with it (`workflow_runs.createdAt`,
 * `outbox_events.publishedAt` and `dlqAt`, `workflow_stages.nextPollAt`,
 * `job_queue.nextPollAt`: two index lookups each) and a `Date` as this client
 * binds it, and throws before the adapter runs anything if the storage class
 * differs or, when both are text, if the form differs (the text with every
 * digit replaced: `9999-99-99T99:99:99.999Z` against
 * `9999-99-99T99:99:99.999+99:99`). It names no Prisma major: what the client
 * binds is read off the client itself, with the same `Date` parameter binding
 * every model query uses (checked on Prisma 6, 7 and 8).
 *
 * What it cannot see, because a bounded probe cannot: a foreign TEXT form on
 * rows strictly between the oldest and the newest of a column (the class check
 * has no such gap: integers sort before every text value, so one foreign
 * integer among text makes the oldest or the newest differ), and any column no
 * index leads with (`updatedAt`, `completedAt`, `lockedAt`, `startedAt`,
 * `occurredAt` and the dates of the other tables). A file the engine's
 * adapters have written to since they carry this guard cannot have gained such
 * rows (the first call on a foreign file refuses); only a file mixed by an
 * earlier release can hold them.
 *
 * Where it runs: the adapters that compare dates (`PrismaWorkflowPersistence`,
 * `PrismaJobQueue`) wrap EVERY method of their prototype except an explicit
 * list of synchronous ones with {@link guardSqliteAdapter}, whatever way the
 * code was compiled, so each entry point (the kernel's commands, both hosts'
 * ticks and job loops, a direct call) awaits the check first. The check is one
 * statement per client.
 */

import { type EnginePrismaClient, rawFor } from "./prisma-client-type.js";

/** Where the explanation of this refusal lives. */
export const SQLITE_DATE_STORAGE_DOCS =
  "https://github.com/bratsos/workflow-engine/blob/main/apps/docs/docs/persistence/prisma-setup.md#a-sqlite-file-belongs-to-the-prisma-major-that-created-it";

/** Thrown, by every adapter method, for a SQLite file written by another Prisma major. */
export class SqliteDateStorageError extends Error {
  readonly code = "SQLITE_DATE_STORAGE_MISMATCH";

  constructor(
    /**
     * What the file stores: the SQLite storage class of the dates that differ
     * (`integer` or `text`), with a sample value when both are text.
     */
    readonly stored: string,
    /** What this client binds for a `Date`, described the same way. */
    readonly bound: string,
    /** `"class"`: integer against text. `"form"`: both text, written differently. */
    readonly kind: "class" | "form" = "class",
    /** The date column the difference was found in, as `table.column`. */
    readonly column?: string,
  ) {
    const why =
      kind === "class"
        ? "SQLite orders every integer before every text value, so each date comparison the engine sends (run.purge retention, run.reapStuck, suspended-stage polls, job leases) would be decided by the type and not by the time, and the engine would purge, reap or poll the wrong rows."
        : "Two ISO text forms agree except at an exact instant, where the suffix decides (`+00:00` sorts before `Z`): a deadline, retention or stuck-run threshold that equals a stored time is compared wrongly, and an exact-time lookup finds nothing.";
    super(
      `This SQLite file stores dates as ${stored}${column ? ` (in ${column})` : ""}, but this Prisma client binds them as ${bound}: the file was written by a different Prisma major (Prisma 6 stores integer epoch milliseconds, Prisma 7 ISO text ending in +00:00, Prisma 8 ISO text ending in Z). ${why} Nothing was read or written. Use the Prisma major that created the file, or start the new major from a fresh SQLite file and migrate the application data into it. See ${SQLITE_DATE_STORAGE_DOCS}`,
    );
    this.name = "SqliteDateStorageError";
  }
}

/** The state of one client's check, shared by every adapter built on it. */
export interface SqliteDateGuard {
  /** Settled once the check is conclusive: resolved if the file is usable, rejected if it is refused. */
  verified: Promise<void> | null;
}

const guards = new WeakMap<object, SqliteDateGuard>();

/** The check state of a client: one per client, so every adapter on it asks once. */
export function sqliteDateGuard(prisma: object): SqliteDateGuard {
  let guard = guards.get(prisma);
  if (!guard) {
    guard = { verified: null };
    guards.set(prisma, guard);
  }
  return guard;
}

/** One probed column: the storage class and text of its oldest and newest value. */
interface Probe {
  col: string;
  lo: string;
  loValue: string | null;
  hi: string;
  hiValue: string | null;
}

/**
 * One statement, one row per probed column plus one for the bound `Date`.
 * Each `MIN` and `MAX` is a scalar subquery of its own, so SQLite answers it
 * with one lookup in the index that leads with the column (one statement
 * holding both aggregates scans the index); `typeof` is the storage class, and
 * the values come back as text so the form of a text date can be compared. A
 * mixed column shows both classes (integers sort before text). The dates
 * probed are set by the client on every insert, never by a column default.
 */
async function probe(prisma: EnginePrismaClient): Promise<Probe[] | undefined> {
  const run = rawFor(prisma, {
    col: "text",
    lo: "text",
    loValue: "text",
    hi: "text",
    hiValue: "text",
  });
  if (!run.$queryRaw) return undefined;
  const d = new Date(0);
  return run.$queryRaw<Probe[]>`
    SELECT 'workflow_runs.createdAt' AS col, typeof(m.lo) AS lo, CAST(m.lo AS TEXT) AS loValue, typeof(m.hi) AS hi, CAST(m.hi AS TEXT) AS hiValue
    FROM (SELECT (SELECT MIN("createdAt") FROM "workflow_runs") AS lo, (SELECT MAX("createdAt") FROM "workflow_runs") AS hi) AS m
    UNION ALL
    SELECT 'outbox_events.publishedAt', typeof(m.lo), CAST(m.lo AS TEXT), typeof(m.hi), CAST(m.hi AS TEXT)
    FROM (SELECT (SELECT MIN("publishedAt") FROM "outbox_events") AS lo, (SELECT MAX("publishedAt") FROM "outbox_events") AS hi) AS m
    UNION ALL
    SELECT 'outbox_events.dlqAt', typeof(m.lo), CAST(m.lo AS TEXT), typeof(m.hi), CAST(m.hi AS TEXT)
    FROM (SELECT (SELECT MIN("dlqAt") FROM "outbox_events") AS lo, (SELECT MAX("dlqAt") FROM "outbox_events") AS hi) AS m
    UNION ALL
    SELECT 'workflow_stages.nextPollAt', typeof(m.lo), CAST(m.lo AS TEXT), typeof(m.hi), CAST(m.hi AS TEXT)
    FROM (SELECT (SELECT MIN("nextPollAt") FROM "workflow_stages") AS lo, (SELECT MAX("nextPollAt") FROM "workflow_stages") AS hi) AS m
    UNION ALL
    SELECT 'job_queue.nextPollAt', typeof(m.lo), CAST(m.lo AS TEXT), typeof(m.hi), CAST(m.hi AS TEXT)
    FROM (SELECT (SELECT MIN("nextPollAt") FROM "job_queue") AS lo, (SELECT MAX("nextPollAt") FROM "job_queue") AS hi) AS m
    UNION ALL
    SELECT 'bound', typeof(b.d), CAST(b.d AS TEXT), typeof(b.d), CAST(b.d AS TEXT)
    FROM (SELECT ${d} AS d) AS b`;
}

/** A text date with every digit replaced: what its form is, whatever the time. */
const form = (value: string) => value.replace(/[0-9]/g, "9");

/** What a refusal says about a stored or bound date: its class, and a sample when it is text. */
const describe = (kind: string, value: string | null) =>
  kind === "text" && value !== null ? `text like ${value}` : kind;

/**
 * Resolves when the file may be used, rejects with {@link SqliteDateStorageError}
 * when it may not. An empty column (`typeof(NULL)` is `null`), a client with no
 * raw queries, a probe that fails (the schema is not pushed yet, the file is
 * busy) and a file of the same storage class and form are not refusals; the
 * failed probe is retried by the next call.
 */
export function verifySqliteDates(
  prisma: EnginePrismaClient,
  guard: SqliteDateGuard,
): Promise<void> {
  guard.verified ??= (async () => {
    let rows: Probe[] | undefined;
    try {
      rows = await probe(prisma);
    } catch {
      guard.verified = null;
      return;
    }
    const bound = rows?.find((row) => row.col === "bound");
    if (!rows || !bound) return;
    for (const row of rows) {
      if (row === bound) continue;
      const ends = [
        { kind: row.lo, value: row.loValue },
        { kind: row.hi, value: row.hiValue },
      ].filter((end) => end.kind !== "null");
      // Integer against text, or the other way round.
      const other = ends.find((end) => end.kind !== bound.lo);
      if (other !== undefined) {
        throw new SqliteDateStorageError(
          other.kind,
          bound.lo,
          "class",
          row.col,
        );
      }
      // Both text, written differently (Prisma 7's `+00:00`, Prisma 8's `Z`).
      const sample = bound.loValue;
      const differing =
        bound.lo === "text" && typeof sample === "string"
          ? ends.find(
              (end) =>
                typeof end.value === "string" &&
                form(end.value) !== form(sample),
            )
          : undefined;
      if (differing !== undefined) {
        throw new SqliteDateStorageError(
          describe("text", differing.value),
          describe("text", sample),
          "form",
          row.col,
        );
      }
    }
  })();
  return guard.verified;
}

const ORIGINAL = Symbol("sqliteDateGuard.original");
const STATE = Symbol("sqliteDateGuard.state");

interface Guarded {
  [STATE]?: { prisma: EnginePrismaClient; guard: SqliteDateGuard };
}

/**
 * Wraps every method on `prototype` except the named synchronous ones, so that,
 * on an instance that {@link armSqliteAdapter} armed, it awaits
 * {@link verifySqliteDates} before the method runs. An instance that is not
 * armed (PostgreSQL) runs the method as before, with no added await. Call once,
 * after the class is defined.
 *
 * The rule does not look at how a function was compiled (a toolchain that
 * lowers `async` below ES2017 turns each `async` method into a plain function
 * that returns a promise, and a check keyed on `AsyncFunction` would then skip
 * every one of them): a method is guarded unless the caller lists it in
 * `synchronous`. A synchronous method that is not listed would start returning
 * a promise, which breaks its callers at once; a listed one that is in fact
 * asynchronous would skip the check, which the adapter tests catch by calling
 * every method of both classes on a refused file.
 */
export function guardSqliteAdapter(
  prototype: object,
  synchronous: readonly string[],
): void {
  let guardedCount = 0;
  for (const name of Object.getOwnPropertyNames(prototype)) {
    if (name === "constructor" || synchronous.includes(name)) continue;
    const descriptor = Object.getOwnPropertyDescriptor(prototype, name);
    const method = descriptor?.value;
    if (typeof method !== "function") continue;
    const guarded = function (this: Guarded, ...args: unknown[]) {
      const state = this[STATE];
      if (!state) return method.apply(this, args);
      return verifySqliteDates(state.prisma, state.guard).then(() =>
        method.apply(this, args),
      );
    };
    Object.defineProperty(guarded, "name", { value: name });
    Object.defineProperty(guarded, ORIGINAL, { value: method });
    Object.defineProperty(prototype, name, { ...descriptor, value: guarded });
    guardedCount++;
  }
  if (guardedCount === 0) {
    throw new Error(
      "The SQLite date guard wrapped no method: the adapter would run unguarded.",
    );
  }
}

/**
 * Runs the check on `prisma` and rejects with {@link SqliteDateStorageError}
 * when the file was written by another Prisma major. For code outside the
 * adapters that reads the same file with dates (the console's read port): one
 * statement per client, shared with every adapter built on that client.
 */
export function assertSqliteDateStorage(prisma: object): Promise<void> {
  return verifySqliteDates(
    prisma as EnginePrismaClient,
    sqliteDateGuard(prisma),
  );
}

/** Arms a SQLite instance: its guarded methods now check `prisma` once. */
export function armSqliteAdapter(adapter: object, prisma: EnginePrismaClient) {
  Object.defineProperty(adapter, STATE, {
    value: { prisma, guard: sqliteDateGuard(prisma) },
    writable: true,
    configurable: true,
  });
}

/** A clone over a transaction client shares the check its parent already ran. */
export function shareSqliteGuard(clone: object, parent: object): void {
  const state = (parent as Guarded)[STATE];
  if (state)
    Object.defineProperty(clone, STATE, {
      value: state,
      writable: true,
      configurable: true,
    });
}

/** The method a guarded prototype method wraps, for code that compares method identity. */
export function unguarded(method: unknown): unknown {
  return (method as { [ORIGINAL]?: unknown })?.[ORIGINAL] ?? method;
}
