---
sidebar_position: 1
title: Prisma Setup
---

# Prisma Setup

**workflow-engine** uses Prisma to manage state persistence in a database-native way. PostgreSQL is the production path; SQLite is supported on Prisma 6, 7 and 8 for single-process deployments and local development.

---

## Which Prisma

One engine build runs on Prisma 6, 7 and 8, against the same tables and the same conformance suites on each major. The setup differs, so pick the path first:

| | Prisma 7 (default) | Prisma 6 | Prisma 8 (release candidate) |
|---|---|---|---|
| Schema file | `prisma/schema.prisma` | `prisma/schema.prisma` | `prisma/contract.prisma` for PostgreSQL; `prisma/contract.prisma` copied from `contract-sqlite.prisma` for SQLite |
| Packages | `prisma`, `@prisma/client`, `@prisma/adapter-pg` for PostgreSQL; `@prisma/adapter-better-sqlite3` for SQLite | `prisma`, `@prisma/client` (native SQLite client) | `prisma` and the matching `@prisma/orm-postgres` or `@prisma/orm-sqlite` package (no `@prisma/client`) |
| Create the tables | `prisma migrate dev` / `db push`, then `prisma generate` | same as 7 | `prisma contract emit`, `prisma db init`; PostgreSQL also needs [one SQL file](#the-mixed-order-indexes) |
| What you pass to the factories | the `PrismaClient` | the `PrismaClient` | `fromPrisma8(db)` |
| Databases | PostgreSQL, SQLite | PostgreSQL, SQLite | PostgreSQL, SQLite |
| Console `--database-url` | PostgreSQL path; use `--config` for SQLite | PostgreSQL path; use `--config` for SQLite | no: use `--config` |

* **New projects should start on Prisma 7.** Prisma 6 receives only security patches until 2026-11-19, per Prisma's [release status page](https://www.prisma.io/docs/orm/release-status).
* **Prisma 8 is a release candidate.** Pin `prisma@8.0.0-rc.29` and the matching target package: `@prisma/orm-postgres@8.0.0-rc.21` or `@prisma/orm-sqlite@8.0.0-rc.21`. Do not use `latest` for the Prisma CLI or driver packages.
* **Prisma 8 SQLite uses the same adapter option as Prisma 6 and 7.** Wrap the SQLite runtime with `fromPrisma8(db)` and pass `{ databaseType: "sqlite" }` to each SQLite-aware adapter. `fromPrisma8` reads the target from `db.contract`; it takes no new options.
* `npx prisma` without a local install now runs Prisma 8. A Prisma 6 or 7 project needs `prisma` as a local dependency, or `npx prisma` runs the wrong major.

The rest of this page describes the Prisma 6 and 7 path and the shared SQLite adapter options; the [Prisma 8](#prisma-8) section covers Prisma 8 setup for both databases.

---

## Authoritative Prisma Schema

The package ships this schema at `node_modules/@bratsos/workflow-engine/prisma/schema.prisma` (Prisma 6 and 7; Prisma 8 uses [`contract.prisma`](#prisma-8)); copy the definitions into your own `prisma/schema.prisma`. In a project with no schema yet, copy the whole file: it carries the `generator` and `datasource` blocks too. For SQLite on Prisma 6 or 7, use the complete conversion in [SQLite setup](#2-sqlite-setup-prisma-6-7-and-8); changing only `provider` leaves PostgreSQL-only types behind. Ensure that all model names map to their plural database equivalents using `@@map`. The Prisma adapters require every model *and column* below — a wall of `PrismaClient is not assignable to EnginePrismaClient` errors means a delegate is missing (after 1.0, almost always `workflowStep` or `workflowDefinition`). Upgrading an existing database? The [0.13 → 1.0 guide](../migrations/migrate-0.13-to-1.0.md) has the column-level checklist as idempotent SQL.

Definition registration requires `$executeRaw` on injected clients. Keep `@@map("workflow_definitions")` and its shipped column names: the raw SQL does not support remapping that table or its columns.

```prisma
// schema.prisma

// 1. Unified status enum for runs, stages, and jobs
enum Status {
  PENDING
  RUNNING
  SUSPENDED
  COMPLETED
  FAILED
  CANCELLED
  SKIPPED
}

// 2. The workflow run model
model WorkflowRun {
  id            String               @id @default(cuid())
  createdAt     DateTime             @default(now())
  updatedAt     DateTime             @updatedAt
  version       Int                  @default(1)
  workflowId    String
  workflowName  String
  workflowType  String
  status        Status               @default(PENDING)
  startedAt     DateTime?
  completedAt   DateTime?
  duration      Int?                 // Duration of execution in seconds
  input         Json
  output        Json?
  config        Json                 @default("{}")
  totalCost     Float                @default(0)
  totalTokens   Int                  @default(0)
  priority      Int                  @default(5)
  metadata      Json?

  // The definition version this run is pinned to. NULL means the run was
  // created before the consumer migrated to definition versioning: it is
  // claimable and executable by any host, exactly as before. See
  // `workflow_definitions` for the structure the version identifies.
  definitionVersion String?
  // How many times `run.redrive` has re-driven this run. Never reset -- it counts the whole life of the run.
  redriveCount      Int     @default(0)

  stages        WorkflowStage[]
  logs          WorkflowLog[]
  artifacts     WorkflowArtifact[]
  annotations   WorkflowAnnotation[]

  // List orderings. Every "recent runs" view -- the console's included --
  // is newest-first, optionally narrowed by status or workflow, and pages
  // on the keyset (createdAt, id), so the tiebreaker travels in the index
  // and a page is one index range scan with no sort node. These replace
  // the bare @@index([status]) / @@index([workflowId]): a composite whose
  // leading column is the same serves every lookup the single-column
  // index served.
  @@index([createdAt(sort: Desc), id(sort: Desc)])
  @@index([status, createdAt(sort: Desc), id(sort: Desc)])
  @@index([workflowId, createdAt(sort: Desc), id(sort: Desc)])
  // The claim: status = 'PENDING' ORDER BY priority DESC, "createdAt" ASC
  // LIMIT 1 FOR UPDATE SKIP LOCKED, run maxClaimsPerTick times per tick
  // per host. The same shape job_queue already indexes, and it needs its
  // own: the (status, createdAt DESC, id DESC) index above cannot serve it
  // because priority is not in it, so the claim reads every PENDING row
  // and top-N sorts it. Measured on Postgres 16, 300k runs / 60k pending:
  // 11.8-15.1 ms before, 0.008-0.022 ms after, for 9 MB of index.
  @@index([status, priority(sort: Desc), createdAt])
  // Definition versioning. The first serves a lookup narrowed to one
  // version with no workflow. The second is the narrow stand-in for the
  // @@index([status]) the list orderings above replaced -- a status count
  // runs index-only off it (3.3 ms at 60k rows, against a heap scan) --
  // and it also narrows the version-filtered claim. It does NOT cover
  // `run.listVersions`: that handler passes no status filter and its
  // aggregate asks for a MIN(createdAt) the index does not carry, so all
  // three of its shapes plan a parallel sequential scan whatever is here.
  @@index([definitionVersion])
  @@index([status, workflowId, definitionVersion])
  @@map("workflow_runs")
}

// Content-addressed workflow definition snapshots. One row per distinct
// (workflowId, version); every run pinned to that version references it,
// so the storage cost is per definition rather than per run.
model WorkflowDefinition {
  workflowId String
  version    String
  createdAt  DateTime @default(now())
  // The structure the version identifies: stage ids, execution groups,
  // definition order, dependencies, modes and normalised JSON Schemas.
  // See `core/definition-version.ts` for the exact shape.
  snapshot   Json
  // Hash of `snapshot`. Equal to `version` for derived versions; for an
  // explicit version it is what lets the engine reject re-registering the
  // same version with a different structure.
  structureHash String

  // No @@index([workflowId]): the compound primary key already leads with
  // it, so a lookup by workflow alone plans identically with and without
  // one (measured: 0.188 ms vs 0.187 ms at 20k rows) -- and no query in
  // the engine reads this table by workflow alone anyway.
  @@id([workflowId, version])
  @@map("workflow_definitions")
}

// 3. Individual stage execution model
model WorkflowStage {
  id              String               @id @default(cuid())
  createdAt       DateTime             @default(now())
  updatedAt       DateTime             @updatedAt
  version         Int                  @default(1)
  workflowRunId   String
  workflowRun     WorkflowRun          @relation(fields: [workflowRunId], references: [id], onDelete: Cascade)
  stageId         String
  stageName       String
  stageNumber     Int
  executionGroup  Int
  attempt         Int                  @default(0)
  status          Status               @default(PENDING)
  startedAt       DateTime?
  completedAt     DateTime?
  duration        Int?                 // Duration of execution in seconds
  inputData       Json?
  outputData      Json?
  config          Json?
  suspendedState  Json?
  resumeData      Json?
  nextPollAt      DateTime?
  pollInterval    Int?
  maxWaitUntil    DateTime?
  metrics         Json?
  embeddingInfo   Json?
  errorMessage    String?

  logs            WorkflowLog[]
  artifacts       WorkflowArtifact[]
  annotations     WorkflowAnnotation[]
  steps           WorkflowStep[]

  @@unique([workflowRunId, stageId])
  @@index([status])
  @@index([nextPollAt])
  @@map("workflow_stages")
}

// 3b. Durable step ledger (drives ctx.step.*; used by createPrismaStepLedger)
model WorkflowStep {
  id            String   @id @default(cuid())
  stageRecordId String
  // Cascade from the stage record, so deleting a stage (or the run above it)
  // removes its ledger rows instead of orphaning them. Constraint name:
  // workflow_steps_stageRecordId_fkey.
  stage         WorkflowStage @relation(fields: [stageRecordId], references: [id], onDelete: Cascade)
  stepId        String
  seq           Int
  kind          String        // "run" | "wait" | "signal" | "sleep"
  status        String
  attempt        Int       @default(1)
  leaseExpiresAt DateTime?
  deadlineAt     DateTime?
  // Deterministic name for the external effect a `run` step body creates,
  // written before the body runs so an orphaned provider-side effect can be
  // found from the row after a crash.
  externalKey    String?
  result        Json?
  error         String?
  waitState     Json?
  createdAt     DateTime @default(now())
  updatedAt     DateTime @updatedAt

  @@unique([stageRecordId, stepId])
  @@index([stageRecordId])
  @@map("workflow_steps")
}

// 4. Execution log lines (drives ctx.log)
model WorkflowLog {
  id              String         @id @default(cuid())
  createdAt       DateTime       @default(now())
  workflowRunId   String?
  workflowRun     WorkflowRun?   @relation(fields: [workflowRunId], references: [id], onDelete: Cascade)
  workflowStageId String?
  workflowStage   WorkflowStage? @relation(fields: [workflowStageId], references: [id], onDelete: Cascade)
  level           String
  message         String
  metadata        Json?

  @@index([workflowRunId])
  @@index([workflowStageId])
  @@map("workflow_logs")
}

// 5. Blob-metadata / artifacts
model WorkflowArtifact {
  id              String         @id @default(cuid())
  createdAt       DateTime       @default(now())
  updatedAt       DateTime       @updatedAt
  workflowRunId   String
  workflowRun     WorkflowRun    @relation(fields: [workflowRunId], references: [id], onDelete: Cascade)
  workflowStageId String?
  workflowStage   WorkflowStage? @relation(fields: [workflowStageId], references: [id], onDelete: SetNull)
  key             String
  type            String
  data            Json
  size            Int
  metadata        Json?

  @@unique([workflowRunId, key])
  @@index([workflowRunId])
  @@map("workflow_artifacts")
}

// 6. AI call logger for cost and token analytics
model AICall {
  id            String   @id @default(cuid())
  createdAt     DateTime @default(now())
  topic         String
  callType      String
  modelKey      String
  modelId       String
  prompt        String   @db.Text
  response      String   @db.Text
  inputTokens   Int
  outputTokens  Int
  cost          Float
  metadata      Json?

  batchId      String?
  requestId    String?

  @@unique([batchId, requestId], map: "ai_calls_batch_request_unique")
  @@index([batchId])
  @@index([topic])
  @@map("ai_calls")
}

// 7. Provenance Annotations (v0.8.0+)
model WorkflowAnnotation {
  id                    String         @id @default(cuid())
  createdAt             DateTime       @default(now())
  workflowRunId         String
  workflowRun           WorkflowRun    @relation(fields: [workflowRunId], references: [id], onDelete: Cascade)
  workflowStageRecordId String?
  workflowStage         WorkflowStage? @relation(fields: [workflowStageRecordId], references: [id], onDelete: SetNull)
  attempt               Int            @default(0)
  scope                 String         // "run" | "stage" | "ai_call" | custom
  scopeId               String?
  actorKind             String?        // "agent" | "user" | "system"
  actorId               String?
  actorVersion          String?
  key                   String         // Dot-namespaced key
  value                 Json           // Scalar or scalar array
  payload               Json?          // Opt-in rich blob details
  idempotencyKey        String?

  @@unique([workflowRunId, key, idempotencyKey])
  @@index([workflowRunId, key])
  @@index([workflowRunId, createdAt])
  @@index([workflowRunId, scope])
  @@index([workflowRunId, actorId])
  @@map("workflow_annotations")
}

// 8. Distributed job queue
model JobQueue {
  id            String    @id @default(cuid())
  createdAt     DateTime  @default(now())
  updatedAt     DateTime  @updatedAt
  workflowRunId String
  stageId       String
  status        Status    @default(PENDING)
  priority      Int       @default(5)
  attempt       Int       @default(0)
  maxAttempts   Int       @default(3)
  workerId      String?
  lockedAt      DateTime?
  startedAt     DateTime?
  completedAt   DateTime?
  nextPollAt    DateTime?
  payload       Json?
  lastError     String?

  // The dequeue: status = 'PENDING' ORDER BY priority DESC, "createdAt" ASC
  // LIMIT 1 FOR UPDATE SKIP LOCKED. This replaces the bare
  // @@index([status, priority]) -- a composite whose leading columns are
  // the same serves every lookup that one served. Carrying the createdAt
  // tiebreak is what removes the sort node: without it a deep queue reads
  // and sorts every PENDING row on every claim (measured on Postgres 16,
  // flat priorities: 0.55 ms at 1,000 ready rows, 26.7 ms at 50,000; with
  // it, 0.03 ms and 0.04 ms -- flat with depth).
  //
  // It costs more on disk than the index it replaces, and the reason is
  // worth knowing: (status, priority) is almost entirely duplicate keys,
  // which btree deduplication collapses, while adding createdAt makes
  // every key distinct. Measured at 150,000 rows: 1 MB -> 10 MB.
  @@index([status, priority(sort: Desc), createdAt])
  // Queue health reports the age of the oldest waiting job as
  // MIN("createdAt") within a status. Completed rows are retained rather
  // than deleted, so [status, priority] would have to scan every row of
  // the status to find it.
  @@index([status, createdAt])
  @@index([nextPollAt])
  @@map("job_queue")
}

// 9. Transactional outbox
model OutboxEvent {
  id              String    @id @default(cuid())
  createdAt       DateTime  @default(now())
  workflowRunId   String
  sequence        Int
  eventType       String
  payload         Json
  causationId     String
  occurredAt      DateTime
  publishedAt     DateTime?
  retryCount      Int       @default(0)
  dlqAt           DateTime?

  @@unique([workflowRunId, sequence])
  @@index([publishedAt])
  // Dead letters are a subset of the unpublished rows, so without this the
  // dead-letter view has to walk every unpublished event and fetch its heap
  // tuple -- which is slowest exactly when a backlog has built up and you
  // most want to read it. Postgres users writing migrations by hand should
  // prefer a partial index (WHERE "dlqAt" IS NOT NULL); Prisma cannot
  // express one, and this is the closest it gets.
  @@index([dlqAt])
  @@map("outbox_events")
}

// 10. Command idempotency
model IdempotencyKey {
  id          String   @id @default(cuid())
  createdAt   DateTime @default(now())
  key         String
  commandType String
  result      Json

  @@unique([key, commandType])
  @@map("idempotency_keys")
}

// 11. Optional: a blob store in the database (createPrismaBlobStore).
// Every process that executes or polls a run must read the same blob store;
// this makes the database that store without object storage. Requires only
// the workflowBlob delegate, not a change to the persistence client.
model WorkflowBlob {
  key       String   @id
  data      Json
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  @@map("workflow_blobs")
}
```

---

## Applying the Schema

After copying the models, set the database URL and run the Prisma migration command to apply the changes to your database. (Prisma 8 has no `migrate dev`, `db push` or `generate`; see [Prisma 8](#prisma-8).)

Prisma 7 sets the URL in `prisma.config.ts`, not in the schema. Its `datasource` block has only `provider`:

```ts
import { defineConfig, env } from "prisma/config";
export default defineConfig({ schema: "prisma/schema.prisma", datasource: { url: env("DATABASE_URL") } });
```

On Prisma 6, add `url = env("DATABASE_URL")` to the `datasource` block (the shipped schema has none, because Prisma 7 rejects it) and skip the config file.

```bash
# Generate the migration and apply to database
npx prisma migrate dev --name add-workflow-engine-tables

# Generate the Prisma client
npx prisma generate
```

---

## Prisma 8

> **Release candidate.** Pin `prisma@8.0.0-rc.29` with the matching target package: `@prisma/orm-postgres@8.0.0-rc.21` or `@prisma/orm-sqlite@8.0.0-rc.21`. Do not use `latest` for these packages.

Prisma 8 has no `@prisma/client`, no `schema.prisma` and no model delegates. You write a *contract*, emit it, and talk to the database through the matching `postgres({ contract, url })` or `sqlite({ contract, path })` runtime. The engine's Prisma adapters expect the Prisma 6 and 7 client surface, so one wrapper, `fromPrisma8(db)`, gives a Prisma 8 client that surface. The adapters themselves are the same code on all three majors, and the engine imports nothing from Prisma.

### Requirements

* **Node.js** 22.18+, 24.11+ or 26+ for the Prisma 8 PostgreSQL path. See [SQLite setup](#2-sqlite-setup-prisma-6-7-and-8) for its tested Node floor.
* **TypeScript** 5.9+, with `skipLibCheck: true`: the AI SDK's types import `json-schema`, which ships none
* **PostgreSQL** 15+ for the Postgres target
* **An ES module project**, `"type": "module"` in `package.json`: the generated `migration.ts`, and any `.ts` file you run with `node`, fail without it
* **`psql`**, the PostgreSQL command-line client, on the machine that provisions a Postgres database: [step 3](#3-provision-an-empty-database) applies a SQL file with it

```bash
# PostgreSQL target
npm install @bratsos/workflow-engine@alpha zod
npm install --save-exact @prisma/orm-postgres@8.0.0-rc.21
npm install --save-dev --save-exact prisma@8.0.0-rc.29
npm install temporal-polyfill
```

`@prisma/orm-postgres` has a peer dependency on `temporal-polyfill`. npm installs it; yarn classic and pnpm with `auto-install-peers=false` do not, and `prisma contract emit` then fails with `Cannot find module 'temporal-polyfill/full/implementation'`. The last line fixes that.

### 1. Copy the contract

The package ships the engine's tables as a Prisma 8 contract at `node_modules/@bratsos/workflow-engine/prisma/contract.prisma`. Copy it to `prisma/contract.prisma`, or, if you already have a contract, copy the `native_enum Status` block and the models into it. It describes the same 12 tables as `schema.prisma`, with the same model, field and relation names (the adapters address the models by those names, so do not rename them). `WorkflowBlob` is only read by `createPrismaBlobStore`.

```bash
mkdir -p prisma
cp node_modules/@bratsos/workflow-engine/prisma/contract.prisma prisma/contract.prisma
```

Two choices in that file must stay as they are. `fromPrisma8` checks both when you construct it and throws an error that names the fix:

* **Timestamps are `TimestampString(3)`**, never `DateTime`. The columns are naive `timestamp(3)` holding UTC, which is what the engine's raw SQL compares against. `TimestampString` reads and writes ISO text (`2026-10-30T14:29:26.513`) and rejects a JavaScript `Date`; `fromPrisma8` does the conversion for the engine and throws at construction on a column of any other timestamp type.
* **`Status` is a native Postgres enum** (`native_enum Status { ... }` and `pg.enum(Status)` on `status`). The raw SQL casts to `::"Status"`. A plain `enum` block in a Prisma 8 contract is a text column with a `CHECK`, and that cast fails against it.

Your own models can live in the same contract. Keep the engine's table names (`@@map`) as shipped.

### 2. Configure and emit

```ts
// prisma.config.ts
import { defineConfig } from "@prisma/orm-postgres/config";
import { definePrismaConfig } from "prisma/config";

export default definePrismaConfig({
  orm: defineConfig({
    contract: "./prisma/contract.prisma",
    db: { connection: process.env.DATABASE_URL ?? "" },
  }),
});
```

```bash
export DATABASE_URL="postgres://user:password@localhost:5432/mydb"
npx prisma contract emit      # writes prisma/contract.json and prisma/contract.d.ts
```

Re-run `contract emit` whenever the contract changes.

### 3. Provision an empty database

```bash
npx prisma db init
psql "$DATABASE_URL" -f node_modules/@bratsos/workflow-engine/prisma/mixed-order-indexes.sql
npx prisma db verify --strict
```

`db init` creates the tables, indexes and constraints and writes Prisma 8's marker (in its own `prisma_contract` schema, which the engine never touches). The SQL file is the one step Prisma 8 cannot do for you, and it needs `psql` installed where you run it.

#### The mixed-order indexes

Five indexes have a descending column, and the engine's queries depend on it:

* `workflow_runs` and `job_queue`: `(status, priority DESC, createdAt)` serves the claim and the dequeue (`ORDER BY priority DESC, "createdAt" ASC`) without a sort node.
* `workflow_runs`: `(createdAt DESC, id DESC)` and its `status` and `workflowId` prefixes serve every newest-first listing, the console's included.

A Prisma 8 contract cannot express a sort direction, so `contract.prisma` declares these five ascending and `mixed-order-indexes.sql` drops and recreates each one in a single transaction with its direction. Without the file everything still works, but a claim gets slower as pending rows pile up. Measured on Postgres 16 with every pending row at the default priority: a job claim at 10,000 pending jobs took 3.1 ms and at 100,000 took 51.6 ms (a sequential scan and sort of every row), against 0.04 ms and 0.03 ms with the indexes; a run claim at 100,000 pending runs took 70 ms against 0.11 ms; eight concurrent claim loops over 20,000 pending runs managed 260 claims a second against about 6,000. Nothing warns you. Prisma 8 cannot see sort direction, so `db verify`, `db verify --strict` (exit 0) and `migration plan` accept the ascending and the descending form alike. Check with `\d` in `psql`, below.

* **Re-apply the file after anything that recreates one of the five indexes**: renaming one in the contract (`migration plan` and `db update` drop the old index and create the new one), or a `DROP INDEX` of your own followed by `db update`. The recreated index is ascending, and `db verify --strict` does not notice. Changing the columns of an index and keeping its name does not recreate it: `migration plan` and `db update` fail with `MIGRATION.PLANNING_FAILED` and tell you to use `migration new`. The file is idempotent (`DROP INDEX IF EXISTS`, then `CREATE INDEX`).
* **If you manage schema changes with `migration plan` and `db migrate`**, put the five statements into the baseline migration instead of running the file by hand, so every environment gets them: plan it with `npx prisma migration plan --from @empty --name baseline`, then in the generated `migration.ts` find each of the five `createIndex` calls by its index name in the SQL file and replace its `columns: [...]` with ``expression: sql`"status", "priority" DESC, "createdAt"` `` (that index's column list from the SQL file). Run the file with `node` to re-emit `ops.json`, then `npx prisma db migrate --advance-ref db`.
* **Pass `--advance-ref db` to every `db migrate`.** Plain `db migrate` does not record which contract the database is on, so the next `migration plan` fails with `MIGRATION.PLAN_ORIGIN_UNKNOWN`. The error prints three commands. Run the first or the second: `prisma migration ref set db <contract>` points the `db` ref at the contract the database is on, and `prisma migration plan --from <contract>` plans from it once. `<contract>` is the hash that `prisma migration status` shows next to `@db`. Do not run the third, `migration plan --from @empty`, on a database that already has the tables: the plan would create every one of them again.
* Check a database in `psql`, because `db verify --strict` will not: `\d workflow_runs` shows four of the indexes with `DESC`, and `\d job_queue` shows the fifth.

`sql/enqueue.sql` (the optional [transactional enqueue](#transactional-enqueue-from-sql-postgresql)) works unchanged against a Prisma 8 database.

### 4. Hand the engine a client

```ts
// db.ts
import postgres from "@prisma/orm-postgres/runtime";
import { contractFromJson } from "@prisma/orm-postgres/static";
import type { Contract } from "./prisma/contract.js";
import contractJson from "./prisma/contract.json" with { type: "json" };

export const db = postgres({
  contract: contractFromJson<Contract>(contractJson),
  url: process.env.DATABASE_URL!,
});
```

```ts
import {
  createPrismaAICallLogger,
  createPrismaBlobStore,
  createPrismaJobQueue,
  createPrismaStepLedger,
  createPrismaWorkflowPersistence,
  fromPrisma8,
} from "@bratsos/workflow-engine/persistence/prisma";
import { db } from "./db";

const prisma = fromPrisma8(db); // wrap once; the factories below are the ones from the Prisma 6 and 7 path

const persistence = createPrismaWorkflowPersistence(prisma);
const jobQueue = createPrismaJobQueue(prisma);
const aiCallLogger = createPrismaAICallLogger(prisma);
const stepLedger = createPrismaStepLedger(prisma);
const blobStore = createPrismaBlobStore(prisma); // needs the WorkflowBlob model
```

These imports suit `moduleResolution: "bundler"` (Vite, tsx, esbuild, Next, Bun). With `nodenext`, import `./prisma/contract.js` and `./db.js`. Running a file directly with `node` needs `./db.ts`, and under `bundler` `tsc` rejects that import with TS5097 unless `allowImportingTsExtensions` is on (it requires `noEmit`). The JSON import (`with { type: "json" }`) fails with TS2823 under `module: "node16"`; use `esnext`, `node18`, `node20`, `nodenext` or `preserve`.

Every example in these docs that builds a `prisma` variable works with this one in its place. `fromPrisma8` is exported from `@bratsos/workflow-engine` as well as from `@bratsos/workflow-engine/persistence/prisma`. `createPrismaConsoleReadPort(prisma)` from the console package takes it too. Close the connection on shutdown with `await db.close()`.

What the wrapper does, so you know what to expect:

* It compiles each delegate call the adapters make into SQL from the contract's column types, and it throws `fromPrisma8: ...` for any argument outside the subset the adapters use, instead of ignoring it. It is not a general Prisma 6 and 7 emulation: use `db.orm` for your own queries.
* On PostgreSQL, dates, JSON, arrays, `{ increment }`, `$transaction([...])` and `$transaction(fn, { isolationLevel, timeout })` behave as the adapters need. Prisma 8 itself takes no isolation option; the wrapper issues `SET TRANSACTION ISOLATION LEVEL` first. The SQLite target does not issue that PostgreSQL statement.
* PostgreSQL calls can return Prisma 8's `SqlQueryError` (read `.sqlState`); SQLite driver errors use SQLite error codes instead. The wrapper raises `P2025` when `update` or `delete` finds no row, and `P2028` once a `$transaction(fn)` passes its `timeout` (5000ms by default, as on Prisma 6 and 7): the next statement fails and the transaction rolls back. A callback that has not settled at the deadline is rejected with `P2028` there and then, and its connection is freed. Prisma 6 and 7 do the same on SQLite for a transaction opened through the adapters. On PostgreSQL they free the connection at the deadline too, but the caller keeps waiting for the callback, so a callback that fails after the deadline gives its own error there and `P2028` here. A statement still running at the deadline is not interrupted on any of the three majors: the caller gets `P2028` when it ends.
* A raw read of your own through the wrapper has to declare its columns, because Prisma 8 drops the ones a raw read does not name: run it on `prisma.$withColumns({ name: "text" })`, or on `prisma.$withColumns("table_name")` for every column of a table. Without that the wrapper throws an error that says so.
* Row ids from the Prisma 8 path are generated by the wrapper: time-ordered hex strings such as `01a18d985ffe0000f041d3af`, where Prisma 6 and 7 produce cuids. Both are opaque text and coexist in one table. It matters only to code that parses ids.

#### Inside your own transaction

A `tx` from `db.transaction(...)` has no `contract` of its own, so pass it:

```ts
await db.transaction(async (tx) => {
  await tx.orm.public.WorkflowLog.create({ level: "INFO", message: "mine" }); // your own write

  const prisma = fromPrisma8(tx, { contract: db.contract });
  const persistence = createPrismaWorkflowPersistence(prisma);
  // ...the rest of the ports over the same `prisma`
});
```

Your writes and the engine's commit or roll back together, as with a Prisma 6 or 7 `$transaction` client. The result has no `$transaction` of its own, like a Prisma 6 or 7 `tx`: nested transactions are not available, and `enqueue` and `enqueueParallel` throw, exactly as they do there. To enqueue inside your own transaction, use the [SQL function](#transactional-enqueue-from-sql-postgresql). Call `fromPrisma8(tx, ...)` once per transaction; the contract is checked once per contract object, so it is cheap.

#### The console

`workflow-console --database-url` needs `@prisma/client`, so on Prisma 8 pass `--config` a module that builds the reader with `fromPrisma8`:

```js
// console.config.mjs
import postgres from "@prisma/orm-postgres/runtime";
import { contractFromJson } from "@prisma/orm-postgres/static";
import { createPrismaConsoleReadPort } from "@bratsos/workflow-engine-console";
import { fromPrisma8 } from "@bratsos/workflow-engine/persistence/prisma";
import contractJson from "./prisma/contract.json" with { type: "json" };

const db = postgres({
  contract: contractFromJson(contractJson),
  url: process.env.DATABASE_URL,
});

export default {
  reader: createPrismaConsoleReadPort(fromPrisma8(db)),
  dispose: () => db.close(),
};
```

```bash
npm install @bratsos/workflow-engine-console   # no @alpha: its version must match the engine's alpha exactly
npx workflow-console --config ./console.config.mjs
```

It serves on `http://127.0.0.1:7799`; `--port` changes that.

Prisma 8 drops the columns a raw read does not declare, so every console query declares its columns. If you wrap `fromPrisma8(db)` in an object of your own (to add a `SET LOCAL`, say), forward its `$withColumns` too.

#### Connection pool

`postgres({ contract, url })` opens at most 10 connections. Keep that for one host process: with 50 hosts in one process polling every 5 ms, a pool of 10 ran workflows 16.7% faster than a pool of 64. To change the size, install `pg` and pass your own pool. `db.close()` does not close a pool you pass in, so end it yourself on shutdown.

```ts
import postgres from "@prisma/orm-postgres/runtime";
import { contractFromJson } from "@prisma/orm-postgres/static";
import { Pool } from "pg";
import type { Contract } from "./prisma/contract.js";
import contractJson from "./prisma/contract.json" with { type: "json" };

export const pool = new Pool({ connectionString: process.env.DATABASE_URL!, max: 20 });
export const db = postgres({ contract: contractFromJson<Contract>(contractJson), pg: pool });
```

#### Workers and other per-request runtimes

A Worker cannot keep a database connection across requests. Build the client with `postgresServerless` at module scope and open one connection per request:

```ts
import postgresServerless from "@prisma/orm-postgres/serverless";
import { contractFromJson } from "@prisma/orm-postgres/static";
import { createPrismaJobQueue, fromPrisma8 } from "@bratsos/workflow-engine/persistence/prisma";
import type { Contract } from "./prisma/contract.d";
import contractJson from "./prisma/contract.json" with { type: "json" };

const postgres = postgresServerless({
  contract: contractFromJson<Contract>(contractJson),
  verifyMarker: false,
});

export default {
  async fetch(request: Request, env: Env) {
    await using db = await postgres.connect({ url: env.HYPERDRIVE.connectionString });
    const jobQueue = createPrismaJobQueue(fromPrisma8(db));
    return await handle(request, jobQueue); // await it: the connection closes when this returns
  },
};
```

Without `verifyMarker: false`, every connection reads Prisma's contract marker, which is two more statements per request: over 300 requests of one read and one claim, 1,202 statements against 602, and 7.9 ms against 5.4 ms per request. That read only logs a warning when the database and the contract differ, so turn it off where your deploy checks that already. Tested on a local PostgreSQL, not through Hyperdrive.

### Adopting a PostgreSQL database that Prisma 6 or 7 created

An existing engine database does not change. Prisma 8 only records a marker in its own `prisma_contract` schema; the engine's tables, columns, indexes (the five descending ones included) and data are untouched, so **skip `mixed-order-indexes.sql`**. The tables a Prisma 8 database gets are the same ones Prisma 6 and 7 create: CI diffs the two schemas statement by statement.

1. Replace the Prisma 6 or 7 packages with the pinned Prisma 8 pair ([above](#requirements)); a project has one `prisma` CLI.
2. Copy `contract.prisma` and add `prisma.config.ts` ([steps 1 and 2](#1-copy-the-contract)). Add models for your own tables to the same contract, or `db verify --strict` reports them as extra. `npx prisma contract infer --db "$DATABASE_URL" --output prisma/inferred.prisma` writes one from the live database (inside a `namespace public { }` block, with plural model names such as `AppNotes`); copy the models for your own tables into `prisma/contract.prisma` and leave the engine's models as shipped.
3. Sign the database:

   ```bash
   npx prisma contract emit
   npx prisma db sign
   npx prisma db verify --strict
   ```

4. Replace the client construction with `fromPrisma8(db)` ([step 4](#4-hand-the-engine-a-client)).

The id format difference above is the only visible change to rows. Existing cuid ids keep working.

### Limits on Prisma 8

* The PostgreSQL target requires the engine's tables in the `public` namespace (see [Environments](#environments)).
* `workflow-console --database-url` is Prisma 6 and 7 only; use `--config`.
* A pre-release: pin the exact pair above and re-test before moving either package.
* Prisma 8's CLI has no `generate`, `migrate dev` or `db push`: the commands above replace them, and the generated `contract.json` / `contract.d.ts` are the only artefacts.

---

## Transactional Enqueue from SQL (PostgreSQL)

The whole kernel already runs in the caller's transaction. `workflow_engine_enqueue`
exposes the enqueue half of that to callers who are not TypeScript — a database
trigger, a stored procedure, a service in another language — so they can schedule
work atomically with the rows that justify it:

```sql
INSERT INTO orders (...) VALUES (...) RETURNING id INTO v_order_id;

PERFORM workflow_engine_enqueue(
  'order:' || v_order_id,          -- idempotency key
  'fulfil-order',                  -- workflow id
  'Fulfil Order',                  -- workflow name
  jsonb_build_object('orderId', v_order_id)
);
```

The function ships as SQL in the package (`node_modules/@bratsos/workflow-engine/sql/enqueue.sql`),
not as something the engine creates at runtime, so your migration owns it. Apply
it after the engine's tables exist. It is `CREATE OR REPLACE`, so re-running is safe.

```bash
psql "$DATABASE_URL" -f node_modules/@bratsos/workflow-engine/sql/enqueue.sql
```

Or, on Prisma 6 and 7, paste it into a migration:

```bash
npx prisma migrate dev --create-only --name workflow-engine-enqueue-function
cat node_modules/@bratsos/workflow-engine/sql/enqueue.sql \
  >> prisma/migrations/*_workflow_engine_enqueue_function/migration.sql
npx prisma migrate dev
```

Prisma 8 has no `migrate dev --create-only`: the CLI fails with `CLI.COMMAND_MOVED` and points to `contract emit`, then `migration plan --name <name>` (for `--create-only`, stop here), then `db migrate --advance-ref db`. Apply the file with `psql`, as above (it works unchanged on a Prisma 8 database), or author a custom migration with `prisma migration new`.

Requires PostgreSQL 13 or newer (for the built-in `gen_random_uuid()`).

### Calling it from TypeScript

On Prisma 8, call it through the transaction's raw lane, so the enqueue commits or rolls back with your own writes:

```ts
await db.transaction(async (tx) => {
  // ...your own writes through tx.orm...
  const [{ id }] = await tx
    .query(
      tx.raw.sql`SELECT workflow_engine_enqueue(${key}, ${"fulfil-order"}, ${"Fulfil Order"}, ${JSON.stringify(input)}::jsonb) AS id`
        .returnsRow({ id: "pg/text@1" })
        .build(),
    )
    .toArray();
});
```

Prisma 8's raw lane takes strings, numbers and booleans as interpolations and rejects a `Date` or an array, so the input goes in as JSON text cast with `::jsonb`. On a rollback no run, outbox event or idempotency row is left; calling it twice with one key returns the same id, and the run is `PENDING` until a host claims it.

### Signature

```sql
workflow_engine_enqueue(
  p_idempotency_key    text,
  p_workflow_id        text,
  p_workflow_name      text,
  p_input              jsonb,
  p_config             jsonb   DEFAULT '{}'::jsonb,
  p_priority           integer DEFAULT 5,
  p_definition_version text    DEFAULT NULL
) RETURNS text   -- the workflow run id
```

It writes exactly the rows `run.create` writes, in the same order: the
idempotency key, the run, and the `workflow:created` outbox event. The run is
left `PENDING` for `run.claimPending`, exactly as `run.create` leaves it — no
job is enqueued here, so a host picks it up like any other run. Calling twice
with one idempotency key returns the same run id and creates nothing the second
time.

A test in the engine's suite (`sql-enqueue.test.ts`, gated on `DATABASE_URL`)
creates one run each way and asserts the two `workflow_runs` rows, the two
`idempotency_keys` results and the two outbox events agree column by column,
and that both runs execute to the same output. That test is what keeps the two
paths from drifting.

### What SQL cannot do, and what the function does about it

**It cannot validate the input.** `run.create` parses the input against the
workflow's Zod input schema and refuses a bad one. Bad input passed here fails
at the first stage instead, as a failed run. If the caller is a trigger on your
own table that is usually fine; if it is an untrusted boundary, validate before
calling.

**It cannot compute the definition version.** A run's `definitionVersion` is a
SHA-256 of the workflow's structural snapshot, computed in TypeScript from the
built definition. So the default is to create the run **unpinned**
(`definitionVersion` NULL) — the same state as a deployment that has not adopted
definition versioning, and claimable by any host. Pass `p_definition_version`
when the caller does know it (a TypeScript service reaching for a transactional
enqueue can read `workflow.definitionVersion`); the function then refuses unless
the matching `workflow_definitions` row already exists, because pinning a run to
an unregistered version would strand it where no host will serve it.

**It cannot merge stage config defaults.** `run.create` merges
`workflow.getDefaultConfig()` under the caller's config before storing it; this
function stores `p_config` verbatim. Behaviour is unaffected — every stage
re-parses its slice of the config through its own schema when it executes, which
applies the same defaults — but the stored `config` column differs in what it
shows a reader. Pass the merged config if you want the column to match.

Two smaller differences: run ids are `gen_random_uuid()::text` rather than
Prisma's cuid (both opaque), and the in-progress idempotency marker never becomes
visible, because the claim and the result live in one transaction here — a
concurrent caller with the same key blocks on the unique index and then reads the
finished result.

---

## Database Configuration

### 1. PostgreSQL Setup (Recommended)
By default, the persistence factories assume a PostgreSQL environment. Under the hood, the job queue uses Postgres `FOR UPDATE SKIP LOCKED` row locking to safely dequeue jobs in multi-worker setups.

```typescript
import {
  createPrismaWorkflowPersistence,
  createPrismaJobQueue,
  createPrismaAICallLogger,
  createPrismaStepLedger,
  createPrismaBlobStore,
} from "@bratsos/workflow-engine/persistence/prisma";
import { PrismaClient } from "@prisma/client"; // or your Prisma 7 generator's output path
import { PrismaPg } from "@prisma/adapter-pg";

// Prisma 7. On Prisma 6, `new PrismaClient()` with the URL in the schema's datasource;
// on Prisma 8, `const prisma = fromPrisma8(db)` (see "Prisma 8" above).
const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) });

const persistence = createPrismaWorkflowPersistence(prisma);
const jobQueue = createPrismaJobQueue(prisma);   // adopts the host's workerId on start()
const aiCallLogger = createPrismaAICallLogger(prisma);
const stepLedger = createPrismaStepLedger(prisma);
const blobStore = createPrismaBlobStore(prisma); // needs the WorkflowBlob model
```

The adapters take a structural client type and never import `@prisma/client`, so any generated client — Prisma 6 or 7, default or custom `output` — satisfies them as long as it has the delegates. A Prisma 8 client has no delegates, so wrap it first: `fromPrisma8(db)` returns a client that satisfies the same type ([Prisma 8](#prisma-8)).

A transaction client works too, on all three majors: build the ports over the `tx` inside your own transaction and the whole kernel tick runs in that transaction, under your `SET LOCAL` and row-level security. On Prisma 6 and 7 that is the `tx` of your `$transaction(async (tx) => ...)`; on Prisma 8 it is `fromPrisma8(tx, { contract: db.contract })` inside `db.transaction(async (tx) => ...)`. (The Prisma step ledger and idempotency-key inserts use `createMany({ skipDuplicates: true })` on Postgres precisely so a conflict does not abort an enclosing transaction.)

Options worth knowing:

* `createPrismaWorkflowPersistence(prisma, { statusEnumName })` names the Prisma enum the Postgres claim statement casts with (default `"Status"`).
* `createPrismaWorkflowPersistence(prisma, { definitionVersioning })` skips the adapter's own check for the `workflow_definitions` table: `false` for a client whose schema has the model against a database deliberately left unmigrated, `true` for a client wrapper the structural check cannot see. Left unset, the adapter confirms the generated client's answer against the database once, lazily, with a catalogue read that returns "absent" rather than raising — so an unmigrated database still starts, with versioning off.
* `createPrismaJobQueue(prisma, { fairness: { maxConcurrentPerGroup, groupBy: "config.tenantId" } })` turns on the opt-in per-group concurrency cap in the PostgreSQL dequeue (off by default; it costs more on a deep queue).
* On PostgreSQL the job lease runs on the database clock; `PrismaJobQueueOptions.now` only affects SQLite.

### 2. SQLite Setup (Prisma 6, 7 and 8)
SQLite has no `FOR UPDATE SKIP LOCKED`, so its adapters use transaction-based claiming. Pass `{ databaseType: "sqlite" }` to every SQLite-aware adapter. Prisma 8 also checks that this option matches `contract.target`; a mismatch fails when you construct the adapter and tells you which value to use. `fromPrisma8(db)` reads the target itself and takes no new option.

```typescript
const sqlitePersistence = createPrismaWorkflowPersistence(prisma, {
  databaseType: "sqlite",
});

const sqliteJobQueue = createPrismaJobQueue(prisma, {
  databaseType: "sqlite",
});

const sqliteStepLedger = createPrismaStepLedger(prisma, {
  databaseType: "sqlite",
});

const sqliteLogger = createPrismaAICallLogger(prisma, {
  databaseType: "sqlite",
});
```

`createPrismaBlobStore` does not need a database type option. When `prisma` is the wrapped Prisma 8 runtime, pass the same `{ databaseType: "sqlite" }` option to `createPrismaWorkflowPersistence`, `createPrismaJobQueue`, `createPrismaStepLedger`, `createPrismaAICallLogger`, and the console read port.

SQLite is for a single host process per file. In the Prisma 8 wrapper, engine writes through one root client are serialized and root reads remain available. A direct `db.transaction(...)` call made by your code does not use that queue and can still contend with an engine write. Always build transactional ports over the passed transaction client. A root write or transaction from another caller waits for the active transaction and then runs, whether that transaction commits or rolls back. An adapter call made from inside a transaction's own callback belongs to it: it is rejected with `P2028` once that transaction rolls back, at the deadline if the callback is waiting on it. A raw `$transaction` on the root client inside a callback does not: it waits for the outer transaction to hit its deadline, fails it with `P2028`, and then runs and commits on its own, so never start one there. A callback that enters an external `AsyncResource` loses that link, so its root write runs after the rollback and persists; use the transaction client for anything that must roll back with the transaction. On Prisma 6/7, the adapters serialize root writes through one client and observe its native SQLite transaction lifecycle after they are constructed, so a transaction opened on that client takes a turn in the same queue; create the root ports before starting consumer transactions. On SQLite on Prisma 6 and 7, `maxWait` does not bound the time a raw transaction waits in that queue; everything ahead of it has a deadline. Direct writes through an unwrapped consumer client remain the consumer’s responsibility: on Prisma 7 one made during an open transaction runs on that transaction's connection and goes with its rollback. Calling a root port inside a raw `client.$transaction(fn)` used to commit with that transaction on Prisma 7 by accident of the shared connection; it now fails with `P2028` after 5 s while the adapter write persists alone. Build ports over `tx`. Do not run multiple processes against one SQLite file; use PostgreSQL for production or multi-process fleets.

Turn on write-ahead logging once, after the database file exists. With 50 hosts in one process, workflows ran about 40% faster on Prisma 8 than on SQLite's default journal, and more than that on Prisma 7. The SQLite suites give the same results on 6, 7 and 8 with it on.

```bash
sqlite3 ./dev.db 'PRAGMA journal_mode=WAL;'
# Without the sqlite3 tool, on Node 22.20 or later:
node -e "new (require('node:sqlite').DatabaseSync)('./dev.db').exec('PRAGMA journal_mode=WAL')"
```

The setting stays in the file. While the database is open, SQLite keeps `dev.db-wal` and `dev.db-shm` beside it and recent commits can be only in `dev.db-wal`, so copy the file for a backup after `db.close()`, or copy all three with the process stopped. WAL needs a local disk: do not use it on a network file system.

#### Prisma 6 and 7: clean-room SQLite setup

Start in a new project directory. These instructions copy the complete shipped engine schema and convert only the PostgreSQL-specific parts that SQLite cannot represent. They use the same conversion as `packages/prisma-fixtures/schema.cjs`; no fixture package is needed in your application.

Initialise the project and install exactly one Prisma major. Prisma 6:

```bash
npm init -y
npm pkg set type=module
npm install --save-exact @bratsos/workflow-engine@1.0.0-alpha.18 zod@4 prisma@6.19.3 @prisma/client@6.19.3
```

For Prisma 7, use this install line instead:

```bash
npm install --save-exact @bratsos/workflow-engine@1.0.0-alpha.18 zod@4 prisma@7.10.1 @prisma/client@7.10.1 @prisma/adapter-better-sqlite3@7.10.1
```

Create `scripts/sqlite-schema.cjs` with this content. It keeps every shipped model, default, relation and index except the SQLite-specific `Status` and JSON-default conversions shown below:

```js
const { mkdirSync, readFileSync, writeFileSync } = require("node:fs");
const { resolve } = require("node:path");

const major = process.argv[2];
if (major !== "6" && major !== "7") throw new Error("Usage: node scripts/sqlite-schema.cjs 6|7");

let schema = readFileSync(
  resolve("node_modules/@bratsos/workflow-engine/prisma/schema.prisma"),
  "utf8",
);
const generator = 'generator client {\n  provider = "prisma-client-js"\n}';
if (!schema.includes(generator)) throw new Error("The shipped generator block changed; review the conversion.");
schema = schema.replace(generator, `${generator.slice(0, -1)}\n  output   = "./sqlite-client"\n}`);
const provider = 'provider = "postgresql"';
if (!schema.includes(provider)) throw new Error("The shipped datasource provider changed; review the conversion.");
schema = schema.replace(
  provider,
  `provider = "sqlite"${major === "6" ? '\n  url      = env("DATABASE_URL")' : ""}`,
);
const statusEnum = /^enum Status \{[\s\S]*?^\}\n\n/m;
if (!statusEnum.test(schema)) throw new Error("Expected the shipped Status enum.");
schema = schema.replace(statusEnum, "");
const statusFields = (schema.match(/\bstatus\s+Status\s+@default\(PENDING\)/g) ?? []).length;
if (statusFields !== 3) throw new Error(`Expected 3 Status fields; found ${statusFields}.`);
schema = schema.replace(/(\bstatus\s+)Status\s+@default\(PENDING\)/g, '$1String @default("PENDING")');
const jsonDefault = /(\bconfig\s+Json)\s+@default\("\{\}"\)/;
if (!jsonDefault.test(schema)) throw new Error("Expected the shipped WorkflowRun.config JSON default.");
schema = schema.replace(jsonDefault, '$1 @default(dbgenerated("\'{}\'"))');
schema = schema.replace(/\s+@db\.Text/g, "");
if (/\bStatus\b|@db\.Text|config\s+Json\s+@default\("\{\}"\)/.test(schema)) {
  throw new Error("SQLite conversion left a PostgreSQL-only type or attribute.");
}
mkdirSync(resolve("prisma"), { recursive: true });
writeFileSync(resolve("prisma/schema.prisma"), schema);
console.log(`Wrote complete SQLite schema for Prisma ${major}.`);
```

Save it under `scripts/`, then create `scripts/prisma-sqlite.cjs`. Prisma's SQLite URL parser needs the resolved absolute path after `file:` with Windows backslashes changed to forward slashes. Keep spaces and Unicode literal. On Windows, Prisma 6/7 accepts `file:C:/...`; the `file:///C:/...` URL from `pathToFileURL` fails `db push` with OS error 161. This keeps the CLI and runtime on the same database file. The Prisma 6 URL adds `connection_limit=1` so its native client serializes writes:

```js
const { execFileSync } = require("node:child_process");
const { resolve } = require("node:path");

const [major, ...args] = process.argv.slice(2);
if ((major !== "6" && major !== "7") || args.length === 0) {
  throw new Error("Usage: node scripts/prisma-sqlite.cjs 6|7 <prisma command>");
}
const fileUrl = `file:${resolve("prisma/dev.db").replace(/\\/g, "/")}`;
const databaseUrl = major === "6" ? `${fileUrl}?connection_limit=1` : fileUrl;
execFileSync(
  process.execPath,
  [
    require.resolve("prisma/build/index.js"),
    ...args,
    "--schema",
    "prisma/schema.prisma",
  ],
  {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: "inherit",
  }
);
```

Generate the client and push the schema into this new file. For Prisma 6:

```bash
node scripts/sqlite-schema.cjs 6
node scripts/prisma-sqlite.cjs 6 generate
node scripts/prisma-sqlite.cjs 6 db push --skip-generate
```

For Prisma 7, first create `prisma.config.ts` (Prisma 7 keeps the URL out of the schema):

```ts
import { defineConfig } from "prisma/config";

export default defineConfig({
  datasource: { url: process.env.DATABASE_URL ?? "" },
});
```

Then run:

```bash
node scripts/sqlite-schema.cjs 7
node scripts/prisma-sqlite.cjs 7 generate
node scripts/prisma-sqlite.cjs 7 db push
```

The generated client is at `prisma/sqlite-client`. Use the same normalized absolute SQLite URL at runtime that the runner used for `generate` and `db push`.

For Prisma 6, save this as `db.mjs`. Its native pool is limited to one connection so engine writes are serialized:

On Windows ARM64, Prisma 6.19.3's native client was verified with Node 24.11.0 x64 under emulation; its native query engine did not load under Node 24.11.0 ARM64. Prisma 7.10.1 passed on ARM64 Node 24.11.0.

```js
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { createPrismaWorkflowPersistence } from "@bratsos/workflow-engine/persistence/prisma";

const require = createRequire(import.meta.url);
const { PrismaClient } = require("./prisma/sqlite-client");
const fileUrl = `file:${resolve("prisma/dev.db").replace(/\\/g, "/")}`;
export const prisma = new PrismaClient({
  datasourceUrl: `${fileUrl}?connection_limit=1`,
});
export const persistence = createPrismaWorkflowPersistence(prisma, {
  databaseType: "sqlite",
});
```

For Prisma 7, use the native better-sqlite3 driver adapter. Save this `db.mjs` instead:

```js
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { createPrismaWorkflowPersistence } from "@bratsos/workflow-engine/persistence/prisma";

const require = createRequire(import.meta.url);
const { PrismaClient } = require("./prisma/sqlite-client");
const { PrismaBetterSqlite3 } = require("@prisma/adapter-better-sqlite3");
const url = `file:${resolve("prisma/dev.db").replace(/\\/g, "/")}`;
export const prisma = new PrismaClient({
  adapter: new PrismaBetterSqlite3({ url }),
});
export const persistence = createPrismaWorkflowPersistence(prisma, {
  databaseType: "sqlite",
});
```

Use the same `{ databaseType: "sqlite" }` option on the other SQLite-aware factories. The client adapter setup is different on Prisma 6 and 7; the engine factories are not.

#### Fresh database required for Prisma 8 SQLite

Do not point Prisma 8 at a SQLite file created by Prisma 6 or Prisma 7. Real-file checks found timestamp comparison differences from both origins. In the Prisma 7 boundary probe, the stored value `2026-06-07T08:09:10.123+00:00` matched a Prisma 7 exact-range query and console filter (1 row each), while Prisma 8's `Z`-formatted exact-range query and console filter returned 0 rows each at that same instant. Prisma 6 stores `DateTime` values as integer epoch milliseconds, which also fail when mixed with Prisma 8 ISO-text timestamps. There is no supported timestamp-normalization migration. For either origin, initialise a fresh SQLite file from the Prisma 8 SQLite contract and migrate application data into it.

#### Prisma 8 with SQLite

Prisma 8 SQLite uses `@prisma/orm-sqlite`, a SQLite contract, and the runtime's `path` option. It requires Node.js 22.20+, 24.11+ or 26+; these are Prisma 8 SQLite CLI floors and do not change the engine's general Node.js `>=22.11` requirement. Start with a new file so `db init` creates the database. The following setup starts from an empty directory:

```bash
npm init -y
npm pkg set type=module
npm install @bratsos/workflow-engine@alpha zod
npm install --save-exact @prisma/orm-sqlite@8.0.0-rc.21
npm install --save-dev --save-exact prisma@8.0.0-rc.29
mkdir -p prisma
cp node_modules/@bratsos/workflow-engine/prisma/contract-sqlite.prisma prisma/contract.prisma
```

Do not install `@prisma/client` on Prisma 8. Configure the SQLite target:

```ts
// prisma.config.ts
import { defineConfig } from "@prisma/orm-sqlite/config";
import { definePrismaConfig } from "prisma/config";

export default definePrismaConfig({
  orm: defineConfig({
    contract: "./prisma/contract.prisma",
    output: "./.generated",
    db: { connection: "file:./dev.db" },
    migrations: { dir: "./.generated/migrations" },
  }),
});
```

Emit the contract and initialise that new database file:

```bash
npx prisma contract emit
npx prisma db init
```

The contract must start with `// use prisma-8`. Use the shipped SQLite contract as-is; it declares SQLite's text status values and `DateTime`/`Json` columns. The Postgres contract's native enum, timestamp codec and mixed-order-index SQL do not apply to SQLite.

Create the runtime from the emitted contract and wrap it once:

```ts
// db.ts
import sqlite from "@prisma/orm-sqlite/runtime";
import { contractFromJson } from "@prisma/orm-sqlite/static";
import type { Contract } from "./.generated/contract.js";
import contractJson from "./.generated/contract.json" with { type: "json" };
import { fromPrisma8 } from "@bratsos/workflow-engine/persistence/prisma";

export const db = sqlite({
  contract: contractFromJson<Contract>(contractJson),
  path: "./dev.db",
});
export const prisma = fromPrisma8(db);
```

Close the SQLite runtime on shutdown with `await db.close()`.

Pass `prisma` to the same factories shown above with `{ databaseType: "sqlite" }`. For the console, use `createPrismaConsoleReadPort(prisma, { databaseType: "sqlite" })`; `workflow-console --database-url` still requires `@prisma/client`, so configure the console with `--config` on Prisma 8. SQLite does not implement PostgreSQL's `statement_timeout`; `statementTimeoutMs` does not cancel an SQLite statement.

---

## Environments

### A schema other than `public`

* **Prisma 6:** `?schema=name` in the connection URL works.
* **Prisma 7:** the driver adapter's `schema` option, `new PrismaPg({ connectionString }, { schema: "name" })`, qualifies the SQL Prisma generates but not the engine's own raw SQL (`FROM job_queue`). Every dequeue then fails with `P2010 relation "job_queue" does not exist`, the host retries in a loop and runs stay `PENDING`. Set `search_path` as well: `new PrismaPg({ connectionString, options: "-c search_path=name" }, { schema: "name" })`.
* **Prisma 8:** the engine's tables must be in `public`. `fromPrisma8` reads the contract's `public` namespace, so with the engine's models in another namespace it throws an error saying the engine's models must be in the contract's `public` namespace, and `mixed-order-indexes.sql` fails with `relation "workflow_runs" does not exist`.

### TLS

Against a server with a self-signed or private-CA certificate, `?sslmode=require`, `sslmode=prefer` or no `sslmode` connects on Prisma 6 and fails on Prisma 7 and 8 with `DEPTH_ZERO_SELF_SIGNED_CERT`: the Postgres driver those two use treats `require` as `verify-full`, and `sslaccept=accept_invalid_certs` is ignored. These worked on all three majors: `sslmode=verify-full&sslrootcert=/path/to/ca.pem`, `sslmode=verify-ca&sslrootcert=/path/to/ca.pem`, and `sslmode=no-verify`.

### PgBouncer

PgBouncer in transaction mode works on Prisma 6, 7 and 8 (tested on PgBouncer 1.26.1 with `max_prepared_statements` 0 and 100): isolation levels, raw reads, the console read port and 16 concurrent claim loops over 1,000 jobs, each job claimed once. Prisma 6 needs `?pgbouncer=true` on the URL: without it 2,458 calls failed with prepared-statement errors and 238 of 1,000 jobs completed (none was claimed twice).

The adapters do not use Prisma 8's `db.prepare`. It relies on named statements, which these setups cannot keep between transactions, and it gave no measurable gain at the default poll intervals.

---

## Database Indexes

Verify that your index declarations (`@@index`) are preserved. On Prisma 8 the five indexes with a descending column come from [`mixed-order-indexes.sql`](#the-mixed-order-indexes), not from the contract. The ones that matter operationally:
* `workflow_runs`: `[status, priority DESC, createdAt]` serves the run claim; the three `(…, createdAt DESC, id DESC)` composites serve every "newest first" listing (the console's included) as one index range scan; `[definitionVersion]` and `[status, workflowId, definitionVersion]` serve the version-filtered claim and `run.listVersions`.
* `job_queue`: `[status, priority DESC, createdAt]` serves the dequeue without a sort node whatever the queue depth; `[status, createdAt]` serves queue health; `[nextPollAt]` serves retries. `@@unique([workflowRunId, stageId])` is what makes the enqueue idempotent on a redrive.
* `workflow_steps`: `@@unique([stageRecordId, stepId])` is the step ledger's claim; the foreign key to `workflow_stages` with `ON DELETE CASCADE` is what lets `run.purge` (and a hand-written `DELETE FROM workflow_runs`) take the ledger with the run.
* `outbox_events`: `[dlqAt]` serves the dead-letter view; on Postgres prefer a partial index (`WHERE "dlqAt" IS NOT NULL`) if you write the migration by hand.
* `workflow_annotations`: `[workflowRunId, key]` enables efficient range queries (e.g. `keyPrefix: "decision."`).

`workflow_definitions` deliberately has no `(workflowId)` index: the compound primary key already leads with it. If an earlier draft of your migration created one, `DROP INDEX CONCURRENTLY IF EXISTS "workflow_definitions_workflowId_idx";` is safe.
