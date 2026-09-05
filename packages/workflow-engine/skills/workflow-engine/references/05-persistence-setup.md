# Persistence Setup

Complete guide for setting up workflow persistence with Prisma.

## ⚠️ Pre-Setup Checklist

Before creating persistence instances, verify your Prisma schema:

- [ ] `WorkflowRun` model exists with `duration` field (not `durationMs`) and a `version` field for optimistic concurrency
- [ ] `WorkflowStage` model exists with `duration` field (not `durationMs`), `version`, and `attempt` fields
- [ ] `WorkflowLog` model exists (required for `ctx.log()`)
- [ ] `WorkflowArtifact` model exists (required for stage outputs)
- [ ] `WorkflowAnnotation` model exists (required for `kernel.annotations` / `ctx.annotate()`)
- [ ] `WorkflowStep` model exists (required by `createPrismaStepLedger` / `ctx.step.*`; part of `EnginePrismaClient` since 1.0)
- [ ] `WorkflowDefinition` model exists, and `WorkflowRun` carries `definitionVersion` / `redriveCount` (optional: the adapter runs without definition versioning when they are absent)
- [ ] `WorkflowBlob` model exists (only when using `createPrismaBlobStore`)
- [ ] `JobQueue` model exists (required for job processing) with `@@unique([workflowRunId, stageId])`
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
| `PrismaClient is not assignable to EnginePrismaClient` (a wall of them) | A required delegate is missing, after 1.0 almost always `workflowStep` | Add the model, run `prisma generate` |
| `near "FOR": syntax error` | Using SQLite without `databaseType: "sqlite"` | Pass `{ databaseType: "sqlite" }` to factory functions |

## Interfaces Overview

The workflow engine uses five persistence ports:

| Interface | Purpose |
|-----------|---------|
| `WorkflowPersistence` / `PersistenceCore` | Workflow runs, stages, definitions, logs, annotations, outbox, idempotency keys |
| `JobQueue` (the kernel's `JobTransport` port) | Job scheduling and processing |
| `StepLedger` | Durable step rows (`ctx.step.*`) |
| `BlobStore` | Stage outputs, artifacts and spilled payloads |
| `AICallLogger` | AI call tracking and stats |

## WorkflowPersistence Interface

`PersistenceCore` and `WorkflowPersistence` are both exported from `@bratsos/workflow-engine` (and `@bratsos/workflow-engine/persistence`):

- **`PersistenceCore`** -- everything the kernel's handlers/helpers and the host packages actually call. The kernel's `Persistence` port (`@bratsos/workflow-engine/kernel`) derives from `PersistenceCore`, so the kernel's real requirement is visible directly in the type graph.
- **`WorkflowPersistence`** -- `PersistenceCore` plus a `withTransaction` whose callback receives the full `WorkflowPersistence` surface. Since 1.0 it is nothing more than that: the pre-1.0 `ArtifactPersistence` methods (`saveArtifact`, `loadArtifact`, `saveStageOutput`, ... -- replaced by the `BlobStore` port, see [03-runtime-setup.md](03-runtime-setup.md)) and the eight legacy query methods (`getRunsByStatus`, `claimPendingRun`, `getStageById`, ...) are no longer part of the contract. The built-in adapters still carry them as plain class methods.

**New implementers only need `PersistenceCore`**; a custom adapter is checked by `persistenceConformanceSuite` (see "Conformance suites" below).

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
  listRunsForPurge(cutoff: Date, statuses: readonly PurgeableRunStatus[], limit: number): Promise<PurgeableRun[]>;   // run.purge: terminal runs finished at or before cutoff, oldest first, with their stage record ids
  deleteRun(id: string): Promise<void>;   // run.purge: the run and everything under it (stages, logs, artifacts, annotations, and workflow_steps through the cascade); missing id is a no-op
  claimNextPendingRun(options?: {
    now?: Date;                                                 // the kernel clock's time, written as startedAt/updatedAt
    serves?: readonly ServedDefinition[];                       // definition versions this build serves; omit to claim any run
  }): Promise<WorkflowRunRecord | null>;                        // atomic FOR UPDATE SKIP LOCKED claim

  // Definition versioning (1.0). An adapter with no versioning tables
  // returns false / null / [] here and ignores `serves`; the engine then
  // behaves exactly as it did before versioning existed. See
  // 13-definition-versioning.md.
  supportsDefinitionVersioning(): boolean;
  ensureDefinitionVersioningDetected?(): Promise<boolean>;   // optional: confirm the answer against the live database once, without a statement that can fail inside a caller's transaction
  insertDefinitionIfAbsent(input: CreateDefinitionInput): Promise<WorkflowDefinitionRecord | null>;
  getDefinition(workflowId: string, version: string): Promise<WorkflowDefinitionRecord | null>;
  countRunsByDefinitionVersion(filter?: DefinitionVersionCountFilter): Promise<DefinitionVersionCount[]>;

  // WorkflowStage operations
  createStage(data: CreateStageInput): Promise<WorkflowStageRecord>;
  upsertStage(data: UpsertStageInput): Promise<WorkflowStageRecord>;
  updateStage(id: string, data: UpdateStageInput): Promise<void>;     // must throw StaleVersionError on expectedVersion mismatch: the poll claims stages with it
  getStage(runId: string, stageId: string): Promise<WorkflowStageRecord | null>;
  getStagesByRun(runId: string, options?: { status?: Status; orderBy?: "asc" | "desc" }): Promise<WorkflowStageRecord[]>;
  getSuspendedStages(beforeDate: Date, options?: {
    limit?: number;                                             // cap, oldest nextPollAt first -- the adapter owns the ordering and the cap
    serves?: readonly ServedDefinition[];                       // same filter as claimNextPendingRun, evaluated against the stage's run
  }): Promise<WorkflowStageRecord[]>;                           // plain read: SUSPENDED and nextPollAt <= beforeDate; the claim happens in updateStage
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

### WorkflowPersistence (full contract)

```typescript
interface WorkflowPersistence extends PersistenceCore {
  // Redeclared (not merely inherited from PersistenceCore) so the callback
  // receives the full WorkflowPersistence surface.
  withTransaction<T>(fn: (tx: WorkflowPersistence) => Promise<T>): Promise<T>;
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
  startedAt: Date;   // this claim's attempt stamp; hand it back as the JobAckFence
}
```

## JobQueue Interface

`JobQueue` is the same shape as the kernel's `JobTransport` port; the built-in
adapters satisfy both. The single-job `enqueue` is no longer on the port
(`enqueueParallel([job])`); the built-in adapters keep it as a plain method.

```typescript
interface JobQueue {
  /** Dotted `groupBy` path the fairness cap reads; null when fairness is off. Read by createSpillingJobTransport. */
  readonly fairnessGroupBy?: string | null;
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
  /** Optional: take the host's workerId unless one was configured; return the id actually stamped. */
  adoptWorkerId?(workerId: string): string;
}

type JobAckOutcome = "acknowledged" | "superseded";
interface JobAckFence { startedAt: Date; attempt: number; }
```

`fail(jobId, error, true)` MUST put the job back in the queue (`PENDING`, with
backoff, keeping its attempt count): the kernel has already recorded the stage
as `PENDING` on that promise. A **decorator** around a transport must forward
the optional `fence` explicitly -- a delegation that drops the trailing
parameter still typechecks, and silently turns every fenced acknowledgement
back into an unconditional write. A fenced `complete`/`fail`/`suspend` naming a
job row that no longer exists must return `"superseded"` rather than throw;
unfenced, it stays an error.

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

## StepLedger Interface

Backs `ctx.step.*` (see [12-durable-steps.md](12-durable-steps.md)). Exported
from `@bratsos/workflow-engine` and `@bratsos/workflow-engine/kernel`; the
bundled implementations are `InMemoryStepLedger` (`/testing`) and
`PrismaStepLedger` (`createPrismaStepLedger`).

```typescript
interface StepLedger {
  /** Insert-if-absent. Existing records win conflicts without throwing. */
  claim(record: Omit<StepRecord, "createdAt" | "updatedAt">): Promise<{ created: boolean; record: StepRecord }>;
  get(stageRecordId: string, stepId: string): Promise<StepRecord | null>;
  update(stageRecordId: string, stepId: string, patch: StepRecordPatch): Promise<StepRecord>;
  /** Apply `patch` only when the row's current status (and attempt, when given) equals `expected`. */
  compareAndSet(
    stageRecordId: string,
    stepId: string,
    expected: { status: StepRecord["status"]; attempt?: number },   // omit attempt to match any attempt
    patch: StepRecordPatch,
  ): Promise<{ applied: boolean; record: StepRecord | null }>;
  list(stageRecordId: string): Promise<StepRecord[]>;
  clear(stageRecordId: string): Promise<void>;
  /** Optional: delete every row of the stage record except `keepStepIds`. A ledger without it falls back to `clear`. */
  clearExcept?(stageRecordId: string, keepStepIds: string[]): Promise<void>;
}
```

`StepRecordPatch` (`status`, `attempt`, `leaseExpiresAt`, `deadlineAt`, `result`,
`error`, `waitState`) follows one rule for every field: a key that is absent, or
present holding `undefined`, leaves that column alone; any other value,
**`null` included**, is written. `{ result: null }` therefore records "completed
with no value" and must overwrite whatever the row held. A ledger that skips
nullish values replays the previous attempt's result forever, which is exactly
what the bundled Prisma ledger did before 1.0.0-alpha.10;
`stepLedgerConformanceSuite` holds any implementation to the rule, and to
`compareAndSet` with and without a pinned `attempt`. `claim` on Postgres must
not raise a unique violation on a replay (it aborts a consumer's enclosing
transaction); `PrismaStepLedger` inserts through
`createMany({ skipDuplicates: true })` and reads the row back.

The kernel wraps whatever ledger it is given with the claim-check spill
(`spillThresholdBytes`, see [15-large-payloads.md](15-large-payloads.md)), so
the port itself never sees a result above the threshold.

## BlobStore Interface

```typescript
interface BlobStore {
  put(key: string, data: unknown): Promise<void>;
  get(key: string): Promise<unknown>;
  has(key: string): Promise<boolean>;
  delete(key: string): Promise<void>;
  list(prefix: string): Promise<string[]>;
}
```

Stage outputs and replay inputs are read from the blob store by **every process
that executes or polls a run**, so the store must be shared across them.
`createPrismaBlobStore(prisma)` makes Prisma that shared store without object
storage (the optional `WorkflowBlob` model below); it needs only the
`workflowBlob` delegate, not a change to `EnginePrismaClient`. A replay whose
blob store lacks a completed stage's output fails naming the blob key and the
shared-store requirement.

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
  steps           WorkflowStep[]

  @@unique([workflowRunId, stageId])
  @@index([status])
  @@index([nextPollAt])
  @@map("workflow_stages")
}
```

`attempt` counts the executions of this stage row: 0 for the original execution, incremented by each job retry and by each `run.redrive` / `run.rerunFrom` that reopens or recreates the stage. Annotations written by `ctx.annotate(...)` during a stage inherit its `attempt` value so a later query can distinguish decisions made on different attempts of the same logical stage.

### WorkflowStep Model

```prisma
model WorkflowStep {
  id            String   @id @default(cuid())
  stageRecordId String
  // Foreign key "workflow_steps_stageRecordId_fkey" ON DELETE CASCADE, so
  // deleting a stage record, or the run above it, removes its ledger rows
  // instead of orphaning them. A table created from an earlier 1.0 alpha
  // lacks it -- the 0.13 -> 1.0 guide has the guarded ADD CONSTRAINT.
  stage         WorkflowStage @relation(fields: [stageRecordId], references: [id], onDelete: Cascade)
  stepId        String
  seq           Int
  kind          String        // "run" | "wait" | "signal" | "sleep"
  status        String        // "running" | "pending" | "completed" | "failed"
  attempt        Int       @default(1)
  leaseExpiresAt DateTime?
  deadlineAt     DateTime?
  // Deterministic name for the external effect a `run` step body creates,
  // written before the body runs so an orphaned provider-side effect can be
  // found from the row after a crash. NULL for wait/signal/sleep rows and
  // for rows written before 1.0.0-alpha.9.
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
```

Backs `PrismaStepLedger`. Rows are keyed by the stage *record* id, so a `run.redrive` that reopens a stage in place keeps its completed rows, while one that deletes the record takes the rows with it through the cascade. `result` above `spillThresholdBytes` holds a `{ "$wfSpill": 1, key, bytes }` reference into the blob store rather than the value.

### WorkflowBlob Model (optional)

```prisma
// Only when using createPrismaBlobStore.
model WorkflowBlob {
  key       String   @id
  data      Json
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  @@map("workflow_blobs")
}
```

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
  createPrismaBlobStore,
  createPrismaStepLedger,
} from "@bratsos/workflow-engine";   // also re-exported from "@bratsos/workflow-engine/persistence/prisma"
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

`PrismaWorkflowPersistence`, `PrismaJobQueue`, `PrismaAICallLogger`, `PrismaStepLedger` and `createEnumHelper` do not accept `prisma: any`. They require a structural `EnginePrismaClient` shape (an internal type, not exported from any public entry point -- you never import or write it by name). Any real Prisma-generated client (6.x or 7.x) satisfies it automatically, since it only requires the delegates the adapters actually call plus optional `$transaction`/`$queryRaw`/`$queryRawUnsafe`/`$executeRaw`/`$Enums`. The required delegates are exactly: `workflowRun`, `workflowStage`, `workflowStep`, `workflowLog`, `workflowArtifact`, `workflowAnnotation`, `outboxEvent`, `idempotencyKey`, `jobQueue`, `aICall`; `workflowDefinition` is optional (its absence turns definition versioning off rather than failing to start), and `createPrismaBlobStore` needs only `workflowBlob`. **A wall of `PrismaClient is not assignable to EnginePrismaClient` errors means one of those models is missing from your schema** (after an upgrade to 1.0 it is almost always `WorkflowStep`): add the model, run `prisma generate`, and the error goes away. The only other visible effect is on hand-written mocks/fakes: a `PrismaClient`-shaped test double missing a delegate the adapter actually calls fails to typecheck, where it previously compiled silently under `any`. No runtime behavior change.

If your schema names the status enum differently (for example `WorkflowStatus`, with or without `@@map`), pass it: the Postgres claim path casts with `::"<name>"` (since 0.11) and fails with `42704 type "Status" does not exist` otherwise. The persistence also accepts a `now` clock; the raw claim statement binds that JS `Date` (converted with `AT TIME ZONE 'UTC'`) instead of `NOW()`. The job queue accepts `now` too, but on PostgreSQL the lease stamps (`lockedAt`, `startedAt`) come from the database clock and `staleLeaseThresholdMs` is measured there; `now` only feeds the SQLite dequeue and the timestamps written outside the raw statement.

```typescript
const persistence = createPrismaWorkflowPersistence(prisma, {
  statusEnumName: "WorkflowStatus",   // default "Status"
  now: () => clock.now(),             // default () => new Date()
  definitionVersioning: undefined,    // unset: detect from the generated client, then confirm against the database once
});
```

`definitionVersioning` is the escape hatch that skips both checks: `false` for a client whose schema carries the models against a database deliberately left unmigrated, `true` for a model surface the structural detection cannot see (a hand-written wrapper, a proxy). Left unset, the client is checked synchronously for a `workflowDefinition` delegate and the database is confirmed once, lazily, through a catalogue read (`to_regclass` / `pg_attribute` on Postgres, `sqlite_master` / `pragma_table_info` on SQLite) that answers "absent" instead of raising, so it cannot abort a transaction the kernel is running inside.

## Database Type Options

The Prisma implementations support both PostgreSQL and SQLite:

| Database | Locking Strategy | Use Case |
|----------|-----------------|----------|
| `postgresql` (default) | `FOR UPDATE SKIP LOCKED` | Production, multi-worker |
| `sqlite` | Optimistic locking with retry | Development, single-worker |

```typescript
type DatabaseType = "postgresql" | "sqlite";

interface PrismaWorkflowPersistenceOptions {
  databaseType?: DatabaseType;          // Default: "postgresql"
  skipInteractiveTransactions?: boolean; // Default: false
  statusEnumName?: string;              // Default: "Status"
  now?: () => Date;                     // Default: () => new Date()
  definitionVersioning?: boolean;       // Default: detected (see above)
}

interface PrismaJobQueueOptions {
  workerId?: string;            // Default: auto-generated, or the host's (see below)
  databaseType?: DatabaseType;  // Default: "postgresql"
  now?: () => Date;             // SQLite dequeue and non-raw writes only; Postgres lease stamps use the database clock
  fairness?: JobQueueFairness;  // Postgres only; see "Per-group fairness"
}

interface PrismaStepLedgerOptions {
  databaseType?: DatabaseType;  // "sqlite" keeps the create-and-catch claim; Postgres uses createMany({ skipDuplicates: true })
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

**Important:** When using SQLite, pass `{ databaseType: "sqlite" }` to `createPrismaWorkflowPersistence`, `createPrismaJobQueue` and `createPrismaStepLedger`. Otherwise, you'll get SQL syntax errors from PostgreSQL-specific queries (or, for the step ledger, a `skipDuplicates` the driver does not support).

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
  definitionVersion: string | null;   // null for a run created before the migration; claimable by any host that holds its workflow
  redriveCount: number;               // times run.redrive has re-driven this run; never reset
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
  definitionVersion?: string | null;   // adapters without the column ignore it and store null
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
  definitionVersion?: string | null;  // re-pin (run.redrive)
  redriveCount?: number;              // absolute value; run.redrive writes current + 1
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
  completedAt?: Date | null;   // null clears an earlier attempt's completion (run.redrive reopen)
  duration?: number | null;
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
  errorMessage?: string | null;   // null clears the stale error of an earlier attempt
  attempt?: number;               // job retries and redrives write existingStage.attempt + 1
  expectedVersion?: number;
}
```

## Custom Persistence Implementation

For non-Prisma databases or testing. Target `PersistenceCore` -- it is what the kernel actually calls. Since 1.0 that includes `listRunsForPurge` / `deleteRun` (`run.purge`), the four definition-versioning methods (an adapter without the schema returns `false` / `null` / `[]` and ignores `serves`), `claimNextPendingRun`'s `serves` option, and `getSuspendedStages`'s `{ limit, serves }` -- the adapter must order oldest `nextPollAt` first and cap at `limit`, or the poller's `maxChecks` window fills with rows it cannot act on:

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
      definitionVersion: data.definitionVersion ?? null,
      redriveCount: 0,
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

### Conformance suites

`@bratsos/workflow-engine/testing` exports one shared suite per port, and each
takes the test primitives as its third argument (`ConformanceTestApi`:
`{ describe, it, expect, beforeEach }`) so the entry imports nothing from
vitest:

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import {
  persistenceConformanceSuite,
  jobQueueConformanceSuite,
  aiCallLoggerConformanceSuite,
  stepLedgerConformanceSuite,
} from "@bratsos/workflow-engine/testing";

const api = { describe, it, expect, beforeEach };
persistenceConformanceSuite("my-persistence", () => createMyPersistence(), api);
jobQueueConformanceSuite("my-queue", () => createMyQueue(), api);
aiCallLoggerConformanceSuite("my-logger", () => createMyLogger(), api);
stepLedgerConformanceSuite("my-ledger", () => createMyLedger(), api);
```

The first three take a factory returning the adapter plus an optional
argument-less `clear()` (`ResettableFixture`); `stepLedgerConformanceSuite`
takes a `StepLedgerFactory` returning a `StepLedgerFixture`
(`StepLedger & { reset?: () => Promise<void> }`) instead, because `StepLedger`
has a `clear(stageRecordId)` of its own. The suites cover `listRunsForPurge` /
`deleteRun`, the outbox claim/release pair, the fenced and unfenced job
acknowledgements, `enqueueParallel`'s idempotency, `deleteByRunAndStages`,
`clearExcept`, `compareAndSet` with and without a pinned attempt, and the
`StepRecordPatch` null rule.

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

## Transactional enqueue from SQL (PostgreSQL)

`workflow_engine_enqueue` creates a workflow run from SQL, inside the caller's
own transaction, so a database trigger or a non-TypeScript service can schedule
work atomically with the rows that justify it. It ships as SQL in the package
(`sql/enqueue.sql`), not as something the engine creates at runtime, so the
consumer's migration owns it.

```bash
psql "$DATABASE_URL" -f node_modules/@bratsos/workflow-engine/sql/enqueue.sql
```

```sql
workflow_engine_enqueue(
  p_idempotency_key    text,
  p_workflow_id        text,
  p_workflow_name      text,
  p_input              jsonb,
  p_config             jsonb   DEFAULT '{}'::jsonb,
  p_priority           integer DEFAULT 5,
  p_definition_version text    DEFAULT NULL
) RETURNS text
```

It writes exactly what `run.create` writes, in the same order — the idempotency
key, the run, the `workflow:created` outbox event — and leaves the run `PENDING`
for `run.claimPending`. Replaying one key returns the same run id.
`sql-enqueue.test.ts` (gated on `DATABASE_URL`) creates one run each way and
asserts the rows, idempotency results and outbox events agree, and that both
execute to the same output; that is what stops the two paths drifting.

Three things it cannot do:

- **Validate the input.** No Zod in SQL. Bad input fails at the first stage as
  a failed run rather than at enqueue.
- **Stamp the definition version.** It is a SHA-256 of the TypeScript
  definition snapshot. The default is an unpinned run (`definitionVersion`
  NULL), claimable by any host. Pass `p_definition_version` when the caller
  knows it; the function refuses unless the `workflow_definitions` row already
  exists, because pinning to an unregistered version strands the run.
- **Merge stage config defaults.** It stores `p_config` verbatim. Behaviour is
  unaffected because each stage re-parses its config slice through its own
  schema at execution, applying the same defaults; only the stored column
  differs.

Requires PostgreSQL 13+ (built-in `gen_random_uuid()`).

## Performance Considerations

### Indexes

The schema includes indexes for common query patterns:
- `(status, priority DESC, createdAt)` on `workflow_runs` and `job_queue` - the run claim and the dequeue, `FOR UPDATE SKIP LOCKED`, flat with depth
- `(createdAt DESC, id DESC)` and its `status` / `workflowId` prefixes on `workflow_runs` - newest-first listings, keyset paginated
- `(definitionVersion)` and `(status, workflowId, definitionVersion)` on `workflow_runs` - version lookups and the version-filtered claim
- `nextPollAt` - for suspended stage polling (`stage.pollSuspended` reads `SUSPENDED` rows with `nextPollAt <= now`, then claims each by moving `nextPollAt` forward with `expectedVersion`; a custom adapter needs the version guard on `updateStage` for two orchestrators to poll safely)
- `workflowRunId` / `stageRecordId` - for stage/log/step lookups
- `dlqAt` on `outbox_events` - the dead-letter view (a partial `WHERE "dlqAt" IS NOT NULL` index is better where you write the migration by hand)

The 0.13 -> 1.0 guide has the `CREATE INDEX CONCURRENTLY` statements and the measurements behind them.

### Job Queue Atomicity

**PostgreSQL** uses `FOR UPDATE SKIP LOCKED` for atomic dequeue:

```sql
UPDATE job_queue
SET status = 'RUNNING', "workerId" = $1,
    "lockedAt" = now() AT TIME ZONE 'UTC', "startedAt" = now() AT TIME ZONE 'UTC',
    attempt = attempt + 1
WHERE id = (
  SELECT id FROM job_queue
  WHERE status = 'PENDING'
    AND ("nextPollAt" IS NULL OR "nextPollAt" <= now() AT TIME ZONE 'UTC')
    -- plus the `serves` predicate on payload._workflowId / _definitionVersion
  ORDER BY priority DESC, "createdAt" ASC
  LIMIT 1
  FOR UPDATE SKIP LOCKED
)
RETURNING id, "workflowRunId", "stageId", priority, attempt, "maxAttempts", payload, "startedAt";
```

The lease stamps come from the database clock, rendered as naive UTC (so
`staleLeaseThresholdMs` is a duration measured there, immune to a host whose
system clock is skewed), and `startedAt` is returned because it is the fence
the worker hands back -- see "Timestamps" and "Fenced acknowledgements" above.

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
