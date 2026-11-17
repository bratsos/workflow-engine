/**
 * Refuses a SQLite file whose dates are stored the way another Prisma major
 * stores them.
 *
 * Prisma 6 stores a `DateTime` in SQLite as integer epoch milliseconds,
 * Prisma 7 and 8 as ISO text. SQLite orders every integer before every text
 * value, so a comparison between a stored date of one kind and a bound
 * parameter of the other is decided by the type and not by the time: with a
 * file Prisma 6 wrote, a Prisma 7 client offers a run completed a moment ago
 * to `run.purge` and a run updated a moment ago to `run.reapStuck`, which act
 * on what they are offered. This module reads the storage class of the
 * oldest and the newest stored `workflow_runs.createdAt` and the storage class
 * this client binds for a `Date`, and throws before the adapter runs anything
 * if they differ. It names no Prisma major: the bound class is read off the
 * client itself, with the same `Date` parameter binding every model query
 * uses (checked on Prisma 6, 7 and 8).
 *
 * Where it runs: the adapters that compare dates (`PrismaWorkflowPersistence`,
 * `PrismaJobQueue`) wrap every `async` method of their prototype with
 * {@link guardSqliteAdapter}, so each entry point (the kernel's commands, both
 * hosts' ticks and job loops, a direct call) awaits the check first. The
 * check is one statement per client, answered by an index on `createdAt`.
 */

import { type EnginePrismaClient, rawFor } from "./prisma-client-type.js";

/** Where the explanation of this refusal lives. */
export const SQLITE_DATE_STORAGE_DOCS =
  "https://github.com/bratsos/workflow-engine/blob/main/apps/docs/docs/persistence/prisma-setup.md#a-sqlite-file-belongs-to-the-prisma-major-that-created-it";

/** Thrown, by every adapter method, for a SQLite file written by another Prisma major. */
export class SqliteDateStorageError extends Error {
  readonly code = "SQLITE_DATE_STORAGE_MISMATCH";

  constructor(
    /** SQLite storage class of the stored dates that differ (`integer` or `text`). */
    readonly stored: string,
    /** SQLite storage class this client binds for a `Date`. */
    readonly bound: string,
  ) {
    super(
      `This SQLite file stores dates as ${stored}, but this Prisma client binds them as ${bound}: the file was written by a different Prisma major (Prisma 6 stores integer epoch milliseconds, Prisma 7 and 8 ISO text). SQLite orders every integer before every text value, so each date comparison the engine sends (run.purge retention, run.reapStuck, suspended-stage polls, job leases) would be decided by the type and not by the time, and the engine would purge, reap or poll the wrong rows. Nothing was read or written. Use the Prisma major that created the file, or start the new major from a fresh SQLite file and migrate the application data into it. See ${SQLITE_DATE_STORAGE_DOCS}`,
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

interface Probe {
  lo: string;
  hi: string;
  bound: string;
}

/**
 * One statement. `MIN` and `MAX` of `createdAt` are the oldest and newest
 * stored dates (SQLite orders a mixed column integers first, so a file two
 * majors wrote shows both classes), each answered by one lookup in the
 * `createdAt` index of `workflow_runs` (a subquery apiece: one statement with
 * both aggregates scans the index); `typeof` of a bound `Date` is what this
 * client stores.
 * `createdAt` is set by the client on every insert, never by a column default.
 */
async function probe(prisma: EnginePrismaClient): Promise<Probe | undefined> {
  const run = rawFor(prisma, { lo: "text", hi: "text", bound: "text" });
  if (!run.$queryRaw) return undefined;
  const rows = await run.$queryRaw<Probe[]>`
    SELECT typeof((SELECT MIN("createdAt") FROM "workflow_runs")) AS lo,
           typeof((SELECT MAX("createdAt") FROM "workflow_runs")) AS hi,
           typeof(${new Date(0)}) AS bound`;
  return rows[0];
}

/**
 * Resolves when the file may be used, rejects with {@link SqliteDateStorageError}
 * when it may not. An empty table (`typeof(NULL)` is `null`), a client with no
 * raw queries and a probe that fails (the schema is not pushed yet, the file is
 * busy) are not refusals; the failed probe is retried by the next call.
 */
export function verifySqliteDates(
  prisma: EnginePrismaClient,
  guard: SqliteDateGuard,
): Promise<void> {
  guard.verified ??= (async () => {
    let seen: Probe | undefined;
    try {
      seen = await probe(prisma);
    } catch {
      guard.verified = null;
      return;
    }
    if (!seen) return;
    const stored = [seen.lo, seen.hi].find(
      (kind) => kind !== "null" && kind !== seen.bound,
    );
    if (stored !== undefined)
      throw new SqliteDateStorageError(stored, seen.bound);
  })();
  return guard.verified;
}

const ORIGINAL = Symbol("sqliteDateGuard.original");
const STATE = Symbol("sqliteDateGuard.state");

interface Guarded {
  [STATE]?: { prisma: EnginePrismaClient; guard: SqliteDateGuard };
}

/**
 * Wraps every `async` method on `prototype` so that, on an instance that
 * {@link armSqliteAdapter} armed, it awaits {@link verifySqliteDates} before
 * the method runs. An instance that is not armed (PostgreSQL) runs the method
 * as before, with no added await. Call once, after the class is defined.
 *
 * A method that is not `async` is left alone: it must not return a promise.
 * The adapter tests list those methods, so a new one is classified on purpose.
 */
export function guardSqliteAdapter(prototype: object): void {
  for (const name of Object.getOwnPropertyNames(prototype)) {
    if (name === "constructor") continue;
    const descriptor = Object.getOwnPropertyDescriptor(prototype, name);
    const method = descriptor?.value;
    if (
      typeof method !== "function" ||
      method.constructor.name !== "AsyncFunction"
    ) {
      continue;
    }
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
  }
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
