---
sidebar_position: 1
title: Testing Workflows
---

# Testing Workflows

Because the workflow kernel is environment-agnostic and relies on injected ports, you can easily write fast, deterministic unit and integration tests using in-memory adapters, without spinning up PostgreSQL, running queue engines, or making network requests to LLM providers.

---

## In-Memory Adapters

The engine exports in-memory implementations of all required ports:

```typescript
// Core persistence and queue mocks
import {
  InMemoryWorkflowPersistence,
  InMemoryJobQueue,
  InMemoryAICallLogger,
} from "@bratsos/workflow-engine/testing";

// Kernel-specific mock ports
import {
  FakeClock,
  InMemoryBlobStore,
  CollectingEventSink,
  NoopScheduler,
} from "@bratsos/workflow-engine/kernel/testing";
```

---

## Setting Up a Test Kernel

You can initialize a fully isolated kernel environment for your test suite. It is best practice to recreate these adapters before each test:

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
    registry: {
      getWorkflow: (id) => workflows.get(id),
    },
  });

  return { 
    kernel, 
    persistence, 
    jobQueue, 
    blobStore, 
    eventSink, 
    scheduler, 
    clock 
  };
}
```

---

## Writing a Lifecycle Test

Here is a complete Vitest example showing how to trigger, execute, and verify a workflow pipeline.

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import { defineStage, WorkflowBuilder } from "@bratsos/workflow-engine";
import { z } from "zod";

// Define a simple stage
const upperCaseStage = defineStage({
  id: "uppercase",
  name: "Uppercase",
  schemas: {
    input: z.object({ value: z.string() }),
    output: z.object({ result: z.string() }),
    config: z.object({}),
  },
  async execute(ctx) {
    return { output: { result: ctx.input.value.toUpperCase() } };
  },
});

// Build the workflow
const testWorkflow = new WorkflowBuilder(
  "uppercase-workflow",
  "Uppercase Workflow",
  "Test description",
  z.object({ value: z.string() }),
  z.object({ result: z.string() })
)
  .pipe(upperCaseStage)
  .build();

describe("Uppercase Workflow Lifecycle", () => {
  let kernel, persistence, jobQueue, eventSink;

  beforeEach(() => {
    const testEnv = createTestKernel(new Map([["uppercase-workflow", testWorkflow]]));
    kernel = testEnv.kernel;
    persistence = testEnv.persistence;
    jobQueue = testEnv.jobQueue;
    eventSink = testEnv.eventSink;
  });

  it("successfully runs to completion", async () => {
    // 1. Create a workflow run
    const { workflowRunId } = await kernel.dispatch({
      type: "run.create",
      idempotencyKey: "test-run-key-1",
      workflowId: "uppercase-workflow",
      input: { value: "hello world" },
    });

    // 2. Claim pending runs (enqueues the first-stage job)
    await kernel.dispatch({
      type: "run.claimPending",
      workerId: "test-worker",
    });

    // 3. Dequeue and execute the enqueued job
    const job = await jobQueue.dequeue();
    expect(job).not.toBeNull();
    expect(job?.stageId).toBe("uppercase");

    await kernel.dispatch({
      type: "job.execute",
      workflowRunId: job!.workflowRunId,
      workflowId: job!.workflowId,
      stageId: job!.stageId,
      config: {},
    });
    
    // Mark job completed in queue
    await jobQueue.complete(job!.jobId);

    // 4. Transition the workflow to evaluate outputs
    const transitionResult = await kernel.dispatch({
      type: "run.transition",
      workflowRunId,
    });
    expect(transitionResult.action).toBe("completed");

    // 5. Verify database records
    const runRecord = await persistence.getRun(workflowRunId);
    expect(runRecord.status).toBe("COMPLETED");
    expect(runRecord.output).toEqual({ result: "HELLO WORLD" });

    // 6. Verify event emissions
    // Flush outbox first to propagate events to the sink
    await kernel.dispatch({ type: "outbox.flush" });
    
    expect(eventSink.events).toContainEqual(
      expect.objectContaining({ type: "workflow:completed" })
    );
  });
});
```

---

## Advancing Time with `FakeClock`

When testing timeouts (like stale lease recoveries or batch polling delays), you can manually shift time using the `FakeClock` fake:

```typescript
const clock = new FakeClock(new Date("2026-07-04T12:00:00.000Z"));

// Execute your stage...
// Simulate the passing of 10 minutes
clock.advance(600_000); 

// Dispatch lease reaping
const reapResult = await kernel.dispatch({
  type: "lease.reapStale",
  staleThresholdMs: 300_000, // 5 minutes
});

// Assert that expired jobs were recovered
expect(reapResult.staleReleased).toBe(1);
```

---

## Mocking AI Calls

To test stages that interact with AI providers without making actual network requests:

1. Create an `InMemoryAICallLogger`.
2. Wrap your AI mock responses or check logged stats to verify correct tokens and prices are tracked:

```typescript
const aiLogger = new InMemoryAICallLogger();

// Inside your stage or test execution:
aiLogger.logCall({
  topic: "workflow.run-123.stage.uppercase",
  callType: "text",
  modelKey: "gemini-2.5-flash",
  modelId: "google/gemini-2.5-flash",
  prompt: "Translate 'hello'",
  response: "Bonjour",
  inputTokens: 5,
  outputTokens: 2,
  cost: 0.00001,
});

const stats = await aiLogger.getStats("workflow.run-123");
expect(stats.totalCost).toBe(0.00001);
```
