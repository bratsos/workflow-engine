-- Install in the same migration as deliveryClaim and its indexes.
-- NULL is unscheduled, '' is a ready head, and a nonempty value is a lease.
CREATE TRIGGER IF NOT EXISTS workflow_engine_outbox_insert AFTER INSERT ON outbox_events
WHEN NEW."publishedAt" IS NULL AND NEW."dlqAt" IS NULL AND NOT EXISTS (
  SELECT 1 FROM outbox_events INDEXED BY outbox_events_delivery_run_idx
  WHERE "workflowRunId" = NEW."workflowRunId" AND "publishedAt" IS NULL AND "dlqAt" IS NULL AND "deliveryClaim" >= ''
)
BEGIN
  UPDATE outbox_events SET "deliveryClaim" = '' WHERE id = NEW.id;
END;

CREATE TRIGGER IF NOT EXISTS workflow_engine_outbox_resolve
AFTER UPDATE OF "publishedAt", "dlqAt" ON outbox_events
WHEN OLD."deliveryClaim" IS NOT NULL AND (NEW."publishedAt" IS NOT NULL OR NEW."dlqAt" IS NOT NULL)
BEGIN
  UPDATE outbox_events SET "deliveryClaim" = NULL WHERE id = NEW.id AND "deliveryClaim" IS NOT NULL;
  UPDATE outbox_events SET "deliveryClaim" = '' WHERE id = (
    SELECT id FROM outbox_events INDEXED BY outbox_events_live_run_sequence_idx
    WHERE "workflowRunId" = NEW."workflowRunId" AND "publishedAt" IS NULL AND "dlqAt" IS NULL
    ORDER BY sequence LIMIT 1
  );
END;

CREATE TRIGGER IF NOT EXISTS workflow_engine_outbox_replay
AFTER UPDATE OF "publishedAt", "dlqAt", "deliveryClaim" ON outbox_events
WHEN (
  ((OLD."dlqAt" IS NOT NULL OR OLD."publishedAt" IS NOT NULL)
    AND NEW."dlqAt" IS NULL AND NEW."publishedAt" IS NULL)
  OR (OLD."deliveryClaim" > '' AND NEW."deliveryClaim" = '')
) AND NOT EXISTS (
  SELECT 1 FROM outbox_events INDEXED BY outbox_events_delivery_run_idx WHERE "workflowRunId" = NEW."workflowRunId" AND "publishedAt" IS NULL AND "dlqAt" IS NULL AND "deliveryClaim" > ''
)
BEGIN
  UPDATE outbox_events SET "deliveryClaim" = NULL
    WHERE "workflowRunId" = NEW."workflowRunId" AND "deliveryClaim" = '';
  UPDATE outbox_events SET "deliveryClaim" = '' WHERE id = (
    SELECT id FROM outbox_events INDEXED BY outbox_events_live_run_sequence_idx
    WHERE "workflowRunId" = NEW."workflowRunId" AND "publishedAt" IS NULL AND "dlqAt" IS NULL
    ORDER BY sequence LIMIT 1
  );
END;

CREATE TRIGGER IF NOT EXISTS workflow_engine_outbox_delete AFTER DELETE ON outbox_events
WHEN OLD."deliveryClaim" IS NOT NULL
BEGIN
  UPDATE outbox_events SET "deliveryClaim" = '' WHERE id = (
    SELECT id FROM outbox_events INDEXED BY outbox_events_live_run_sequence_idx
    WHERE "workflowRunId" = OLD."workflowRunId" AND "publishedAt" IS NULL AND "dlqAt" IS NULL
    ORDER BY sequence LIMIT 1
  );
END;

-- Backfill the schedule from all unpublished, non-dead-lettered rows.
UPDATE outbox_events SET "deliveryClaim" = ''
WHERE id IN (
  SELECT first_value(id) OVER (PARTITION BY "workflowRunId" ORDER BY sequence)
  FROM outbox_events WHERE "publishedAt" IS NULL AND "dlqAt" IS NULL
);
