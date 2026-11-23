-- Install after adding outbox_events.pruneTerminal to the schema.
CREATE OR REPLACE FUNCTION workflow_engine_outbox_prune_terminal() RETURNS trigger
LANGUAGE plpgsql SET enable_seqscan = off AS $$
BEGIN
  IF NEW."publishedAt" IS NULL OR NEW."dlqAt" IS NOT NULL THEN
    NEW."pruneTerminal" := FALSE;
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF OLD."publishedAt" IS NOT NULL AND OLD."dlqAt" IS NULL
       AND OLD."workflowRunId" = NEW."workflowRunId" THEN
      NEW."pruneTerminal" := OLD."pruneTerminal";
      RETURN NEW;
    END IF;
  END IF;
  -- Rows entering the published range lock the parent, whose status
  -- trigger only touches already published rows. Appending an unpublished
  -- stage event can still commit while cancellation holds the run lock.
  -- Keep the parent lookup keyed when stale statistics describe a tiny table.
  SELECT r."status" IN ('COMPLETED', 'FAILED', 'CANCELLED')
    INTO NEW."pruneTerminal" FROM "workflow_runs" r
    WHERE r."id" >= NEW."workflowRunId" AND r."id" <= NEW."workflowRunId"
    ORDER BY r."id" LIMIT 1 FOR SHARE;
  NEW."pruneTerminal" := COALESCE(NEW."pruneTerminal", FALSE);
  RETURN NEW;
END;
$$;
-- statement-breakpoint
CREATE OR REPLACE FUNCTION workflow_engine_refresh_outbox_prune() RETURNS trigger
LANGUAGE plpgsql SET enable_seqscan = off AS $$
DECLARE eligible boolean := FALSE;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    eligible := NEW."status" IN ('COMPLETED', 'FAILED', 'CANCELLED');
    IF eligible = (OLD."status" IN ('COMPLETED', 'FAILED', 'CANCELLED')) THEN
      RETURN NULL;
    END IF;
  END IF;
  UPDATE "outbox_events" SET "pruneTerminal" = eligible
    WHERE "workflowRunId" = OLD."id" AND "publishedAt" IS NOT NULL AND "dlqAt" IS NULL
      AND "pruneTerminal" IS DISTINCT FROM eligible;
  RETURN NULL;
END;
$$;
-- statement-breakpoint
DROP TRIGGER IF EXISTS workflow_engine_outbox_prune_terminal ON "outbox_events";
-- statement-breakpoint
CREATE TRIGGER workflow_engine_outbox_prune_terminal
BEFORE INSERT OR UPDATE OF "workflowRunId", "publishedAt", "dlqAt" ON "outbox_events"
FOR EACH ROW EXECUTE FUNCTION workflow_engine_outbox_prune_terminal();
-- statement-breakpoint
DROP TRIGGER IF EXISTS workflow_engine_refresh_outbox_prune ON "workflow_runs";
-- statement-breakpoint
CREATE TRIGGER workflow_engine_refresh_outbox_prune
AFTER UPDATE OF "status" OR DELETE ON "workflow_runs"
FOR EACH ROW EXECUTE FUNCTION workflow_engine_refresh_outbox_prune();
-- statement-breakpoint
UPDATE "outbox_events" SET "pruneTerminal" = FALSE
  WHERE "pruneTerminal" AND ("publishedAt" IS NULL OR "dlqAt" IS NOT NULL);
-- statement-breakpoint
UPDATE "outbox_events" e SET "pruneTerminal" = TRUE
  FROM "workflow_runs" r
  WHERE e."workflowRunId" = r."id" AND NOT e."pruneTerminal"
    AND e."publishedAt" IS NOT NULL AND e."dlqAt" IS NULL
    AND r."status" IN ('COMPLETED', 'FAILED', 'CANCELLED');
-- statement-breakpoint
CREATE INDEX IF NOT EXISTS "outbox_events_prune_idx"
  ON "outbox_events" (("publishedAt" + interval '0 seconds'))
  WHERE "pruneTerminal" = TRUE AND "dlqAt" IS NULL AND "publishedAt" IS NOT NULL;
-- statement-breakpoint
CREATE INDEX IF NOT EXISTS "idempotency_keys_prune_idx"
  ON "idempotency_keys" (("createdAt" + interval '0 seconds'))
  WHERE ("result"->>'__workflowEngineState') IS DISTINCT FROM 'in_progress';
