-- Legacy lookups use literal, byte-ordered prefixes and JSON run attribution.
CREATE INDEX IF NOT EXISTS "ai_calls_legacy_topic_idx"
  ON "ai_calls" ("topic") WHERE "workflowRunId" IS NULL;
CREATE INDEX IF NOT EXISTS "idempotency_keys_legacy_run_idx"
  ON "idempotency_keys" (json_extract("result", '$.workflowRunId')) WHERE "workflowRunId" IS NULL;
CREATE INDEX IF NOT EXISTS "idempotency_keys_legacy_prefix_idx"
  ON "idempotency_keys" ("commandType", "key") WHERE "workflowRunId" IS NULL;
-- Erasure checks that no other run archived a stage record it is about to erase.
CREATE INDEX IF NOT EXISTS "workflow_annotations_archived_record_idx"
  ON "workflow_annotations" (json_extract("payload", '$.stageRecordId')) WHERE "key" = 'run.supersededAttempt';
