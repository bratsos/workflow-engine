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
  | `outbox_events` | `sequence INT`, `causationId TEXT`, `occurredAt TIMESTAMP`, `publishedAt`, `retryCount INT DEFAULT 0`, `dlqAt TIMESTAMP` | `appendEvents` / `outbox.flush` | every command that emits an event throws |
  | `idempotency_keys` | `createdAt TIMESTAMP NOT NULL DEFAULT now()` | `acquireIdempotencyKey` writes it explicitly so an injected `Clock` is authoritative | **every** `dispatch` fails with `Unknown argument createdAt` |
  | `idempotency_keys` | `commandType TEXT`, `result JSONB` | same | same |

  ```sql
  -- The three that 1.0 consumers actually tripped on
  ALTER TABLE "workflow_stages"   ADD COLUMN IF NOT EXISTS "attempt"   INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE "workflow_stages"   ADD COLUMN IF NOT EXISTS "version"   INTEGER NOT NULL DEFAULT 1;
  ALTER TABLE "idempotency_keys"  ADD COLUMN IF NOT EXISTS "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
  ```

  The reliable check is a diff: `npx prisma migrate diff --from-schema-datasource prisma/schema.prisma --to-schema-datamodel node_modules/@bratsos/workflow-engine/prisma/schema.prisma --script` prints the SQL that separates your database from the package schema (ignore the differences on your own tables).

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
  - `claimUnpublishedOutboxEvents(limit)` and `releaseOutboxEvents(ids)` — the
    outbox flush claims rows (stamping `publishedAt`) before it emits them.
  - `supportsDefinitionVersioning()`, `insertDefinitionIfAbsent(input)`,
    `getDefinition(workflowId, version)` and
    `countRunsByDefinitionVersion(filter?)`; an adapter without the schema
    returns `false` / `null` / `null` / `[]`. `ensureDefinitionVersioningDetected()`
    is optional.
  - `listRunsForPurge(cutoff, statuses, limit)` and `deleteRun(id)` for
    `run.purge`.
  - `claimNextPendingRun({ now?, serves? })`: a run is claimable only when it is
    pinned to one of the `serves` pairs, or unpinned *and* one of the pairs
    names its workflow; an empty `serves` claims nothing; omitted, it is the
    pre-1.0 predicate. An adapter with no `definitionVersion` column may
    ignore it.
  - `getSuspendedStages(beforeDate, { limit?, serves? })` must return rows
    oldest `nextPollAt` first, capped at `limit`, and filtered by `serves`
    (ignorable on a schema with no `definitionVersion` column).
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

- [ ] **Update the AI SDK peer range.** 1.0 targets AI SDK 7. `ai@^7`, `@ai-sdk/google@^4` and `@openrouter/ai-sdk-provider@^3` are regular dependencies of the package, so they come with it — but any `ai` your own code imports (an `Output.object(...)`, a hand-built `streamText`) must be on `^7` too, or two copies coexist. The optional peers are `@ai-sdk/anthropic@>=4.0.46` / `@ai-sdk/openai@>=4.0.53` (only if you batch natively against them; without them the helper falls back to OpenRouter with a WARN), and `zod@^4.1.12` / `@prisma/client@>=6` are unchanged.

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

- **A reclaimed batch submit no longer creates a second provider batch (1.0.0-alpha.9).** A worker that died between the provider accepting a `ctx.step.ai.map` batch and the ledger recording it left the step `running`; the replay after the lease expired submitted the whole batch again, and the first was orphaned and still billed. Every `run` step now carries a deterministic external key (`workflow_steps.externalKey`, written before the body runs), `ctx.step.run(id, fn)` passes it to the body as `fn({ stepId, externalKey, attempt, isReclaim })`, and the OpenAI and Google batch adapters stamp it into the provider fields they can search (`metadata` and `displayName`) so a reclaimed submit adopts the existing batch. **Add the column** (`ALTER TABLE "workflow_steps" ADD COLUMN IF NOT EXISTS "externalKey" TEXT;`). **One behaviour change:** on Anthropic and OpenRouter, which offer no searchable field, a reclaimed submit now throws `BatchNotAdoptableError` instead of duplicating — pass `batch: { onReclaim: "resubmit" }` on the map to accept the duplicate cost. A step whose body cannot be recovered at all can declare `ctx.step.run(id, fn, { onReclaim: "fail" })`, which fails with `StepNotReplaySafeError` rather than re-executing; the default stays `"rerun"`.

- **Timestamps written by raw statements are explicitly UTC (1.0.0-alpha.8).** The `FOR UPDATE SKIP LOCKED` claim and dequeue and the outbox claim now write `$n::timestamptz AT TIME ZONE 'UTC'` instead of a bare bound `Date`, which Postgres converted through the *session* timezone on the way into the naive `timestamp` columns. On a non-UTC session that put `job_queue.lockedAt` hours in the future and stale-lease recovery never fired — a crashed worker's job stayed `RUNNING` forever, in 0.13 and in the 1.0 alphas alike. **No schema change is required**, but check that you did not map any engine timestamp column to `@db.Timestamptz`: the engine's columns must stay plain Prisma `DateTime` (naive `timestamp` holding UTC), as `prisma/schema.prisma` declares them. If you did map one, revert it with `ALTER TABLE "job_queue" ALTER COLUMN "lockedAt" TYPE timestamp(3) USING "lockedAt" AT TIME ZONE 'UTC';` (same shape for the other columns).
- **A racing job is re-delivered instead of discarded (1.0.0-alpha.8).** `run.claimPending` enqueues a claimed run's first-stage job *after* the claim transaction commits, so a job loop can no longer dequeue a job whose run is still `PENDING` — a race that wedged the majority of runs at a short `jobPollIntervalMs` in 0.13 and in the 1.0 alphas alike. `JobExecuteResult` gains `ghostReason` (`"race"` | `"orphan"` | `"version"`) next to `ghost: true`; the built-in hosts re-deliver a `"race"`, defer a `"version"` (a run pinned to a definition version this build does not serve — through `JobTransport.defer` when the transport has it, so no attempt is spent) and still fail an `"orphan"` terminally. Nothing to change unless you wrote your own host loop against `ghost`: it keeps working, but read `ghostReason` to pick the recovery up.
- **`run.rerunFrom` is deprecated for `run.redrive`.** `run.redrive({ workflowRunId, from?, definitionVersion?, idempotencyKey? })` takes `from: { kind: "lastFailure" } | { kind: "start" } | { kind: "stage", stageId }` (default `lastFailure`). For `lastFailure` and `stage` the resumed stage record is reopened in place — back to `PENDING`, `attempt` incremented, error/output/timings cleared — so its durable step ledger survives: every `completed` step row is answered from the ledger, rows naming an external effect are re-opened, and waits, sleeps and failed rows without an external key are dropped through `StepLedger.clearExcept`. Stages after it are archived and deleted; `start` replaces everything. Every superseded record is archived first as a stage-scoped `run.supersededAttempt` annotation (with `abandonedSteps` when a dropped row named an external effect), and `definitionVersion: "latest"` re-pins the run onto the version this build serves — the remedy for a run stranded at a version nothing serves. The result is `{ workflowRunId, fromStageId, supersededStages, redriveCount, definitionVersion }`. `run.rerunFrom` keeps its result shape and now delegates, so it gets the same behaviour; move to `run.redrive` when you touch the call. See `14-redrive.md`.
- **Runs can be pinned to a definition version.** With the columns above, `run.create` stamps each run with a content-addressed version (`workflow.definitionVersion`, `sha256-…`, or one you declare with `defineWorkflow(...).version("...")`) and stores the structure as a `workflow_definitions` snapshot. Claiming, job dequeue and suspended-stage polling then take only the runs this build serves when the registry is built with `createWorkflowRegistry(workflows)`; a hand-written `{ getWorkflow }` registry cannot enumerate and keeps the old predicate, and `serves: "all"` on either host restores it explicitly. **Two changes in the default:** an unpinned run is claimable only by a host whose served definitions name its workflow, and `run.claimPending` no longer adopts-and-fails a run whose workflow is missing from an enumerating registry — it leaves it `PENDING` and `run.listVersions` reports it under `unservedHere`. Re-registering an explicit version with a different structure throws `DefinitionVersionConflictError`. See `13-definition-versioning.md`.
- **Retention: `run.purge`.** New command `{ type: "run.purge", olderThan, statuses?, limit? }` → `{ purged, workflowRunIds }` clears the step ledger, blobs and job rows and deletes the run with everything under it. Both hosts run it on the maintenance tick when given `retention: { olderThanMs, statuses?, limit? }` (off by default); `MaintenanceTickCounts` gains `purged`.
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
- **Outbox delivery is once per outbox.** `outbox.flush` claims rows (stamps `publishedAt`) before emitting, with `FOR UPDATE SKIP LOCKED` on Postgres, so two hosts ticking the same outbox no longer both deliver `workflow:created`. A custom `WorkflowPersistence` gains two required methods, `claimUnpublishedOutboxEvents(limit)` and `releaseOutboxEvents(ids)` (see 05-persistence-setup.md); the conformance suite exercises them.
- **`stage:retrying`.** A retried attempt emits `stage:retrying` (`attempt`, `maxAttempts`, `error`) instead of `stage:failed`; `stage:failed` now means the stage row is `FAILED`. Event consumers that alerted on every `stage:failed` see one alert per terminal failure.
- **Host job results carry the retry contract.** `executeJobWithHeartbeat` (and the serverless host's `handleJob`) return `willRetry`, `attempt`, `maxAttempts` and `retryDelayMs`; a push transport whose `fail()` cannot re-enqueue must retry the message after `retryDelayMs` when `willRetry` is true and acknowledge it otherwise. Malformed job messages (no `payload`, no `workflowId`) are failed and acknowledged as dead jobs instead of throwing.
- **Realtime map retries are in-process.** `realtime.retries` re-calls the model inside the same `execute()` after `retryDelayMs`, bumping the ledger row's `attempt`; the stage no longer suspends and replays per failed item. `ctx.step.run` retries still suspend.
- **The host stamps its `workerId` on the job queue (host-node 0.4.4).** `createNodeHost(...).start()` hands its `workerId` to the transport, so `job_queue.workerId` matches the host instead of the queue's generated `worker-<pid>-<timestamp>`. Change `createPrismaJobQueue(prisma, { workerId })` to `createPrismaJobQueue(prisma)` under a host; a transport that keeps an explicit id gets a one-line `workerId mismatch` warning at startup. Existing job rows are not rewritten.
- **A multi-stage run is no longer pinned to one worker (host-node 0.4.4).** The host that completes a job enqueues the next execution group in-process, and used to win it back straight away while every other worker was still parked in its poll timer. The job loop now pauses for a uniform draw over `[0, postJobYieldMs)` after a completed job — default `jobPollIntervalMs`, `0` to disable — skipped while it is draining jobs from other runs. Expect a single-worker deployment's sequential pipeline to take up to `jobPollIntervalMs` longer per stage hand-off unless you set `postJobYieldMs: 0`; see 03-runtime-setup.md.
- **Hosts flush the outbox when they finish work.** `NodeHost.stop()` waits for the in-flight job (bounded by `shutdownTimeoutMs`, default 10s) and then runs a final `outbox.flush` (`flushOutboxOnStop: false` opts out), so `workflow:completed` for a run finished by that process is published before it exits instead of by whichever process ticks next. The serverless host has no lifecycle, so it flushes after each `handleJob` (`flushOutboxAfterJob`, default true, bounded by `outboxFlushTimeoutMs`). `runToCompletion` from `@bratsos/workflow-engine-host-serverless` is the supported way to create a run and drive it to a terminal state inside one request; see `03-runtime-setup.md`.
- **A failed stage transitions the run immediately** on every host. With retries remaining the job is re-enqueued with backoff and the stage row is not `FAILED`; with none remaining `run.transition` runs at once with the stage error on the run.
- **Batch accounting rows** store the item prompt, the model's reply (its raw text when it failed validation) and `metadata.batchDurationMs` (the batch wall time). There is no per-row `durationMs` on batch rows: providers report no per-item latency.
- **Run totals on failed runs.** `WorkflowRun.totalCost` / `totalTokens` are rolled up on `FAILED` runs too, and a failed `generateObject` call logs the tokens (and cost) its `NoObjectGeneratedError` carried instead of 0/0.
- **Step order warnings.** Each `ctx.step.*` id consumes a sequence number on every replay, including items answered from the ledger. Keep the item list of a `map` identical across replays (filter through an outside cache *inside* a step, or not at all) or every step after the map logs `non-deterministic step order`.

## New features

See the 1.0 changeset and `12-durable-steps.md`: `ctx.step.run/waitFor/waitForSignal/sleep` (with `heartbeat`, `retryBackoff`, `onReclaim` and `keepalive`), `ctx.step.ai.generateText/generateObject/streamText/map`, `createTestHarness` (with `harness.steps` mocks, `start`/`tickUntil` and `cancel`; `07-testing-patterns.md`), the builder inference types (`InferWorkflowContext`, `InferWorkflowInput`, `InferWorkflowOutput`, `InferWorkflowStageIds`, `InferStageOutputById`), `AIHelperOptions.adapter`, per-call timeouts (`AICallTimeoutError`), `createKernel({ services, stepLedger, spillThresholdBytes })`, the `step.signal`, `job.heartbeat`, `run.redrive`, `run.listVersions` and `run.purge` commands, `createPrismaStepLedger` / `createPrismaBlobStore`, `workflow_engine_enqueue` (`sql/enqueue.sql`, applied by your own migration after the tables exist; `05-persistence-setup.md`), per-group dequeue fairness (`createPrismaJobQueue(prisma, { fairness })`), `shadowRuns` / `shadowVersions` / `assertShadowCompatible` in the testing entry, and the `@bratsos/workflow-engine-console` package (`16-operational-console.md`).
