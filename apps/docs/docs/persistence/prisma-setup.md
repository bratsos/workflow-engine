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

  stages        WorkflowStage[]
  logs          WorkflowLog[]
  artifacts     WorkflowArtifact[]
  annotations   WorkflowAnnotation[]

  @@index([status])
  @@index([workflowId])
  @@map("workflow_runs")
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

  @@index([status, priority])
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
