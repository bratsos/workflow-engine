-- PostgreSQL online upgrade for the attribution columns and indexes.
-- Run with psql -X -v ON_ERROR_STOP=1 -f tenant-attribution.sql.
-- Each ALTER commits before the next table is locked. The concurrent index
-- builds run outside transaction blocks, so omit psql --single-transaction.

BEGIN;
SET LOCAL lock_timeout = '500ms';
ALTER TABLE "workflow_runs"
  ADD COLUMN IF NOT EXISTS "tenantId" TEXT,
  ADD COLUMN IF NOT EXISTS "labels" JSONB;
COMMIT;

BEGIN;
SET LOCAL lock_timeout = '500ms';
ALTER TABLE "ai_calls"
  ADD COLUMN IF NOT EXISTS "workflowRunId" TEXT,
  ADD COLUMN IF NOT EXISTS "tenantId" TEXT,
  ADD COLUMN IF NOT EXISTS "labels" JSONB,
  ADD COLUMN IF NOT EXISTS "textExpiresAt" TIMESTAMP(3);
COMMIT;

BEGIN;
SET LOCAL lock_timeout = '500ms';
ALTER TABLE "idempotency_keys"
  ADD COLUMN IF NOT EXISTS "workflowRunId" TEXT;
COMMIT;

CREATE INDEX CONCURRENTLY IF NOT EXISTS "workflow_runs_tenantId_createdAt_id_idx"
  ON "workflow_runs" ("tenantId", "createdAt" DESC, "id" DESC);
CREATE INDEX CONCURRENTLY IF NOT EXISTS "ai_calls_tenantId_createdAt_idx"
  ON "ai_calls" ("tenantId", "createdAt");
CREATE INDEX CONCURRENTLY IF NOT EXISTS "ai_calls_workflowRunId_idx" ON "ai_calls" ("workflowRunId");
CREATE INDEX CONCURRENTLY IF NOT EXISTS "ai_calls_textExpiresAt_idx" ON "ai_calls" ("textExpiresAt");
CREATE INDEX CONCURRENTLY IF NOT EXISTS "idempotency_keys_workflowRunId_idx"
  ON "idempotency_keys" ("workflowRunId");
CREATE INDEX CONCURRENTLY IF NOT EXISTS "idempotency_keys_createdAt_idx" ON "idempotency_keys" ("createdAt");

-- IF NOT EXISTS skips an INVALID index left by a failed concurrent build.
DO $$
DECLARE
  invalid_index text;
BEGIN
  SELECT name INTO invalid_index
  FROM unnest(ARRAY[
    'workflow_runs_tenantId_createdAt_id_idx',
    'ai_calls_tenantId_createdAt_idx',
    'ai_calls_workflowRunId_idx',
    'ai_calls_textExpiresAt_idx',
    'idempotency_keys_workflowRunId_idx',
    'idempotency_keys_createdAt_idx'
  ]) AS wanted(name)
  LEFT JOIN pg_index ON indexrelid = to_regclass(quote_ident(name))
  WHERE indisvalid IS DISTINCT FROM TRUE
  LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION 'Attribution index % is missing or invalid', invalid_index
      USING HINT = 'Drop an invalid index with DROP INDEX CONCURRENTLY and retry this script.';
  END IF;
END;
$$;
