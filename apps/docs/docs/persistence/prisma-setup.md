---
sidebar_position: 1
title: Prisma Setup
---

# Prisma Setup

**workflow-engine** uses Prisma to manage state persistence in a database-native way. The engine supports **PostgreSQL** (recommended for production) and **SQLite** (useful for local development and testing).

---

## Authoritative Prisma Schema

To configure persistence, copy these definitions directly into your `prisma/schema.prisma` file. Ensure that all model names map to their plural database equivalents using `@@map`.

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
  // How many times `run.redrive` has re-driven this run (Step Functions'
  // redrive count). Never reset -- it counts the whole life of the run.
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

  @@unique([workflowRunId, stageId])
  @@index([status])
  @@index([nextPollAt])
  @@map("workflow_stages")
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
```

---

## Applying the Schema

After copying the models, run the Prisma migration command to apply the changes to your database:

```bash
# Generate the migration and apply to database
npx prisma migrate dev --name add-workflow-engine-tables

# Generate the Prisma client
npx prisma generate
```

---

## Database Configuration

### 1. PostgreSQL Setup (Recommended)
By default, the persistence factories assume a PostgreSQL environment. Under the hood, the job queue uses Postgres `FOR UPDATE SKIP LOCKED` row locking to safely dequeue jobs in multi-worker setups.

```typescript
import {
  createPrismaWorkflowPersistence,
  createPrismaJobQueue,
  createPrismaAICallLogger,
} from "@bratsos/workflow-engine/persistence/prisma";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const persistence = createPrismaWorkflowPersistence(prisma);
const jobQueue = createPrismaJobQueue(prisma);
const aiCallLogger = createPrismaAICallLogger(prisma);
```

### 2. SQLite Setup
SQLite lacks native lock features like `FOR UPDATE SKIP LOCKED`. If you are running locally or inside a testing context on SQLite:
1. **Pass `databaseType`**: You **must** pass `{ databaseType: "sqlite" }` in the config options of the persistence and job queue factories. Without this, the engine will attempt to run Postgres-specific locking syntax, throwing database query errors.
2. **Transaction Handling**: The engine wraps SQLite dequeuing inside standard database transactions, maintaining concurrency protection for single-host or local dev setups.

```typescript
const sqlitePersistence = createPrismaWorkflowPersistence(prisma, {
  databaseType: "sqlite",
});

const sqliteJobQueue = createPrismaJobQueue(prisma, {
  databaseType: "sqlite",
});
```

---

## Database Indexes

Verify that your index declarations (`@@index`) are preserved:
* `job_queue`: Indexes on `[status, priority]` and `[nextPollAt]` ensure that workers can query and claim jobs with negligible overhead.
* `workflow_annotations`: Indexes on `[workflowRunId, key]` enable efficient range queries (e.g. `keyPrefix: "decision."`) when using PostgreSQL index-range scans.
