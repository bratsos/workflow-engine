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
 * dates seen, all matching) is remembered. A check that sees no stored date
 * (an empty file) lets that one operation run and is asked again on the next
 * call: such a file holds no row of a table that has a date the engine
 * compares, so the operation's comparisons match nothing and its writes store
 * this client's form, and the first date another major writes is seen on the
 * next call.
 *
 * What it cannot see, because a bounded probe cannot: a foreign TEXT form on
 * rows strictly between the oldest and the newest of a column (the class check
 * has no such gap: integers sort before every text value, so one foreign
 * integer among text makes the oldest or the newest differ), and rows of a
 * sampled table other than the one read. Neither arises while one Prisma major
 * at a time uses a file: only a file an earlier release mixed, or two majors
 * writing to one file at once (which no probe can tell apart while the file is
 * empty), can hold them.
 *
 * Where it runs: the adapters (`PrismaWorkflowPersistence`, `PrismaJobQueue`,
 * `PrismaStepLedger`, `PrismaAICallLogger`) wrap EVERY method of their
 * prototype except an explicit list of synchronous ones with
 * {@link guardSqliteAdapter}, whatever way the code was compiled, so each entry
 * point (the kernel's commands, both hosts' ticks and job loops, a direct call)
 * awaits the check first; the console read port calls
 * {@link assertSqliteDateStorage}. The check is one statement per client.
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
        : `The check of how this SQLite file stores dates failed (${options?.cause instanceof Error ? options.cause.message : String(options?.cause)}), so the operation was not run; the next call checks again. See ${SQLITE_DATE_STORAGE_DOCS}`,
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
 * - The required date of one row of each table whose rows no run implies
 *   (`job_queue`, `outbox_events`, `idempotency_keys`, `ai_calls`: they have no
 *   foreign key to `workflow_runs`). Stages, steps, logs, artifacts and
 *   annotations belong to a run, whose `createdAt` is probed. So the probe sees
 *   no stored date only when none of these tables holds a row.
 *
 * Every date probed is set by the client on insert, never by a column default.
 */
const PROBE_SQL = [
  range("workflow_runs", "createdAt"),
  range("outbox_events", "publishedAt"),
  range("outbox_events", "dlqAt"),
  range("workflow_stages", "nextPollAt"),
  range("job_queue", "nextPollAt"),
  sample("job_queue", "createdAt"),
  sample("outbox_events", "occurredAt"),
  sample("idempotency_keys", "createdAt"),
  sample("ai_calls", "createdAt"),
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
function probe(prisma: EnginePrismaClient): Promise<Probe[]> {
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
    return run.$queryRaw<Probe[]>(Object.assign(parts, { raw: parts }), bound);
  }
  if (typeof run.$queryRawUnsafe === "function") {
    // Prisma 6 and 7 adapters take `?`; the Prisma 8 facade expands `$n` itself.
    const sql =
      prisma.$databaseType === "sqlite"
        ? PROBE_SQL
        : PROBE_SQL.replace("$1", "?");
    return run.$queryRawUnsafe<Probe[]>(sql, bound);
  }
  throw new SqliteDateStorageUnverifiedError("no-raw-query");
}

/** A text date with every digit replaced: what its form is, whatever the time. */
const form = (value: string) => value.replace(/[0-9]/g, "9");

/** What a refusal says about a stored or bound date: its class, and a sample when it is text. */
const describe = (kind: string, value: string | null) =>
  kind === "text" && value !== null ? `text like ${value}` : kind;

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
    const ends = [
      { kind: row.lo, value: row.loValue },
      { kind: row.hi, value: row.hiValue },
    ].filter((end) => end.kind !== "null");
    if (ends.length > 0) seen = true;
    // Integer against text, or the other way round.
    const other = ends.find((end) => end.kind !== bound.lo);
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

/** Probes and judges: `true` for a conclusive pass, `false` for no stored date. */
async function probeAndJudge(prisma: EnginePrismaClient): Promise<boolean> {
  let rows: Probe[];
  try {
    rows = await probe(prisma);
  } catch (error) {
    throw error instanceof SqliteDateStorageUnverifiedError
      ? error
      : new SqliteDateStorageUnverifiedError("probe-failed", { cause: error });
  }
  return judge(rows);
}

/**
 * Resolves when the operation may run, rejects when it may not.
 *
 * - Stored dates seen, all in this client's class and form: resolves, and the
 *   pass is remembered for the client (no further probe).
 * - A stored date of another class or form: rejects with
 *   {@link SqliteDateStorageError}, and the refusal is remembered.
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
  const check: Promise<void> = probeAndJudge(prisma).then(
    (conclusive) => {
      if (!conclusive && guard.verified === check) guard.verified = null;
    },
    (error) => {
      if (
        !(error instanceof SqliteDateStorageError) &&
        guard.verified === check
      )
        guard.verified = null;
      throw error;
    },
  );
  guard.verified = check;
  return check;
}

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
