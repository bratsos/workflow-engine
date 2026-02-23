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
  NoopScheduler,
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
  const scheduler = new NoopScheduler();
  const clock = new FakeClock();

  const kernel = createKernel({
    persistence,
    blobStore,
    jobTransport: jobQueue,
    eventSink,
    scheduler,
    clock,
    registry: { getWorkflow: (id) => workflows.get(id) },
  });

  return { kernel, persistence, jobQueue, blobStore, eventSink, scheduler, clock };
}
```

## Full Workflow Lifecycle Test

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import { defineStage, WorkflowBuilder } from "@bratsos/workflow-engine";
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

const workflow = new WorkflowBuilder(
  "echo-wf", "Echo WF", "Test",
  z.object({ message: z.string() }),
  z.object({ echoed: z.string() }),
)
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
