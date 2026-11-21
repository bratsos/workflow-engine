/**
 * `GROUP BY status` over the active statuses, shared by the Prisma
 * persistence (runs, stages) and job queue adapters.
 *
 * The `IN (PENDING, RUNNING, SUSPENDED)` filter is what keeps the read
 * bounded: terminal rows (COMPLETED, FAILED, CANCELLED, SKIPPED) are never
 * visited, so the cost follows the amount of active work and not the size of
 * the table. Each model's `status`-led index serves it: the runs and jobs
 * indexes also carry `createdAt`, so the oldest-PENDING figure comes from the
 * same index-only read.
 *
 * That holds while the planner's statistics are not stale. SQLite takes the
 * row counts of its last `ANALYZE` as the table's size, so statistics taken
 * while a table held a few active rows make it scan the grown table; there the
 * read is raw SQL whose filter is wrapped in `likelihood(..., 0.0001)`, which
 * keeps it on the index whatever `sqlite_stat1` says. Postgres has no such
 * hint: with statistics taken while most rows were active and not refreshed
 * (autovacuum off or behind), it reads the table once (see the docs).
 */

import {
  ACTIVE_STATUSES,
  type ActiveStatusCounts,
  emptyActiveStatusCounts,
  isActiveStatus,
} from "../interface";
import { readOutboxSql } from "./outbox-claim";
import {
  type EnginePrismaClient,
  type PrismaDelegate,
} from "./prisma-client-type";

/** A date a raw SQLite read returned: Prisma 6 gives the stored integer, 7 the stored text, 8 a `Date`. */
export function sqliteDate(value: unknown): Date | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value;
  return new Date(
    typeof value === "bigint" || /^-?\d+$/.test(String(value))
      ? Number(value)
      : String(value),
  );
}

/** `likelihood()` tells SQLite's planner a term is rarely true, so it searches the index for it. */
export const SQLITE_RARE = 0.0001;

export async function countActiveByStatus(
  delegate: PrismaDelegate,
  /** The `status` filter values, as the adapter's enum helper resolves them. */
  statuses: readonly unknown[],
  withOldestPending: boolean,
  /** SQLite with a raw read: the client and the table, for the `likelihood()` form. */
  sqlite?: { prisma: EnginePrismaClient; table: string },
): Promise<{
  byStatus: ActiveStatusCounts;
  oldestPendingCreatedAt: Date | null;
}> {
  if (sqlite) {
    const rows = await readOutboxSql<{
      status: string;
      n: bigint | number;
      oldest: unknown;
    }>(
      sqlite.prisma,
      "sqlite",
      { status: "text", n: "bigint", oldest: "timestamp" },
      `SELECT "status" AS status, COUNT(*) AS n, ${withOldestPending ? `MIN("createdAt")` : "NULL"} AS oldest FROM "${sqlite.table}" WHERE likelihood("status" IN (${ACTIVE_STATUSES.map((s) => `'${s}'`).join(", ")}), ${SQLITE_RARE}) GROUP BY "status"`,
      [],
    );
    const byStatus = emptyActiveStatusCounts();
    let oldestPendingCreatedAt: Date | null = null;
    for (const row of rows) {
      if (!isActiveStatus(row.status)) continue;
      byStatus[row.status] = Number(row.n);
      if (row.status === "PENDING")
        oldestPendingCreatedAt = sqliteDate(row.oldest);
    }
    return { byStatus, oldestPendingCreatedAt };
  }
  if (typeof delegate.groupBy !== "function") {
    throw new Error(
      `Counting ${ACTIVE_STATUSES.join("/")} rows requires a Prisma client whose delegates support groupBy.`,
    );
  }
  const rows: any[] = await delegate.groupBy({
    by: ["status"],
    where: { status: { in: statuses } },
    _count: { _all: true },
    ...(withOldestPending ? { _min: { createdAt: true } } : {}),
  });

  const byStatus = emptyActiveStatusCounts();
  let oldestPendingCreatedAt: Date | null = null;
  for (const row of rows) {
    const status: string = row.status;
    if (!isActiveStatus(status)) continue;
    byStatus[status] = row._count?._all ?? 0;
    if (status === "PENDING") {
      oldestPendingCreatedAt = row._min?.createdAt ?? null;
    }
  }
  return { byStatus, oldestPendingCreatedAt };
}
