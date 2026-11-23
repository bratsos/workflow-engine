# Job runtime controls

Apply this schema upgrade before deploying the engine that supports workflow and stage runtime controls. Use the updated Prisma schema or contract, or apply the equivalent SQL below as one upgrade. Existing rows need no backfill.

Prisma models do not declare expression indexes. After provisioning with a Prisma schema or contract, install the index using the packaged `sql/job-workflow-index.postgresql.sql` or `sql/job-workflow-index.sqlite.sql` before enabling `maxConcurrent`. The SQL upgrade below already includes the index. If you applied an earlier version of this upgrade, run only the matching index file.

## PostgreSQL

Use the shipped `sql/job-runtime-controls.postgresql.sql`. Run outside a transaction so the indexes build concurrently. The column addition has a 500 ms lock timeout. If it times out, retry the column addition. If an index build fails after the columns are added, inspect the index and drop any invalid build before retrying that index statement. If you grant privileges per column, grant the new engine role the matching job queue column privileges before deploying it.

## SQLite

Run these statements in one transaction. The declarations below match Prisma 6 and 7. For Prisma 8, use `TEXT` in place of `JSONB` and both `DATETIME` declarations. Keep the same Prisma major and date storage format as the existing database.

```sql
BEGIN;

ALTER TABLE "job_queue" ADD COLUMN "workflowId" TEXT;
ALTER TABLE "job_queue" ADD COLUMN "retryPolicy" JSONB;
ALTER TABLE "job_queue" ADD COLUMN "leaseTimeoutMs" INTEGER;
ALTER TABLE "job_queue" ADD COLUMN "leaseExpiresAt" DATETIME;
ALTER TABLE "job_queue" ADD COLUMN "absoluteTimeoutMs" INTEGER;
ALTER TABLE "job_queue" ADD COLUMN "absoluteExpiresAt" DATETIME;
CREATE INDEX "job_queue_status_leaseExpiresAt_idx" ON "job_queue" ("status", "leaseExpiresAt");
CREATE INDEX "job_queue_status_absoluteExpiresAt_idx" ON "job_queue" ("status", "absoluteExpiresAt");
CREATE INDEX "job_queue_status_workflowId_idx" ON "job_queue" ("status", "workflowId");
CREATE INDEX "job_queue_status_workflow_priority_idx"
  ON "job_queue" ("status", (COALESCE(':' || COALESCE("workflowId", json_extract(payload, '$._workflowId')), '')), "priority" DESC, "createdAt");

COMMIT;
```

The upgrade is **rolling-safe** with the new options disabled. Old worker code can continue to use the migrated schema. Stop old hosts first before setting the options on a shared queue. Old hosts use their previous retry and timeout rules and may claim above the configured workflow limit.
