-- workflow_engine_enqueue: create a workflow run from SQL, inside the
-- caller's own transaction.
--
-- The whole kernel already runs in the caller's transaction; this exposes
-- the enqueue half of that to callers who are not TypeScript — a database
-- trigger, a stored procedure, a service in another language — so they can
-- schedule work atomically with the rows that justify it:
--
--   INSERT INTO orders (...) VALUES (...) RETURNING id INTO v_order_id;
--   PERFORM workflow_engine_enqueue(
--     'order:' || v_order_id, 'fulfil-order', 'Fulfil Order',
--     jsonb_build_object('orderId', v_order_id));
--
-- This file is part of the schema, not something the engine creates at
-- runtime: run it in your own migration, next to the tables it writes, so
-- your migration history owns it. Apply it AFTER the workflow engine tables
-- exist. It is idempotent (CREATE OR REPLACE) and safe to re-run.
--
-- Requires PostgreSQL 13+ (for the built-in gen_random_uuid()).
--
-- ---------------------------------------------------------------------------
-- What it does, and where it stops short of run.create
-- ---------------------------------------------------------------------------
--
-- It writes exactly the rows `run.create` writes, in the same order: the
-- idempotency key, the run, and the `workflow:created` outbox event. The run
-- is left PENDING for `run.claimPending`, exactly as the TypeScript path
-- leaves it — no job is enqueued here, so a host picks it up the same way it
-- picks up any other run.
--
-- Three things `run.create` does that SQL cannot, each with a decision:
--
-- 1. INPUT VALIDATION. `run.create` parses the input against the workflow's
--    Zod input schema and refuses a bad one. This function cannot. Bad input
--    therefore fails at the first stage, as a failed run, instead of at
--    enqueue time. If the caller is a trigger on your own table, that is
--    usually fine; if it is an untrusted API boundary, validate before
--    calling.
--
-- 2. THE DEFINITION VERSION. A run's `definitionVersion` is a SHA-256 of the
--    workflow's structural snapshot, computed in TypeScript from the built
--    definition. SQL cannot compute it, and a run pinned to a version whose
--    `workflow_definitions` row was never inserted would be pinned to
--    nothing. So the default is to create the run UNPINNED
--    (`definitionVersion` NULL) — the same state as a deployment that has
--    not adopted definition versioning, and claimable by any host. Pass
--    `p_definition_version` when the caller does know the version (a
--    TypeScript service reaching for a transactional enqueue can read
--    `workflow.definitionVersion`); the function then REFUSES unless the
--    matching `workflow_definitions` row already exists, because pinning a
--    run to an unregistered version would strand it.
--
-- 3. STAGE CONFIG DEFAULTS. `run.create` merges `workflow.getDefaultConfig()`
--    under the caller's config before storing it. This function stores
--    `p_config` verbatim. Behaviour is unaffected: every stage re-parses its
--    slice of the config through its own schema when it executes, which
--    applies the same defaults. Only the stored `config` column differs, and
--    only in what it shows a reader. Pass the merged config if you want the
--    column to match a TypeScript-created run exactly.
--
-- Two smaller differences worth knowing:
--
--   * IDs. Prisma generates a cuid client-side; this function uses
--     `gen_random_uuid()::text`. Both are opaque text and nothing reads
--     structure out of them.
--   * The in-progress idempotency marker never becomes visible, because the
--     claim and the result live in one transaction here. A concurrent caller
--     with the same key blocks on the unique index and then reads the
--     finished result — the replay path — rather than seeing the marker.
--
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION workflow_engine_enqueue(
  -- Deduplicates the enqueue exactly as `run.create`'s does: calling twice
  -- with one key returns the same run id and creates nothing the second time.
  p_idempotency_key    text,
  p_workflow_id        text,
  -- `workflow.name`. Stored on the run for display; `workflowType` is set to
  -- `p_workflow_id`, as `run.create` sets it.
  p_workflow_name      text,
  p_input              jsonb,
  p_config             jsonb   DEFAULT '{}'::jsonb,
  p_priority           integer DEFAULT 5,
  -- NULL creates the run unpinned. See note 2 above.
  p_definition_version text    DEFAULT NULL
) RETURNS text
LANGUAGE plpgsql
AS $$
DECLARE
  v_existing jsonb;
  v_run_id   text;
  v_now      timestamp(3);
  v_sequence integer;
BEGIN
  IF p_idempotency_key IS NULL OR p_idempotency_key = '' THEN
    RAISE EXCEPTION
      'workflow_engine_enqueue: an idempotency key is required (run.create takes one too)';
  END IF;
  IF p_workflow_id IS NULL OR p_workflow_id = '' THEN
    RAISE EXCEPTION 'workflow_engine_enqueue: a workflow id is required';
  END IF;
  IF p_input IS NULL THEN
    RAISE EXCEPTION 'workflow_engine_enqueue: input must not be NULL (use ''{}''::jsonb)';
  END IF;

  v_now := (now() AT TIME ZONE 'UTC');

  -- 1. Claim the idempotency key. The unique index on (key, commandType) is
  --    what makes two concurrent callers agree on one run.
  INSERT INTO "idempotency_keys" ("id", "createdAt", "key", "commandType", "result")
  VALUES (
    gen_random_uuid()::text,
    v_now,
    p_idempotency_key,
    'run.create',
    '{"__workflowEngineState":"in_progress"}'::jsonb
  )
  ON CONFLICT ("key", "commandType") DO NOTHING;

  IF NOT FOUND THEN
    SELECT "result" INTO v_existing
      FROM "idempotency_keys"
     WHERE "key" = p_idempotency_key AND "commandType" = 'run.create';

    -- A marker left behind by a TypeScript dispatch that has not settled.
    -- Refusing matches the engine's IdempotencyInProgressError rather than
    -- creating a second run under a key that already owns one.
    IF v_existing ? '__workflowEngineState' THEN
      RAISE EXCEPTION
        'workflow_engine_enqueue: run.create for idempotency key % is already in progress',
        p_idempotency_key
        USING ERRCODE = '55006';
    END IF;

    RETURN v_existing ->> 'workflowRunId';
  END IF;

  -- 2. A pinned run must name a definition that exists, or it is pinned to
  --    nothing and no host will ever serve it.
  IF p_definition_version IS NOT NULL THEN
    PERFORM 1
       FROM "workflow_definitions"
      WHERE "workflowId" = p_workflow_id
        AND "version" = p_definition_version;
    IF NOT FOUND THEN
      RAISE EXCEPTION
        'workflow_engine_enqueue: no workflow_definitions row for (%, %); a version is registered by the TypeScript definition that computed it, so create one run from TypeScript first or pass NULL to create this run unpinned',
        p_workflow_id, p_definition_version;
    END IF;
  END IF;

  -- 3. The run itself. PENDING, for run.claimPending — this function
  --    enqueues no job, exactly as run.create enqueues none.
  v_run_id := gen_random_uuid()::text;

  INSERT INTO "workflow_runs" (
    "id", "createdAt", "updatedAt", "workflowId", "workflowName",
    "workflowType", "status", "input", "config", "priority",
    "definitionVersion"
  ) VALUES (
    v_run_id, v_now, v_now, p_workflow_id, p_workflow_name,
    p_workflow_id, 'PENDING'::"Status", p_input,
    COALESCE(p_config, '{}'::jsonb), COALESCE(p_priority, 5),
    p_definition_version
  );

  -- 4. The workflow:created outbox event, sequenced per run under the same
  --    advisory lock the TypeScript writer takes.
  PERFORM pg_advisory_xact_lock(hashtext(v_run_id));
  SELECT COALESCE(MAX("sequence"), 0) + 1 INTO v_sequence
    FROM "outbox_events"
   WHERE "workflowRunId" = v_run_id;

  INSERT INTO "outbox_events" (
    "id", "createdAt", "workflowRunId", "sequence", "eventType",
    "payload", "causationId", "occurredAt"
  ) VALUES (
    gen_random_uuid()::text,
    v_now,
    v_run_id,
    v_sequence,
    'workflow:created',
    jsonb_build_object(
      'type', 'workflow:created',
      -- The TypeScript payload carries a Date, which reaches jsonb as an
      -- ISO-8601 string; this is that same encoding.
      'timestamp', to_char(v_now, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'workflowRunId', v_run_id,
      'workflowId', p_workflow_id
    ),
    p_idempotency_key,
    v_now
  );

  -- 5. Record the result under the key, so a replay returns this run
  --    instead of creating another. Same shape as RunCreateResult.
  UPDATE "idempotency_keys"
     SET "result" = jsonb_build_object(
       'workflowRunId', v_run_id,
       'status', 'PENDING',
       'definitionVersion', p_definition_version
     )
   WHERE "key" = p_idempotency_key AND "commandType" = 'run.create';

  RETURN v_run_id;
END;
$$;

COMMENT ON FUNCTION workflow_engine_enqueue(text, text, text, jsonb, jsonb, integer, text) IS
  'Create a PENDING workflow run in the caller''s transaction. Mirrors the run.create kernel command; see sql/enqueue.sql for what it cannot do (input validation, definition-version stamping, stage config defaults).';
