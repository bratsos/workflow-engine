# Persistence Setup

Complete guide for setting up workflow persistence with Prisma.

## ⚠️ Pre-Setup Checklist

Before creating persistence instances, verify your Prisma schema:

- [ ] `WorkflowRun` model exists with `duration` field (not `durationMs`) and a `version` field for optimistic concurrency
- [ ] `WorkflowStage` model exists with `duration` field (not `durationMs`), `version`, and `attempt` fields
- [ ] `WorkflowLog` model exists (required for `ctx.log()`)
- [ ] `WorkflowArtifact` model exists (required for stage outputs)
- [ ] `WorkflowAnnotation` model exists (required for `kernel.annotations` / `ctx.annotate()`)
- [ ] `JobQueue` model exists (required for job processing)
- [ ] `OutboxEvent` model exists (required for the transactional outbox / `outbox.flush`)
- [ ] `IdempotencyKey` model exists (required for command idempotency keys)
- [ ] `Status` enum exists with all values: PENDING, RUNNING, SUSPENDED, COMPLETED, FAILED, CANCELLED, SKIPPED
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

`WorkflowPersistence` (41 methods) is split into two focused interfaces, both exported from `@bratsos/workflow-engine` (and `@bratsos/workflow-engine/persistence`) alongside `WorkflowPersistence` itself:

- **`PersistenceCore`** (~26 methods) -- everything the kernel's handlers/helpers and the host packages actually call. The kernel's `Persistence` port (`@bratsos/workflow-engine/kernel`) derives from `PersistenceCore`, not the wider interface, so the kernel's real requirement is visible directly in the type graph.
- **`ArtifactPersistence`** (7 methods) -- artifact/blob-adjacent methods. **The kernel does not call any of these** -- all artifact I/O goes through the `BlobStore` port instead (see [03-runtime-setup.md](03-runtime-setup.md)). `@deprecated` as a group, removal at 1.0.

`WorkflowPersistence extends PersistenceCore, ArtifactPersistence`, plus 8 more legacy query methods with no kernel call site (also individually `@deprecated`, each JSDoc pointing at its `getRun`/`getStagesByRun`-based replacement). This split is purely additive -- existing implementers and consumers of the full `WorkflowPersistence` interface are unaffected. **New implementers generally only need `PersistenceCore`**; the wider interface exists for backward compatibility with `PrismaWorkflowPersistence`, `InMemoryWorkflowPersistence`, and existing third-party adapters.

### PersistenceCore (what the kernel actually calls)

```typescript
interface PersistenceCore {
  withTransaction<T>(fn: (tx: PersistenceCore) => Promise<T>): Promise<T>;

  // WorkflowRun operations
  createRun(data: CreateRunInput): Promise<WorkflowRunRecord>;
  updateRun(id: string, data: UpdateRunInput): Promise<void>;   // version increments on every call, regardless of expectedVersion
  getRun(id: string): Promise<WorkflowRunRecord | null>;
  getRunStatus(id: string): Promise<Status | null>;
  getStuckRuns(stuckSince: Date): Promise<WorkflowRunRecord[]>;
  claimNextPendingRun(): Promise<WorkflowRunRecord | null>;     // atomic FOR UPDATE SKIP LOCKED claim

  // WorkflowStage operations
  createStage(data: CreateStageInput): Promise<WorkflowStageRecord>;
  upsertStage(data: UpsertStageInput): Promise<WorkflowStageRecord>;
  updateStage(id: string, data: UpdateStageInput): Promise<void>;
  getStage(runId: string, stageId: string): Promise<WorkflowStageRecord | null>;
  getStagesByRun(runId: string, options?: { status?: Status; orderBy?: "asc" | "desc" }): Promise<WorkflowStageRecord[]>;
  getSuspendedStages(beforeDate: Date): Promise<WorkflowStageRecord[]>;
  deleteStage(id: string): Promise<void>;

  // WorkflowLog operations
  createLog(data: CreateLogInput): Promise<void>;

  // WorkflowAnnotation operations
  appendAnnotations(inputs: CreateAnnotationInput[]): Promise<void>;
  listAnnotations(workflowRunId: string, filters?: AnnotationFilters): Promise<WorkflowAnnotationRecord[]>;

  // Outbox DLQ operations
  incrementOutboxRetryCount(id: string): Promise<number>;
  moveOutboxEventToDLQ(id: string): Promise<void>;
  replayDLQEvents(maxEvents: number): Promise<number>;

  // Outbox operations
  appendOutboxEvents(events: CreateOutboxEventInput[]): Promise<void>;
  getUnpublishedOutboxEvents(limit?: number): Promise<OutboxRecord[]>;
  markOutboxEventsPublished(ids: string[]): Promise<void>;

  // Idempotency operations
  //
  // `options.staleInProgressAfterMs` lets a dispatch reclaim a key stuck
  // `in_progress` (e.g. a previous dispatcher crashed between committing
  // its transaction and calling `completeIdempotencyKey`) once it has
  // been in progress for at least that long, measured against
  // `options.now`. The kernel passes this automatically -- see
  // `KernelConfig.idempotencyStaleInProgressMs` (default 10 minutes).
  acquireIdempotencyKey(
    key: string,
    commandType: string,
    options?: { now?: Date; staleInProgressAfterMs?: number },
  ): Promise<
    | { status: "acquired" }
    | { status: "replay"; result: unknown }
    | { status: "in_progress" }
  >;
  completeIdempotencyKey(key: string, commandType: string, result: unknown): Promise<void>;
  releaseIdempotencyKey(key: string, commandType: string): Promise<void>;
}
```

### ArtifactPersistence (deprecated -- use BlobStore)

None of these are on the kernel's call path. Stage artifacts and stage output are persisted through the `BlobStore` port, not through `WorkflowPersistence`. Kept on `WorkflowPersistence` for backward compatibility; removal at 1.0.

```typescript
interface ArtifactPersistence {
  /** @deprecated Unused by the kernel -- use the BlobStore port instead. */
  saveArtifact(data: SaveArtifactInput): Promise<void>;
  /** @deprecated Unused by the kernel -- use the BlobStore port instead. */
  loadArtifact(runId: string, key: string): Promise<unknown>;
  /** @deprecated Unused by the kernel -- use the BlobStore port instead. */
  hasArtifact(runId: string, key: string): Promise<boolean>;
  /** @deprecated Unused by the kernel -- use the BlobStore port instead. */
  deleteArtifact(runId: string, key: string): Promise<void>;
  /** @deprecated Unused by the kernel -- use the BlobStore port instead. */
  listArtifacts(runId: string): Promise<WorkflowArtifactRecord[]>;
  /** @deprecated Unused by the kernel -- use the BlobStore port instead. */
  getStageIdForArtifact(runId: string, stageId: string): Promise<string | null>;
  /** @deprecated Unused by the kernel -- stage output is persisted through the BlobStore port. */
  saveStageOutput(runId: string, workflowType: string, stageId: string, output: unknown): Promise<string>;
}
```

### WorkflowPersistence (full contract: Core + Artifact + 8 legacy query methods)

```typescript
interface WorkflowPersistence extends PersistenceCore, ArtifactPersistence {
  // Redeclared (not merely inherited from PersistenceCore) so the callback
  // receives the full WorkflowPersistence surface, including artifact methods.
  withTransaction<T>(fn: (tx: WorkflowPersistence) => Promise<T>): Promise<T>;

  /** @deprecated Unused by the kernel. */
  getRunsByStatus(status: Status): Promise<WorkflowRunRecord[]>;

  /** @deprecated Unused by the kernel -- claimNextPendingRun (atomic FOR UPDATE SKIP LOCKED claim) is used instead. */
  claimPendingRun(id: string): Promise<boolean>;

  /** @deprecated Unused by the kernel -- resolve via getStage(runId, stageId) and call updateStage(stage.id, ...) instead. */
  updateStageByRunAndStageId(workflowRunId: string, stageId: string, data: UpdateStageInput): Promise<void>;

  /** @deprecated Unused by the kernel -- use getStage(runId, stageId) or getStagesByRun(runId) instead. */
  getStageById(id: string): Promise<WorkflowStageRecord | null>;

  /** @deprecated Unused by the kernel -- use getStagesByRun(runId, { status: "SUSPENDED" }) and filter by nextPollAt === null instead. */
  getFirstSuspendedStageReadyToResume(runId: string): Promise<WorkflowStageRecord | null>;

  /** @deprecated Unused by the kernel -- use getStagesByRun(runId, { status: "FAILED" }) instead. */
  getFirstFailedStage(runId: string): Promise<WorkflowStageRecord | null>;

  /** @deprecated Unused by the kernel -- use getStagesByRun(runId, { status: "COMPLETED", orderBy: "desc" }) instead. */
  getLastCompletedStage(runId: string): Promise<WorkflowStageRecord | null>;

  /** @deprecated Unused by the kernel -- use getStagesByRun(runId, { status: "COMPLETED", orderBy: "desc" }) and filter by executionGroup instead. */
  getLastCompletedStageBefore(runId: string, executionGroup: number): Promise<WorkflowStageRecord | null>;
}
```

```typescript
interface DequeueResult {
  jobId: string;
  workflowRunId: string;
  workflowId: string;
  stageId: string;
  priority: number;
  attempt: number;
  maxAttempts: number;
  payload: Record<string, unknown>;
}
```

## JobQueue Interface

```typescript
interface JobQueue {
  /** @deprecated Unused by the kernel -- enqueueParallel is used even for single-job enqueues. */
  enqueue(options: EnqueueJobInput): Promise<string>;
  enqueueParallel(jobs: EnqueueJobInput[]): Promise<string[]>;
  dequeue(): Promise<DequeueResult | null>;
  complete(jobId: string): Promise<void>;
  suspend(jobId: string, nextPollAt: Date): Promise<void>;
  fail(jobId: string, error: string, shouldRetry?: boolean): Promise<void>;
  releaseStaleJobs(staleThresholdMs?: number): Promise<number>;
  cancelByRun(workflowRunId: string): Promise<number>;
  getJobsByWorkflowRun(workflowRunId: string): Promise<JobRecord[]>;
  touchJob(jobId: string): Promise<void>;
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

The authoritative copy of this schema lives in the package [README](../../../README.md#getting-started) and in `prisma/schema.prisma`. If this block and the README ever disagree, trust the README / `prisma/schema.prisma`.

### Required Enum

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
```

`LogLevel` and `ArtifactType` are **not** enums -- `WorkflowLog.level` and `WorkflowArtifact.type` are plain `String` columns (the engine validates the values at the TypeScript layer).

### WorkflowRun Model

```prisma
model WorkflowRun {
  id            String   @id @default(cuid())
  createdAt     DateTime @default(now())
  updatedAt     DateTime @updatedAt
  version       Int      @default(1)
  workflowId    String
  workflowName  String
  workflowType  String
  status        Status   @default(PENDING)
  startedAt     DateTime?
  completedAt   DateTime?
  duration      Int?
  input         Json
  output        Json?
  config        Json           @default("{}")
  totalCost     Float          @default(0)
  totalTokens   Int            @default(0)
  priority      Int            @default(5)
  metadata      Json?

  stages        WorkflowStage[]
  logs          WorkflowLog[]
  artifacts     WorkflowArtifact[]
  annotations   WorkflowAnnotation[]

  @@index([status])
  @@index([workflowId])
  @@map("workflow_runs")
}
```

`version` backs optimistic concurrency on `updateRun` (see `expectedVersion` on `UpdateRunInput`); it is incremented on every update, whether or not the caller passes `expectedVersion`. `metadata` is a free-form JSON slot passed through from `CreateRunInput.metadata` -- it is stored as-is, not spread into columns.

### WorkflowStage Model

```prisma
model WorkflowStage {
  id              String              @id @default(cuid())
  createdAt       DateTime            @default(now())
  updatedAt       DateTime            @updatedAt
  version         Int                 @default(1)
  workflowRunId   String
  workflowRun     WorkflowRun         @relation(fields: [workflowRunId], references: [id], onDelete: Cascade)
  stageId         String
  stageName       String
  stageNumber     Int
  executionGroup  Int
  attempt         Int                 @default(0)
  status          Status              @default(PENDING)
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

  logs            WorkflowLog[]
  artifacts       WorkflowArtifact[]
  annotations     WorkflowAnnotation[]

  @@unique([workflowRunId, stageId])
  @@index([status])
  @@index([nextPollAt])
  @@map("workflow_stages")
}
```

`attempt` is the rerun generation: 0 for the original execution, incremented each time `run.rerunFrom` recreates the stage. Annotations written by `ctx.annotate(...)` during a stage inherit its `attempt` value so a later query can distinguish decisions made on different attempts of the same logical stage.

### WorkflowLog Model

```prisma
model WorkflowLog {
  id              String          @id @default(cuid())
  createdAt       DateTime        @default(now())
  workflowRunId   String?
  workflowRun     WorkflowRun?    @relation(fields: [workflowRunId], references: [id], onDelete: Cascade)
  workflowStageId String?
  workflowStage   WorkflowStage?  @relation(fields: [workflowStageId], references: [id], onDelete: Cascade)
  level           String
  message         String
  metadata        Json?

  @@index([workflowRunId])
  @@index([workflowStageId])
  @@map("workflow_logs")
}
```

### WorkflowArtifact Model

```prisma
model WorkflowArtifact {
  id              String          @id @default(cuid())
  createdAt       DateTime        @default(now())
  updatedAt       DateTime        @updatedAt
  workflowRunId   String
  workflowRun     WorkflowRun     @relation(fields: [workflowRunId], references: [id], onDelete: Cascade)
  workflowStageId String?
  workflowStage   WorkflowStage?  @relation(fields: [workflowStageId], references: [id], onDelete: SetNull)
  key             String
  type            String
  data            Json
  size            Int
  metadata        Json?

  @@unique([workflowRunId, key])
  @@index([workflowRunId])
  @@map("workflow_artifacts")
}
```

### WorkflowAnnotation Model

```prisma
model WorkflowAnnotation {
  id                    String   @id @default(cuid())
  createdAt             DateTime @default(now())

  workflowRunId         String
  workflowRun           WorkflowRun     @relation(fields: [workflowRunId], references: [id], onDelete: Cascade)

  workflowStageRecordId String?
  workflowStage         WorkflowStage?  @relation(fields: [workflowStageRecordId], references: [id], onDelete: SetNull)
  attempt               Int             @default(0)

  scope                 String          // "run" | "stage" | "ai_call" | custom
  scopeId               String?

  actorKind             String?         // "agent" | "user" | "system" (open)
  actorId               String?
  actorVersion          String?

  key                   String          // dot-namespaced, e.g. "trigger.source"
  value                 Json            // scalar or scalar-array preferred
  payload               Json?           // opt-in blob slot for non-queryable rich data

  idempotencyKey        String?

  @@unique([workflowRunId, key, idempotencyKey])
  @@index([workflowRunId, key])
  @@index([workflowRunId, createdAt])
  @@index([workflowRunId, scope])
  @@index([workflowRunId, actorId])
  @@map("workflow_annotations")
}
```

Backs `kernel.annotations.attach(...)` / `kernel.annotations.list(...)` and `ctx.annotate(...)`. Rows sharing `(workflowRunId, key, idempotencyKey)` are deduplicated via the unique constraint -- retries with the same `idempotencyKey` are silently skipped rather than erroring.

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
```

### OutboxEvent Model

```prisma
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
```

Backs the kernel's transactional outbox: command handlers write events here in the same transaction as their state changes, and `outbox.flush` publishes them to the `EventSink` afterward. `dlqAt` marks events that exhausted their retry budget; `replayDLQEvents` resets them for reprocessing.

### IdempotencyKey Model

```prisma
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

Backs `acquireIdempotencyKey` / `completeIdempotencyKey` / `releaseIdempotencyKey`. A row's `result` holds an internal in-progress marker until the command completes, at which point it's overwritten with the cached command result (so a replayed dispatch with the same key returns it without re-executing). `createdAt` doubles as the "acquired at" timestamp: if a dispatcher crashes after committing its transaction but before calling `completeIdempotencyKey`, the row is left stuck with the in-progress marker forever. The kernel guards against this by reclaiming keys that have been `in_progress` for longer than `KernelConfig.idempotencyStaleInProgressMs` (default 10 minutes) -- see `acquireIdempotencyKey`'s `staleInProgressAfterMs` option above.

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

`PrismaWorkflowPersistence`, `PrismaJobQueue`, `PrismaAICallLogger`, and `createEnumHelper` no longer accept `prisma: any`. They now require a structural `EnginePrismaClient` shape (an internal type, not exported from any public entry point -- you never import or write it by name). Any real Prisma-generated client (6.x or 7.x) satisfies it automatically, since it only requires the delegates the adapters actually call (`workflowRun`, `workflowStage`, etc.) plus optional `$transaction`/`$queryRaw`/`$executeRaw`/`$Enums`. The only visible effect is on hand-written mocks/fakes: a `PrismaClient`-shaped test double missing a delegate the adapter actually calls now fails to typecheck, where it previously compiled silently under `any`. No runtime behavior change.

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
  version: number;
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
  metadata: unknown | null;
}

interface WorkflowStageRecord {
  id: string;
  createdAt: Date;
  updatedAt: Date;
  version: number;
  workflowRunId: string;
  stageId: string;
  stageName: string;
  stageNumber: number;
  executionGroup: number;
  attempt: number;   // rerun generation; 0 for the original execution
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
  completedAt?: Date | null;
  duration?: number | null;
  output?: unknown;
  totalCost?: number;
  totalTokens?: number;
  expectedVersion?: number;  // optimistic concurrency; version always bumps regardless
}

interface CreateStageInput {
  workflowRunId: string;
  stageId: string;
  stageName: string;
  stageNumber: number;
  executionGroup: number;
  attempt?: number;  // rerun generation; defaults to 0
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
  artifacts?: unknown;
  errorMessage?: string;
  expectedVersion?: number;
}
```

## Custom Persistence Implementation

For non-Prisma databases or testing. Target `PersistenceCore` (not the full `WorkflowPersistence`) unless you specifically need the deprecated artifact methods for backward compatibility -- it's the ~26-method subset the kernel actually calls:

```typescript
import type { PersistenceCore } from "@bratsos/workflow-engine";

class CustomPersistence implements PersistenceCore {
  private runs = new Map<string, WorkflowRunRecord>();
  private stages = new Map<string, WorkflowStageRecord>();

  async createRun(data: CreateRunInput): Promise<WorkflowRunRecord> {
    const run: WorkflowRunRecord = {
      id: data.id ?? crypto.randomUUID(),
      createdAt: new Date(),
      updatedAt: new Date(),
      version: 1,
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
      metadata: data.metadata ?? null,
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
