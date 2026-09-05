/**
 * UTC handling for the raw Postgres statements in these adapters.
 *
 * The reference schema declares every timestamp as a plain Prisma
 * `DateTime`, which maps to Postgres `timestamp(3)` — a *naive* type that
 * stores no offset. Through the model API Prisma writes (and reads) those
 * columns as UTC wall-clock, so `createdAt`, `updatedAt`, `completedAt`
 * and friends are all UTC no matter where the database or its client
 * lives.
 *
 * A raw statement does not get that for free. Prisma binds a JS `Date`
 * parameter as a `timestamptz`, and Postgres converts a `timestamptz`
 * into a naive `timestamp` column — or compares the two — through the
 * *session's* `TimeZone` setting. On a session at `Europe/Zurich` every
 * timestamp written by a raw statement therefore landed two hours ahead
 * of everything Prisma wrote: `job_queue.lockedAt` was permanently in the
 * future, no lease ever looked stale, and a crashed worker's job was
 * never released — crash recovery silently did not work. `NOW()` is wrong
 * for exactly the same reason, one step earlier.
 *
 * Wrapping the bound parameter in `AT TIME ZONE 'UTC'` converts the
 * instant to the naive UTC wall-clock the model API stores, so raw and
 * model writes agree on any session timezone with nothing for the
 * consumer to configure.
 *
 * Scope note (1.0.0-alpha.9): the *job lease* no longer binds a Date at
 * all. `PrismaJobQueue`'s claim, heartbeat and stale sweep all read
 * `now() AT TIME ZONE 'UTC'` instead, so the lease has exactly one clock —
 * the database's — and a host with a drifting system clock cannot shorten
 * or extend it. What follows still applies to every other raw statement
 * (`claimNextPendingRun`, the outbox publish sweep), which do bind Dates.
 *
 * Scope: only the raw statements need this. Every other timestamp the
 * engine writes or compares — `leaseExpiresAt`, `deadlineAt`,
 * `maxWaitUntil`, `nextPollAt` on the poll path, and the `completedAt` of
 * every terminal write — goes through the Prisma model API on both sides,
 * which is UTC on both sides, so writer and sweeper already agree there.
 * The skew only ever appeared where a raw statement wrote a column a
 * model-API query later compared.
 *
 * The mapping is deliberately tied to naive `timestamp` columns — the
 * shipped schema's shape, and the reason the conversion is needed at all.
 * (A schema that declared these columns `@db.Timestamptz` would instead
 * bind `$n::timestamptz` with no conversion, the way Postgres-native queue
 * libraries do; the engine does not, and a consumer must not add that
 * mapping unilaterally — see the 0.13 → 1.0 migration guide.)
 */

/**
 * SQL for a positional parameter carrying a JS `Date`, converted to the
 * naive UTC value the Prisma model API writes.
 *
 * @param position 1-based parameter index, as `$queryRawUnsafe` numbers them.
 */
export function utcTimestampParam(position: number): string {
  if (!Number.isInteger(position) || position < 1) {
    throw new Error(
      `utcTimestampParam: position must be a positive integer, got ${position}`,
    );
  }
  return `($${position}::timestamptz AT TIME ZONE 'UTC')`;
}
