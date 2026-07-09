# Testing Patterns

Complete guide for testing with the command kernel using in-memory adapters.

## In-Memory Adapters

The engine provides in-memory implementations for all ports:

```typescript
// Persistence and job queue
import {
  InMemoryWorkflowPersistence,
  InMemoryJobQueue,
  InMemoryAICallLogger,
} from "@bratsos/workflow-engine/testing";

// Kernel-specific test adapters
import {
  FakeClock,
  InMemoryBlobStore,
  CollectingEventSink,
} from "@bratsos/workflow-engine/kernel/testing";
```

## Test Kernel Setup

Create a fully in-memory kernel for testing:

```typescript
import { createKernel } from "@bratsos/workflow-engine/kernel";

function createTestKernel(workflows: Map<string, Workflow>) {
  const persistence = new InMemoryWorkflowPersistence();
  const jobQueue = new InMemoryJobQueue();
  const blobStore = new InMemoryBlobStore();
  const eventSink = new CollectingEventSink();
  const clock = new FakeClock();

  const kernel = createKernel({
    persistence,
    blobStore,
    jobTransport: jobQueue,
    eventSink,
    clock,
    registry: { getWorkflow: (id) => workflows.get(id) },
  });

  return { kernel, persistence, jobQueue, blobStore, eventSink, clock };
}
```

## Full Workflow Lifecycle Test

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import { defineStage, defineWorkflow } from "@bratsos/workflow-engine";
import { z } from "zod";

const echoStage = defineStage({
  id: "echo",
  name: "Echo",
  schemas: {
    input: z.object({ message: z.string() }),
    output: z.object({ echoed: z.string() }),
    config: z.object({}),
  },
  async execute(ctx) {
    return { output: { echoed: ctx.input.message } };
  },
});

const workflow = defineWorkflow({
  id: "echo-wf",
  name: "Echo WF",
  description: "Test",
  input: z.object({ message: z.string() }),
})
  .pipe(echoStage)
  .build();

describe("echo workflow", () => {
  let kernel, persistence, jobQueue;

  beforeEach(() => {
    const t = createTestKernel(new Map([["echo-wf", workflow]]));
    kernel = t.kernel;
    persistence = t.persistence;
    jobQueue = t.jobQueue;
  });

  it("completes a single-stage workflow", async () => {
    // 1. Create the run
    const { workflowRunId } = await kernel.dispatch({
      type: "run.create",
      idempotencyKey: "test-1",
      workflowId: "echo-wf",
      input: { message: "hello" },
    });

    // 2. Claim pending runs (enqueues first-stage job)
    await kernel.dispatch({
      type: "run.claimPending",
      workerId: "test-worker",
    });

    // 3. Dequeue and execute the job
    const job = await jobQueue.dequeue();
    expect(job).not.toBeNull();

    await kernel.dispatch({
      type: "job.execute",
      workflowRunId: job.workflowRunId,
      workflowId: job.workflowId,
      stageId: job.stageId,
      config: {},
    });
    await jobQueue.complete(job.jobId);

    // 4. Transition the workflow
    const { action } = await kernel.dispatch({
      type: "run.transition",
      workflowRunId,
    });
    expect(action).toBe("completed");

    // 5. Verify final state
    const run = await persistence.getRun(workflowRunId);
    expect(run.status).toBe("COMPLETED");
  });
});
```

## FakeClock

Injectable time source for deterministic testing:

```typescript
const clock = new FakeClock();
clock.now(); // Returns frozen time

// Advance time for testing stale leases, poll intervals, etc.
clock.advance(60_000); // Advance 60 seconds
```

## CollectingEventSink

Captures events for assertions:

```typescript
const eventSink = new CollectingEventSink();

// ... run workflow ...

// Flush outbox to publish events
await kernel.dispatch({ type: "outbox.flush" });

// Assert on collected events
expect(eventSink.events).toContainEqual(
  expect.objectContaining({ type: "workflow:completed" })
);
```

## Testing Idempotency

```typescript
it("deduplicates run.create with same key", async () => {
  const cmd = {
    type: "run.create" as const,
    idempotencyKey: "same-key",
    workflowId: "echo-wf",
    input: { message: "hello" },
  };

  const first = await kernel.dispatch(cmd);
  const second = await kernel.dispatch(cmd);

  expect(first.workflowRunId).toBe(second.workflowRunId);
});
```

## Testing Cancellation

```typescript
it("cancels a running workflow", async () => {
  const { workflowRunId } = await kernel.dispatch({
    type: "run.create",
    idempotencyKey: "cancel-test",
    workflowId: "echo-wf",
    input: { message: "hello" },
  });

  await kernel.dispatch({ type: "run.claimPending", workerId: "w1" });

  const { cancelled } = await kernel.dispatch({
    type: "run.cancel",
    workflowRunId,
    reason: "User cancelled",
  });
  expect(cancelled).toBe(true);
});
```

## Reset Between Tests

```typescript
beforeEach(() => {
  persistence.clear();
  jobQueue.clear();
  eventSink.events = [];
});
```

## Conformance Suites for Custom Adapters (v0.11+)

If you implement `WorkflowPersistence`, `JobQueue`, or `AICallLogger` yourself (a non-Prisma database, a queue product, etc.), validate it against the same behavior the built-in Prisma and in-memory adapters are tested with, instead of hand-rolling parity tests:

```typescript
import {
  persistenceConformanceSuite,
  jobQueueConformanceSuite,
  aiCallLoggerConformanceSuite,
} from "@bratsos/workflow-engine/testing";
```

Each suite is a vitest side-effect registrar: calling it registers `describe`/`it` blocks, so it must be invoked at module scope inside a `*.test.ts` file, passing a factory that returns a fresh adapter instance per test:

```typescript
// my-adapter.conformance.test.ts
import { persistenceConformanceSuite, jobQueueConformanceSuite } from "@bratsos/workflow-engine/testing";
import { MyCustomPersistence } from "./my-custom-persistence";
import { MyCustomJobQueue } from "./my-custom-job-queue";

persistenceConformanceSuite("MyCustomPersistence", () => new MyCustomPersistence());
jobQueueConformanceSuite("MyCustomJobQueue", () => new MyCustomJobQueue());
```

The factory type signatures -- note the `reset`/`clear` seam:

```typescript
interface ResettableFixture {
  clear?: () => void;        // synchronous reset (in-memory fakes)
  reset?: () => Promise<void>;  // async reset (e.g. a real database's TRUNCATE)
}

type PersistenceFactory = () => WorkflowPersistence & ResettableFixture;
type JobQueueFactory = () => JobQueue & ResettableFixture;
type AILoggerFactory = () => AICallLogger & ResettableFixture;
```

Each suite's `beforeEach` prefers the async `reset()` when the fixture provides one, falling back to synchronous `clear()` otherwise. For a real-database adapter, attach `reset` instead of `clear`:

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

**FK-safe seeding convention:** before creating any stage, log, artifact, or annotation row, the suite seeds a parent `WorkflowRun` row first if one doesn't already exist for the referenced run id. Real schemas (e.g. Postgres) enforce a mandatory foreign key from those child tables to their parent run, even though an in-memory fake might not care -- your adapter needs to actually support that FK relationship (accept the parent row the suite seeds) for the suite to pass cleanly.

Run it like any other test file (`vitest run my-adapter.conformance.test.ts`). A failing case points at a specific behavior your adapter diverges on -- e.g. version-bump semantics, suspended-readiness ordering, or retry defaults -- the same semantics the built-in Prisma/in-memory adapters are held to. This isn't just a convenience for third-party adapter authors: `PrismaWorkflowPersistence`/`PrismaJobQueue`/`PrismaAICallLogger` are validated with the exact same suite against a real Postgres database in this repo's own CI (each factory attaching `reset` the same way as the example above), not just against the in-memory fakes.
