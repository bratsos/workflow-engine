# Migrating from 0.13 to 1.0

## Summary

1.0 adds durable steps (`ctx.step.*`, backed by a new `WorkflowStep` table), injects AI services into every stage context (`ctx.ai`, `ctx.aiLogger`, `ctx.step.ai`), replaces the async-batch stage pattern with one primitive (`ctx.step.ai.map` with a realtime/batch policy), makes the workflow builder infer the context type from earlier stages, pins runs to a definition version (`13-definition-versioning.md`), replaces `run.rerunFrom` with `run.redrive` (`14-redrive.md`), spills oversized step results and job payloads to the blob store (`15-large-payloads.md`), ships an embeddable operational console (`16-operational-console.md`), and removes everything deprecated for 1.0. It also moves to AI SDK 7. Two things bite at runtime rather than compile time, so do them first: the database needs the `workflow_steps` table plus the columns and indexes listed below, and every stage context now carries `step`, `ai`, `aiLogger` and `abortSignal`.

The first real-world runs of the 1.0 alphas also found and fixed behaviour that 0.13 code may rely on: batch results are now validated and repaired, realtime map retries run in-process, and hosts flush the outbox on `stop()`. See "Behaviour changes".

## Does this affect you?

- **Every consumer** — apply the database checklist and update the peer dependencies. If you construct a `StageContext` by hand (custom host, unit tests calling `stage.execute(ctx)` directly) read "Hand-built contexts".
- **You use `defineAsyncBatchStage`** — it is no longer exported. Migrate to `defineStage` with `ctx.step.waitFor` (a poll) or `ctx.step.ai.map` (an AI batch); the section below has the before/after. `npx workflow-engine-codemod --from 0.13` flags every use, with `checkCompletion`, `requireStageOutput`, `experimental_output` and the removed model helpers.
- **You call any API in the removals table** — those are compile errors now; each has a one-line replacement.
- **You implement `AIAdapter`** — `generateObject` results are now read from `object` (an alpha bug read `output`), and the repair loop expects `NoObjectGeneratedError` with `text` set. See "Adapters".
- **You implement a port yourself** (`JobQueue`/`JobTransport`, `WorkflowPersistence`, `StepLedger`) — each gained required methods and changed return types; the three checklist items under "Custom port implementations" list them, and the conformance suites in `@bratsos/workflow-engine/testing` check every one.
- **You dispatch `run.rerunFrom`** — it still works, but it is deprecated for `run.redrive`, which keeps the resumed stage's completed steps and can move a run onto another definition version. See "Behaviour changes" and `14-redrive.md`.

## Database checklist

Verified against `git diff` of the package's `prisma/schema.prisma` between 0.13.0 and 1.0.0, plus every column the 1.0 Prisma adapters write. Apply in order; every statement is idempotent on Postgres (`IF NOT EXISTS`).

On Prisma 8 there is no `schema.prisma` or generated client: update `prisma/contract.prisma` from the package's `contract.prisma`, run `npx prisma contract emit`, then `npx prisma db update` (or `npx prisma migration plan` and `npx prisma db migrate --advance-ref db`). Renaming one of the six descending indexes, or dropping and recreating it, brings it back ascending, and `db verify --strict` does not notice, so re-run `psql "$DATABASE_URL" -f node_modules/@bratsos/workflow-engine/prisma/mixed-order-indexes.sql` afterwards. (A change to an index's columns under the same name fails planning with `MIGRATION.PLANNING_FAILED` instead.) See [Prisma 8](../references/05-persistence-setup.md#prisma-8).

- [ ] **Add the `workflow_steps` table** (new in 1.0; used by `createPrismaStepLedger`).

  ```prisma
  model WorkflowStep {
    id             String    @id @default(cuid())
    stageRecordId  String
    stage          WorkflowStage @relation(fields: [stageRecordId], references: [id], onDelete: Cascade)
    stepId         String
    seq            Int
    kind           String
    status         String
    attempt        Int       @default(1)
    leaseExpiresAt DateTime?
    deadlineAt     DateTime?
    externalKey    String?
    result         Json?
    error          String?
    waitState      Json?
    createdAt      DateTime  @default(now())
    updatedAt      DateTime  @updatedAt

    @@unique([stageRecordId, stepId])
    @@index([stageRecordId])
    @@map("workflow_steps")
  }
  ```

  Add the back-relation `steps WorkflowStep[]` to your `WorkflowStage` model.

  ```sql
  CREATE TABLE IF NOT EXISTS "workflow_steps" (
    "id"             TEXT PRIMARY KEY,
    "stageRecordId"  TEXT NOT NULL,
    "stepId"         TEXT NOT NULL,
    "seq"            INTEGER NOT NULL,
    "kind"           TEXT NOT NULL,
    "status"         TEXT NOT NULL,
    "attempt"        INTEGER NOT NULL DEFAULT 1,
    "leaseExpiresAt" TIMESTAMP(3),
    "deadlineAt"     TIMESTAMP(3),
    "externalKey"    TEXT,
    "result"         JSONB,
    "error"          TEXT,
    "waitState"      JSONB,
    "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"      TIMESTAMP(3) NOT NULL,
    CONSTRAINT "workflow_steps_stageRecordId_fkey"
      FOREIGN KEY ("stageRecordId") REFERENCES "workflow_stages"("id")
      ON DELETE CASCADE ON UPDATE CASCADE
  );
  CREATE UNIQUE INDEX IF NOT EXISTS "workflow_steps_stageRecordId_stepId_key"
    ON "workflow_steps"("stageRecordId", "stepId");
  CREATE INDEX IF NOT EXISTS "workflow_steps_stageRecordId_idx"
    ON "workflow_steps"("stageRecordId");
  ```

  `stageRecordId` is the `WorkflowStage.id` of the stage execution. The foreign key cascades: deleting a stage record — or the run above it, through `workflow_stages`' own cascade — removes its ledger rows with it, so a run deleted by hand or by `run.purge` leaves no orphans in `workflow_steps`. The kernel still clears the ledger explicitly (`StepLedger.clear` / `clearExcept` on a rerun, and `run.purge` before it deletes the run) because the `StepLedger` port is pluggable and a non-Prisma ledger has no cascade to rely on. **If you created `workflow_steps` from an earlier 1.0 alpha, add the constraint** (rows whose stage record no longer exists must be deleted first, or the `ADD CONSTRAINT` fails its validation):

  ```sql
  DELETE FROM "workflow_steps" s
    WHERE NOT EXISTS (SELECT 1 FROM "workflow_stages" st WHERE st."id" = s."stageRecordId");
  DO $$
  BEGIN
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint WHERE conname = 'workflow_steps_stageRecordId_fkey'
    ) THEN
      ALTER TABLE "workflow_steps"
        ADD CONSTRAINT "workflow_steps_stageRecordId_fkey"
        FOREIGN KEY ("stageRecordId") REFERENCES "workflow_stages"("id")
        ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
  END $$;
  ```

  `result` holds the JSON the step returned (a `download` step that returns the whole document stores the whole document — return a key or a summary when the payload is large). `externalKey` (added in 1.0.0-alpha.9) is the deterministic name of the external effect a `run` body creates, written before the body runs; it is what lets an operator find a provider-side effect orphaned by a crash. **If you created `workflow_steps` from an earlier 1.0 alpha, add the column:**

  ```sql
  ALTER TABLE "workflow_steps" ADD COLUMN IF NOT EXISTS "externalKey" TEXT;
  ```

- [ ] **Add `batchId` and `requestId` to `ai_calls`.** The 0.12→0.13 guide asked for these, but the package's own `prisma/schema.prisma` did not carry them until 1.0, so a consumer who copied the package schema is missing them. Both nullable; the unique index is what deduplicates batch cost rows.

  ```sql
  ALTER TABLE "ai_calls"
    ADD COLUMN IF NOT EXISTS "batchId"   TEXT,
    ADD COLUMN IF NOT EXISTS "requestId" TEXT;
  CREATE INDEX IF NOT EXISTS "ai_calls_batchId_idx" ON "ai_calls"("batchId");
  CREATE UNIQUE INDEX IF NOT EXISTS "ai_calls_batch_request_unique"
    ON "ai_calls"("batchId", "requestId");
  ```

- [ ] **Add the cost-accounting fields and columns to `ai_calls`.** Since 1.0.0-alpha.14 every call row keeps the registry estimate beside the provider's figure, which of the two `cost` is, the endpoint that served the request, and the cached-input and reasoning token breakdowns. All six are nullable; rows written before this read back with them absent and `cost` is unchanged, so nothing depends on a backfill. The Prisma logger passes them on every write, so you must update your Prisma schema, apply the SQL migration, and regenerate your Prisma client before deploying:

  1. **Add the six fields to your `AICall` model in `schema.prisma`:**
     ```prisma
     model AICall {
       // ... existing fields ...
       estimatedCost     Float?
       reportedCost      Float?
       costSource        String?
       servedBy          String?
       cachedInputTokens Int?
       reasoningTokens   Int?
     }
     ```

  2. **Add the columns to the database:**
     ```sql
     ALTER TABLE "ai_calls"
       ADD COLUMN IF NOT EXISTS "estimatedCost"     DOUBLE PRECISION,
       ADD COLUMN IF NOT EXISTS "reportedCost"      DOUBLE PRECISION,
       ADD COLUMN IF NOT EXISTS "costSource"        TEXT,
       ADD COLUMN IF NOT EXISTS "servedBy"          TEXT,
       ADD COLUMN IF NOT EXISTS "cachedInputTokens" INTEGER,
       ADD COLUMN IF NOT EXISTS "reasoningTokens"   INTEGER;
     ```

  3. **Regenerate the Prisma client** (`npx prisma generate` or `pnpm prisma generate`) before deploying. If you omit this step, the generated client rejects the logger's write with `Unknown argument estimatedCost`.

- [ ] **Confirm the columns the adapters write on every dispatch.** These all exist in the 0.13 package schema, but consumers who forked the schema before 0.11 (or applied migrations selectively) have hit each of them as a runtime `Unknown argument` from Prisma on the first `dispatch`. Each write site is named so you can grep the adapter if you doubt it.

  | Table | Column | Written by | If missing |
  |---|---|---|---|
  | `workflow_runs` | `version INT NOT NULL DEFAULT 1` | every run update (optimistic concurrency) | `run.transition` throws |
  | `workflow_runs` | `config JSONB NOT NULL DEFAULT '{}'`, `priority INT DEFAULT 5`, `metadata JSONB` | `createRun` | `run.create` throws |
  | `workflow_runs` | `totalCost FLOAT DEFAULT 0`, `totalTokens INT DEFAULT 0` | run completion | `run.transition` throws |
  | `workflow_stages` | `attempt INT NOT NULL DEFAULT 0` | `createStage` / `upsertStage` | first `job.execute` throws `Unknown argument attempt` |
  | `workflow_stages` | `version INT NOT NULL DEFAULT 1` | `upsertStage` (`version: { increment: 1 }`) and every guarded update | same |
  | `workflow_stages` | `suspendedState`, `resumeData JSONB`, `nextPollAt TIMESTAMP`, `pollInterval INT`, `maxWaitUntil TIMESTAMP`, `metrics`, `embeddingInfo JSONB`, `errorMessage TEXT` | stage updates | suspension / failure paths throw |
  | `workflow_annotations` | whole table (0.8) incl. `attempt`, `scope`, `scopeId`, `actorKind`, `actorId`, `actorVersion`, `key`, `value`, `payload`, `idempotencyKey` | `appendAnnotations` | `ctx.annotate` throws |
  | `job_queue` | `attempt INT DEFAULT 0`, `maxAttempts INT DEFAULT 3`, `workerId`, `lockedAt`, `startedAt`, `completedAt`, `nextPollAt TIMESTAMP`, `payload JSONB`, `lastError TEXT` | enqueue / dequeue / complete / fail | job claim throws |
  | `outbox_events` | `sequence INT`, `causationId TEXT`, `occurredAt TIMESTAMP`, `publishedAt`, `retryCount INT DEFAULT 0`, `dlqAt TIMESTAMP` | event append / `outbox.flush` | event-producing commands require these base fields |
  | `outbox_events` | `deliveryClaim TEXT NULL`, the three indexes below | `outbox.flush` / console outbox detail | `run.create` and `engine.stats` work. Flushes reject with `OUTBOX_SCHEMA_MISSING` (on SQLite also without the indexes) and the console needs the column |
  | `idempotency_keys` | `createdAt TIMESTAMP NOT NULL DEFAULT now()` | `acquireIdempotencyKey` writes it explicitly so an injected `Clock` is authoritative | **every** `dispatch` fails with `Unknown argument createdAt` |
  | `idempotency_keys` | `commandType TEXT`, `result JSONB` | same | same |

  ```sql
  -- The three that 1.0 consumers actually tripped on
  ALTER TABLE "workflow_stages"   ADD COLUMN IF NOT EXISTS "attempt"   INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE "workflow_stages"   ADD COLUMN IF NOT EXISTS "version"   INTEGER NOT NULL DEFAULT 1;
  ALTER TABLE "idempotency_keys"  ADD COLUMN IF NOT EXISTS "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
  ```

  The reliable check is a diff: `npx prisma migrate diff --from-schema-datasource prisma/schema.prisma --to-schema-datamodel node_modules/@bratsos/workflow-engine/prisma/schema.prisma --script` prints the SQL that separates your database from the package schema (on Prisma 7, which removed those flags: `npx prisma migrate diff --from-config-datasource --to-schema node_modules/@bratsos/workflow-engine/prisma/schema.prisma --script`) (ignore the differences on your own tables).

- [ ] **Optional: add `workflow_blobs` if you want Prisma as the blob store.** Stage outputs and every replay's `ctx.input` are read from the `BlobStore` by *every* process that executes or polls a run (workers, cron ticks, a web process that kicks orchestration), so the store must be shared — an `InMemoryBlobStore` in one of them fails the next process with `Blob "<key>" ... is not in the blob store`. `createPrismaBlobStore(prisma)` keeps blobs in this table so no object storage is needed; it requires only the `workflowBlob` delegate, so consumers on S3/R2 do not add it.

  ```prisma
  model WorkflowBlob {
    key       String   @id
    data      Json
    createdAt DateTime @default(now())
    updatedAt DateTime @updatedAt

    @@map("workflow_blobs")
  }
  ```

  ```sql
  CREATE TABLE IF NOT EXISTS "workflow_blobs" (
    "key"       TEXT PRIMARY KEY,
    "data"      JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL
  );
  ```

- [ ] **`job_queue` gains a unique on `(workflowRunId, stageId)`.** Required as of
  1.0.0-alpha.7. `run.rerunFrom` now retires the job rows of the stages it deletes,
  and every enqueue path replaces the row already queued for a pair instead of
  inserting another one — "one job row per stage per run" is the invariant those
  paths rely on, so declare it.

  ```prisma
  model JobQueue {
    // ...unchanged columns...
    @@unique([workflowRunId, stageId])
    @@index([status, priority(sort: Desc), createdAt]) // replaces @@index([status, priority]); see the index block below
    @@index([status, createdAt])
    @@index([nextPollAt])
    @@map("job_queue")
  }
  ```

  **Collapse duplicate rows first** — the index build fails while any pair has more
  than one row. Runs before the upgrade may have accumulated duplicates (each
  `run.rerunFrom` added one per rerun stage). Keep the newest row per pair; the
  older ones are finished history of stages that have since been re-enqueued, and
  nothing reads a job row by id except the host currently holding it:

  ```sql
  -- 1. Look before you delete.
  SELECT "workflowRunId", "stageId", count(*)
    FROM "job_queue" GROUP BY 1, 2 HAVING count(*) > 1;

  -- 2. Keep the newest row per (run, stage). Run it when no worker is mid-job:
  --    a RUNNING row that loses is a job whose host will fail its `complete`.
  DELETE FROM "job_queue" a
    USING "job_queue" b
   WHERE a."workflowRunId" = b."workflowRunId"
     AND a."stageId"       = b."stageId"
     AND (a."createdAt", a.id) < (b."createdAt", b.id);

  -- 3. Then add the constraint.
  CREATE UNIQUE INDEX IF NOT EXISTS "job_queue_workflowRunId_stageId_key"
    ON "job_queue" ("workflowRunId", "stageId");
  ```

  A deployment that cannot take the constraint yet still gets the fix: the enqueue
  paths are idempotent regardless, so reruns stop accumulating rows. What the
  constraint adds is the database refusing a duplicate a custom `JobQueue`
  implementation might still write.

- [ ] **Pin runs to a definition version** (optional, but it is what makes a
  rolling deploy safe — see the *Core Concepts → Definition Versioning* page
  of the documentation site for what the version identifies and how a fleet
  drains one).
  Two columns on `workflow_runs` (`definitionVersion`, nullable, and
  `redriveCount`, defaulting to 0), two indexes, and one new table.
  Entirely additive with no backfill, and **skipping it is a supported
  configuration**: the Prisma adapter detects that the generated client has no
  `workflowDefinition` delegate (it is optional on `EnginePrismaClient`),
  records no versions, leaves claiming unfiltered, and answers
  `run.listVersions` with `{ supported: false }`. A client that *does* carry
  the model is confirmed against the database once, lazily, through a
  catalogue read that answers "absent" instead of raising — so a database
  behind its client (`prisma generate` before `migrate deploy`, a rolling
  deploy that ships code first) still starts, with versioning off.
  `createPrismaWorkflowPersistence(prisma, { definitionVersioning: true | false })`
  skips both checks. Runs created before the migration keep a `NULL` version
  for life and stay claimable by every host whose registry holds their
  workflow.

  ```sql
  ALTER TABLE "workflow_runs" ADD COLUMN IF NOT EXISTS "definitionVersion" TEXT;
  ALTER TABLE "workflow_runs" ADD COLUMN IF NOT EXISTS "redriveCount" INTEGER NOT NULL DEFAULT 0;

  CREATE TABLE IF NOT EXISTS "workflow_definitions" (
    "workflowId"    TEXT NOT NULL,
    "version"       TEXT NOT NULL,
    "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "snapshot"      JSONB NOT NULL,
    "structureHash" TEXT NOT NULL,
    CONSTRAINT "workflow_definitions_pkey" PRIMARY KEY ("workflowId", "version")
  );
  ```

  There is deliberately no `workflow_definitions (workflowId)` index: the
  compound primary key already leads with that column, so a lookup by
  workflow alone plans identically with and without one (measured: 0.188 ms
  vs 0.187 ms at 20k rows). An earlier draft of this guide created one — if
  you already ran it, `DROP INDEX CONCURRENTLY IF EXISTS
  "workflow_definitions_workflowId_idx";` is safe.

  The indexes for these two columns are in the index block below, because
  they belong to one `workflow_runs` index set rather than to two separate
  migrations.

- [ ] **Replace the `workflow_runs` and `job_queue` index sets.** 1.0 changes
  which orderings are served, and the changes are stated together here
  because they touch the same two tables and should go in one migration.
  Nothing about them is required for correctness — every query still returns
  the same rows without them — but two of the three replaced indexes were
  serving sequential scans and sorts on the hottest paths in the system.

  Build them `CONCURRENTLY` on a live database (outside a transaction), then
  drop the ones they replace.

  ```sql
  -- workflow_runs: newest-first list orderings, keyset-paged on
  -- (createdAt, id). Replaces the bare (status) and (workflowId) indexes:
  -- a composite whose leading column is the same serves every lookup the
  -- single-column index served. Measured at 500k runs: "recent runs first"
  -- 244 ms -> 0.03 ms, filtered by status 94 ms -> 0.03 ms, filtered by
  -- workflow 60 ms -> 0.03 ms. The engine's own hot paths are unchanged
  -- within noise (claimNextPendingRun 18.4 -> 19.2 ms).
  CREATE INDEX CONCURRENTLY IF NOT EXISTS "workflow_runs_createdAt_id_idx"
    ON "workflow_runs" ("createdAt" DESC, "id" DESC);
  CREATE INDEX CONCURRENTLY IF NOT EXISTS "workflow_runs_status_createdAt_id_idx"
    ON "workflow_runs" ("status", "createdAt" DESC, "id" DESC);
  CREATE INDEX CONCURRENTLY IF NOT EXISTS "workflow_runs_workflowId_createdAt_id_idx"
    ON "workflow_runs" ("workflowId", "createdAt" DESC, "id" DESC);
  DROP INDEX CONCURRENTLY IF EXISTS "workflow_runs_status_idx";
  DROP INDEX CONCURRENTLY IF EXISTS "workflow_runs_workflowId_idx";

  -- workflow_runs: the claim. `claimNextPendingRun` issues the same shape
  -- against workflow_runs that the dequeue issues against job_queue --
  -- status = 'PENDING' ORDER BY priority DESC, "createdAt" ASC LIMIT 1 --
  -- maxClaimsPerTick times per tick per host, and none of the indexes
  -- above can serve it, because priority is in none of them. Measured on
  -- Postgres 16 at 300k runs / 60k pending: 11.8-15.1 ms before (top-N
  -- sort over every PENDING row), 0.008-0.022 ms after, for 9 MB.
  CREATE INDEX CONCURRENTLY IF NOT EXISTS "workflow_runs_status_priority_createdAt_idx"
    ON "workflow_runs" ("status", "priority" DESC, "createdAt" ASC);

  -- workflow_runs: definition versioning. Only if you took the columns
  -- above. The first serves a lookup narrowed to one version with no
  -- workflow; the second is the narrow stand-in for the (status) index the
  -- list orderings replaced (a status count runs index-only off it) and
  -- narrows the version-filtered claim. Neither covers `run.listVersions`,
  -- which plans a parallel sequential scan regardless: it passes no status
  -- filter, and its aggregate asks for a MIN("createdAt") no index here
  -- carries.
  CREATE INDEX CONCURRENTLY IF NOT EXISTS "workflow_runs_definitionVersion_idx"
    ON "workflow_runs" ("definitionVersion");
  CREATE INDEX CONCURRENTLY IF NOT EXISTS "workflow_runs_status_workflowId_definitionVersion_idx"
    ON "workflow_runs" ("status", "workflowId", "definitionVersion");

  -- job_queue: cover the dequeue's createdAt tiebreak. Replaces
  -- (status, priority), whose leading columns it repeats. Without the
  -- tiebreak in the index a deep queue reads and sorts every PENDING row on
  -- every claim: measured on Postgres 16 with flat priorities, 0.55 ms at
  -- 1,000 ready rows and 26.7 ms at 50,000; with it, 0.03 ms and 0.04 ms,
  -- flat with depth. It is the one index change here that costs real space —
  -- (status, priority) is nearly all duplicate keys, which btree
  -- deduplication collapses, and adding createdAt makes every key distinct:
  -- 1 MB -> 10 MB at 150,000 rows.
  CREATE INDEX CONCURRENTLY IF NOT EXISTS "job_queue_status_priority_createdAt_idx"
    ON "job_queue" ("status", "priority" DESC, "createdAt" ASC);
  DROP INDEX CONCURRENTLY IF EXISTS "job_queue_status_priority_idx";

  -- job_queue: queue health reads MIN("createdAt") within a status, and
  -- completed rows are retained rather than deleted.
  CREATE INDEX CONCURRENTLY IF NOT EXISTS "job_queue_status_createdAt_idx"
    ON "job_queue" ("status", "createdAt");

  -- outbox_events: the dead-letter page. Prisma cannot express a partial
  -- index; if you write migrations by hand, prefer one — dead letters are a
  -- small subset of unpublished rows.
  --   CREATE INDEX CONCURRENTLY ... ON "outbox_events" ("dlqAt") WHERE "dlqAt" IS NOT NULL;
  CREATE INDEX CONCURRENTLY IF NOT EXISTS "outbox_events_dlqAt_idx"
    ON "outbox_events" ("dlqAt");
  ```

### Tenant attribution and SQL enqueue

Add the nullable attribution columns and indexes before deploying clients
that write them. Existing rows keep NULL in the new columns. Keep
`ai_calls.prompt` and `ai_calls.response` required. Store an empty string when
text is omitted or expires. `labels` has its own column alongside metadata.

#### PostgreSQL column and index upgrade

The additive upgrade is rolling-safe for old clients with compatible prepared
statements. The online procedure can briefly delay traffic on the table being
altered. It commits each table's metadata-only `ALTER TABLE` before touching
the next table and builds indexes concurrently so ordinary reads and writes
can continue. PostgreSQL waits at most 500 ms per lock attempt for each
`ALTER TABLE`. A long transaction on one table can cause that step to fail
with SQLSTATE `55P03`.

On Prisma 6 with the default statement cache, **stop old hosts first** and
close their cached connections. Keep them stopped across the schema change.
For a rolling upgrade, roll those hosts onto `statement_cache_size=0` before
running any DDL. An old claim uses `RETURNING *`. If it warms a cached plan
before the column change, subsequent claims on that connection fail with
`0A000` until it is recycled. Prisma 7 and Prisma 8 use fresh statements for
this claim.

Run the shipped PostgreSQL upgrade against the engine schema. Each `ALTER`
has its own transaction. The six `CREATE INDEX CONCURRENTLY` statements follow
outside any transaction block.

psql takes a libpq connection string, not the application's Prisma URL.
Remove Prisma-only parameters such as `schema`, `connection_limit` and
`statement_cache_size`. For a non-public engine schema, select it with
`PGOPTIONS='-c search_path=<schema>'` on both psql commands in this section.

```bash
psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 \
  -f node_modules/@bratsos/workflow-engine/sql/tenant-attribution.sql
```

Use the same transaction boundaries if you incorporate these statements into
your own migration. Configure your migration runner to stop on errors and
allow concurrent index builds to run outside transaction blocks.

If the command exits on `55P03`, let the blocking transaction finish and
rerun the script. Completed table steps and indexes are reusable. Before
returning success, the script checks that each of the six names is a valid
index on the planned table. A failed or canceled concurrent build leaves an
invalid index under the name. If the script reports an index, inspect it with
`\d` in psql,
drop it with `DROP INDEX CONCURRENTLY` outside a transaction, then rerun. Deploy the
updated schema or contract and clients after the script succeeds and the
optional enqueue upgrade below is complete.

#### SQLite column and index upgrade

Use the updated schema or contract for your Prisma major. For hand-written
SQL, add each column in its own statement. Prisma 6 and 7 use `JSONB` for
labels and `DATETIME` for `textExpiresAt`. For Prisma 8 substitute `TEXT` for
both types.

```sql
ALTER TABLE "workflow_runs" ADD COLUMN "tenantId" TEXT;
ALTER TABLE "workflow_runs" ADD COLUMN "labels" JSONB;
ALTER TABLE "ai_calls" ADD COLUMN "workflowRunId" TEXT;
ALTER TABLE "ai_calls" ADD COLUMN "tenantId" TEXT;
ALTER TABLE "ai_calls" ADD COLUMN "labels" JSONB;
ALTER TABLE "ai_calls" ADD COLUMN "textExpiresAt" DATETIME;
ALTER TABLE "idempotency_keys" ADD COLUMN "workflowRunId" TEXT;
```

Create the six indexes below in your SQLite migration. The Prisma 8 contract
emits an ascending tenant index. A reverse scan serves descending order
within one tenant.

```sql
CREATE INDEX IF NOT EXISTS "workflow_runs_tenantId_createdAt_id_idx"
  ON "workflow_runs" ("tenantId", "createdAt" DESC, "id" DESC);
CREATE INDEX IF NOT EXISTS "ai_calls_tenantId_createdAt_idx"
  ON "ai_calls" ("tenantId", "createdAt");
CREATE INDEX IF NOT EXISTS "ai_calls_workflowRunId_idx" ON "ai_calls" ("workflowRunId");
CREATE INDEX IF NOT EXISTS "ai_calls_textExpiresAt_idx" ON "ai_calls" ("textExpiresAt");
CREATE INDEX IF NOT EXISTS "idempotency_keys_workflowRunId_idx"
  ON "idempotency_keys" ("workflowRunId");
CREATE INDEX IF NOT EXISTS "idempotency_keys_createdAt_idx" ON "idempotency_keys" ("createdAt");
```

#### Upgrade the PostgreSQL enqueue function

After the column and index script succeeds, apply the new `sql/enqueue.sql`.
The same file installs and upgrades, and it drops nothing:

- It creates `workflow_engine_enqueue(..., p_tenant_id text, p_labels jsonb)`,
  which takes all nine arguments and has no defaults.
- It then replaces the released seven-argument function in place with
  `CREATE OR REPLACE`. Its signature, defaults, owner, ACL and the views or
  wrappers that depend on it stay as they are. Its body stores NULL tenant
  and labels and does not call the new overload.

No call can match both overloads, so existing calls keep resolving. Table
names resolve through the caller's search path as before, also for triggers
on the engine tables and after a schema rename. If a statement fails, the
seven-argument function still works, released or replaced, and with
`--single-transaction` nothing changes.

The new overload gets the database's default function ACL, which lets
`PUBLIC` execute it. Existing callers of the seven-argument function keep
their `EXECUTE` access; only roles that pass a tenant or labels need it on the
new overload. If you restricted the released function, restrict the new one
in the same transaction:

```bash
# Omit both -c lines to keep the default ACL.
psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 --single-transaction \
  -f node_modules/@bratsos/workflow-engine/sql/enqueue.sql \
  -c 'REVOKE EXECUTE ON FUNCTION workflow_engine_enqueue(text, text, text, jsonb, jsonb, integer, text, text, jsonb) FROM PUBLIC' \
  -c 'GRANT EXECUTE ON FUNCTION workflow_engine_enqueue(text, text, text, jsonb, jsonb, integer, text, text, jsonb) TO app_role'
```

A role that writes the engine tables through column-level grants, rather
than table-wide `INSERT` and `UPDATE`, also needs two column grants after the
column and index script and before `sql/enqueue.sql` or the new engine is
deployed.
Both SQL signatures write these columns, even with NULL tenant and labels.
The engine writes `workflowRunId` whenever it completes an idempotency key,
and `tenantId` and `labels` when `run.create` receives them:

```sql
GRANT INSERT ("tenantId", labels) ON workflow_runs TO app_role;
GRANT UPDATE ("workflowRunId") ON idempotency_keys TO app_role;
```

Without them, replays still succeed but a new key fails with SQLSTATE
`42501`. Table-wide grants need nothing.

Without `ON_ERROR_STOP`, psql prints an error but exits 0, so automation
cannot see the failure. `sql/enqueue.sql` requires PostgreSQL 13 or newer.

Custom persistence adapters receive the run ID as the fourth argument to
`completeIdempotencyKey(key, commandType, result, workflowRunId)`. The argument
is `null` when the caller has no run ID. Existing keys need no backfill. To
identify older keys that lack the column value, use `result->>'workflowRunId'`
where present. For older `job.execute` keys, the original job ID binds a
`job:<jobId>:attempt:` prefix while the job rows still exist.

#### Retention and erasure schema

Put these changes in the same release's migration as the column and index
upgrade above. Prisma's generated migration from the updated schema or
contract creates the columns and the four plain indexes; for hand-written
SQL, the indexes are:

```sql
CREATE INDEX IF NOT EXISTS "idempotency_keys_workflowRunId_commandType_idx"
  ON "idempotency_keys" ("workflowRunId", "commandType");
CREATE INDEX IF NOT EXISTS "workflow_artifacts_workflowStageId_idx"
  ON "workflow_artifacts" ("workflowStageId");
CREATE INDEX IF NOT EXISTS "workflow_annotations_workflowStageRecordId_idx"
  ON "workflow_annotations" ("workflowStageRecordId");
CREATE INDEX IF NOT EXISTS "ai_calls_createdAt_idx" ON "ai_calls" ("createdAt");
```

Include `sql/retention-indexes.postgresql.sql` or
`sql/retention-indexes.sqlite.sql` from the engine package in the same
migration. These indexes serve literal AI topic and idempotency key prefixes,
the legacy idempotency result's JSON run ID and the stage records that
`run.redrive` archived. Keep them in the migration SQL since the Prisma schemas
cannot express their expressions and collations. Targeted erasure on SQLite
requires them.

The indexes are rolling-safe. Upgrade or stop all older hosts before using
targeted `run.purge` with run IDs or a tenant ID: older hosts do not register
the stage executions and cancellation sweeps that erasure waits for, so their
writes can land after a run was reported erased.

For table retention, also add this column to the same migration:

| Table | Column | PostgreSQL | SQLite |
| --- | --- | --- | --- |
| `outbox_events` | `pruneTerminal` | `BOOLEAN NOT NULL DEFAULT FALSE` | `INTEGER NOT NULL DEFAULT 0` |

Run the matching `sql/retention-eligibility.postgresql.sql` or
`sql/retention-eligibility.sqlite.sql` after adding the column. The script
installs the outbox triggers, backfills existing events and creates the
eligible-only pruning indexes, and a partial index on `idempotency_keys` for
run writer registrations (`idempotency_keys_writer_prune_idx`). Include these
statements alongside Prisma's generated migration. The triggers track event
publication, dead letters, and run transitions and deletion. The indexes
exclude live or orphaned events, dead letters, unpublished events and
in-progress idempotency keys. A run status change between live and terminal
updates that run's published events, so its cost grows with the run's
published history. On SQLite, pruning reads each table's indexes from the table itself and
names the primary-key index and the `ai_calls` age indexes (`createdAt`,
`textExpiresAt`) it finds, so that statistics taken on a small table cannot
turn a prune into a table scan; a table without one is pruned with a plain
statement.

Runs created and redriven before this release need nothing more: erasure finds
the stage records a redrive archived through its `run.supersededAttempt`
annotations. Stage executions, suspended-stage polls, signal senders and
cancellation sweeps register as writers of their run in `idempotency_keys`
(command type `run.write`); erasure reports `writers` while one is registered
and refreshed. A `step.signal` for a run that has ended registers as
well and behaves as it did; only one that finds the run marked for erasure
(`run.purge` writes an idempotency key of command type `run.erase` before it
looks for writers) writes nothing. A registration whose process stopped refreshing it stops counting
after one minute (`RUN_WRITE_LEASE_MS`), and a writer that finds its lease
lapsed does not revive it. `engine.prune` with `idempotencyKeys` removes
registrations nobody has refreshed for ten leases, so those a crashed host
left do not accumulate; it needs `idempotency_keys_writer_prune_idx` and
skips them without it. A custom asynchronous `AICallLogger` that buffers calls must return, from
`logCall`, a promise that settles once the call is stored: erasure waits for
that promise, not for the buffer.

Custom persistence adapters receive the run ID in
`acquireIdempotencyKey`'s `options.workflowRunId` and the acquisition time as
the optional last argument of `completeIdempotencyKey` and
`releaseIdempotencyKey`. When it is given, complete or delete only the
in-progress row whose `createdAt` equals it. `completeIdempotencyKey` must not
create a row: a key erased with its run stays erased.

### Custom port implementations

- [ ] **Custom `JobQueue` / `JobTransport` implementation?** The port changed in
  several places; `jobQueueConformanceSuite` covers all of them.
  - `enqueue` is gone from the port — the kernel calls `enqueueParallel([job])`
    (the built-in queues keep `enqueue` as a plain method).
  - `enqueueParallel` must be idempotent on `(workflowRunId, stageId)`: replace
    any row already queued for a pair, resetting `attempt`, `status`,
    `workerId`, `lockedAt`, `lastError` and `nextPollAt`.
  - `deleteByRunAndStages(workflowRunId, stageIds)` is a new required method
    (delete every row for those stages of that run, any status, return the
    count).
  - `dequeue(options?)` returns `startedAt` — the attempt stamp of that claim
    — and takes `DequeueOptions.serves`, naming the definition versions the
    calling host presents: filter on the payload's `_definitionVersion` /
    `_workflowId` if you can, and ignore it if your transport cannot select
    (the kernel's version-ghost handling is the backstop).
  - `complete`, `fail` and `suspend` return `"acknowledged" | "superseded"`
    (`JobAckOutcome`) instead of `void` and take an optional trailing
    `JobAckFence` (`{ startedAt, attempt }`); a fenced write must be
    conditioned on the job still being the RUNNING attempt the fence
    describes, and a fenced call naming a job row that no longer exists must
    return `"superseded"` rather than throw (unfenced, it stays an error).
    A decorator around a transport must forward the fence explicitly —
    dropping the optional parameter still typechecks and silently turns every
    fenced acknowledgement back into an unconditional write.
    `fail(jobId, error, true)` must re-queue the job with backoff: the kernel
    has already recorded the stage as `PENDING` on that promise.
  - Optional new methods: `defer(jobId, nextPollAt, reason, fence?)` puts a
    claimed job back `PENDING` *without* spending its attempt, which is how a
    host declines a job pinned to a version it does not serve (without it the
    host falls back to `fail(..., true)` and a deploy exhausts the retry
    budget); `expireRunawayJobs(absoluteTimeoutMs)` is the absolute lease
    tier (`LEASE_ABSOLUTE_CAP`; without it there is no absolute tier);
    `adoptWorkerId(workerId)` lets a host stamp its own id on the rows; and
    the readonly property `fairnessGroupBy` is what `createSpillingJobTransport`
    reads to keep a spilled payload's fairness group.

- [ ] **Custom `WorkflowPersistence` implementation?** Beyond the removals in
  the table below, `PersistenceCore` gained required methods, all in
  `persistenceConformanceSuite`:
  - `claimOutboxDelivery`, `completeOutboxDelivery` and `failOutboxDelivery` (and the optional `isOutboxDeliveryClaimActive`, which the kernel never calls) — claims have a separate owner and expiry; publication is recorded only after sink acceptance.
  - `supportsDefinitionVersioning()`, `insertDefinitionIfAbsent(input)`,
    `getDefinition(workflowId, version)` and
    `countRunsByDefinitionVersion(filter?)`; an adapter without the schema
    returns `false` / `null` / `null` / `[]`. `ensureDefinitionVersioningDetected()`
    is optional.
  - `listRunsForPurge(cutoff, statuses, limit)` and
    `deleteRun(id, cutoff, statuses)` for `run.purge`. `deleteRun` rechecks
    `cutoff` and `statuses` in the delete itself and returns whether it deleted.
  - `claimNextPendingRun({ now?, serves? })`: a run is claimable only when it is
    pinned to one of the `serves` pairs, or unpinned *and* one of the pairs
    names its workflow; an empty `serves` claims nothing; omitted, it is the
    pre-1.0 predicate. An adapter with no `definitionVersion` column may
    ignore it.
  - `getSuspendedStages(beforeDate, { limit?, serves?, includeSettlements? })` must return rows
    oldest `nextPollAt` first, capped at `limit`, and filtered by `serves`
    (ignorable on a schema with no `definitionVersion` column). With
    `includeSettlements: true`, include `COMPLETED` and `FAILED` stages
    with a due `nextPollAt` so polling can retry job settlement.
  - `WorkflowRunRecord` gains `definitionVersion: string | null` and
    `redriveCount: number`; `CreateRunInput`/`UpdateRunInput` carry
    `definitionVersion`, `UpdateRunInput` carries `redriveCount`, and
    `UpdateStageInput.completedAt` / `duration` / `errorMessage` accept `null`
    so `run.redrive` can reopen a stage record in place. `RunCreateResult`
    gains `definitionVersion`.

- [ ] **Custom `StepLedger` implementation?** `StepRecordExpectation.attempt` is
  now optional and `compareAndSet` must match any attempt when it is omitted;
  `clearExcept(stageRecordId, keepStepIds)` is optional (without it the kernel
  falls back to `clear` and logs the external keys it drops); and
  `StepRecordPatch` has one rule every field follows: a key that is absent, or
  present holding `undefined`, leaves the column alone, and every other value
  — **`null` included** — is written. A ledger that skipped nullish values
  records "completed with no value" as "unchanged" and replays the previous
  attempt's result forever. `StepRecord` gains `externalKey`. The new
  `stepLedgerConformanceSuite(name, factory, api)` holds a ledger to all of it.

- [ ] **Running the kernel inside one Prisma transaction per tick?** The 1.0 adapters no longer rely on a caught unique violation for any insert-if-absent on Postgres (`PrismaStepLedger.claim`, `acquireIdempotencyKey` use `createMany({ skipDuplicates: true })` + read-back), so a replay that re-claims completed steps no longer aborts the enclosing transaction with `25P02`. Pass `createPrismaStepLedger(prisma, { databaseType: "sqlite" })` on SQLite, which has no `skipDuplicates`. The run claim binds a JS `Date` (UTC) instead of `NOW()`; pass `now: () => clock.now()` to `createPrismaWorkflowPersistence` to make it follow your clock. The Postgres job lease (`lockedAt`, `startedAt`, the stale-lease sweep) runs on the *database* clock, so `PrismaJobQueueOptions.now` no longer affects it — it still drives the SQLite dequeue and the timestamps written outside the raw statement.

- [ ] **If your Prisma `Status` enum has another name**, pass it: `createPrismaWorkflowPersistence(prisma, { statusEnumName: "WorkflowStatus" })`. The raw-SQL claim paths cast with `::"Status"` (since 0.11) and fail with `42704 type "Status" does not exist` otherwise. See `05-persistence-setup.md`.

- [ ] **Check the delegates on your `PrismaClient`.** `EnginePrismaClient` requires `workflowRun`, `workflowStage`, `workflowStep`, `workflowLog`, `workflowArtifact`, `workflowAnnotation`, `aICall`, `jobQueue`, `outboxEvent` and `idempotencyKey`; `workflowDefinition` is optional (its absence turns definition versioning off), and `$transaction`, `$queryRaw`, `$queryRawUnsafe` and `$executeRaw` are optional with guarded fallbacks. A wall of `PrismaClient is not assignable to EnginePrismaClient` errors means one of the required delegates is missing from your schema (in 1.0 almost always `workflowStep`) — add the model and regenerate the client. `createPrismaBlobStore` needs only `workflowBlob`.

## Required code changes

- [ ] **Remove the APIs that were deprecated for 1.0.**

  | Removed | Use instead |
  |---|---|
  | `ModelStatsTracker`, `ModelWithRecorder` | `AICallLogger` rows (`createPrismaAICallLogger`) |
  | `getModelById`, `getRegisteredModel`, `listRegisteredModels`, `getDefaultModel`, `printAvailableModels` | `getModel(key)`, `registerModels()` and your own registry listing |
  | `modelSupportsBatch(key)` | `getModel(key).supportsAsyncBatch` |
  | `recordCall(modelKey, prompt, response, tokens, options)` (positional) | the object form `recordCall({ ... })` |
  | `requireStageOutput` | `ctx.require("stageId")` |
  | `SuspendedStateSchema.apiKey` | `BatchOptions.apiKey` |
  | `defineWorkflow({ output })` | nothing — the workflow output is always the last stage's output schema (or the merged object of the last parallel group) |
  | `AnthropicBatchProvider` & co. (already gone in 0.13) | `ai.batch()` / `ctx.step.ai.map` |
  | `defineAsyncBatchStage` (root and `/client` exports) | `defineStage` with `ctx.step.waitFor` / `ctx.step.ai.map`; the async-batch mode itself (`defineStage({ mode: "async-batch", checkCompletion })`) still runs for hosts that keep it |
  | `KernelConfig.scheduler`, `NoopScheduler` | nothing — the kernel never scheduled anything; drop the option |
  | `RunCreateCommand.metadata` | `annotations` on `run.create` |
  | `ArtifactPersistence` (`saveArtifact`, `loadArtifact`, `hasArtifact`, `deleteArtifact`, `listArtifacts`, `getStageIdForArtifact`, `saveStageOutput`, `loadStageOutput`) on the `WorkflowPersistence` port | the `BlobStore` port (`createPrismaBlobStore`); the built-in adapters keep the methods as plain class methods |
  | `getRunsByStatus`, `claimPendingRun`, `updateStageByRunAndStageId`, `getStageById`, `getFirstSuspendedStageReadyToResume`, `getFirstFailedStage`, `getLastCompletedStage`, `getLastCompletedStageBefore` on the port | `getStagesByRun(runId, { status, orderBy })`, `getStage(runId, stageId)`, `updateStage(stage.id, ...)`; the built-in adapters keep the methods |
  | `JobQueue.enqueue` / `JobTransport.enqueue` on the ports | `enqueueParallel([job])`; the built-in queues keep `enqueue` |
  | Conformance suites `persistenceConformanceSuite(name, factory)` | take a third argument `{ describe, it, expect, beforeEach }` (the `testing` entry no longer imports vitest) |

- [ ] **Provide `step`, `ai`, `aiLogger` and `abortSignal` on hand-built stage contexts.** `StageContext.step` is required (it was optional), `StageContext.abortSignal: AbortSignal` is new and required, and `CheckCompletionContext` gained `step`, `ai` and `aiLogger` too. Code that builds a context by hand must supply them; a stage that never touches them still runs (the wrapper only probes `ctx.step` when present).

  ```typescript
  // Before (0.13)
  const ctx = { input, config, require, log, storage, ... };
  await stage.execute(ctx);

  // After (1.0) — ledger-less step API + mock AI for tests
  import { neverAbortingSignal } from "@bratsos/workflow-engine";
  import { createStepApi } from "@bratsos/workflow-engine/kernel";
  import { createMockAIHelperFactory, InMemoryAICallLogger } from "@bratsos/workflow-engine/testing";

  const aiLogger = new InMemoryAICallLogger();
  const ctx = {
    input, config, require, log, storage, ...,
    step: createStepApi({ clock: { now: () => new Date() } }), // throws StepLedgerNotConfiguredError if used
    ai: createMockAIHelperFactory()("test", aiLogger),
    aiLogger,
    abortSignal: neverAbortingSignal(), // or new AbortController().signal
  };
  ```

- [ ] **`ctx.step.run` bodies receive a `StepRunContext`.** `ctx.step.run(id, fn)` now calls `fn({ stepId, externalKey, attempt, isReclaim, heartbeat, abortSignal })`. Zero-argument bodies are unaffected. While you are there: `lease` and `retryDelay` are the canonical `StepRunOptions` names (milliseconds or a duration string); `leaseMs` and `retryDelayMs` still work as deprecated aliases and lose to the canonical name when both are given.

  Prefer `createTestHarness()` from `@bratsos/workflow-engine/testing`, which builds all of it.

- [ ] **Wire the kernel services.** `createKernel` takes `stepLedger` (for `ctx.step`) and `services` (for `ctx.ai`). Without `services.aiLogger`, `ctx.ai` throws `AIServicesNotConfiguredError`; without `stepLedger`, `ctx.step` throws `StepLedgerNotConfiguredError`.

  ```typescript
  // Before (0.13)
  const kernel = createKernel({ persistence, jobTransport, blobStore, eventSink, clock, registry });

  // After (1.0)
  import { createPrismaAICallLogger, createPrismaStepLedger } from "@bratsos/workflow-engine";

  const kernel = createKernel({
    persistence, jobTransport, blobStore, eventSink, clock, registry,
    stepLedger: createPrismaStepLedger(prisma),
    services: {
      aiLogger: createPrismaAICallLogger(prisma),
      // ai: (topic, logger, logContext, providerResolver, options) =>
      //   createAIHelper(topic, logger, logContext, providerResolver, { ...options, adapter }),
    },
  });
  ```

  `services.ai` is optional; the default builds `createAIHelper` per stage. Pass your own factory to install an `AIAdapter` (local CLI, proxy, recorded fixtures) — it is the *only* way an adapter reaches `ctx.step.ai`. `createKernel` also takes `spillThresholdBytes` (default 64 KiB) for the step-result claim check; see `15-large-payloads.md`.

- [ ] **Update the AI SDK peer range.** 1.0 targets AI SDK 7. `ai@^7`, `@ai-sdk/google@^4` and `@openrouter/ai-sdk-provider@^3` are regular dependencies of the package, so they come with it — but any `ai` your own code imports (an `Output.object(...)`, a hand-built `streamText`) must be on `^7` too, or two copies coexist. The optional peers are `@ai-sdk/anthropic@>=4.0.46` / `@ai-sdk/openai@>=4.0.53` for native batching, and `zod@^4.1.12` / `@prisma/client@>=6` are unchanged. Automatic fallback without the vendor SDK carries the client's batch options. With a provider policy, fallback requires an unset `baseURL` or the canonical OpenRouter base URL.

  ```bash
  npm install ai@^7 zod@^4
  # optional, only what you batch against
  npm install @ai-sdk/anthropic @ai-sdk/openai
  ```

- [ ] **Use the builder's inference instead of hand-typed contexts.** `defineWorkflow(id, { input }).stage(id, definition)` infers the context from earlier stages so `ctx.require()` is typed and `dependencies` only accepts earlier ids. `.stage(prebuilt)` / `.pipe(prebuilt)` now check a prebuilt stage's declared context against the accumulated one; a stage that requires a key no earlier stage produces no longer compiles (the parameter resolves to `{ __error: "stage requires context keys not produced by earlier stages: ..." }`). The object form `defineWorkflow({ id, name, description, input })` still works.

  ```typescript
  // Before (0.13) — context typed by hand on every stage
  const summarize = defineStage<typeof In, typeof Out, typeof Cfg, { extract: ExtractOut }>({ ... });
  export const wf = defineWorkflow({ id: "docs", input: In, output: Out }).pipe(extract).pipe(summarize).build();

  // After (1.0) — inferred; `output` is gone (it is the last stage's output)
  export const wf = defineWorkflow("docs", { input: In })
    .stage("extract", { schemas: { input: In, output: ExtractOut, config: Cfg }, async execute(ctx) { ... } })
    .stage("summarize", {
      dependencies: ["extract"],
      schemas: { input: "none", output: Out, config: Cfg },
      async execute(ctx) {
        const { text } = ctx.require("extract"); // typed
        ...
      },
    })
    .build();
  type Ctx = InferWorkflowContext<typeof wf>;
  ```

- [ ] **`ModelKey` is open.** The zod schema is `z.string().min(1)`; a `schemas.config` field typed with it no longer rejects an unregistered key at `run.create`. Validation happens at `getModel()` — register every model you reference.

- [ ] **`ctx.log` / `ctx.onLog` return `void`.** Awaiting them still compiles; drop the `await` when you touch the code.

- [ ] **`AIStreamResult.rawResult` is `undefined`** when the stream came from an adapter. Guard before reading it.

## `defineAsyncBatchStage` → `ctx.step.ai.map`

`defineAsyncBatchStage` is not exported any more. The replacement is one linear stage body; the full before/after is in `12-durable-steps.md` ("Migrating an async-batch stage to steps").

```typescript
// Before (0.13)
const extract = defineAsyncBatchStage({
  id: "extract", name: "Extract", schemas: { input: In, output: Out, config: Cfg },
  async execute(ctx) {
    const batch = ctx.ai.batch("gemini-2.5-flash");
    const handle = await batch.submit(buildRequests(ctx.input.docs));
    return { suspended: true, state: { batchId: handle.id, metadata: { batchRefs: handle.refs, requestIds } } };
  },
  async checkCompletion(state, ctx) {
    const batch = ctx.ai.batch("gemini-2.5-flash");
    const status = await batch.getStatus(state.batchId, state.metadata);
    if (status.status !== "completed") return { ready: false };
    const results = await batch.getResults(state.batchId, { ...state.metadata, schemas });
    return { ready: true, output: toOutput(results) };
  },
});

// After (1.0)
const extract = defineStage({
  id: "extract", name: "Extract", schemas: { input: In, output: Out, config: Cfg },
  async execute(ctx) {
    const results = await ctx.step.ai.map("extract", ctx.input.docs, {
      model: "gemini-2.5-flash",
      schema: SectionSchema,
      prompt: (doc) => `Extract sections from:\n${doc.text}`,
      itemId: (doc) => doc.id,
      policy: "auto",                                  // batch at >= 20 items, realtime below
      batch: { pollEvery: "60s", timeout: "24h", onExpiry: "fail" },
      realtime: { concurrency: 8, retries: 2, retryDelayMs: "10s" },
      repair: { attempts: 1 },
    });
    return { output: toOutput(results) };
  },
});
```

What changes: submit happens exactly once (`${id}:submit` step), polling is a stored-deadline wait (`${id}:poll`), results are validated against `schema` and repaired realtime when they do not validate, a crash between submit and collect resumes from the ledger, and small inputs run realtime through the same code. Every `ctx.step.*` id must be stable and unique within the stage; derive `itemId` from data.

## Adapters

- `AdapterObjectResponse.object` is the structured result (the 1.0.0-alpha.0 engine read `output`; fixed in alpha.1). Do not return both.
- For `ctx.step.ai.map` repair to quote a bad answer back to the model, throw `NoObjectGeneratedError` (re-exported from `@bratsos/workflow-engine`) with `text` set to the raw output and `cause` set to the parse/validation error. Any error carrying `text` (or `cause.text`), a `ZodError`, or a JSON `SyntaxError` is also treated as repairable. Any other thrown error consumes a `realtime.retries` attempt.
- `AdapterTextResponse.object` is what `generateText` with `output` returns as `result.output`.

## Behaviour changes

- **Retry classification: `NonRetryableError` and `retryIf` (1.0.0-alpha.21).** Throw `NonRetryableError` (root export; `isNonRetryableError` detects it across bundled copies) from a stage or a `ctx.step.run` body to fail the stage attempt terminally: no step `retries`, no job retry, no poll retry. `StepRunOptions.retryIf(error, { attempt })` returning `false` does the same for one step, and the stage receives a `NonRetryableError` with the original as `cause`. The predicate must answer synchronously: anything but `false`, a throw included, leaves the error retryable (a throw or an object return is logged). A predicate that returns or throws a Promise breaks its synchronous contract: the engine attaches a no-op handler to a plain native Promise where it can, and if that Promise rejects and the engine cannot attach a handler, the rejection is the application's own unhandled rejection, as anywhere else in stage code. A step still retries every other error, a Zod error included. The stage classifier is the one earlier releases used (a Zod error of the engine's own zod, a duplicate step key) plus the `NonRetryableError` brand, read as one symbol property after those checks; an expired wait or an `onReclaim: "fail"` refusal carries that brand as the execution that records it throws it, so those no longer spend job attempts on the same error. No name, message or other field of a thrown value is read to classify it, and error texts are recorded as before. The classifier sees errors thrown in the current execution only. The step ledger stores what it stored before (the message), so a replayed step failure is classified as on main: a plain `Error` with the stored message, or `StepTimeoutError` for that step's timeout text, with no brand. A `NonRetryableError` or `retryIf` refusal is therefore terminal only in the execution that threw it, and a replay with `retries` left runs the body again. Stage retries re-open failed steps and `onReclaim` decides takeovers exactly as before. A terminal verdict ends the job exactly as an exhausted final attempt does: the stage is FAILED, the queue row fails, the run fails, and a later delivery of the job (a lost acknowledgement, a lost lease) meets that FAILED stage and, on a host that includes #83's FAILED-stage handling, ends as a dead job with the stored error, exactly as after an exhausted final attempt: no step runs again and no retry is scheduled. A throwing `checkCompletion` is unchanged: it fails the stage and the run on that poll. A host acknowledges a job as dead for a `JobTargetMissingError` (now exported, with `isJobTargetMissingError`) only when its `target` is that job's workflow, stage and run; the branded missing target of another dispatch made inside the job is rethrown. Any other thrown value goes through the matcher earlier releases used, unchanged: the message of an `Error` (any other value converted to a string) must start with one of the missing-target texts. That covers the plain `Error` an earlier release's kernel throws and an error decoded from JSON, and also any other error with that name and text, since the stage text does not name the run and the run text names neither the workflow nor the stage. An error with any other name or text, or the branded missing target of another dispatch made inside the job, is rethrown. Remote workers report an optional `retryable: false` for a `NonRetryableError`, and a `defineRemoteStage` proxy now fails the stage on a failed outcome with an empty message (as `remote activity failed`), which used to leave it suspended; see 11-remote-activity-workers.md. Rolling deploys: A terminal verdict (`NonRetryableError`, a `retryIf` that returns `false`) is honoured once every host runs this release. A host still on an earlier release that recovers a job (after a lost lease or a lost failure acknowledgement) runs it as that release does: it can run the body again, even past the queue's budget, which limits only the decision to schedule another retry, so completed steps and provider calls can run again. The dead-job end after a lost acknowledgement requires the recovering host to include the FAILED-stage handling of #83 (on main since e44baf8), not this release. No schema change.
- **Prisma client views and outbox batch writes (1.0.0-alpha.21).** A root facade without `$transaction` flushes committed outbox rows. The generated Prisma 6 and 7 transaction clients and the Prisma 8 bridge identify caller-owned views automatically. A wrapper that strips the transaction marker must pass `transactionView: true` to `createPrismaWorkflowPersistence` or forward `$inTransaction: true` on the transaction view. Sinks stay deferred there. `skipInteractiveTransactions: true` also skips the interactive claim on PostgreSQL. The single-statement claim still uses row locks. It runs without the transaction-local planner settings, so its plan follows the PostgreSQL statistics: with statistics taken after the outbox drained, a claim can read the whole live set once per run it visits. Run `ANALYZE outbox_events` after bulk loads on that shape. A wrapper whose transaction view has no raw read runs its claim on the root the same way. A root append inserts one atomic batch across runs. A transactional append reserves sequences in run-ID order. For a business transaction appending in several calls, order the calls consistently across transactions or retry the entire transaction on PostgreSQL SQLSTATE `40P01`.
- **SQLite storage check and Node restarts (1.0.0-alpha.21).** The check accepts compatible numeric timestamps, including the better-sqlite3 adapter's `unixepoch-ms` mode, and detects TEXT-affinity files before a numeric client writes. A pending probe blocks the calls sharing that client until it settles. Node ticks and dequeue loops belong to their start. After stop, the old tick cannot call `onTick` and the old loop cannot take a new job. A restarted host waits for the old loop to settle before installing its replacement.

- **SQLite probe errors keep their type and cause (1.0.0-alpha.21).** A failed date-storage probe throws `SqliteDateStorageUnverifiedError` with the original rejection as `cause`. If the rejection cannot be formatted, the message says `Unprintable error`. The operation stays blocked and the next call checks again. Host constructors also retain their `RangeError` for invalid timer options and `TypeError` for invalid `onTick` values when those values cannot be formatted.

- **Caller transactions defer outbox delivery (1.0.0-alpha.21).** A kernel built over a caller-owned Prisma transaction still runs the whole maintenance tick there. Its `outbox.flush` now returns `deferred: true` with zero deliveries and the tick reports `outboxDeferred: true`. Dispatch `outbox.flush` on a root-client kernel after commit to deliver the committed rows. A rollback produces no sink effects from that tick.
- **Outbox at-least-once delivery and schema upgrade (1.0.0-alpha.21).** Stop old flushers and close their connections before running the migration. A warm alpha.20 query can fail with `cached plan must not change result type` after the new column changes its result shape. Restart on the new release after migration. For SQLite, stop every process using the file, including application writers and the console, and close all generated clients. Apply the schema migration in a separate process, then close that process before restarting the engine. Keep separately generated SQLite clients out of that migration process. Treat legacy stamped rows as published. An event that an old flusher already lost cannot be recovered from its stamp.

  Add the field and indexes to `OutboxEvent` in your Prisma schema or contract:

  ```prisma
  deliveryClaim String?
  @@index([publishedAt, dlqAt, workflowRunId, deliveryClaim], map: "outbox_events_delivery_run_idx")
  @@index([publishedAt, dlqAt, workflowRunId, sequence], map: "outbox_events_live_run_sequence_idx")
  @@index([deliveryClaim, workflowRunId], map: "outbox_events_delivery_cursor_idx")
  ```

  Add the nullable column and three indexes in one schema migration. Existing rows keep their publication and dead-letter state. If you write the schema migration by hand, run the following block as one transaction. On PostgreSQL, write `BEGIN;` as the first line:

  ```sql
  BEGIN IMMEDIATE;
  ALTER TABLE "outbox_events" ADD COLUMN "deliveryClaim" TEXT;
  CREATE INDEX "outbox_events_delivery_run_idx" ON "outbox_events" ("publishedAt", "dlqAt", "workflowRunId", "deliveryClaim");
  CREATE INDEX "outbox_events_live_run_sequence_idx" ON "outbox_events" ("publishedAt", "dlqAt", "workflowRunId", "sequence");
  CREATE INDEX "outbox_events_delivery_cursor_idx" ON "outbox_events" ("deliveryClaim", "workflowRunId");
  COMMIT;
  ```

  If the process stops before `COMMIT`, the database discards the whole block. PostgreSQL rolls it back at once. SQLite rolls it back the next time the file is opened, in WAL and in rollback-journal mode. Then run the block again. A partial state exists only if the statements ran outside a transaction. To finish such a state, first check what exists. On SQLite use `SELECT name FROM pragma_table_info('outbox_events') WHERE name = 'deliveryClaim'` and `SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'outbox_events'`. On PostgreSQL use `information_schema.columns` and `pg_indexes`. Then run the block with the `ALTER TABLE` line removed if the column exists, and with `CREATE INDEX IF NOT EXISTS` in the three index statements.

  `run.create` and `engine.stats` work before this upgrade. Until it, `outbox.flush` rejects with `OutboxSchemaMissingError` (code `OUTBOX_SCHEMA_MISSING`), which names this step, and claims nothing, so events wait in the outbox: on SQLite when the column or any of the three indexes is missing, on PostgreSQL when the column is missing (without the indexes PostgreSQL claims on slower plans). The console needs it for outbox timelines and dead-letter detail.

  Custom persistence adapters must implement `claimOutboxDelivery`, `completeOutboxDelivery` and `failOutboxDelivery`; `isOutboxDeliveryClaimActive` is optional and the kernel never calls it. These replace `claimUnpublishedOutboxEvents` and `releaseOutboxEvents`. The kernel checks the required methods at construction. Use `persistenceConformanceSuite`. Adapters exposing transaction views mark them with `outboxDeliveryDeferred`.

  The Prisma flusher resumes after the last run served using a rank stored in the outbox rows. It works across new persistence instances. A page claims one head per available run, then each claimed run's next live events up to an equal share of the page. A run's events reach the sink in sequence order and different runs concurrently. On PostgreSQL and SQLite the claim needs `$queryRaw` or `$queryRawUnsafe`; a root without either is refused when the persistence is built with `OutboxClaimUnsupportedError` (`OUTBOX_CLAIM_UNSUPPORTED`). A page of eight events takes 6 driver statements on PostgreSQL against 1 for an alpha.20 flush, and 3 on SQLite against 9. See [Transactional Outbox Events](https://workflow-engine.dev/core-concepts/kernel-and-ports#transactional-outbox-events) for the measured cost and for the client shapes whose claim plan follows the statistics. Deduplicate by the durable outbox `eventId`. Order is decided at claim time. A replayed dead letter is delivered after later events of its run already claimed or published before replay. After replay, later unclaimed events wait behind it. Sequence may be reused after SQL deletion. Delivery can duplicate whenever the sink effect happens without a durable acknowledgement. Examples include a crash or write error after acceptance, an emit in flight at expiry, a sink that commits and then rejects, and partial plugin success. The claim returns only rows it owns and an expiry check precedes each emit, but the external effect and the acknowledgement are separate. The lease starts before the claim query and a claim returned too late emits nothing, logs a warning and reports degraded delivery.

  A host timeout or Node shutdown ends new claims and sink calls by the affected flush. A call already in flight can settle and write only under its original owner fence. Claims last 60 seconds by default. Hosts give a dispatch its wait budget plus 60 seconds, capped at 2,147,483,647 ms. A slow sink can leave rows for expiry and a later flush. Synchronize host clocks. `engine.stats` counts claimed rows as unpublished. `run.purge` leaves outbox rows. A flush waits for a live claim, skips a published row, and skips a dead letter until replay. Only an operator deletes outbox rows with SQL.
- **Prefix filters support single-raw-read SQLite clients (1.0.0-alpha.21).** Prisma prefix reads bind values for native SQLite 6/7, the Prisma 8 positional facade and PostgreSQL. This covers AI call listing and stats, annotations and blob listing through `$queryRawUnsafe`. If `createPrismaBlobStore` receives a Prisma 6/7 SQLite facade that exposes only `$queryRawUnsafe`, pass `{ databaseType: "sqlite" }`. No schema change.
- **A SQLite client with no raw read is refused; a date check that cannot run fails the call (1.0.0-alpha.21).** The SQLite date-storage check (next bullets) runs through the client's tagged `$queryRaw`, or `$queryRawUnsafe` when that is all the client has. A client given to `PrismaWorkflowPersistence`, `PrismaJobQueue`, `PrismaStepLedger`, `PrismaAICallLogger` or `createPrismaConsoleReadPort` on SQLite with neither (a facade that forwards only the model delegates) is now refused on every call with `SqliteDateStorageUnverifiedError` (`code: "SQLITE_DATE_STORAGE_UNVERIFIED"`, `reason: "no-raw-query"`); it used to run unchecked. Forward `$queryRawUnsafe` (and on Prisma 8 `$databaseType` and `$withColumns`) from the facade. A check that fails (a database error, a missing table) throws the same error with `reason: "probe-failed"` and the database error as `cause`, runs nothing, and the next call checks again; before, a failed check let the call run. Both errors are exported from `@bratsos/workflow-engine`. PostgreSQL is not affected.
- **The conformance suites wait for the adapter instead of sleeping (1.0.0-alpha.21).** `aiCallLoggerConformanceSuite` no longer sleeps a fixed 100 ms after a fire-and-forget `logCall`: it polls every 20 ms for up to 4 s until the write is visible, so a database-backed `AICallLogger` that commits within 4 s now passes where it failed under load. `jobQueueConformanceSuite`'s heartbeat test (touched job survives `releaseStaleJobs`, untouched job is reclaimed) measures the gap between `touchJob` and `releaseStaleJobs` and, when a loaded machine stretched it, repeats on fresh jobs with a 300 ms and a 900 ms threshold (2.6 s of sleeping at most) instead of failing; the quiet-machine path is unchanged at 200 ms. A `touchJob` that does not refresh the lease still fails. Keep your runner's per-test timeout at 5 s or higher.
- **Timer options are validated at construction (1.0.0-alpha.21).** Every option that reaches `setTimeout` or `setInterval` must be a number of milliseconds from 1 to 2147483647 (the longest delay a timer honours), or the constructor throws a `RangeError` that names the option. The options: Node host `orchestrationIntervalMs`, `jobPollIntervalMs`, `jobHeartbeatIntervalMs`, `shutdownTimeoutMs` and `postJobYieldMs` (0 is also accepted there: it turns the pause off); serverless host `jobHeartbeatIntervalMs`, `outboxFlushTimeoutMs` and `onTickTimeoutMs`; `runAndWait`'s `pollIntervalMs`; `runToCompletion`'s `jobHeartbeatIntervalMs`; `createActivityWorker`'s `heartbeatMs`, `idleDelayMs` and `maxBackoffMs`; `createRemoteExecutor`'s `pollEveryMs`; and `executeJobWithHeartbeat`'s `jobHeartbeatIntervalMs`. alpha.20 passed the value straight to the timer, so these inputs worked there and now throw: a numeric string such as an environment variable passed through unparsed (`orchestrationIntervalMs: process.env.TICK_MS` fired because a timer coerces `"20"`; pass `Number(process.env.TICK_MS)`); `0` on an interval or a bound (a busy loop, or a bound that stopped waiting at once; use a positive value); a fraction below 1 such as `0.5` (use `1`); `Infinity` or any value above 2147483647 (a timer fired after 1 ms: a "no limit" became the tightest limit; use `2147483647`, about 24.8 days, to wait for practically anything); and `NaN`, a negative number or a non-number. `onTick`, new in this release, must be a function (a `TypeError` from either host's constructor).
- **The SQLite adapters refuse a file another Prisma major wrote (1.0.0-alpha.21).** Prisma 6 stores `DateTime` in SQLite as integer epoch milliseconds, Prisma 7 and 8 as ISO text, and SQLite orders every integer before every text value, so a file one timestamp format wrote and another reads can get date comparisons wrong: a run completed a moment ago was offered to `run.purge` retention and a run updated a moment ago to `run.reapStuck`. `PrismaWorkflowPersistence`, `PrismaJobQueue`, `PrismaStepLedger` and `PrismaAICallLogger` on SQLite now compare the oldest and newest stored value of every date column an index leads with (`workflow_runs.createdAt`, `outbox_events.publishedAt` and `dlqAt`, `workflow_stages.nextPollAt`, `job_queue.nextPollAt`) and the date of one row of each table no run implies (`job_queue.createdAt`, `outbox_events.occurredAt`, `idempotency_keys.createdAt`, `ai_calls.createdAt`) with a `Date` as their client binds it, before every method until a check has seen a stored date: the storage class and, when both are text, the form (Prisma 7's `+00:00` against Prisma 8's `Z`); every method of these classes except the named synchronous ones throws `SqliteDateStorageError` (`code: "SQLITE_DATE_STORAGE_MISMATCH"`, `kind` `"class"`, `"form"` or `"sqlite-timestamp"`, `column`) before reading or writing when any differs, in all six cross directions for the majors’ default timestamp modes. `createNodeHost(...).start()` rejects with it and the serverless host's entry points throw it (new optional `JobTransport.verifyStorage()`), and `createPrismaConsoleReadPort` refuses too. For a major switch, follow the [SQLite major-switch procedure](https://workflow-engine.dev/persistence/prisma-setup#switching-sqlite-prisma-majors). Drain with the creating major until there are no unpublished events and no live delivery claims. Resolve or explicitly discard dead letters before the three DELETEs. A file with Prisma 8’s TEXT date affinity requires a fresh file when targeting Prisma 6, even after an intermediate switch to Prisma 7. A date in SQLite's own form (`2026-11-18 06:30:09`), which `CURRENT_TIMESTAMP`, `datetime('now')` and the Prisma 6 and 7 `createdAt` column default write when SQL outside the engine inserts rows, is found anywhere in an indexed date column and refused with `kind: "sqlite-timestamp"` and `recovery`, the statement that rewrites those rows in the client's form (see the setup guide); a refusal is not remembered, so the next call after the rewrite runs. The other ISO form on rows strictly between the oldest and newest of an indexed column, and the rows of a sampled table other than the one read, are not seen until they become the oldest, newest or read row. If you see it, use the Prisma major that created the file or start the new major from a fresh SQLite file and migrate the data; there is no normalization migration. A file in the client’s own timestamp format continues to work. A format-compatible file with no stored date runs the call and is checked again on the next one, so run one Prisma major per file also while it is empty: two majors that start on an empty file cannot be told apart until one writes, and after that the other refuses on its next call; the path of a Prisma 7 to 8 upgrade (a Prisma 7 file opened by a Prisma 8 client) is refused like the others. No schema change.
- **`run.listVersions` opens no transaction (1.0.0-alpha.21).** It is a single read. `InMemoryWorkflowPersistence.getAllStages()` now returns each stage once.
- **`engine.stats` and `onTick` (1.0.0-alpha.21).** New read-only command `engine.stats` reports active work (runs, stages, jobs and outbox events by non-terminal status, the oldest PENDING run and job, due SUSPENDED stages, unpublished and dead-lettered events) with ages in milliseconds. It counts PENDING, RUNNING and SUSPENDED rows only, from indexes that lead with the active column when the tables were never analysed or their statistics are current; on PostgreSQL, statistics taken while most rows were active and then outgrown by terminal rows (autovacuum off or behind) make the runs, jobs and unpublished-outbox counts read the whole table until the next `ANALYZE` (SQLite stays bounded). Both hosts accept `onTick(counts)`, called after every maintenance tick with a copy of its counts; a hook that throws is logged and never stops the loop. The Node host runs the hook outside the tick, so ticks never wait for what it awaits (its synchronous code runs on the host's thread and holds the ticks while it runs): one call at a time, one warning when a tick skips it, `stop()` waits for it within `shutdownTimeoutMs`, and a hook must not await `host.stop()`. The serverless host awaits it for at most the new option `onTickTimeoutMs` (default 5000), then returns the counts and logs a warning; the bound covers a hook that yields, and synchronous code in the hook delays the return by as long as it runs. `KernelCommand` and `CommandResult` gain `engine.stats`, so a custom host or wrapper with an exhaustive `switch` over `command.type` stops compiling (`Type 'EngineStatsCommand' is not assignable to type 'never'`) until it handles the new case or has a `default`. Port additions are optional: `Persistence.getActiveWorkStats(now)` and `JobTransport.getJobStats()`; a custom adapter without one gets `{ available: false }` for the affected sections, so nothing is required of it. The built-in adapters implement both. No schema change.
- **Dead-letter replay recovers legacy claim stamps (1.0.0-alpha.21).** An older flusher could leave a dead letter stamped as published. Replay clears that legacy stamp as well as the dead-letter state. The new atomic failure write records the retry, clears the claim and sets `dlqAt` together, replacing the earlier separate increment and DLQ move.
- **The operational console's run detail lists each stage's attempts (1.0.0-alpha.21).** A stage that retried showed only its latest attempt. `@bratsos/workflow-engine-console` now builds an "Attempts by stage" section from the events the run's outbox still holds: each attempt's start and end, why it began (first run recorded, job retry, retry inside `stage.pollSuspended`, rerun after a redrive, started again after it ended, started again while the previous execution had no recorded end), how it ended, its error, its stage events and the steps that last changed during it. A `run.cancel` ends the open attempt as *cancelled* (the `workflow:cancelled` event), and a redrive (`workflow:started`) makes the next `stage:started` a rerun. A stage that started again with no event ending the previous execution shows that execution as *No end recorded* and lists causes that leave this record (a worker that stopped or lost its lease, a job delivered again, an outcome that could not be written) without picking one. The page uses a stage's events only when they form an unbroken range from the run's first outbox row (its `workflow:created` at sequence 1), which finds every row removed from the start or the middle; rows removed from the end are found only when what remains contradicts the run or stage rows (the store numbers a run's next row one past the highest it holds, so once the run writes again the range is unbroken), and a crash re-delivery or poll retry recorded only in removed rows is not shown; the page says this in one line wherever it shows a history. Nothing in the engine deletes outbox rows (`run.purge` removes the run and leaves them); only SQL such as your own pruning job does. The checks: the run's own events follow the engine's order (each redrive's `workflow:started` after a run end; a first start may be two `workflow:started` rows, a `run.transition` dispatched before `run.claimPending` and the claim, read as one), record exactly its `redriveCount` and end in its status, and the stage row agrees with them (status, `attempt` as the recorded executions and redrive modes give it, `startedAt` once a start is retained, `completedAt`, error; the Prisma store stamps a new row's `startedAt` before the stage starts and the in-memory store does not, so a stage with no event of its own is read from its status and `attempt`); otherwise the stage shows its latest attempt and says why, naming the field that disagrees. A run whose outbox rows are all gone says so instead of showing its stages as not started. `RunDetail.stageEvents` (`{ events, after, lastSequence, complete, more }`) and `RunDetailOptions.stageEventsAfter` (`GET /api/runs/:id?stageEventsAfter=N`) are new and optional. A custom `ConsoleReadPort` that does not return `stageEvents` keeps compiling and working, but its run detail then says, for every stage, "Per-attempt history is unavailable for this stage: this reader does not provide stage events", and shows only the latest attempt as before; implement `stageEvents` (return `workflow:created`, `workflow:completed` and `workflow:failed` with the other types; a first read with no row must return `complete: false`) to get the attempt view. A read covers at most 10,000 outbox sequences and 2,000 events, so its cost is bounded whatever the run's size and whatever statistics the planner holds; the page reads a longer history in further reads, each continuing from the last, at most four per poll interval. For a long run this means the attempts show only once the page has caught up: at the default 5-second poll interval a run of 400,000 outbox sequences takes 40 reads, about 50 seconds, with the stages shown as still loading meanwhile; with polling paused, "Refresh now" reads one more part. A custom reader should return the run detail as of one moment (the Prisma reader uses `REPEATABLE READ` on Postgres) and may return each stage event's `causationId`. `listRunEvents` (`GET /api/runs/:id/events`) on the Prisma reader may return fewer rows than `limit`, across removed rows or a gap; only an empty answer means no row remains past `afterSequence`, so read again from the last sequence returned until one is empty. On Postgres the run detail is always one transaction: inside a caller's Prisma 7 transaction it is a savepoint that sends no `SET TRANSACTION` (the server logged an error per read before), and the caller's `statement_timeout` is restored after it; Prisma's transaction limits follow `statementTimeoutMs` (twenty times it, none with 0, each capped at the longest Node timer; on Prisma 8 the port bounds the wait for a connection itself; on SQLite a read queued behind another transaction gives up after `statementTimeoutMs` with `limit: "connection"` on every major, also with the engine's adapters on the same client, and waits with 0; the wait is measured from when the read is sent, so a bound of a few milliseconds also counts a slow begin or a stalled event loop) and a client that gives up (`P2028`) answers 504 `query_timeout` instead of 500. On Postgres the annotations page is read through cursors in the read's transaction: behind a pooler, use a transaction-scoped connection. A lifecycle event's error text is capped at 2,000 characters and the page says when it was cut. No schema change and no engine change.
- **Prisma 8 SQLite: the wrapper coordinates every statement on the client's root connection, and refuses `BEGIN` and `SAVEPOINT` there (1.0.0-alpha.21).** Reads and writes your application sends through Prisma 8's own API on the client it wraps (`db.orm`, `db.sql`, `db.query`, `db.execute`) now take part in the same rules as the engine's: reads are counted, so an engine commit on a rollback-journal file no longer fails with `Transaction commit failed` (and in WAL the engine no longer rejects with `SQLITE_BUSY_SNAPSHOT`) while one is returning rows; writes run in the wrapper's write queue. The journal mode is read at every commit, so switching between WAL and a rollback journal after start-up is followed. Send that switch through the wrapped client's root connection: from another connection or process it can lose rows the engine committed. `BEGIN` and `SAVEPOINT` sent to the root (raw through the wrapper, or `db.execute`) now throw `fromPrisma8: ... Use $transaction`: move such code into `$transaction(...)` or `db.transaction(...)`. `EXPLAIN PRAGMA ...` now waits for the write queue, since SQLite runs the PRAGMA while preparing it. The wrapper looks the driver up at its first call, so `db.connect()` after `fromPrisma8(db)` works as before; without such a driver it logs one warning. Only `BEGIN` and `SAVEPOINT` are refused on the root; `COMMIT`, `END`, `ROLLBACK` and `RELEASE` always run. Statements sent before the first adapter call are not coordinated. A transaction opened by one of them is found at that call: engine writes wait up to 5 s for it to end and then fail busy (`the SQLite root connection is inside a transaction this adapter did not open`), and never join it. Every wait is bounded: on a rollback-journal file an engine commit under a read your code holds open (a `for await` over `db.orm` that awaits the engine inside the loop, or an unfinished iterator) fails with `Transaction commit failed` after the busy timeout, as before 1.0; read the rows first, or use WAL. No schema change.
- **Prisma 8 SQLite: an engine transaction no longer fails while a root read is returning rows (1.0.0-alpha.21).** The Prisma 8 SQLite driver hands a root read's rows over across microtasks and holds the read lock in between, so on a rollback-journal file (SQLite's default) an engine transaction committing on another connection of the same process waited its busy timeout synchronously and failed with `Transaction commit failed`, and in WAL a root write behind it could fail with `SQLITE_BUSY_SNAPSHOT`. On a rollback-journal file the adapter's transactions now commit once the root reads in flight have finished, and root reads that start meanwhile wait for that commit; in WAL a root write that fails `SQLITE_BUSY_SNAPSHOT` for that reason waits for those reads and runs once more. WAL commits do not wait. Your own `db.transaction(...)` still fails that way on a rollback-journal file: use WAL for concurrent work in one process. No schema change.
- **Prisma 8 SQLite: a root statement that fails with a busy error no longer makes later root writes vanish (1.0.0-alpha.21).** The Prisma 8 SQLite driver runs every statement that returns rows through `node:sqlite`'s `iterate()`, which does not reset a statement whose first step fails `SQLITE_BUSY` (a consumer's `db.transaction(...)` or another process held the file past the busy timeout), so SQLite kept it active on the shared root connection. After such a write (`create`, `update`, `upsert`, `delete`, or a raw statement that writes, returning rows or not) every later root write reported success, was not committed and was rolled back when the statement was garbage collected. `fromPrisma8` now decides once per root statement whether it is provably a read (`SELECT`, `VALUES`, `EXPLAIN`, or `WITH` ending in `SELECT` or `VALUES`). Anything else, `PRAGMA` and DDL included, waits in the root write queue and only its turn there runs it: inside `BEGIN IMMEDIATE` when it returns rows, through the driver's `execute` when it returns none, as it is when it is a `PRAGMA` that returns rows. Raw `VALUES` and `WITH ... VALUES` reads no longer wait in the queue, and a raw `EXPLAIN` of a statement with `RETURNING` returns the plan instead of failing on a missing column. A root read that fails busy at its first step is still left active by the driver until it is garbage collected: until then, with a rollback journal other connections cannot commit, and in WAL the root reads a stale snapshot and its writes fail with `SQLITE_BUSY_SNAPSHOT`; no write is lost. Keep the default 5 s `busy_timeout` or longer and prefer WAL. No schema change.
- **Prisma 8 SQLite binds booleans on every Node floor, and a NUL in text is refused where `node:sqlite` cannot read it (1.0.0-alpha.21).** Before Node 24.21 and 26.8 (every Node 22 release), `node:sqlite` rejected a boolean raw parameter (`Provided value cannot be bound to SQLite parameter N`); `fromPrisma8` now binds `1` or `0`. `node:sqlite` also reads TEXT back cut at its first NUL character on every Node 22 release, Node 24 before 24.16 and Node 26.0, so a stage or step ID with a NUL changed without an error; on those versions `fromPrisma8` now throws `fromPrisma8: SQLite text containing a NUL character cannot be stored ...` before the statement runs. NUL-safe text needs Node 24.16+ or 26.1+. Prisma 6 and 7 are unaffected. CI now runs the SQLite suite for each Prisma major on Node 24, for Prisma 6 and 7 also on 22.12.0, and for Prisma 8 also on 22.20.0, 24.11.0 and 26.0.0. No schema change.
- **`run.cancel` cancels the run's provider batches (1.0.0-alpha.21).** A cancelled run's `ctx.step.ai.map` batch kept running at the provider and kept billing. After the cancel commits, `run.cancel` now cancels every batch the run created (the `${id}:submit` steps of all its stages, and refs a legacy async-batch stage persisted in `suspendedState.metadata.batchRefs`) that has not ended. `RunCancelResult` gained `batches`, one outcome per batch (`cancelled`, `already-terminal`, `unsupported`, `unavailable`, `failed`, plus `unrecorded` for a submit step that holds no handle, `unverified` for a handle the engine cannot prove it created, and `held`, with `heldUntil`, for a step another `run.cancel` sweep holds: repeat `run.cancel` after that time); a batch that may still be running is logged as a WARN on the run, and the run ends `CANCELLED` whatever a provider answers. **Records written before this release are not cancelled:** the engine cancels a submit record only when it carries its own ownership marker (`externalKey`, equal to its row's key), which earlier versions did not write, so a run submitted by an older version reports its batches as `unverified` (and a WARN) and they must be cancelled at the provider; the same applies to an ordinary `ctx.step.run` named `*:submit` that memoises a handle. OpenRouter documents no cancel call, so its batches are `unsupported`; its batch transport now defaults to the documented base URL `https://openrouter.ai/api/v1` (it was `/api/beta`; pass `baseURL` to keep the old one). `cancelled` keeps its meaning (`true` only for the command that moved the run to `CANCELLED`); repeating `run.cancel` on a `CANCELLED` run retries every provider cancel that did not take effect. The process that dispatches `run.cancel` builds the transport from the stored ref and the environment's credentials (`OPENAI_API_KEY` and so on); set `createKernel({ services: { batchModels } })` when they live elsewhere. A cancelled batch is never adopted and never waited on: when every batch of a `${id}:submit` row is cancelled, `run.cancel` tombstones the stored submit record and re-opens the step, so `run.redrive` creates a new batch on every transport (no `onReclaim` needed; its poll and collect steps become `${id}:poll.1` and `${id}:collect.1`); a batch that was not confirmed cancelled keeps the conservative behaviour (wait on it, or `BatchNotAdoptableError` where adoption is impossible), except one whose cancel request was sent and whose answer is unknown: the row records it (`cancelIntent`), and a repeated `run.cancel` or the redriven step completes that cancel before going on (a step that cannot complete it fails retryably with a WARN). A `FAILED` run keeps its batches. The provider calls are bounded (30 s per batch, 60 s per sweep; `services.batchCancelTimeouts`), a batch not reached is `failed`, and the same sweep runs wherever a handler that executed a stage body finds the run `CANCELLED` (`job.execute` ghost exits, `stage.pollSuspended` replays). No `run` step body starts once the stage's signal reports the cancel, and writes no row. A submit step's outcome is recorded only at the attempt its execution claimed: a submit body that lost its row to a replay or a sweep throws `StepLeaseLostError` (or parks on the recorded outcome) instead of overwriting it, and cancels the batches it created that the row does not list. Other `run` steps keep first write wins. `run.cancel` ends only stages that have not ended: a stage another execution completed first stays `COMPLETED`; its run write is fenced on the version it read, so a cancel held up past another cancel and a redrive ends, and sweeps, the generation it reads again. A spilled step result goes to a new blob key on every write, under a new prefix (`workflow-v2/spill/step-writes/<stageRecordId>/<stepId>/<uuid>.json`; earlier rows keep `workflow-v2/spill/steps/<stageRecordId>/<stepId>.json` and still resolve); a run purged, or redriven from the start, by an older release leaves the new keys behind. **Upgrade every worker before relying on `run.cancel` then `run.redrive`:** a worker on an older release does not see the tombstone and adopts the cancelled batch while the provider still lists it. `run.redrive` reports a submit step a cancel sweep still holds in the new optional `RunRedriveResult.batches` (`held`, with `heldUntil`; its redriven step waits until then). A `run.redrive` also cancels, after its commit, a batch whose cancel was asked for on a submit step it deletes (a sweep held the step, or recorded a cancel on it) and a batch a step owes a cancel (`cancelOwed`: an execution of the step created it and lost the step), and, on a `CANCELLED` run, every batch of a stage record it deletes whose stage had not completed, unless recorded as cancelled; it names them all in a WARN on the run before its commit, then reports each in `RunRedriveResult.batches` with the provider's answer and in one log line per batch. On a run that was not cancelled, a deleted step with batches and no recorded cancel is still abandoned with its WARN. A batch a step owes a cancel on a completed row (or a failed one with no retry left) is cancelled by the stage's next replay of the step, on a backoff recorded on the row when it fails (1 minute doubling to 1 hour, one WARN per kind of failure); a provider with no cancel call settles it once into `noCancelBatchIds`. WARNs that name a batch are written on the run, not the stage record, and advise repeating `run.cancel` only while the run is still `CANCELLED`. New API: `EngineBatchModel.cancel?`, `AIBatch.cancel?`, `AIBatch.canAdopt?`, `RunCancelBatchOutcome.heldUntil`, `RunRedriveResult.batches`, `resolveBatchModelForRef`, `KernelServices.batchModels`. No schema change.
- **A waiting run is no longer reaped (1.0.0-alpha.20).** `run.reapStuck` failed a healthy run as `STUCK_RUN_REAPED` when its `SUSPENDED` stage was not due for longer than the stuck threshold: a `ctx.step.sleep`, `waitFor` `every`, signal `keepalive` or `pollInterval` above it. A run is now left alone while a suspended stage's `nextPollAt` is ahead or came due less than one threshold ago; a suspended stage with no `nextPollAt`, or one overdue by more than the threshold, is reaped as before. No schema change.
- **A suspended-stage replay that throws is retried (1.0.0-alpha.20).** A stage that threw while `stage.pollSuspended` replayed it (a failed commit, a step-ledger or blob write error, a body error) failed the stage and the run on the first error. It is now retried with the attempts its `SUSPENDED` job row has left, as `job.execute` retries the same throw: the stage stays `SUSPENDED` with the error on `errorMessage`, `attempt` is incremented, failed `run` steps are re-opened and `stage:retrying` is emitted where `stage:failed` used to be. A `ctx.step.run` that spends its own `retries` during a replay therefore no longer fails the run on that poll: each remaining attempt runs the step once more. An expired wait, an `onReclaim: "fail"` refusal, a `DuplicateStepKeyError` and a cancelled run still end the stage at once. No schema change.
- **Concurrent definition registration uses atomic conflict handling.** When upgrading from 1.0.0-alpha.14, remove any local patch of `insertDefinitionIfAbsent`. If your transaction retry loop catches only Prisma errors, also handle `DefinitionRegistrationRetryableError` (`code: "DEFINITION_REGISTRATION_RETRY"`): a `REPEATABLE READ` / `SERIALIZABLE` snapshot conflict, `40001` / `P2034`, or a missing follow-up row now uses this typed error. Let the caller transaction roll back and retry the **whole transaction**, not just registration. No schema change is required.
- **A reclaimed batch submit no longer creates a second provider batch (1.0.0-alpha.9).** A worker that died between the provider accepting a `ctx.step.ai.map` batch and the ledger recording it left the step `running`; the replay after the lease expired submitted the whole batch again, and the first was orphaned and still billed. Every `run` step now carries a deterministic external key (`workflow_steps.externalKey`, written before the body runs), `ctx.step.run(id, fn)` passes it to the body as `fn({ stepId, externalKey, attempt, isReclaim })`, and the OpenAI and Google batch adapters stamp it into the provider fields they can search (`metadata` and `displayName`) so a reclaimed submit adopts the existing batch. **Add the column** (`ALTER TABLE "workflow_steps" ADD COLUMN IF NOT EXISTS "externalKey" TEXT;`). **One behaviour change:** on Anthropic and OpenRouter, which offer no searchable field, a reclaimed submit now throws `BatchNotAdoptableError` instead of duplicating — pass `batch: { onReclaim: "resubmit" }` on the map to accept the duplicate cost. A step whose body cannot be recovered at all can declare `ctx.step.run(id, fn, { onReclaim: "fail" })`, which fails with `StepNotReplaySafeError` rather than re-executing; the default stays `"rerun"`.

- **Timestamps written by raw statements are explicitly UTC (1.0.0-alpha.8).** The `FOR UPDATE SKIP LOCKED` claim and dequeue and the outbox claim now write `$n::timestamptz AT TIME ZONE 'UTC'` instead of a bare bound `Date`, which Postgres converted through the *session* timezone on the way into the naive `timestamp` columns. On a non-UTC session that put `job_queue.lockedAt` hours in the future and stale-lease recovery never fired — a crashed worker's job stayed `RUNNING` forever, in 0.13 and in the 1.0 alphas alike. **No schema change is required**, but check that you did not map any engine timestamp column to `@db.Timestamptz`: the engine's columns must stay plain Prisma `DateTime` (naive `timestamp` holding UTC), as `prisma/schema.prisma` declares them. If you did map one, revert it with `ALTER TABLE "job_queue" ALTER COLUMN "lockedAt" TYPE timestamp(3) USING "lockedAt" AT TIME ZONE 'UTC';` (same shape for the other columns).
- **A racing job is re-delivered instead of discarded (1.0.0-alpha.8).** `run.claimPending` enqueues a claimed run's first-stage job *after* the claim transaction commits, so a job loop can no longer dequeue a job whose run is still `PENDING` — a race that wedged the majority of runs at a short `jobPollIntervalMs` in 0.13 and in the 1.0 alphas alike. `JobExecuteResult` gains `ghostReason` (`"race"` | `"orphan"` | `"version"`) next to `ghost: true`; the built-in hosts re-deliver a `"race"`, defer a `"version"` (a run pinned to a definition version this build does not serve — through `JobTransport.defer` when the transport has it, so no attempt is spent) and still fail an `"orphan"` terminally. Nothing to change unless you wrote your own host loop against `ghost`: it keeps working, but read `ghostReason` to pick the recovery up.
- **`run.rerunFrom` is deprecated for `run.redrive`.** `run.redrive({ workflowRunId, from?, definitionVersion?, idempotencyKey? })` takes `from: { kind: "lastFailure" } | { kind: "start" } | { kind: "stage", stageId }` (default `lastFailure`). For `lastFailure` and `stage` the resumed stage record is reopened in place — back to `PENDING`, `attempt` incremented, error/output/timings cleared — so its durable step ledger survives: every `completed` step row is answered from the ledger, rows naming an external effect are re-opened, and waits, sleeps and failed rows without an external key are dropped through `StepLedger.clearExcept`. Stages after it are archived and deleted; `start` replaces everything. Every superseded record is archived first as a stage-scoped `run.supersededAttempt` annotation (with `abandonedSteps` when a dropped row named an external effect), and `definitionVersion: "latest"` re-pins the run onto the version this build serves — the remedy for a run stranded at a version nothing serves. The result is `{ workflowRunId, fromStageId, supersededStages, redriveCount, definitionVersion }`. `run.rerunFrom` keeps its result shape and now delegates, so it gets the same behaviour; move to `run.redrive` when you touch the call. See `14-redrive.md`.
- **Runs can be pinned to a definition version.** With the columns above, `run.create` stamps each run with a content-addressed version (`workflow.definitionVersion`, `sha256-…`, or one you declare with `defineWorkflow(...).version("...")`) and stores the structure as a `workflow_definitions` snapshot. Claiming, job dequeue and suspended-stage polling then take only the runs this build serves when the registry is built with `createWorkflowRegistry(workflows)`; a hand-written `{ getWorkflow }` registry cannot enumerate and keeps the old predicate, and `serves: "all"` on either host restores it explicitly. **Two changes in the default:** an unpinned run is claimable only by a host whose served definitions name its workflow, and `run.claimPending` no longer adopts-and-fails a run whose workflow is missing from an enumerating registry — it leaves it `PENDING` and `run.listVersions` reports it under `unservedHere`. Re-registering an explicit version with a different structure throws `DefinitionVersionConflictError`. See `13-definition-versioning.md`.
- **Retention: `run.purge`.** New command `{ type: "run.purge", olderThan, statuses?, limit? }` → `{ purged, workflowRunIds }` clears the step ledger, blobs and job rows and deletes the run with its stages, logs, artifacts and annotations (not its `outbox_events` or `ai_calls`: nothing in the engine deletes outbox rows). Both hosts run it on the maintenance tick when given `retention: { olderThanMs, statuses?, limit? }` (off by default); `MaintenanceTickCounts` gains `purged`.
- **Cancellation reaches a running body.** `ctx.abortSignal` (the same object as `step.abortSignal` inside a `ctx.step.run` body) is aborted from the host's job lease heartbeat, which now dispatches the new `job.heartbeat` command: the reason is a `StageAbortedError` with `reason: "cancelled"` or `"lease-lost"` (`stageAbortReason(signal)` reads it). After a `"cancelled"` abort a `run` body that finishes is recorded as `failed`, no retry is spent, and `waitFor` checks the signal before it polls. A direct `job.execute` dispatch without `abortSignal` gets a signal that never fires.
- **Two-tier job lease expiry.** Beside `staleLeaseThresholdMs` (heartbeat lost, `LEASE_HEARTBEAT_LOST`, requeued) both hosts take `jobAbsoluteTimeoutMs` (default one hour, `0` disables): a job whose claim is older than that is failed terminally with `LEASE_ABSOLUTE_CAP`, since a worker that is alive but wedged keeps heartbeating. `lease.reapStale` returns `{ released, expired }` and `MaintenanceTickCounts` gains `staleExpired`. On Postgres the lease stamps now come from the database clock.
- **A failing event sink is a named state.** `outbox.flush` returns `{ published, failed, deadLettered, eventSinkStatus, eventSinkError? }` and `MaintenanceTickCounts` gains `eventsFailed`, `eventsDeadLettered`, `eventSinkStatus` and `eventSinkError`; `failed` and `deadLettered` are disjoint. The Node host exposes `getStats().eventSink`; `createEventSinkMonitor()` is exported for a custom loop. See `03-runtime-setup.md`.
- **Large values spill to the blob store.** A `workflow_steps.result` above `spillThresholdBytes` (64 KiB by default) is written to the `blobStore` and the row keeps a `{ "$wfSpill": 1, key, bytes }` reference, resolved before the value reaches your stage; job payloads spill only when you wrap the transport with `createSpillingJobTransport`. The blob store must therefore be shared by every process that executes or polls a run (it already had to be, for stage outputs); reading a spilled value through a different store throws `SpilledPayloadUnavailableError`. See `15-large-payloads.md`.
- **No default `temperature` is sent.** 0.13 sent `0` on `generateObject` and `0.7` on `generateText`; 1.0 sends `temperature` only when the caller sets it, on every path (`generateText`, `generateObject`, `streamText`, `ctx.step.ai.*`, `map`, both batch bodies). Set it explicitly where a fixed value was relied upon.
- **Suspended events are emitted once per wait.** A replay no longer re-emits `stage:suspended` / `workflow:suspended` on every poll while the stage is waiting on the same step with the same deadline; they fire when the wait starts and when the stage moves to a different wait.
- **`stage.pollSuspended` claims a stage before replaying it.** A version-guarded `nextPollAt` lease (`max(pollInterval, 60s)`) stops two orchestrating processes replaying the same suspended stage; a stage this build cannot serve is handed back to its existing deadline. No schema change.
- **Batch results are validated and repaired.** In 0.13 batch results were never validated after a resume. In 1.0 every `map` item is validated against `schema`; items that fail go through the realtime repair pass (`repair.attempts`, default 1), which costs a realtime call per failed item. A WARN naming the batch id, the failure class (provider error or schema validation) and the first error is logged when more than half of a batch fails, and the poll logs a WARN when the provider reports failed requests. The Google batch path sends the engine's own union-preserving conversion of the JSON Schema as `responseSchema` (Gemini's batch endpoint does not honour `responseJsonSchema`, and the provider's conversion drops discriminated unions).
- **Structured-output schemas are made portable per target.** A `z.discriminatedUnion` emits `oneOf`, which OpenAI's strict structured outputs (native and via OpenRouter) reject and Gemini drops. Every JSON `responseFormat` sent to an OpenAI, OpenRouter or Google model — `generateObject`, `generateText` + `Output.object`, `streamText`, `ctx.step.ai.*`, batch bodies — is rewritten at the model boundary (`oneOf` → `anyOf`; `additionalProperties: false` and every property required-but-nullable for OpenAI; a `z.record()` sent to OpenAI as an array of `{ key, value }` pairs and rebuilt before validation, since strict mode has no map type); validation still runs against your Zod schema. A keyword strict mode cannot express (`patternProperties`, `if`/`then`/`else`, ...) throws `UnportableSchemaError` before the request instead of a provider 400. Nothing to change unless you relied on sending `oneOf`, `propertyNames` or an open `additionalProperties` verbatim to one of these providers.
- **Failed steps are re-executed on the next job attempt.** A retryable failure keeps the stage's ledger rows; on the retry, completed steps are replayed from the ledger while every `run` step and every `map` item that ended `failed` is re-opened and executed again (so a `${id}:submit` that hit a 503, or an item whose repair budget ran out, gets a fresh call). A replay of the same attempt (a poll) still answers failures from the ledger. The map's `:submit` step has no retry of its own — the job's attempt budget is its retry. A reopened row keeps counting: `workflow_steps.attempt` is the number of executions of that step across job attempts. `WorkflowStage.attempt` counts job retries as well as `run.rerunFrom` reruns (0 on the first execution), and a retried stage that completes — directly or after a suspension — clears its `errorMessage`.
- **Outbox delivery (1.0.0-alpha.21).** Delivery is at least once until the retry budget is exhausted; see the upgrade step above for claim expiry, deduplication, replay and custom adapters.
- **`stage:retrying`.** A retried attempt emits `stage:retrying` (`attempt`, `maxAttempts`, `error`) instead of `stage:failed`; `stage:failed` now means the stage row is `FAILED`. Event consumers that alerted on every `stage:failed` see one alert per terminal failure.
- **Host job results carry the retry contract.** `executeJobWithHeartbeat` (and the serverless host's `handleJob`) return `willRetry`, `attempt`, `maxAttempts` and `retryDelayMs`; a push transport whose `fail()` cannot re-enqueue must retry the message after `retryDelayMs` when `willRetry` is true and acknowledge it otherwise. Malformed job messages (no `payload`, no `workflowId`) are failed and acknowledged as dead jobs instead of throwing.
- **Realtime map retries are in-process.** `realtime.retries` re-calls the model inside the same `execute()` after `retryDelayMs`, bumping the ledger row's `attempt`; the stage no longer suspends and replays per failed item. `ctx.step.run` retries still suspend.
- **The host stamps its `workerId` on the job queue (host-node 0.4.4).** `createNodeHost(...).start()` hands its `workerId` to the transport, so `job_queue.workerId` matches the host instead of the queue's generated `worker-<pid>-<timestamp>`. Change `createPrismaJobQueue(prisma, { workerId })` to `createPrismaJobQueue(prisma)` under a host; a transport that keeps an explicit id gets a one-line `workerId mismatch` warning at startup. Existing job rows are not rewritten.
- **A multi-stage run is no longer pinned to one worker (host-node 0.4.4).** The host that completes a job enqueues the next execution group in-process, and used to win it back straight away while every other worker was still parked in its poll timer. The job loop now pauses for a uniform draw over `[0, postJobYieldMs)` after a completed job — default `jobPollIntervalMs`, `0` to disable — skipped while it is draining jobs from other runs. Expect a single-worker deployment's sequential pipeline to take up to `jobPollIntervalMs` longer per stage hand-off unless you set `postJobYieldMs: 0`; see 03-runtime-setup.md.
- **Hosts flush the outbox when they finish work.** `NodeHost.stop()` waits for the in-flight job (bounded by `shutdownTimeoutMs`, default 10s) and then attempts a final `outbox.flush` (`flushOutboxOnStop: false` opts out). Events not delivered before the timeout remain available to a later flush. The serverless host has no lifecycle, so it flushes after each `handleJob` (`flushOutboxAfterJob`, default true, bounded by `outboxFlushTimeoutMs`). `runToCompletion` from `@bratsos/workflow-engine-host-serverless` is the supported way to create a run and drive it to a terminal state inside one request; see `03-runtime-setup.md`.
- **A failed stage transitions the run immediately** on every host. With retries remaining the job is re-enqueued with backoff and the stage row is not `FAILED`; with none remaining `run.transition` runs at once with the stage error on the run.
- **Batch accounting rows** store the item prompt, the model's reply (its raw text when it failed validation) and `metadata.batchDurationMs` (the batch wall time). There is no per-row `durationMs` on batch rows: providers report no per-item latency.
- **Run totals on failed runs.** `WorkflowRun.totalCost` / `totalTokens` are rolled up on `FAILED` runs too, and a failed `generateObject` call logs the tokens (and cost) its `NoObjectGeneratedError` carried instead of 0/0.
- **Step order warnings.** Each `ctx.step.*` id consumes a sequence number on every replay, including items answered from the ledger. Keep the item list of a `map` identical across replays (filter through an outside cache *inside* a step, or not at all) or every step after the map logs `non-deterministic step order`.

## New features

See the 1.0 changeset and `12-durable-steps.md`: `ctx.step.run/waitFor/waitForSignal/sleep` (with `heartbeat`, `retryBackoff`, `onReclaim` and `keepalive`), `ctx.step.ai.generateText/generateObject/streamText/map`, `createTestHarness` (with `harness.steps` mocks, `start`/`tickUntil` and `cancel`; `07-testing-patterns.md`), the builder inference types (`InferWorkflowContext`, `InferWorkflowInput`, `InferWorkflowOutput`, `InferWorkflowStageIds`, `InferStageOutputById`), `AIHelperOptions.adapter`, per-call timeouts (`AICallTimeoutError`), `createKernel({ services, stepLedger, spillThresholdBytes })`, the `step.signal`, `job.heartbeat`, `run.redrive`, `run.listVersions` and `run.purge` commands, `createPrismaStepLedger` / `createPrismaBlobStore`, `workflow_engine_enqueue` (`sql/enqueue.sql`, applied by your own migration after the tables exist; `05-persistence-setup.md`), per-group dequeue fairness (`createPrismaJobQueue(prisma, { fairness })`), `shadowRuns` / `shadowVersions` / `assertShadowCompatible` in the testing entry, and the `@bratsos/workflow-engine-console` package (`16-operational-console.md`).
