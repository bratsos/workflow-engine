# Persistence Setup

Complete guide for setting up workflow persistence with Prisma.

## ⚠️ Pre-Setup Checklist

Before creating persistence instances, verify your Prisma schema:

- [ ] `WorkflowRun` model exists with `duration` field (not `durationMs`)
- [ ] `WorkflowStage` model exists with `duration` field (not `durationMs`)
- [ ] `WorkflowLog` model exists (required for `ctx.log()`)
- [ ] `WorkflowArtifact` model exists (required for stage outputs)
- [ ] `JobQueue` model exists (required for job processing)
- [ ] `Status` enum exists with all values: PENDING, RUNNING, SUSPENDED, COMPLETED, FAILED, CANCELLED, SKIPPED
- [ ] `LogLevel` enum exists: DEBUG, INFO, WARN, ERROR
- [ ] `ArtifactType` enum exists: STAGE_OUTPUT, ARTIFACT, METADATA
- [ ] Table names use `@@map` (e.g., `@@map("workflow_runs")`)
- [ ] Run `prisma db push` or `prisma migrate dev` after schema changes

**Common Errors:**
| Error | Cause | Fix |
|-------|-------|-----|
| `Cannot read properties of undefined (reading 'create')` | Missing `WorkflowLog` model | Add `WorkflowLog` to schema |
| `Cannot read properties of undefined (reading 'upsert')` | Missing `WorkflowArtifact` model | Add `WorkflowArtifact` to schema |
| `Unknown argument 'duration'. Did you mean 'durationMs'?` | Wrong field name | Rename `durationMs` to `duration` |
| `near "FOR": syntax error` | Using SQLite without `databaseType: "sqlite"` | Pass `{ databaseType: "sqlite" }` to factory functions |

## Interfaces Overview

The workflow engine uses three persistence interfaces:

| Interface | Purpose |
|-----------|---------|
| `WorkflowPersistence` | Workflow runs, stages, logs, artifacts |
| `JobQueue` | Job scheduling and processing |
| `AICallLogger` | AI call tracking and stats |

## WorkflowPersistence Interface

```typescript
interface WorkflowPersistence {
  // WorkflowRun operations
  createRun(data: CreateRunInput): Promise<WorkflowRunRecord>;
  updateRun(id: string, data: UpdateRunInput): Promise<void>;
  getRun(id: string): Promise<WorkflowRunRecord | null>;
  getRunStatus(id: string): Promise<WorkflowStatus | null>;
  getRunsByStatus(status: WorkflowStatus): Promise<WorkflowRunRecord[]>;

  // WorkflowStage operations
  createStage(data: CreateStageInput): Promise<WorkflowStageRecord>;
  upsertStage(data: UpsertStageInput): Promise<WorkflowStageRecord>;
  updateStage(id: string, data: UpdateStageInput): Promise<void>;
  updateStageByRunAndStageId(runId, stageId, data): Promise<void>;
  getStage(runId, stageId): Promise<WorkflowStageRecord | null>;
  getStageById(id): Promise<WorkflowStageRecord | null>;
  getStagesByRun(runId, options?): Promise<WorkflowStageRecord[]>;
  getSuspendedStages(beforeDate): Promise<WorkflowStageRecord[]>;
  getFirstSuspendedStageReadyToResume(runId): Promise<WorkflowStageRecord | null>;
  getFirstFailedStage(runId): Promise<WorkflowStageRecord | null>;
  getLastCompletedStage(runId): Promise<WorkflowStageRecord | null>;
  getLastCompletedStageBefore(runId, executionGroup): Promise<WorkflowStageRecord | null>;
  deleteStage(id): Promise<void>;

  // WorkflowLog operations
  createLog(data: CreateLogInput): Promise<void>;

  // WorkflowArtifact operations
  saveArtifact(data: SaveArtifactInput): Promise<void>;
  loadArtifact(runId, key): Promise<unknown>;
  hasArtifact(runId, key): Promise<boolean>;
  deleteArtifact(runId, key): Promise<void>;
  listArtifacts(runId): Promise<WorkflowArtifactRecord[]>;
  getStageIdForArtifact(runId, stageId): Promise<string | null>;

  // Stage output convenience
  saveStageOutput(runId, workflowType, stageId, output): Promise<string>;
}
```

## JobQueue Interface

```typescript
interface JobQueue {
  enqueue(options: EnqueueJobInput): Promise<string>;
  enqueueParallel(jobs: EnqueueJobInput[]): Promise<string[]>;
  dequeue(): Promise<DequeueResult | null>;
  complete(jobId: string): Promise<void>;
  suspend(jobId: string, nextPollAt: Date): Promise<void>;
  fail(jobId: string, error: string, shouldRetry?: boolean): Promise<void>;
  getSuspendedJobsReadyToPoll(): Promise<Array<{ jobId, stageId, workflowRunId }>>;
  releaseStaleJobs(staleThresholdMs?: number): Promise<number>;
}
```

## AICallLogger Interface

```typescript
interface AICallLogger {
  logCall(call: CreateAICallInput): void;
  logBatchResults(batchId: string, results: CreateAICallInput[]): Promise<void>;
  getStats(topicPrefix: string): Promise<AIHelperStats>;
  isRecorded(batchId: string): Promise<boolean>;
}
```

## Prisma Schema

### Required Enums

```prisma
// Unified status enum for workflows, stages, and jobs
enum Status {
  PENDING
  RUNNING
  SUSPENDED
  COMPLETED
  FAILED
  CANCELLED
  SKIPPED
}

enum LogLevel {
  DEBUG
  INFO
  WARN
  ERROR
}

enum ArtifactType {
  STAGE_OUTPUT
  ARTIFACT
  METADATA
}
```

### WorkflowRun Model

```prisma
model WorkflowRun {
  id            String    @id @default(cuid())
  createdAt     DateTime  @default(now())
  updatedAt     DateTime  @updatedAt
  workflowId    String
  workflowName  String
  workflowType  String
  status        Status    @default(PENDING)
  startedAt     DateTime?
  completedAt   DateTime?
  duration      Int?
  input         Json
  output        Json?
  config        Json      @default("{}")
  totalCost     Float     @default(0)
  totalTokens   Int       @default(0)
  priority      Int       @default(5)

  // Relations
  stages        WorkflowStage[]
  logs          WorkflowLog[]
  artifacts     WorkflowArtifact[]

  // Indexes for common queries
  @@index([status])
  @@index([workflowType])
  @@index([createdAt])

  @@map("workflow_runs")
}
```

### WorkflowStage Model

```prisma
model WorkflowStage {
  id              String    @id @default(cuid())
  createdAt       DateTime  @default(now())
  updatedAt       DateTime  @updatedAt
  workflowRunId   String
  stageId         String
  stageName       String
  stageNumber     Int
  executionGroup  Int
  status          Status    @default(PENDING)
  startedAt       DateTime?
  completedAt     DateTime?
  duration        Int?
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

  // Relations
  workflowRun     WorkflowRun        @relation(fields: [workflowRunId], references: [id], onDelete: Cascade)
  logs            WorkflowLog[]
  artifacts       WorkflowArtifact[]

  // Unique constraint for stage lookup
  @@unique([workflowRunId, stageId])
  @@index([status])
  @@index([nextPollAt])

  @@map("workflow_stages")
}
```

### WorkflowLog Model

```prisma
model WorkflowLog {
  id              String         @id @default(cuid())
  createdAt       DateTime       @default(now())
  workflowRunId   String?
  workflowStageId String?
  level           LogLevel
  message         String
  metadata        Json?

  // Relations
  workflowRun     WorkflowRun?   @relation(fields: [workflowRunId], references: [id], onDelete: Cascade)
  workflowStage   WorkflowStage? @relation(fields: [workflowStageId], references: [id], onDelete: Cascade)

  @@index([workflowRunId])
  @@index([createdAt])

  @@map("workflow_logs")
}
```

### WorkflowArtifact Model

```prisma
model WorkflowArtifact {
  id              String       @id @default(cuid())
  createdAt       DateTime     @default(now())
  updatedAt       DateTime     @updatedAt
  workflowRunId   String
  workflowStageId String?
  key             String
  type            ArtifactType
  data            Json
  size            Int
  metadata        Json?

  // Relations
  workflowRun     WorkflowRun   @relation(fields: [workflowRunId], references: [id], onDelete: Cascade)
  workflowStage   WorkflowStage? @relation(fields: [workflowStageId], references: [id], onDelete: Cascade)

  // Unique constraint for artifact lookup
  @@unique([workflowRunId, key])
  @@index([type])

  @@map("workflow_artifacts")
}
```

### JobQueue Model

```prisma
model JobQueue {
  id            String    @id @default(cuid())
  createdAt     DateTime  @default(now())
  updatedAt     DateTime  @updatedAt
  workflowRunId String
  stageId       String
  status        Status    @default(PENDING)
  priority      Int       @default(5)
  workerId      String?
  lockedAt      DateTime?
  startedAt     DateTime?
  completedAt   DateTime?
  attempt       Int       @default(0)
  maxAttempts   Int       @default(3)
  lastError     String?
  nextPollAt    DateTime?
  payload       Json      @default("{}")

  @@index([status, nextPollAt])
  @@index([workflowRunId])

  @@map("job_queue")
}
```

### AICall Model

```prisma
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
  @@index([createdAt])
  @@index([modelKey])

  @@map("ai_calls")
}
```

## Creating Persistence Implementations

```typescript
import {
  createPrismaWorkflowPersistence,
  createPrismaJobQueue,
  createPrismaAICallLogger,
} from "@bratsos/workflow-engine/persistence/prisma";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

// PostgreSQL (default)
const persistence = createPrismaWorkflowPersistence(prisma);
const jobQueue = createPrismaJobQueue(prisma, { workerId: "my-worker-id" });
const aiCallLogger = createPrismaAICallLogger(prisma);

// SQLite - uses optimistic locking instead of FOR UPDATE SKIP LOCKED
const persistence = createPrismaWorkflowPersistence(prisma, {
  databaseType: "sqlite"
});
const jobQueue = createPrismaJobQueue(prisma, {
  databaseType: "sqlite",
  workerId: "my-worker-id"  // optional
});
```

## Database Type Options

The Prisma implementations support both PostgreSQL and SQLite:

| Database | Locking Strategy | Use Case |
|----------|-----------------|----------|
| `postgresql` (default) | `FOR UPDATE SKIP LOCKED` | Production, multi-worker |
| `sqlite` | Optimistic locking with retry | Development, single-worker |

```typescript
type DatabaseType = "postgresql" | "sqlite";

interface PrismaWorkflowPersistenceOptions {
  databaseType?: DatabaseType;  // Default: "postgresql"
}

interface PrismaJobQueueOptions {
  workerId?: string;            // Default: auto-generated
  databaseType?: DatabaseType;  // Default: "postgresql"
}
```

**Important:** When using SQLite, pass `{ databaseType: "sqlite" }` to both `createPrismaWorkflowPersistence` and `createPrismaJobQueue`. Otherwise, you'll get SQL syntax errors from PostgreSQL-specific queries.

## Prisma Version Compatibility

The library supports both Prisma 6.x and 7.x:

**Prisma 6.x**: Status values are strings
```typescript
status: "PENDING"
```

**Prisma 7.x**: Status values are typed enums
```typescript
status: prisma.$Enums.Status.PENDING
```

The library automatically detects your Prisma version and handles this difference internally via the enum compatibility layer.

## Status Type

```typescript
// Unified status for all entities
type Status =
  | "PENDING"     // Not started
  | "RUNNING"     // Executing
  | "SUSPENDED"   // Paused (waiting for external event)
  | "COMPLETED"   // Finished successfully
  | "FAILED"      // Finished with error
  | "CANCELLED"   // Manually stopped
  | "SKIPPED";    // Bypassed (stage-specific)

// Deprecated aliases (use Status instead)
type WorkflowStatus = Status;
type WorkflowStageStatus = Status;
type JobStatus = Status;
```

## Record Types

```typescript
interface WorkflowRunRecord {
  id: string;
  createdAt: Date;
  updatedAt: Date;
  workflowId: string;
  workflowName: string;
  workflowType: string;
  status: WorkflowStatus;
  startedAt: Date | null;
  completedAt: Date | null;
  duration: number | null;
  input: unknown;
  output: unknown | null;
  config: unknown;
  totalCost: number;
  totalTokens: number;
  priority: number;
}

interface WorkflowStageRecord {
  id: string;
  createdAt: Date;
  updatedAt: Date;
  workflowRunId: string;
  stageId: string;
  stageName: string;
  stageNumber: number;
  executionGroup: number;
  status: WorkflowStageStatus;
  startedAt: Date | null;
  completedAt: Date | null;
  duration: number | null;
  inputData: unknown | null;
  outputData: unknown | null;
  config: unknown | null;
  suspendedState: unknown | null;
  resumeData: unknown | null;
  nextPollAt: Date | null;
  pollInterval: number | null;
  maxWaitUntil: Date | null;
  metrics: unknown | null;
  embeddingInfo: unknown | null;
  errorMessage: string | null;
}
```

## Input Types

```typescript
interface CreateRunInput {
  id?: string;
  workflowId: string;
  workflowName: string;
  workflowType: string;
  input: unknown;
  config?: unknown;
  priority?: number;
  metadata?: Record<string, unknown>;  // Domain-specific fields
}

interface UpdateRunInput {
  status?: WorkflowStatus;
  startedAt?: Date;
  completedAt?: Date;
  duration?: number;
  output?: unknown;
  totalCost?: number;
  totalTokens?: number;
}

interface CreateStageInput {
  workflowRunId: string;
  stageId: string;
  stageName: string;
  stageNumber: number;
  executionGroup: number;
  status?: WorkflowStageStatus;
  startedAt?: Date;
  config?: unknown;
  inputData?: unknown;
}

interface UpdateStageInput {
  status?: WorkflowStageStatus;
  startedAt?: Date;
  completedAt?: Date;
  duration?: number;
  outputData?: unknown;
  config?: unknown;
  suspendedState?: unknown;
  resumeData?: unknown;
  nextPollAt?: Date | null;
  pollInterval?: number;
  maxWaitUntil?: Date;
  metrics?: unknown;
  embeddingInfo?: unknown;
  errorMessage?: string;
}
```

## Custom Persistence Implementation

For non-Prisma databases or testing:

```typescript
import type { WorkflowPersistence } from "@bratsos/workflow-engine";

class CustomPersistence implements WorkflowPersistence {
  private runs = new Map<string, WorkflowRunRecord>();
  private stages = new Map<string, WorkflowStageRecord>();

  async createRun(data: CreateRunInput): Promise<WorkflowRunRecord> {
    const run: WorkflowRunRecord = {
      id: data.id ?? crypto.randomUUID(),
      createdAt: new Date(),
      updatedAt: new Date(),
      workflowId: data.workflowId,
      workflowName: data.workflowName,
      workflowType: data.workflowType,
      status: "PENDING",
      startedAt: null,
      completedAt: null,
      duration: null,
      input: data.input,
      output: null,
      config: data.config ?? {},
      totalCost: 0,
      totalTokens: 0,
      priority: data.priority ?? 5,
    };
    this.runs.set(run.id, run);
    return run;
  }

  async updateRun(id: string, data: UpdateRunInput): Promise<void> {
    const run = this.runs.get(id);
    if (!run) throw new Error(`Run ${id} not found`);
    Object.assign(run, data, { updatedAt: new Date() });
  }

  async getRun(id: string): Promise<WorkflowRunRecord | null> {
    return this.runs.get(id) ?? null;
  }

  // ... implement other methods
}
```

## Database Migrations

After adding the Prisma schema:

```bash
# Generate migration
npx prisma migrate dev --name add_workflow_tables

# Apply to production
npx prisma migrate deploy

# Generate Prisma client
npx prisma generate
```

## Performance Considerations

### Indexes

The schema includes indexes for common query patterns:
- `status` - for polling pending/running workflows
- `nextPollAt` - for suspended stage polling
- `workflowRunId` - for stage/log lookups
- `createdAt` - for ordering

### Job Queue Atomicity

**PostgreSQL** uses `FOR UPDATE SKIP LOCKED` for atomic dequeue:

```sql
UPDATE job_queue
SET status = 'RUNNING', workerId = $1, lockedAt = NOW()
WHERE id = (
  SELECT id FROM job_queue
  WHERE status = 'PENDING'
    AND (nextPollAt IS NULL OR nextPollAt <= NOW())
  ORDER BY priority DESC, createdAt ASC
  LIMIT 1
  FOR UPDATE SKIP LOCKED
)
RETURNING *;
```

**SQLite** uses optimistic locking with retry:

```typescript
// 1. Find PENDING job
const job = await prisma.jobQueue.findFirst({
  where: { status: "PENDING" },
  orderBy: [{ priority: "desc" }, { createdAt: "asc" }],
});

// 2. Atomically claim it (fails if already claimed)
const result = await prisma.jobQueue.updateMany({
  where: { id: job.id, status: "PENDING" },
  data: { status: "RUNNING", workerId, lockedAt: new Date() },
});

// 3. If count === 0, another worker claimed it → retry
```

Both approaches ensure each job is processed by exactly one worker, even with multiple workers competing.
