---
sidebar_position: 2
title: Custom Adapters
---

# Custom Adapters

If your infrastructure cannot use PostgreSQL/SQLite or Prisma, you can write custom persistence adapters. **workflow-engine** exposes clean interfaces for the persistence layer, the job queue, the step ledger, and the AI logger.

**Aside on the built-in Prisma adapters:** `PrismaWorkflowPersistence`, `PrismaJobQueue`, `PrismaStepLedger` and `PrismaAICallLogger` (the ones you're opting out of by writing a custom adapter) require a structural type (`EnginePrismaClient`) that isn't exported from any public entry point, so you never reference it by name. Any real Prisma-generated client (6.x or 7.x) satisfies it automatically, since it only requires the delegates the adapters actually call — `workflowRun`, `workflowStage`, `workflowStep`, `workflowLog`, `workflowArtifact`, `workflowAnnotation`, `outboxEvent`, `idempotencyKey`, `jobQueue`, `aICall`, and `workflowDefinition` for definition versioning — plus optional `$transaction`/`$queryRaw`/`$executeRaw`/`$Enums`. The only visible effect is on hand-written mocks: a fake `PrismaClient`-shaped object missing a delegate the adapter calls fails to typecheck.

---

## Adapter Interfaces

To create a custom adapter, you must implement one or more of the following interfaces from the core package:

### 1. `WorkflowPersistence`
Responsible for storing workflow runs, stage states, logs, outbox events, and idempotency records.

```typescript
import type { 
  WorkflowPersistence, 
  CreateRunInput, 
  WorkflowRunRecord,
  UpdateRunInput,
  CreateStageInput,
  WorkflowStageRecord,
  UpsertStageInput,
  UpdateStageInput,
  CreateLogInput,
  SaveArtifactInput,
  CreateAnnotationInput,
  AnnotationFilters,
  WorkflowAnnotationRecord,
  CreateOutboxEventInput,
  OutboxRecord
} from "@bratsos/workflow-engine";

// Implement this class for your custom database (e.g. MongoDB, DynamoDB, Drizzle, etc.)
class MyCustomPersistence implements WorkflowPersistence {
  // Transaction wrapper
  async withTransaction<T>(fn: (tx: WorkflowPersistence) => Promise<T>): Promise<T> { ... }

  // Workflow Run Operations
  async createRun(data: CreateRunInput): Promise<WorkflowRunRecord> { ... }
  async updateRun(id: string, data: UpdateRunInput): Promise<void> { ... }
  async getRun(id: string): Promise<WorkflowRunRecord | null> { ... }
  async getRunStatus(id: string): Promise<Status | null> { ... }
  async getStuckRuns(stuckSince: Date): Promise<WorkflowRunRecord[]> { ... }
  async claimNextPendingRun(options?: { now?: Date; serves?: readonly ServedDefinition[] }): Promise<WorkflowRunRecord | null> { ... }
  // Retention (run.purge)
  async listRunsForPurge(cutoff: Date, statuses: readonly Status[], limit: number): Promise<...> { ... }
  async deleteRun(id: string): Promise<void> { ... }
  // Definition versioning
  supportsDefinitionVersioning(): boolean { ... }
  async insertDefinitionIfAbsent(...): Promise<...> { ... }
  async getDefinition(workflowId: string, version: string): Promise<... | null> { ... }
  async countRunsByDefinitionVersion(...): Promise<...> { ... }

  // Stages
  async createStage / upsertStage / updateStage / getStage / getStagesByRun / deleteStage
  async getSuspendedStages(beforeDate: Date, options?: { limit?, serves? }): Promise<WorkflowStageRecord[]> { ... }

  // Logs, annotations, outbox, idempotency
  async createLog / appendAnnotations / listAnnotations
  async appendOutboxEvents / getUnpublishedOutboxEvents / claimUnpublishedOutboxEvents / releaseOutboxEvents
  async markOutboxEventsPublished / incrementOutboxRetryCount / moveOutboxEventToDLQ / replayDLQEvents
  async acquireIdempotencyKey / completeIdempotencyKey / releaseIdempotencyKey
}
```

Points that are easy to get wrong, all covered by the conformance suite:

* **`claimNextPendingRun({ serves })`**: a pinned run is claimable only by a caller presenting its `(workflowId, version)` pair; an *unpinned* run (`definitionVersion` null) only by a caller whose `serves` names its workflow; an empty `serves` claims nothing. Omit `serves` (or pass `"all"`) for the version-blind predicate. Bind the `now` the kernel passes rather than the database's `NOW()`.
* **`getSuspendedStages(beforeDate, { limit, serves })`** owns both narrowings: oldest `nextPollAt` first, capped at `limit`, and only stages of runs the caller serves. An adapter without a `definitionVersion` column may ignore `serves`.
* **`claimUnpublishedOutboxEvents(limit)`** must stamp `publishedAt` atomically (`FOR UPDATE SKIP LOCKED` on Postgres, a per-row compare-and-set elsewhere) so two hosts flushing the same outbox do not both deliver an event; `releaseOutboxEvents(ids)` hands back the events of a run whose emit threw.
* **`listRunsForPurge` / `deleteRun`** back `run.purge`; `deleteRun` must take stages, logs, artifacts and annotations with the run.
* **`UpdateStageInput`** accepts `null` for `errorMessage`, `completedAt` and `duration` (a redrive clears them when it reopens a stage) and carries `attempt`.
* An adapter without the versioning schema returns `false` / `null` / `[]` from the four definition methods and ignores `serves`; runs then stay unpinned.
* The eight legacy query methods and the `ArtifactPersistence` methods were removed from the port in 1.0; the built-in adapters keep them as plain class methods.

### 2. `JobQueue`
Responsible for scheduling, claiming (dequeuing), heartbeating, and cancelling active background jobs.

```typescript
import type {
  JobQueue,
  EnqueueJobInput,
  DequeueResult,
  JobRecord,
  JobAckFence,
  JobAckOutcome,
} from "@bratsos/workflow-engine";

class MyCustomJobQueue implements JobQueue {
  async enqueueParallel(jobs: EnqueueJobInput[]): Promise<string[]> { ... } // idempotent on (workflowRunId, stageId)
  async deleteByRunAndStages(workflowRunId: string, stageIds: string[]): Promise<number> { ... }
  async dequeue(options?: DequeueOptions): Promise<DequeueResult | null> { ... }
  async complete(jobId: string, fence?: JobAckFence): Promise<JobAckOutcome> { ... }
  async suspend(jobId: string, nextPollAt: Date, fence?: JobAckFence): Promise<JobAckOutcome> { ... }
  async fail(jobId: string, error: string, shouldRetry?: boolean, fence?: JobAckFence): Promise<JobAckOutcome> { ... }
  async defer(jobId: string, nextPollAt: Date, reason: string, fence?: JobAckFence): Promise<JobAckOutcome> { ... } // optional, see below
  async releaseStaleJobs(staleThresholdMs?: number): Promise<number> { ... }
  async expireRunawayJobs(absoluteTimeoutMs: number): Promise<number> { ... } // optional, absolute lease tier
  async cancelByRun(workflowRunId: string): Promise<number> { ... }
  async getJobsByWorkflowRun(workflowRunId: string): Promise<JobRecord[]> { ... }
  async touchJob(jobId: string): Promise<void> { ... } // Heartbeat lock
  adoptWorkerId(workerId: string): string { ... } // optional: take the host's workerId on start()
  readonly fairnessGroupBy?: string | null;         // optional: read by createSpillingJobTransport
}
```

The single-job `enqueue` was removed from the port in 1.0 (`enqueueParallel([job])` is the replacement). `enqueueParallel` must be idempotent on `(workflowRunId, stageId)` — replace any row already queued for the pair and reset its attempt, status, worker, lock and error — and `deleteByRunAndStages` retires the rows of stage records a redrive deletes. Both are in the conformance suite.

#### Declining a job: `dequeue(options)` and `defer`

`dequeue` takes an optional `{ serves }` — the `(workflowId, version)` pairs
the calling host presents. A job carries its run's definition version on its
payload as `_definitionVersion` (and its workflow as `_workflowId`), so the
filter is expressible without joining anything: claim a job when its version
is in `serves`, or when it has no version and `serves` names its workflow.
Claim nothing for an empty `serves`.

A transport that cannot select — a push queue you do not control the
ordering of — may ignore `serves` entirely. The kernel's backstop then
applies: `job.execute` returns a ghost with `ghostReason: "version"`, and
the host calls `defer(jobId, nextPollAt, reason, fence)` instead of `fail`.
`defer` puts the job back `PENDING` with a later `nextPollAt` **and gives
back the attempt the dequeue counted**. That distinction matters: a version
mismatch lasts for a whole deploy, so re-delivering it through the retry
budget takes the job row terminal in about fifteen seconds. Declining work
is not failing it. `defer` is optional; without it the host falls back to
`fail(..., true)`, which is correct but bounded by the budget.

#### Fenced acknowledgements

`dequeue()` returns a `startedAt` alongside `attempt`: together they are the
*attempt stamp* of that claim. A worker that stalls long enough for
`releaseStaleJobs` to rescue its job — and for a second worker to claim it —
must not be able to mark the newer attempt COMPLETED or FAILED when it
finally wakes up. `complete`, `fail` and `suspend` therefore accept an
optional `JobAckFence` (`{ startedAt, attempt }`, taken straight from the
`DequeueResult`) and must condition the write on the job still being the
`RUNNING` attempt that fence describes:

```sql
UPDATE jobs SET ... WHERE id = $1 AND status = 'RUNNING'
                      AND "startedAt" = $2 AND attempt = $3
```

When nothing matches, write nothing and return `"superseded"`; a superseded
acknowledgement is a real outcome the host logs, not an error to swallow and
not a success to report. Called without a fence the methods keep their older
unconditional behaviour and always return `"acknowledged"`, so a transport
that cannot carry the stamp (a JSON push bridge, say) still works.

`touchJob` is deliberately *not* fenced: a stale heartbeat only refreshes the
lease of whichever attempt currently owns the row, which costs the newer
attempt nothing.

#### Per-group fairness

`EnqueueJobInput.groupKey` names the fairness group a job belongs to — usually a
tenant. A transport that supports fairness stores it (the built-in adapters put
it on the payload as `_groupKey`, and strip it again before the payload reaches
a stage) and, when configured with a `JobQueueFairness`, excludes from the claim
any group already holding `maxConcurrentPerGroup` jobs in `RUNNING`.

It has to be a cap rather than a reordering: whatever rule ranks the pending
rows, a flooding group's next row is re-ranked to the front the instant its
previous one is claimed, so a quiet group still waits behind the whole flood.
Excluding a group already at its share is what actually breaks the starvation.

Fairness is opt-in and off by default because it costs materially more on a deep
queue than the default claim — see the measured numbers in the engine's
persistence reference.

#### Two-tier lease expiry

`releaseStaleJobs` compares `lockedAt`, which `touchJob` refreshes, so it detects
a worker that *stopped*. It cannot detect a worker that is alive but wedged — a
hung request with no timeout, an infinite loop — because that worker keeps
heartbeating and holds the job forever. `expireRunawayJobs(absoluteTimeoutMs)` is
the coarse backstop: it compares `startedAt`, stamped once per claim and
refreshed by nothing, and fails the job terminally rather than requeueing it (a
job that hung for the whole cap will hang again). The method is optional on the
port — an adapter without it simply has no absolute tier.

Write the two outcomes so they can be told apart afterwards: stamp `lastError`
with the exported `LEASE_HEARTBEAT_LOST` prefix when reclaiming a lease and
`LEASE_ABSOLUTE_CAP` when expiring a runaway. `jobQueueConformanceSuite` checks
both, skipping the absolute tier when the method is absent.

### 3. `StepLedger`
Responsible for the durable step rows behind `ctx.step.*` — one row per `(stageRecordId, stepId)`.

```typescript
import type { StepLedger, StepRecord, StepRecordPatch, StepRecordExpectation } from "@bratsos/workflow-engine";

class MyCustomStepLedger implements StepLedger {
  async claim(record: Omit<StepRecord, "createdAt" | "updatedAt">): Promise<{ created: boolean; record: StepRecord }> { ... } // insert-if-absent; existing rows win without throwing
  async get(stageRecordId: string, stepId: string): Promise<StepRecord | null> { ... }
  async update(stageRecordId: string, stepId: string, patch: StepRecordPatch): Promise<StepRecord> { ... }
  async compareAndSet(stageRecordId: string, stepId: string, expected: StepRecordExpectation, patch: StepRecordPatch): Promise<{ applied: boolean; record: StepRecord | null }> { ... }
  async list(stageRecordId: string): Promise<StepRecord[]> { ... }
  async clear(stageRecordId: string): Promise<void> { ... }
  async clearExcept(stageRecordId: string, keepStepIds: string[]): Promise<void> { ... } // optional, see below
}
```

* **`claim` must not throw on a conflict.** A replay re-claims every completed step; on Postgres a caught unique violation aborts a consumer's enclosing transaction, so insert with `ON CONFLICT DO NOTHING` (or the equivalent) and read the row back.
* **`StepRecordPatch` has one rule.** A key that is absent, or present holding `undefined`, leaves that column alone; any other value — **`null` included** — is written. A ledger that skips nullish values records "completed with no value" as "unchanged", and the previous attempt's result then replays forever.
* **`compareAndSet`** conditions the write on the row still matching `expected` (`status`, and `attempt` when given — `attempt` is optional and must match any attempt when omitted). It is what makes a step's outcome first-write-wins when two workers reach the same body.
* **`clearExcept`** is optional. It is what lets a redrive, or a fresh attempt of a terminally failed stage, keep the rows that name an external effect while dropping the rest; a ledger without it falls back to `clear`, and the kernel logs every external key it is about to drop.
* The kernel wraps whatever ledger it is given for [claim-check spilling](../core-concepts/kernel-and-ports.md#durable-step-results-automatic) of large results; the port sees plain JSON either way.

### 4. `AICallLogger`
Responsible for tracking LLM prompt/response pairs, token usage, and cost stats.

```typescript
import type { AICallLogger, CreateAICallInput, AIHelperStats } from "@bratsos/workflow-engine";

class MyCustomAICallLogger implements AICallLogger {
  logCall(call: CreateAICallInput): void { ... }
  async logBatchResults(batchId: string, results: CreateAICallInput[]): Promise<void> { ... }
  async getStats(topicPrefix: string): Promise<AIHelperStats> { ... }
  async isRecorded(batchId: string): Promise<boolean> { ... }
}
```

---

## Conformance Testing

To ensure that your custom adapter behaves exactly like the built-in Prisma and in-memory implementations (with identical lock mechanics, retry defaults, status mutations, fenced acknowledgements, and concurrency version-increment behaviors), **workflow-engine** exports test suite runners:

* **`persistenceConformanceSuite`**
* **`jobQueueConformanceSuite`**
* **`stepLedgerConformanceSuite`**
* **`aiCallLoggerConformanceSuite`**

They register test specs dynamically inside your test suite. `@bratsos/workflow-engine/testing` imports nothing from vitest, so each suite takes the test primitives as a third argument (`ConformanceTestApi`: `{ describe, it, expect, beforeEach }`) — pass vitest's, Jest's, or `node:test`'s.

### Writing a Conformance Test File

Create a `my-adapter.conformance.test.ts` file in your workspace:

```typescript
// my-adapter.conformance.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import {
  persistenceConformanceSuite,
  jobQueueConformanceSuite,
  stepLedgerConformanceSuite,
  aiCallLoggerConformanceSuite,
} from "@bratsos/workflow-engine/testing";
import { MyCustomPersistence } from "./my-custom-persistence";
import { MyCustomJobQueue } from "./my-custom-job-queue";
import { MyCustomStepLedger } from "./my-custom-step-ledger";
import { MyCustomAICallLogger } from "./my-custom-ai-logger";

const api = { describe, it, expect, beforeEach };

// Call each suite at the top-level.
// The second argument is a factory function returning a fresh adapter instance.
persistenceConformanceSuite("MyCustomPersistence", () => new MyCustomPersistence(), api);
jobQueueConformanceSuite("MyCustomJobQueue", () => new MyCustomJobQueue(), api);
stepLedgerConformanceSuite("MyCustomStepLedger", () => new MyCustomStepLedger(), api);
aiCallLoggerConformanceSuite("MyCustomAICallLogger", () => new MyCustomAICallLogger(), api);
```

`stepLedgerConformanceSuite` takes a `StepLedgerFixture` (`StepLedger & { reset?: () => Promise<void> }`) rather than the `ResettableFixture` below, because `StepLedger` has a `clear(stageRecordId)` of its own. It covers `clearExcept` (skipped when absent), `compareAndSet` with and without a pinned attempt, and result nulling.

### Resetting Fixtures Between Tests: `clear` vs `reset`

Each suite's `beforeEach` resets the adapter to a clean slate before every test. The factory's return type allows either a synchronous `clear()` — what the in-memory examples above use — or an async `reset()`, and prefers `reset()` when the fixture provides one:

```typescript
export interface ResettableFixture {
  clear?: () => void;
  reset?: () => Promise<void>;
}

export type PersistenceFactory = () => WorkflowPersistence & ResettableFixture;
// JobQueueFactory / AILoggerFactory follow the same &ResettableFixture pattern.
```

For a real-database adapter, attach an async `reset` that truncates the underlying tables instead of relying on `clear`:

```typescript
persistenceConformanceSuite("MyCustomPersistence (real database)", () => {
  const adapter = new MyCustomPersistence(pool);
  return Object.assign(adapter, {
    reset: async () => {
      await pool.query(`TRUNCATE TABLE workflow_runs, workflow_stages CASCADE`);
    },
  });
});
```

**Foreign-key-safe seeding:** before creating any stage, log, artifact, or annotation row, the suite first seeds a parent `WorkflowRun` row if one doesn't already exist for the referenced run id. Real schemas (e.g. Postgres) enforce a mandatory foreign key from those child tables to their parent run, even though an in-memory fake might not care — so your adapter needs to actually support that FK relationship (accept the parent row the suite seeds, rather than rejecting or ignoring it) for the suite to pass cleanly.

This isn't just a convenience for third-party adapter authors — the exact same suite is what proves this project's own Prisma+Postgres adapters are correct in CI, run against a real `postgres:16` service container.

### Execution
Run the test file via your local package testing framework (e.g., `vitest`):

```bash
npx vitest run my-adapter.conformance.test.ts
```

If a test block fails, the assertion will pinpoint where your adapter's state mutations, concurrency handling, or lease reaping behavior diverges from the core engine's specifications.
