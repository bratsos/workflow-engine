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

-- IF NOT EXISTS skips any index that already has the name: an INVALID one
-- left by a failed concurrent build, or one with another definition. Check
-- each name is a valid index of the planned table and columns.
DO $$
DECLARE
  bad_index text;
BEGIN
  SELECT wanted.name INTO bad_index
  FROM (VALUES
    ('workflow_runs_tenantId_createdAt_id_idx', 'workflow_runs',
     'btree ("tenantId", "createdAt" DESC, id DESC)'),
    ('ai_calls_tenantId_createdAt_idx', 'ai_calls', 'btree ("tenantId", "createdAt")'),
    ('ai_calls_workflowRunId_idx', 'ai_calls', 'btree ("workflowRunId")'),
    ('ai_calls_textExpiresAt_idx', 'ai_calls', 'btree ("textExpiresAt")'),
    ('idempotency_keys_workflowRunId_idx', 'idempotency_keys', 'btree ("workflowRunId")'),
    ('idempotency_keys_createdAt_idx', 'idempotency_keys', 'btree ("createdAt")')
  ) AS wanted(name, table_name, definition)
  LEFT JOIN pg_index i ON i.indexrelid = to_regclass(quote_ident(wanted.name))
  WHERE NOT coalesce(
    i.indisvalid
      AND NOT i.indisunique
      AND i.indrelid = to_regclass(quote_ident(wanted.table_name))
      AND split_part(pg_get_indexdef(i.indexrelid), ' USING ', 2) = wanted.definition,
    false)
  LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION 'Attribution index % is missing, invalid or not defined as planned', bad_index
      USING HINT = 'Drop that index with DROP INDEX CONCURRENTLY and retry this script.';
  END IF;
END;
$$;
