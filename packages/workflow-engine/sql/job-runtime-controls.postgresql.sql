-- Apply as one schema upgrade. Run outside a transaction for the index builds.
SET lock_timeout = '500ms';

ALTER TABLE "job_queue"
  ADD COLUMN "workflowId" TEXT,
  ADD COLUMN "retryPolicy" JSONB,
  ADD COLUMN "leaseTimeoutMs" INTEGER,
  ADD COLUMN "leaseExpiresAt" TIMESTAMP(3),
  ADD COLUMN "absoluteTimeoutMs" INTEGER,
  ADD COLUMN "absoluteExpiresAt" TIMESTAMP(3);

RESET lock_timeout;

CREATE INDEX CONCURRENTLY "job_queue_status_leaseExpiresAt_idx" ON "job_queue" ("status", "leaseExpiresAt");
CREATE INDEX CONCURRENTLY "job_queue_status_absoluteExpiresAt_idx" ON "job_queue" ("status", "absoluteExpiresAt");
CREATE INDEX CONCURRENTLY "job_queue_status_workflowId_idx" ON "job_queue" ("status", "workflowId");
