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
 */

import {
  ACTIVE_STATUSES,
  type ActiveStatusCounts,
  emptyActiveStatusCounts,
  isActiveStatus,
} from "../interface";
import type { PrismaDelegate } from "./prisma-client-type";

export async function countActiveByStatus(
  delegate: PrismaDelegate,
  /** The `status` filter values, as the adapter's enum helper resolves them. */
  statuses: readonly unknown[],
  withOldestPending: boolean,
): Promise<{
  byStatus: ActiveStatusCounts;
  oldestPendingCreatedAt: Date | null;
}> {
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
