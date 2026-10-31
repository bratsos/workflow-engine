/**
 * Classifying database errors across Prisma majors.
 *
 * The same Postgres failure reaches us in a different shape on each major,
 * so every check in these adapters reads the SQLSTATE through here instead
 * of looking at one field:
 *
 *   - Prisma 8: `error.sqlState`
 *   - Prisma 6, raw SQL: `P2010` with the SQLSTATE on `error.meta.code`
 *   - Prisma 7, raw SQL: `P2010` with the SQLSTATE on
 *     `error.meta.driverAdapterError.cause.originalCode`
 *   - node-postgres: the SQLSTATE on `error.code`
 *   - Prisma model API (any major): `P2002` / `P2034`, which are the unique
 *     violation (`23505`) and the serialization failure (`40001`)
 */

const SQLSTATE = /^[0-9A-Z]{5}$/;
/** A Prisma error code (`P2010`, ...). Also five characters, but not a SQLSTATE. */
const PRISMA_CODE = /^P[1-9]\d{3}$/;
const FROM_PRISMA_CODE: Record<string, string> = {
  P2002: "23505",
  P2034: "40001",
};

const UNIQUE_VIOLATION = "23505";
const SERIALIZATION_FAILURE = "40001";

function sqlState(value: unknown): string | undefined {
  return typeof value === "string" && SQLSTATE.test(value) ? value : undefined;
}

/** The five-character SQLSTATE behind a driver error, or `undefined`. */
export function sqlStateOf(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const failure = error as {
    sqlState?: unknown;
    code?: unknown;
    meta?: {
      code?: unknown;
      driverAdapterError?: { cause?: { originalCode?: unknown } };
    };
  };
  const code = typeof failure.code === "string" ? failure.code : undefined;
  return (
    sqlState(failure.sqlState) ??
    sqlState(failure.meta?.code) ??
    sqlState(failure.meta?.driverAdapterError?.cause?.originalCode) ??
    (code !== undefined && !PRISMA_CODE.test(code)
      ? sqlState(code)
      : undefined) ??
    (code !== undefined ? FROM_PRISMA_CODE[code] : undefined)
  );
}

/** A unique constraint was violated. */
export function isUniqueViolation(error: unknown): boolean {
  return sqlStateOf(error) === UNIQUE_VIOLATION;
}

/** Postgres aborted the transaction for a serialization failure or write conflict. */
export function isSerializationFailure(error: unknown): boolean {
  return sqlStateOf(error) === SERIALIZATION_FAILURE;
}

function isSqliteBusyCode(value: unknown): boolean {
  if (typeof value === "string" && /^SQLITE_(BUSY|LOCKED)(_|$)/.test(value)) {
    return true;
  }
  const code =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^\d+$/.test(value)
        ? Number(value)
        : NaN;
  return Number.isInteger(code) && ((code & 255) === 5 || (code & 255) === 6);
}

/** SQLite BUSY/LOCKED can succeed in a fresh transaction after the writer finishes. */
export function isSqliteBusy(error: unknown): boolean {
  // Prisma 8 retains node:sqlite's numeric code on cause; 6/7 use meta.
  for (
    let depth = 0;
    depth < 5 && typeof error === "object" && error;
    depth++
  ) {
    const failure = error as {
      code?: unknown;
      errcode?: unknown;
      cause?: unknown;
      meta?: {
        code?: unknown;
        driverAdapterError?: { cause?: { originalCode?: unknown } };
      };
    };
    if (
      isSqliteBusyCode(failure.errcode) ||
      isSqliteBusyCode(failure.code) ||
      isSqliteBusyCode(failure.meta?.code) ||
      isSqliteBusyCode(failure.meta?.driverAdapterError?.cause?.originalCode)
    ) {
      return true;
    }
    error = failure.cause;
  }
  return false;
}
