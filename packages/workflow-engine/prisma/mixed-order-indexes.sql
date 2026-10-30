-- Companion to contract.prisma: the five indexes whose columns have a sort
-- direction. A Prisma 8 contract cannot express one (the planner creates every
-- column ascending), but the engine's queries need them:
--   workflow_runs / job_queue claim: ORDER BY priority DESC, "createdAt" ASC
--   run lists: ORDER BY "createdAt" DESC, id DESC
-- Without them a claim reads and sorts every PENDING row.
--
-- A database created by Prisma 6 or 7 already has them: skip this file. For one
-- provisioned by Prisma 8, put the statements in the baseline migration instead
-- of running them by hand: replace each `columns: [...]` of the matching
-- `createIndex` with `expression: sql`<the column list below>``, then run the
-- migration file with node to re-emit it. prisma-fixtures/v8 does exactly that.
--
-- `db verify` and `migration plan` read an index by its columns and ignore the
-- sort direction, so they neither flag these nor recreate them. A plan that
-- changes one of these indexes recreates it ascending: re-run this file after.
-- Run it in one transaction, once, after the tables exist.

BEGIN;

DROP INDEX IF EXISTS "workflow_runs_createdAt_id_idx";
CREATE INDEX "workflow_runs_createdAt_id_idx" ON "workflow_runs" ("createdAt" DESC, "id" DESC);

DROP INDEX IF EXISTS "workflow_runs_status_createdAt_id_idx";
CREATE INDEX "workflow_runs_status_createdAt_id_idx" ON "workflow_runs" ("status", "createdAt" DESC, "id" DESC);

DROP INDEX IF EXISTS "workflow_runs_workflowId_createdAt_id_idx";
CREATE INDEX "workflow_runs_workflowId_createdAt_id_idx" ON "workflow_runs" ("workflowId", "createdAt" DESC, "id" DESC);

DROP INDEX IF EXISTS "workflow_runs_status_priority_createdAt_idx";
CREATE INDEX "workflow_runs_status_priority_createdAt_idx" ON "workflow_runs" ("status", "priority" DESC, "createdAt");

DROP INDEX IF EXISTS "job_queue_status_priority_createdAt_idx";
CREATE INDEX "job_queue_status_priority_createdAt_idx" ON "job_queue" ("status", "priority" DESC, "createdAt");

COMMIT;
