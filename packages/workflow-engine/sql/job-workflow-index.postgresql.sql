-- Required for bounded maxConcurrent claims on fresh Prisma-provisioned databases.
-- Run outside a transaction. The Wave 4 upgrade already creates this index.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "job_queue_status_workflow_priority_idx"
  ON "job_queue" ("status", (COALESCE(':' || COALESCE("workflowId", payload ->> '_workflowId'), '')), "priority" DESC, "createdAt");
