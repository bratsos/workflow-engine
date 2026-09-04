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
  updateStage(id: string, data: UpdateStageInput): Promise<void>;     // must throw StaleVersionError on expectedVersion mismatch: the poll claims stages with it
  getStage(runId: string, stageId: string): Promise<WorkflowStageRecord | null>;
  getStagesByRun(runId: string, options?: { status?: Status; orderBy?: "asc" | "desc" }): Promise<WorkflowStageRecord[]>;
  getSuspendedStages(beforeDate: Date): Promise<WorkflowStageRecord[]>;   // plain read: SUSPENDED and nextPollAt <= beforeDate; the claim happens in updateStage
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
  claimUnpublishedOutboxEvents(limit?: number): Promise<OutboxRecord[]>;
  releaseOutboxEvents(ids: string[]): Promise<void>;
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
  deleteByRunAndStages(workflowRunId: string, stageIds: string[]): Promise<number>;
  /** `serves` narrows the claim to the definition versions this host presents. */
  dequeue(options?: { serves?: readonly ServedDefinition[] }): Promise<DequeueResult | null>;
  complete(jobId: string, fence?: JobAckFence): Promise<JobAckOutcome>;
  suspend(jobId: string, nextPollAt: Date, fence?: JobAckFence): Promise<JobAckOutcome>;
  fail(jobId: string, error: string, shouldRetry?: boolean, fence?: JobAckFence): Promise<JobAckOutcome>;
  /** Put a claimed job back PENDING without spending its attempt. Optional. */
  defer?(jobId: string, nextPollAt: Date, reason: string, fence?: JobAckFence): Promise<JobAckOutcome>;
  releaseStaleJobs(staleThresholdMs?: number): Promise<number>;
  expireRunawayJobs?(absoluteTimeoutMs: number): Promise<number>;
  cancelByRun(workflowRunId: string): Promise<number>;
  getJobsByWorkflowRun(workflowRunId: string): Promise<JobRecord[]>;
  touchJob(jobId: string): Promise<void>;
}
```

### One job row per stage per run

`job_queue` carries at most one row per `(workflowRunId, stageId)`, declared as
`@@unique([workflowRunId, stageId])` in the reference schema. Two rules keep it:

- **`enqueueParallel` is idempotent on that pair.** A custom implementation MUST
  replace any row already queued for a pair it is asked to enqueue, resetting
  `attempt`, `status`, `workerId`, `lockedAt`, `lastError` and `nextPollAt`. Both
  built-in queues do it by deleting the existing rows in the same transaction as
  the insert (which also collapses duplicates a pre-1.0 schema may already hold);
  the new row therefore has a new `id`. `run.rerunFrom` and `run.reapStuck`'s
  PENDING-without-job recovery sweep both re-enqueue stages that still carry a
  terminal job row from a previous execution, so an implementation that inserts
  unconditionally either accumulates duplicates or fails against the unique.
- **`deleteByRunAndStages` retires rows outright.** `run.rerunFrom` calls it for
  every stage record it deletes -- including the downstream stages it deletes
  without recreating, whose rows nothing would ever enqueue over.

Both are covered by `jobQueueConformanceSuite`, so a custom `JobQueue` gets the
same checks the built-in adapters do.

### Fenced acknowledgements

`dequeue()` hands back `startedAt` next to `attempt`. The pair is that claim's
*attempt stamp*, and passing it back as a `JobAckFence` (`{ startedAt, attempt }`)
on `complete`, `fail` or `suspend` conditions the write on the job still being
the `RUNNING` attempt it describes:

```sql
UPDATE job_queue SET ... WHERE id = $1 AND status = 'RUNNING'
                           AND "startedAt" = $2 AND attempt = $3
```

Without it, a worker that stalls past `staleLeaseThresholdMs` has its job
rescued by `releaseStaleJobs` and re-claimed by someone else -- and then, on
waking, marks the *new* attempt COMPLETED and discards the work that attempt is
actually doing. With it, the stale write matches nothing, changes nothing and
comes back as `"superseded"`, which the built-in hosts log (and, on the
completed path, use to skip the `run.transition` the newer attempt owns). An
unfenced call keeps the older unconditional behaviour and always returns
`"acknowledged"`, so a transport that cannot carry the stamp still works.

`touchJob` is deliberately unfenced: a stale heartbeat only refreshes whichever
attempt currently owns the row, which costs the newer attempt nothing.

`jobQueueConformanceSuite` covers both the fenced and unfenced paths.

### Per-group fairness (opt-in, PostgreSQL)

By default the dequeue orders by `priority DESC, "createdAt" ASC` and nothing
else, so a tenant that enqueues 100k jobs puts every later arrival from every
other tenant behind all 100k. `JobQueueFairness` fixes that:

```typescript
const jobQueue = createPrismaJobQueue(prisma, {
  fairness: {
    // How many jobs one group may hold RUNNING at once. No default -- size it
    // to your pool, roughly `workers / groups active at once`, never below 1.
    maxConcurrentPerGroup: 4,
    // Where the group key lives in the job payload. Defaults to "_groupKey",
    // which is what EnqueueJobInput.groupKey writes.
    groupBy: "config.tenantId",
  },
});
```

**It is a concurrency cap, not a reordering.** A group already holding
`maxConcurrentPerGroup` RUNNING jobs is excluded from the claim entirely, which
leaves a quiet group's job as the only candidate. Reordering cannot fix
starvation: whatever rule ranks the pending rows, the flooding group's next row
is re-ranked to the front the moment its previous one is claimed. This is
pg-boss v12's group-concurrency mechanism.

**Which key to use.** The kernel's own enqueue paths (`run.claimPending`,
`run.transition`, `run.reapStuck`) enqueue from the run record and do not set
`groupKey`, but they do copy the run's `config` into the job payload -- so for
kernel-driven workflows point `groupBy` at a field of the run config, e.g.
`"config.tenantId"`. `EnqueueJobInput.groupKey` (stored as `payload._groupKey`,
and stripped again before the payload reaches a stage) is for callers that
enqueue jobs directly. Jobs with no value at the path share one anonymous
group, which is capped like any other.

**Cost.** Measured on Postgres 16, one connection, flat priorities, 200
sequential claims per run:

| Ready jobs / groups | Default claim | Fair claim | Ratio |
| --- | --- | --- | --- |
| 1,000 / 5 | 1.65 ms mean | 1.55 ms | 0.94x |
| 10,000 / 10 | 2.66 ms mean | 4.37 ms | 1.64x |
| 50,000 / 100 | 7.90 ms mean | 17.30 ms | 2.19x |

Fairness is materially more expensive on a deep queue -- the claim joins the
candidate rows against a per-group count of everything RUNNING, where the
default statement stops at the first index entry -- which is why it is opt-in
and off by default. On a shallow queue it is free. It is PostgreSQL only;
constructing a SQLite queue with `fairness` throws at wiring time rather than
silently ignoring it.

### Two-tier lease expiry

`releaseStaleJobs` is the fine-grained tier: it compares `lockedAt`, which
`touchJob` refreshes on every heartbeat, so it catches a worker that *stopped*.
It cannot catch a worker that is alive but wedged, because that worker keeps
heartbeating. `expireRunawayJobs(absoluteTimeoutMs)` -- optional on the port, so
an older adapter still compiles -- is the coarse backstop: it compares
`startedAt`, stamped once per claim and refreshed by nothing, and fails the job
terminally.

Both stamp `lastError` with an exported prefix so the two are distinguishable
after the fact: `LEASE_HEARTBEAT_LOST` (requeued `PENDING`) and
`LEASE_ABSOLUTE_CAP` (`FAILED`). A custom adapter should write the same prefixes.
The kernel sweeps the heartbeat tier first, so a dead worker's job is retried
rather than dead-lettered. Defaults and the host knobs live in
03-runtime-setup.md.

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

### Timestamps

Every `DateTime` below is a plain Prisma `DateTime` -- on Postgres a naive
`timestamp(3)` holding UTC. Keep it that way: **do not** map these columns to
`@db.Timestamptz`. The adapters' raw statements (the `FOR UPDATE SKIP LOCKED`
claim and dequeue, the outbox claim) convert their bound timestamps with
`AT TIME ZONE 'UTC'` so they agree with what the Prisma model API writes to
the same columns, which is what makes lease expiry and the stale-job sweep
work on a session in *any* timezone without the consumer setting anything. A
`@db.Timestamptz` mapping puts the two writers back out of step and crash
recovery stops happening -- see [Troubleshooting](09-troubleshooting.md#crash-recovery-never-happens-non-utc-postgres-session).

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

  // One job row per stage per run -- see "One job row per stage per run" above.
  @@unique([workflowRunId, stageId])
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
```

`@@unique([workflowRunId, stageId])` is required as of 1.0.0-alpha.7. Adding it to
an existing database fails while duplicate rows are present; collapse them first
(keep the newest row per pair) -- the [0.13 -> 1.0 guide](../migrations/migrate-0.13-to-1.0.md#database-checklist) has the SQL.

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
  // Dead letters are a subset of the unpublished rows, so without this the
  // dead-letter view has to walk every unpublished event and fetch its heap
  // tuple -- which is slowest exactly when a backlog has built up and you
  // most want to read it. Postgres users writing migrations by hand should
  // prefer a partial index (WHERE "dlqAt" IS NOT NULL); Prisma cannot
  // express one, and this is the closest it gets.
  @@index([dlqAt])
  @@map("outbox_events")
}
```

Backs the kernel's transactional outbox: command handlers write events here in the same transaction as their state changes, and `outbox.flush` publishes them to the `EventSink` afterward. The flush **claims** rows before it emits them (`claimUnpublishedOutboxEvents` stamps `publishedAt` atomically — one `UPDATE ... FROM (SELECT ... FOR UPDATE SKIP LOCKED) RETURNING` on Postgres, a per-row compare-and-set on `publishedAt IS NULL` on SQLite), so two processes flushing the same outbox at once — a cron tick and a request-kicked tick, two workers — deliver each event once; an emit that throws hands the event (and the rest of its run, to keep order) back with `releaseOutboxEvents` for the next flush. A process that dies between the claim and the emit leaves that event stamped: the claim is what makes delivery once-only. A custom `WorkflowPersistence` must implement both methods; the conformance suite covers them. `dlqAt` marks events that exhausted their retry budget; `replayDLQEvents` resets them for reprocessing.

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

  batchId      String?
  requestId    String?

  @@unique([batchId, requestId], map: "ai_calls_batch_request_unique")
  @@index([batchId])
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
// Omit workerId under a host: createNodeHost stamps its own on the queue,
// so job_queue.workerId names the same worker run.claimPending does.
const jobQueue = createPrismaJobQueue(prisma);
const aiCallLogger = createPrismaAICallLogger(prisma);

// Prisma-backed blob store (optional WorkflowBlob table): stage outputs are
// read by every process that executes or polls a run, so the store must be
// shared across them.
const blobStore = createPrismaBlobStore(prisma);
const stepLedger = createPrismaStepLedger(prisma);

// SQLite - uses optimistic locking instead of FOR UPDATE SKIP LOCKED
const persistence = createPrismaWorkflowPersistence(prisma, {
  databaseType: "sqlite"
});
const jobQueue = createPrismaJobQueue(prisma, {
  databaseType: "sqlite",
  workerId: "my-worker-id"  // optional
});
```

`PrismaWorkflowPersistence`, `PrismaJobQueue`, `PrismaAICallLogger`, and `createEnumHelper` no longer accept `prisma: any`. They now require a structural `EnginePrismaClient` shape (an internal type, not exported from any public entry point -- you never import or write it by name). Any real Prisma-generated client (6.x or 7.x) satisfies it automatically, since it only requires the delegates the adapters actually call plus optional `$transaction`/`$queryRaw`/`$queryRawUnsafe`/`$executeRaw`/`$Enums`. The required delegates are exactly: `workflowRun`, `workflowStage`, `workflowStep`, `workflowLog`, `workflowArtifact`, `workflowAnnotation`, `outboxEvent`, `idempotencyKey`, `jobQueue`, `aICall`. **A wall of `PrismaClient is not assignable to EnginePrismaClient` errors means one of those models is missing from your schema** (after an upgrade to 1.0 it is almost always `WorkflowStep`): add the model, run `prisma generate`, and the error goes away.

If your schema names the status enum differently (for example `WorkflowStatus`, with or without `@@map`), pass it: the Postgres claim path casts with `::"<name>"` (since 0.11) and fails with `42704 type "Status" does not exist` otherwise. The persistence and job queue also accept a `now` clock; the raw statements bind that JS `Date` (UTC) instead of `NOW()`.

```typescript
const persistence = createPrismaWorkflowPersistence(prisma, {
  statusEnumName: "WorkflowStatus",   // default "Status"
  now: () => clock.now(),             // default () => new Date()
});
``` The only visible effect is on hand-written mocks/fakes: a `PrismaClient`-shaped test double missing a delegate the adapter actually calls now fails to typecheck, where it previously compiled silently under `any`. No runtime behavior change.

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
  workerId?: string;            // Default: auto-generated, or the host's (see below)
  databaseType?: DatabaseType;  // Default: "postgresql"
}
```

### `workerId`: let the host supply it

`job_queue.workerId` is written by the queue, not by the host, and the queue is
normally constructed first. Left to itself it generates `worker-<pid>-<timestamp>`,
which matches no `NodeHostConfig.workerId` and makes "which worker ran this stage"
unanswerable from the job row.

As of 1.0.0-alpha.7 / host-node 0.4.4, `createNodeHost(...).start()` offers its
`workerId` to the transport (`JobTransport.adoptWorkerId`, optional on the port).
So:

- **`createPrismaJobQueue(prisma)`** -- the queue adopts the host's id. This is
  what you want under a host.
- **`createPrismaJobQueue(prisma, { workerId: "..." })`** -- the queue keeps yours
  (you asked for it), and the host logs a one-line `workerId mismatch` warning
  naming both ids if they differ. Pass one only where there is no host to take it
  from, e.g. a script enqueueing jobs directly.

A custom `JobTransport` may implement `adoptWorkerId(workerId): string` -- take the
id unless one was explicitly configured, and return the id you will actually stamp.
Omitting the method is fine; the host then leaves the transport alone.

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
  attempt: number;   // executions of this stage row: reruns and job retries; 0 for the original execution
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
  attempt?: number;  // executions of this stage row; defaults to 0
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
- `nextPollAt` - for suspended stage polling (`stage.pollSuspended` reads `SUSPENDED` rows with `nextPollAt <= now`, then claims each by moving `nextPollAt` forward with `expectedVersion`; a custom adapter needs the version guard on `updateStage` for two orchestrators to poll safely)
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
