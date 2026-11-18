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
 * `job_queue.nextPollAt`: two index lookups each), the required date of one row
 * of each table no run implies (`job_queue.createdAt`,
 * `outbox_events.occurredAt`, `idempotency_keys.createdAt`,
 * `ai_calls.createdAt`) and a `Date` as this client binds it, and refuses the
 * operation if the storage class differs or, when both are text, if the form
 * differs (the text with every digit replaced: `9999-99-99T99:99:99.999Z`
 * against `9999-99-99T99:99:99.999+99:99`). It names no Prisma major: what the
 * client binds is read off the client itself, through the same raw read the
 * client exposes, with the same `Date` binding every model query uses
 * (measured on Prisma 6, 7 and 8, tagged and unsafe raw reads alike).
 *
 * It fails closed. An operation runs only after a check that succeeded: a probe
 * that throws, or a client with no raw read, refuses the operation with
 * {@link SqliteDateStorageUnverifiedError}. Only a conclusive pass (stored
 * dates seen, all matching, none of them uncommitted) is remembered; a refusal
 * is not, so rewriting the rows it names lets the next call through. It also
 * walks each indexed column day by day for SQLite's own timestamp form
 * (`2026-11-18 06:30:09`), which other SQL writes and which sorts before the
 * ISO dates of its day, so that form is found wherever it lies, not only at
 * the ends. A check that sees no stored date
 * (an empty file) lets that one operation run and is asked again on the next
 * call: such a file holds no row of a table that has a date the engine
 * compares, so the operation's comparisons match nothing and its writes store
 * this client's form, and the first date another major writes is seen on the
 * next call.
 *
 * What it cannot see, because a bounded probe cannot: the other ISO text form
 * (`+00:00` among `Z`, or the reverse) on rows strictly between the oldest and
 * the newest of an indexed column, since the two interleave within a day (the
 * class check has no such gap: integers sort before every text value, so one
 * foreign integer among text makes the oldest or the newest differ), and any
 * row of a sampled table other than the one read, SQLite's own form included.
 * Such a row is seen once it becomes the oldest, the newest or the row read,
 * for example after `run.purge` deletes the rows around it. The ISO mix arises
 * only from two Prisma majors writing to one file.
 *
 * Where it runs: the adapters (`PrismaWorkflowPersistence`, `PrismaJobQueue`,
 * `PrismaStepLedger`, `PrismaAICallLogger`) wrap EVERY method of their
 * prototype except an explicit list of synchronous ones with
 * {@link guardSqliteAdapter}, whatever way the code was compiled, so each entry
 * point (the kernel's commands, both hosts' ticks and job loops, a direct call)
 * awaits the check first; the console read port calls
 * {@link assertSqliteDateStorage}. The check is one statement per client.
 */

import { toErrorMessage } from "../../kernel/helpers/error-message.js";
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
    /**
     * `"class"`: integer against text. `"form"`: both text, written
     * differently. `"sqlite-timestamp"`: rows in SQLite's own form
     * (`2026-11-18 06:30:09`), written by SQL outside the engine.
     */
    readonly kind: "class" | "form" | "affinity" | "sqlite-timestamp" = "class",
    /** The date column the difference was found in, as `table.column`. */
    readonly column?: string,
    /** For `"sqlite-timestamp"`: the statement that rewrites those rows in this client's form. */
    readonly recovery?: string,
  ) {
    const why =
      kind === "class"
        ? "SQLite orders every integer before every text value, so each date comparison the engine sends (run.purge retention, run.reapStuck, suspended-stage polls, job leases) would be decided by the type and not by the time, and the engine would purge, reap or poll the wrong rows."
        : kind === "affinity"
          ? "The table has TEXT affinity, so it would store numeric dates as text. Use a fresh file before switching to a numeric timestamp driver."
          : kind === "sqlite-timestamp"
            ? "That is SQLite's own timestamp form, which `CURRENT_TIMESTAMP` and `datetime('now')` write, as does the Prisma 6 and 7 column default when an insert leaves the column out. The engine never writes it. It sorts before every other date of its day (and, as text, after every integer date), so the engine's date comparisons would treat such a row as up to a day early, or always late."
            : "Two ISO text forms agree except at an exact instant, where the suffix decides (`+00:00` sorts before `Z`): a deadline, retention or stuck-run threshold that equals a stored time is compared wrongly, and an exact-time lookup finds nothing.";
    const remedy =
      kind === "sqlite-timestamp"
        ? `Rewrite those rows in this client's form, and do the same in any other date column that SQL outside the engine writes: ${recovery}; then retry, since a refusal is not remembered.`
        : "Use the Prisma major that created the file, or start the new major from a fresh SQLite file and migrate the application data into it.";
    super(
      `This SQLite file stores dates as ${stored}${column ? ` (in ${column})` : ""}, but this Prisma client binds them as ${bound}${kind === "sqlite-timestamp" ? "" : ": the file uses a different Prisma major or SQLite timestamp format"}. ${why} Nothing was read or written. ${remedy} See ${SQLITE_DATE_STORAGE_DOCS}`,
    );
    this.name = "SqliteDateStorageError";
  }
}

/**
 * Thrown, by every guarded adapter method and the console read port, when the
 * check could not be made: the probe failed (`reason: "probe-failed"`, the
 * database error is `cause`), or the client exposes no raw read to make it
 * with (`reason: "no-raw-query"`). The operation did not run. A failed probe
 * is not remembered: the next call probes again.
 */
export class SqliteDateStorageUnverifiedError extends Error {
  readonly code = "SQLITE_DATE_STORAGE_UNVERIFIED";

  constructor(
    readonly reason: "probe-failed" | "no-raw-query",
    options?: { cause?: unknown },
  ) {
    super(
      reason === "no-raw-query"
        ? `This Prisma client exposes neither $queryRaw (tagged template) nor $queryRawUnsafe, so the engine cannot check how this SQLite file stores dates, and it does not run on a file it has not checked. Pass the Prisma client itself, or a wrapper that forwards one of the two. See ${SQLITE_DATE_STORAGE_DOCS}`
        : `The check of how this SQLite file stores dates failed (${toErrorMessage(options?.cause)}), so the operation was not run; the next call checks again. See ${SQLITE_DATE_STORAGE_DOCS}`,
      options,
    );
    this.name = "SqliteDateStorageUnverifiedError";
  }
}

/** The state of one client's check, shared by every adapter built on it. */
export interface SqliteDateGuard {
  /**
   * The check in flight, or its conclusive result: resolved when stored dates
   * were seen and all match this client, rejected with
   * {@link SqliteDateStorageError} when they do not. `null` before the first
   * check and after a check that failed or saw no stored date.
   */
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

/** Oldest and newest of a column an index leads with: two index lookups. */
const range = (table: string, column: string) =>
  `SELECT '${table}.${column}' AS col, typeof(m.lo) AS lo, CAST(m.lo AS TEXT) AS loValue, typeof(m.hi) AS hi, CAST(m.hi AS TEXT) AS hiValue
    FROM (SELECT (SELECT MIN("${column}") FROM "${table}") AS lo, (SELECT MAX("${column}") FROM "${table}") AS hi) AS m`;

/**
 * A text date in SQLite's own form (`2026-11-18 06:30:09`, what
 * `CURRENT_TIMESTAMP`, `datetime('now')` and the Prisma 6 and 7 `db push`
 * column defaults write) anywhere in an indexed column. Within a day it sorts
 * before every `T` form, so it is the first text value of its day: the walk
 * seeks the first text value of each stored day, one index seek per day, and
 * returns the first whose 11th character is not `T`. Integers sort before
 * every text value and are skipped by the first seek.
 */
const ownForm = (table: string, column: string) => {
  const c = `"${column}"`;
  const first = (where: string) =>
    `(SELECT ${c} FROM "${table}" WHERE ${where} ORDER BY ${c} LIMIT 1)`;
  return `SELECT '${table}.${column}', 'text', w.v, 'text', w.v FROM (
      WITH RECURSIVE day(v) AS (
        SELECT ${first(`${c} >= ''`)}
        UNION ALL
        SELECT ${first(`${c} > day.v AND ${c} >= substr(day.v, 1, 10) || 'U'`)} FROM day WHERE day.v IS NOT NULL
      )
      SELECT v FROM day WHERE substr(v, 11, 1) <> 'T' LIMIT 1
    ) AS w`;
};

/** The required date of the first row of a table (one row read, no index needed). */
const sample = (table: string, column: string) =>
  `SELECT '${table}.${column}', typeof(s.v), CAST(s.v AS TEXT), typeof(s.v), CAST(s.v AS TEXT)
    FROM (SELECT (SELECT "${column}" FROM "${table}" LIMIT 1) AS v) AS s`;

/**
 * The probe: one statement, one row per probed column plus one for the bound
 * `Date` (`$1`, the only parameter).
 *
 * - The oldest and newest value of each date column an index leads with (two
 *   index lookups each). A mixed column shows both classes there (integers sort
 *   before text).
 * - For each of those columns, the first text value of each stored day, to
 *   find SQLite's own form anywhere in it ({@link ownForm}): one index seek
 *   per distinct day.
 * - The required date of one row of each table whose rows no run implies
 *   (`job_queue`, `outbox_events`, `idempotency_keys`, `ai_calls`: they have no
 *   foreign key to `workflow_runs`). Stages, steps, logs, artifacts and
 *   annotations belong to a run, whose `createdAt` is probed. So the probe sees
 *   no stored date only when none of these tables holds a row.
 *
 * The engine sets every date it writes through the client. A column default
 * (`CURRENT_TIMESTAMP` on the `createdAt` of `workflow_runs`, `job_queue`,
 * `idempotency_keys` and `ai_calls` in a Prisma 6 or 7 schema) fills only rows
 * inserted by other SQL that leaves the column out.
 */
const RANGES = [
  ["workflow_runs", "createdAt"],
  ["outbox_events", "publishedAt"],
  ["outbox_events", "dlqAt"],
  ["workflow_stages", "nextPollAt"],
  ["job_queue", "nextPollAt"],
] as const;
/** @internal The probe statement, for the plan test. */
export const PROBE_SQL = [
  ...RANGES.map(([table, column]) => range(table, column)),
  ...RANGES.map(([table, column]) => ownForm(table, column)),
  sample("job_queue", "createdAt"),
  sample("outbox_events", "occurredAt"),
  sample("idempotency_keys", "createdAt"),
  sample("ai_calls", "createdAt"),
  // A drained Prisma 8 file retains TEXT affinity across intermediate
  // major switches. Reject a numeric writer before it inserts its first key.
  `SELECT 'affinity', 'text', type, 'text', type FROM pragma_table_info('workflow_runs')
    WHERE name = 'createdAt' AND instr(upper(type), 'INT') = 0
      AND (instr(upper(type), 'TEXT') > 0 OR instr(upper(type), 'CHAR') > 0 OR instr(upper(type), 'CLOB') > 0)`,
  `SELECT 'bound', typeof(b.d), CAST(b.d AS TEXT), typeof(b.d), CAST(b.d AS TEXT) FROM (SELECT $1 AS d) AS b`,
].join("\n    UNION ALL\n    ");

/**
 * Runs the probe through the raw read the client exposes: the tagged
 * `$queryRaw` if it has one, else the parameterized `$queryRawUnsafe` (a
 * wrapper that forwards only that, such as the console's minimum client). The
 * `Date` parameter is bound the same way on both and the same way the model API
 * binds it (measured on Prisma 6, 7 and 8). A client with neither cannot be
 * checked: refused.
 */
async function probe(prisma: EnginePrismaClient): Promise<Probe[]> {
  try {
    const run = rawFor(prisma, {
      col: "text",
      lo: "text",
      loValue: "text",
      hi: "text",
      hiValue: "text",
    });
    const bound = new Date(0);
    if (typeof run.$queryRaw === "function") {
      const parts = PROBE_SQL.split("$1");
      return await run.$queryRaw<Probe[]>(
        Object.assign(parts, { raw: parts }),
        bound,
      );
    }
    if (typeof run.$queryRawUnsafe === "function") {
      // Prisma 6 and 7 adapters take `?`; the Prisma 8 facade expands `$n` itself.
      const sql =
        prisma.$databaseType === "sqlite"
          ? PROBE_SQL
          : PROBE_SQL.replace("$1", "?");
      return await run.$queryRawUnsafe<Probe[]>(sql, bound);
    }
  } catch (cause) {
    throw new SqliteDateStorageUnverifiedError("probe-failed", { cause });
  }
  throw new SqliteDateStorageUnverifiedError("no-raw-query");
}

/** A text date with every digit replaced: what its form is, whatever the time. */
const form = (value: string) => value.replace(/[0-9]/g, "9");

/** What a refusal says about a stored or bound date: its class, and a sample when it is text. */
const describe = (kind: string, value: string | null) =>
  kind === "text" && value !== null ? `text like ${value}` : kind;

/** INTEGER and REAL are ordered together as numbers by SQLite. */
const numeric = (kind: string) => kind === "integer" || kind === "real";

/**
 * The statement that rewrites SQLite's own form in `column` (`table.column`)
 * into what this client binds: epoch milliseconds (Prisma 6), ISO text ending
 * in `+00:00` (Prisma 7) or in `Z` (Prisma 8). `CURRENT_TIMESTAMP` is UTC.
 */
function rewriteSql(
  kind: string,
  sample: string | null,
  column: string,
): string {
  const [table, name] = column.split(".");
  const c = `"${name}"`;
  if (numeric(kind))
    return `UPDATE "${table}" SET ${c} = CAST(ROUND((julianday(${c}) - 2440587.5) * 86400000) AS INTEGER) WHERE typeof(${c}) = 'text' AND substr(${c}, 11, 1) = ' '`;
  const suffix = sample?.endsWith("Z") ? "Z" : "+00:00";
  return `UPDATE "${table}" SET ${c} = strftime('%Y-%m-%dT%H:%M:%f${suffix}', ${c}) WHERE substr(${c}, 11, 1) = ' '`;
}

/**
 * Compares the probe's answer. Throws {@link SqliteDateStorageError} for a date
 * of another class or form; returns whether any stored date was seen (a
 * conclusive pass) or none was (inconclusive).
 */
function judge(rows: Probe[]): boolean {
  const bound = rows.find((row) => row.col === "bound");
  if (!bound) {
    throw new SqliteDateStorageUnverifiedError("probe-failed", {
      cause: new Error("the probe returned no bound date"),
    });
  }
  let seen = false;
  for (const row of rows) {
    if (row === bound) continue;
    // SQLite's own form, written by SQL outside the engine: refused with the
    // statement that rewrites it, whatever this client binds.
    const own = [row.loValue, row.hiValue].find(
      (value, i) => [row.lo, row.hi][i] === "text" && value?.charAt(10) === " ",
    );
    if (own)
      throw new SqliteDateStorageError(
        describe("text", own),
        describe(bound.lo, bound.loValue),
        "sqlite-timestamp",
        row.col,
        rewriteSql(bound.lo, bound.loValue, row.col),
      );
    if (row.col === "affinity") {
      if (numeric(bound.lo))
        throw new SqliteDateStorageError(
          `${row.loValue} affinity`,
          bound.lo,
          "affinity",
          "workflow_runs.createdAt",
        );
      continue;
    }
    const ends = [
      { kind: row.lo, value: row.loValue },
      { kind: row.hi, value: row.hiValue },
    ].filter((end) => end.kind !== "null");
    if (ends.length > 0) seen = true;
    // SQLite compares both numeric storage classes as numbers. The
    // better-sqlite3 adapter can bind a REAL that DATETIME affinity stores
    // as an INTEGER, without changing the value or its ordering.
    const other = ends.find(
      (end) =>
        end.kind !== bound.lo && !(numeric(end.kind) && numeric(bound.lo)),
    );
    if (other !== undefined) {
      throw new SqliteDateStorageError(other.kind, bound.lo, "class", row.col);
    }
    // Both text, written differently (Prisma 7's `+00:00`, Prisma 8's `Z`).
    const boundSample = bound.loValue;
    const differing =
      bound.lo === "text" && typeof boundSample === "string"
        ? ends.find(
            (end) =>
              typeof end.value === "string" &&
              form(end.value) !== form(boundSample),
          )
        : undefined;
    if (differing !== undefined) {
      throw new SqliteDateStorageError(
        describe("text", differing.value),
        describe("text", boundSample),
        "form",
        row.col,
      );
    }
  }
  return seen;
}

/**
 * Resolves when the operation may run, rejects when it may not.
 *
 * - Stored dates seen, all in this client's class and form: resolves, and the
 *   pass is remembered for the client (no further probe), unless the probe
 *   ran inside a transaction the consumer opened on a Prisma 8 root
 *   connection, whose writes it saw before they committed.
 * - A stored date of another class or form: rejects with
 *   {@link SqliteDateStorageError}. Not remembered: once the rows are
 *   rewritten, the next call passes on the same client.
 * - No stored date anywhere the probe looks (an empty file, a file holding
 *   only definitions or blobs): resolves for this call only; the next call
 *   probes again, so the first date another major writes is seen.
 * - The probe fails, or the client has no raw read: rejects with
 *   {@link SqliteDateStorageUnverifiedError}; nothing is remembered.
 */
export function verifySqliteDates(
  prisma: EnginePrismaClient,
  guard: SqliteDateGuard,
): Promise<void> {
  if (guard.verified) return guard.verified;
  const uncommitted = () =>
    (prisma as { [UNCOMMITTED_READS]?: boolean })[UNCOMMITTED_READS] === true;
  const before = uncommitted();
  const forget = () => {
    if (guard.verified === check) guard.verified = null;
  };
  const check: Promise<void> = probe(prisma)
    .then(judge)
    .then(
      (conclusive) => {
        if (!conclusive || before || uncommitted()) forget();
      },
      (error) => {
        forget();
        throw error;
      },
    );
  guard.verified = check;
  return check;
}

/**
 * Set by `fromPrisma8` on a SQLite root client: `true` while a transaction the
 * consumer opened is in progress on its connection, so a read there sees
 * uncommitted writes.
 */
export const UNCOMMITTED_READS = Symbol.for(
  "@bratsos/workflow-engine/uncommitted-reads",
);

const ORIGINAL = Symbol("sqliteDateGuard.original");
const STATE = Symbol("sqliteDateGuard.state");

interface Guarded {
  [STATE]?: { prisma: EnginePrismaClient; guard: SqliteDateGuard };
}

/**
 * Wraps every method on `prototype` except the named synchronous ones, so that,
 * on an instance that {@link armSqliteAdapter} armed, it awaits
 * {@link verifySqliteDates} before the method runs and does not run it if the
 * check rejects. An instance that is not armed (PostgreSQL, a transaction
 * clone) runs the method as before, with no added await. Call once, after the
 * class is defined.
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
 * when the file was written by another Prisma major, or with
 * {@link SqliteDateStorageUnverifiedError} when the check could not be made.
 * For code outside the adapters that reads the same file with dates (the
 * console's read port): one statement per client, shared with every adapter
 * built on that client, and remembered only once it is conclusive.
 */
export function assertSqliteDateStorage(prisma: object): Promise<void> {
  return verifySqliteDates(
    prisma as EnginePrismaClient,
    sqliteDateGuard(prisma),
  );
}

/** Arms a SQLite instance: its guarded methods now check `prisma` first. */
export function armSqliteAdapter(adapter: object, prisma: EnginePrismaClient) {
  Object.defineProperty(adapter, STATE, {
    value: { prisma, guard: sqliteDateGuard(prisma) },
    writable: true,
    configurable: true,
  });
}

/**
 * A clone over a transaction client does not check: its parent checked before
 * the transaction opened, and a probe on the parent's client from inside the
 * transaction would only wait on it.
 */
export function shareSqliteGuard(clone: object, parent: object): void {
  if ((parent as Guarded)[STATE])
    Object.defineProperty(clone, STATE, {
      value: undefined,
      writable: true,
      configurable: true,
    });
}

/**
 * The check an armed instance makes before a write it does not return to its
 * caller (`PrismaAICallLogger.logCall`); `undefined` when the instance is not
 * armed (PostgreSQL) or is a transaction clone.
 */
export function sqliteCheckFor(adapter: object): Promise<void> | undefined {
  const state = (adapter as Guarded)[STATE];
  return state ? verifySqliteDates(state.prisma, state.guard) : undefined;
}

/** The method a guarded prototype method wraps, for code that compares method identity. */
export function unguarded(method: unknown): unknown {
  return (method as { [ORIGINAL]?: unknown })?.[ORIGINAL] ?? method;
}
