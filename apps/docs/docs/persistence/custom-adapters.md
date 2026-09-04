---
sidebar_position: 2
title: Custom Adapters
---

# Custom Adapters

If your infrastructure cannot use PostgreSQL/SQLite or Prisma, you can write custom persistence adapters. **workflow-engine** exposes clean interfaces for the persistence layer, the job queue, and the AI logger.

**Aside on the built-in Prisma adapters:** `PrismaWorkflowPersistence`, `PrismaJobQueue`, and `PrismaAICallLogger` (the ones you're opting out of by writing a custom adapter) no longer accept a `prisma: any` parameter — they require a structural type (`EnginePrismaClient`) that isn't exported from any public entry point, so you never reference it by name. Any real Prisma-generated client (6.x or 7.x) satisfies it automatically, since it only requires the delegates the adapters actually call (`workflowRun`, `workflowStage`, etc.) plus optional `$transaction`/`$queryRaw`/`$executeRaw`/`$Enums`. The only visible effect is on hand-written mocks: a fake `PrismaClient`-shaped object missing a delegate the adapter calls now fails to typecheck, where it previously compiled silently under `any`.

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
  ...
}
```

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
  async enqueue(options: EnqueueJobInput): Promise<string> { ... }
  async enqueueParallel(jobs: EnqueueJobInput[]): Promise<string[]> { ... }
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
}
```

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

### 3. `AICallLogger`
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

## Conformance Testing (v0.11+)

To ensure that your custom adapter behaves exactly like the built-in Prisma and in-memory implementations (with identical lock mechanics, retry defaults, status mutations, and concurrency version-increment behaviors), **workflow-engine** exports test suite runners:

* **`persistenceConformanceSuite`**
* **`jobQueueConformanceSuite`**
* **`aiCallLoggerConformanceSuite`**

These are Vitest suite runners that register test specs dynamically inside your test suite.

### Writing a Conformance Test File

Create a `my-adapter.conformance.test.ts` file in your workspace:

```typescript
// my-adapter.conformance.test.ts
import { 
  persistenceConformanceSuite, 
  jobQueueConformanceSuite,
  aiCallLoggerConformanceSuite
} from "@bratsos/workflow-engine/testing";
import { MyCustomPersistence } from "./my-custom-persistence";
import { MyCustomJobQueue } from "./my-custom-job-queue";
import { MyCustomAICallLogger } from "./my-custom-ai-logger";

// Call each suite at the top-level.
// The second argument is a factory function returning a fresh adapter instance.
persistenceConformanceSuite("MyCustomPersistence", () => {
  const adapter = new MyCustomPersistence();
  return adapter;
});

jobQueueConformanceSuite("MyCustomJobQueue", () => {
  const queue = new MyCustomJobQueue();
  return queue;
});

aiCallLoggerConformanceSuite("MyCustomAICallLogger", () => {
  const logger = new MyCustomAICallLogger();
  return logger;
});
```

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
