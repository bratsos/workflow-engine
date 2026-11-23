-- Required for maxConcurrent claims on fresh Prisma-provisioned databases.
-- The Wave 4 upgrade already creates this index.
CREATE INDEX IF NOT EXISTS "job_queue_status_workflow_priority_idx"
  ON "job_queue" ("status", (COALESCE(':' || COALESCE("workflowId", json_extract(payload, '$._workflowId')), '')), "priority" DESC, "createdAt");
