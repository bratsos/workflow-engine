-- Install in the same migration as deliveryClaim and its indexes.
-- NULL is an unscheduled row; the empty string is a ready run head.
-- A nonempty value is that head's expiry and owner token.
CREATE OR REPLACE FUNCTION workflow_engine_refresh_outbox_head()
RETURNS trigger LANGUAGE plpgsql
-- Trigger lookups are ordered point/range reads, including on tiny stale histograms.
SET enable_seqscan TO off
SET enable_bitmapscan TO off
SET enable_sort TO off
AS $$
DECLARE
  run_id text;
  scheduled_id text;
  scheduled_claim text;
  next_id text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."deliveryClaim" IS NULL THEN RETURN NULL; END IF;
    run_id := OLD."workflowRunId";
  ELSE
    run_id := NEW."workflowRunId";
    IF TG_OP = 'INSERT' AND (NEW."publishedAt" IS NOT NULL OR NEW."dlqAt" IS NOT NULL) THEN
      RETURN NULL;
    END IF;
    IF TG_OP = 'UPDATE'
      AND OLD."publishedAt" IS NOT DISTINCT FROM NEW."publishedAt"
      AND OLD."dlqAt" IS NOT DISTINCT FROM NEW."dlqAt"
      AND NOT COALESCE(OLD."deliveryClaim" > '' AND NEW."deliveryClaim" = '', false)
    THEN RETURN NULL; END IF;
  END IF;

  -- Serialize schedule changes even for outbox rows without a run FK.
  PERFORM pg_advisory_xact_lock(hashtext(run_id));

  IF TG_OP = 'INSERT' THEN
    -- Appends use increasing sequences. The first live row of a run
    -- becomes its head; subsequent appends never displace a head.
    IF NEW.sequence = 1 OR NOT EXISTS (
      SELECT 1 FROM outbox_events
      WHERE "workflowRunId" = run_id AND "publishedAt" IS NULL AND "dlqAt" IS NULL
        AND sequence < NEW.sequence
    ) THEN
      UPDATE outbox_events SET "deliveryClaim" = '' WHERE id = NEW.id;
    END IF;
    RETURN NULL;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF NEW."publishedAt" IS NOT NULL OR NEW."dlqAt" IS NOT NULL THEN
      IF OLD."deliveryClaim" IS NULL THEN RETURN NULL; END IF;
      IF NEW."deliveryClaim" IS NOT NULL THEN
        UPDATE outbox_events SET "deliveryClaim" = NULL WHERE id = NEW.id;
      END IF;
    ELSIF OLD."deliveryClaim" > '' AND NEW."deliveryClaim" = '' THEN
      scheduled_id := NEW.id;
    ELSE
      SELECT id, "deliveryClaim" INTO scheduled_id, scheduled_claim
        FROM outbox_events
        WHERE "workflowRunId" = run_id AND "publishedAt" IS NULL AND "dlqAt" IS NULL
          AND "deliveryClaim" >= ''
        ORDER BY "publishedAt", "dlqAt", "workflowRunId", "deliveryClaim" LIMIT 1;
      -- A successor already claimed before replay retains its place.
      IF scheduled_claim <> '' THEN RETURN NULL; END IF;
    END IF;
  END IF;

  SELECT id INTO next_id FROM outbox_events
    WHERE "workflowRunId" = run_id AND "publishedAt" IS NULL AND "dlqAt" IS NULL
    ORDER BY "publishedAt", "dlqAt", "workflowRunId", sequence LIMIT 1;
  IF next_id IS NOT DISTINCT FROM scheduled_id THEN RETURN NULL; END IF;
  IF scheduled_id IS NOT NULL THEN
    -- A concurrent claim can beat the replay to the schedule.
    UPDATE outbox_events SET "deliveryClaim" = NULL
      WHERE id = scheduled_id AND "deliveryClaim" = '';
    IF NOT FOUND THEN RETURN NULL; END IF;
  END IF;
  UPDATE outbox_events SET "deliveryClaim" = '' WHERE id = next_id;
  RETURN NULL;
END
$$;

DROP TRIGGER IF EXISTS workflow_engine_outbox_head ON outbox_events;
CREATE TRIGGER workflow_engine_outbox_head
  AFTER INSERT OR DELETE OR UPDATE OF "publishedAt", "dlqAt", "deliveryClaim" ON outbox_events
  FOR EACH ROW EXECUTE FUNCTION workflow_engine_refresh_outbox_head();

-- Existing unpublished rows predate the schedule. Initialize one head per run.
UPDATE outbox_events SET "deliveryClaim" = ''
WHERE id IN (
  SELECT DISTINCT ON ("workflowRunId") id FROM outbox_events
  WHERE "publishedAt" IS NULL AND "dlqAt" IS NULL
  ORDER BY "workflowRunId", sequence
);
