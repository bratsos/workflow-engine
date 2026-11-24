-- Install after adding outbox_events.pruneTerminal to the schema.
CREATE TRIGGER IF NOT EXISTS workflow_engine_outbox_prune_insert
AFTER INSERT ON "outbox_events" FOR EACH ROW
BEGIN
  UPDATE "outbox_events" SET "pruneTerminal" = NEW."publishedAt" IS NOT NULL AND NEW."dlqAt" IS NULL AND EXISTS (
    SELECT 1 FROM "workflow_runs" r WHERE r."id" = NEW."workflowRunId"
      AND r."status" IN ('COMPLETED', 'FAILED', 'CANCELLED')
  ) WHERE "id" = NEW."id";
END;
-- statement-breakpoint
CREATE TRIGGER IF NOT EXISTS workflow_engine_outbox_prune_reassign
AFTER UPDATE OF "workflowRunId", "publishedAt", "dlqAt" ON "outbox_events" FOR EACH ROW
BEGIN
  UPDATE "outbox_events" SET "pruneTerminal" = NEW."publishedAt" IS NOT NULL AND NEW."dlqAt" IS NULL AND EXISTS (
    SELECT 1 FROM "workflow_runs" r WHERE r."id" = NEW."workflowRunId"
      AND r."status" IN ('COMPLETED', 'FAILED', 'CANCELLED')
  ) WHERE "id" = NEW."id";
END;
-- statement-breakpoint
CREATE TRIGGER IF NOT EXISTS workflow_engine_outbox_prune_status
AFTER UPDATE OF "status" ON "workflow_runs" FOR EACH ROW
WHEN (OLD."status" IN ('COMPLETED', 'FAILED', 'CANCELLED'))
  != (NEW."status" IN ('COMPLETED', 'FAILED', 'CANCELLED'))
BEGIN
  UPDATE "outbox_events"
    SET "pruneTerminal" = NEW."status" IN ('COMPLETED', 'FAILED', 'CANCELLED')
    WHERE "workflowRunId" = NEW."id" AND "publishedAt" IS NOT NULL AND "dlqAt" IS NULL;
END;
-- statement-breakpoint
CREATE TRIGGER IF NOT EXISTS workflow_engine_outbox_prune_run_delete
AFTER DELETE ON "workflow_runs" FOR EACH ROW
BEGIN
  UPDATE "outbox_events" SET "pruneTerminal" = 0
    WHERE "workflowRunId" = OLD."id" AND "pruneTerminal" = 1;
END;
-- statement-breakpoint
UPDATE "outbox_events" SET "pruneTerminal" = 0
  WHERE "pruneTerminal" = 1 AND ("publishedAt" IS NULL OR "dlqAt" IS NOT NULL);
-- statement-breakpoint
UPDATE "outbox_events" SET "pruneTerminal" = 1
  WHERE "pruneTerminal" = 0 AND "publishedAt" IS NOT NULL AND "dlqAt" IS NULL AND EXISTS (
    SELECT 1 FROM "workflow_runs" r WHERE r."id" = "outbox_events"."workflowRunId"
      AND r."status" IN ('COMPLETED', 'FAILED', 'CANCELLED')
  );
-- statement-breakpoint
CREATE INDEX IF NOT EXISTS "outbox_events_prune_idx" ON "outbox_events" ("publishedAt")
  WHERE "pruneTerminal" = 1 AND "dlqAt" IS NULL AND "publishedAt" IS NOT NULL;
-- statement-breakpoint
CREATE INDEX IF NOT EXISTS "idempotency_keys_prune_idx" ON "idempotency_keys" ("createdAt")
  WHERE json_extract("result", '$.__workflowEngineState') IS NOT 'in_progress';
-- statement-breakpoint
-- Run writer registrations are in progress, so the index above never holds
-- them; this one lets pruning find those whose lease lapsed.
CREATE INDEX IF NOT EXISTS "idempotency_keys_writer_prune_idx" ON "idempotency_keys" ("createdAt")
  WHERE "commandType" = 'run.write';
