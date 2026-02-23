---
name: workflow-engine
description: Guide for @bratsos/workflow-engine - a type-safe workflow engine with AI integration, stage pipelines, and persistence. Use when building multi-stage workflows, AI-powered pipelines, implementing workflow persistence, defining stages, or working with batch AI operations.
license: MIT
metadata:
  author: bratsos
  version: "0.2.0"
  repository: https://github.com/bratsos/workflow-engine
---

# @bratsos/workflow-engine Skill

Type-safe workflow engine for building AI-powered, multi-stage pipelines with persistence and batch processing support. Uses a **command kernel** architecture with environment-agnostic design.

## Architecture Overview

The engine follows a **kernel + host** pattern:

- **Core library** (`@bratsos/workflow-engine`) - Command kernel, stage/workflow definitions, persistence adapters
- **Node Host** (`@bratsos/workflow-engine-host-node`) - Long-running worker with polling loops and signal handling
- **Serverless Host** (`@bratsos/workflow-engine-host-serverless`) - Stateless single-invocation for edge/lambda/workers

The **kernel** is a pure command dispatcher. All workflow operations are expressed as typed commands dispatched via `kernel.dispatch()`. Hosts wrap the kernel with environment-specific process management.

## When to Apply

- User wants to create workflow stages or pipelines
- User mentions `defineStage`, `defineAsyncBatchStage`, `WorkflowBuilder`
- User is implementing workflow persistence with Prisma
- User needs AI integration (generateText, generateObject, embeddings, batch)
- User is building multi-stage data processing pipelines
- User mentions kernel, command dispatch, or job execution
- User wants to set up a Node.js worker or serverless worker
- User wants to rerun a workflow from a specific stage
- User needs to test workflows with in-memory adapters

## Quick Start

```typescript
import { defineStage, WorkflowBuilder } from "@bratsos/workflow-engine";
import { createKernel } from "@bratsos/workflow-engine/kernel";
import { createNodeHost } from "@bratsos/workflow-engine-host-node";
import {
  createPrismaWorkflowPersistence,
  createPrismaJobQueue,
} from "@bratsos/workflow-engine";
import { z } from "zod";

// 1. Define a stage
const processStage = defineStage({
  id: "process",
  name: "Process Data",
  schemas: {
    input: z.object({ data: z.string() }),
    output: z.object({ result: z.string() }),
    config: z.object({ verbose: z.boolean().default(false) }),
  },
  async execute(ctx) {
    return { output: { result: ctx.input.data.toUpperCase() } };
  },
});

// 2. Build a workflow
const workflow = new WorkflowBuilder(
  "my-workflow", "My Workflow", "Processes data",
  z.object({ data: z.string() }),
  z.object({ result: z.string() })
)
  .pipe(processStage)
  .build();

// 3. Create kernel
const kernel = createKernel({
  persistence: createPrismaWorkflowPersistence(prisma),
  blobStore: myBlobStore,
  jobTransport: createPrismaJobQueue(prisma),
  eventSink: myEventSink,
  scheduler: myScheduler,
  clock: { now: () => new Date() },
  registry: { getWorkflow: (id) => (id === "my-workflow" ? workflow : undefined) },
});

// 4. Start a Node host
const host = createNodeHost({
  kernel,
  jobTransport: createPrismaJobQueue(prisma),
  workerId: "worker-1",
});
await host.start();

// 5. Dispatch a command
await kernel.dispatch({
  type: "run.create",
  idempotencyKey: crypto.randomUUID(),
  workflowId: "my-workflow",
  input: { data: "hello" },
});
```

## Core Exports Reference

| Export | Type | Import Path | Purpose |
|--------|------|-------------|---------|
| `defineStage` | Function | `@bratsos/workflow-engine` | Create sync stages |
| `defineAsyncBatchStage` | Function | `@bratsos/workflow-engine` | Create async/batch stages |
| `WorkflowBuilder` | Class | `@bratsos/workflow-engine` | Chain stages into workflows |
| `createKernel` | Function | `@bratsos/workflow-engine/kernel` | Create command kernel |
| `createNodeHost` | Function | `@bratsos/workflow-engine-host-node` | Create Node.js host |
| `createServerlessHost` | Function | `@bratsos/workflow-engine-host-serverless` | Create serverless host |
| `createAIHelper` | Function | `@bratsos/workflow-engine` | AI operations (text, object, embed, batch) |
| `definePlugin` | Function | `@bratsos/workflow-engine/kernel` | Define kernel plugins |
| `createPluginRunner` | Function | `@bratsos/workflow-engine/kernel` | Create plugin event processor |

## Kernel Commands

All operations go through `kernel.dispatch(command)`:

| Command | Description |
|---------|-------------|
| `run.create` | Create a new workflow run |
| `run.claimPending` | Claim pending runs, enqueue first-stage jobs |
| `run.transition` | Advance to next stage group or complete |
| `run.cancel` | Cancel a running workflow |
| `run.rerunFrom` | Rerun from a specific stage |
| `job.execute` | Execute a single stage |
| `stage.pollSuspended` | Poll suspended stages for readiness (returns `resumedWorkflowRunIds`) |
| `lease.reapStale` | Release stale job leases |
| `outbox.flush` | Publish pending outbox events |
| `plugin.replayDLQ` | Replay dead-letter queue events |

## Stage Definition

### Sync Stage

```typescript
const myStage = defineStage({
  id: "my-stage",
  name: "My Stage",
  description: "Optional",
  dependencies: ["prev"],

  schemas: {
    input: InputSchema,     // Zod schema or "none"
    output: OutputSchema,
    config: ConfigSchema,
  },

  async execute(ctx) {
    const { input, config, workflowContext } = ctx;
    const prevOutput = ctx.require("prev");
    const optOutput = ctx.optional("other");

    await ctx.log("INFO", "Processing...");

    return {
      output: { ... },
      customMetrics: { itemsProcessed: 10 },
    };
  },
});
```

### Async Batch Stage

```typescript
const batchStage = defineAsyncBatchStage({
  id: "batch-process",
  name: "Batch Process",
  mode: "async-batch",
  schemas: { input: "none", output: OutputSchema, config: ConfigSchema },

  async execute(ctx) {
    if (ctx.resumeState) {
      return { output: ctx.resumeState.cachedResult };
    }

    const batchId = await submitBatchJob(ctx.input);
    return {
      suspended: true,
      state: { batchId, pollInterval: 60000, maxWaitTime: 3600000 },
      pollConfig: { pollInterval: 60000, maxWaitTime: 3600000, nextPollAt: new Date(Date.now() + 60000) },
    };
  },

  async checkCompletion(suspendedState, ctx) {
    const status = await checkBatchStatus(suspendedState.batchId);
    if (status === "completed") return { ready: true, output: { results } };
    if (status === "failed") return { ready: false, error: "Batch failed" };
    return { ready: false, nextCheckIn: 60000 };
  },
});
```

## WorkflowBuilder

```typescript
const workflow = new WorkflowBuilder(
  "workflow-id", "Workflow Name", "Description",
  InputSchema, OutputSchema
)
  .pipe(stage1)
  .pipe(stage2)
  .parallel([stage3a, stage3b])
  .pipe(stage4)
  .build();

workflow.getStageIds();
workflow.getExecutionPlan();
workflow.getDefaultConfig();
workflow.validateConfig(config);
```

## Kernel Setup

```typescript
import { createKernel } from "@bratsos/workflow-engine/kernel";
import type { Kernel, KernelConfig, Persistence, BlobStore, JobTransport, EventSink, Scheduler, Clock } from "@bratsos/workflow-engine/kernel";

const kernel = createKernel({
  persistence,   // Persistence port - runs, stages, logs, outbox, idempotency
  blobStore,     // BlobStore port - large payload storage
  jobTransport,  // JobTransport port - job queue
  eventSink,     // EventSink port - async event publishing
  scheduler,     // Scheduler port - deferred command triggers
  clock,         // Clock port - injectable time source
  registry,      // WorkflowRegistry - { getWorkflow(id) }
});

// Dispatch typed commands
const { workflowRunId } = await kernel.dispatch({
  type: "run.create",
  idempotencyKey: "unique-key",
  workflowId: "my-workflow",
  input: { data: "hello" },
});
```

### Node Host

```typescript
import { createNodeHost } from "@bratsos/workflow-engine-host-node";

const host = createNodeHost({
  kernel,
  jobTransport,
  workerId: "worker-1",
  orchestrationIntervalMs: 10_000,
  jobPollIntervalMs: 1_000,
  staleLeaseThresholdMs: 60_000,
});

await host.start();   // Starts polling loops + signal handlers
await host.stop();    // Graceful shutdown
host.getStats();      // { workerId, jobsProcessed, orchestrationTicks, isRunning, uptimeMs }
```

### Serverless Host

```typescript
import {
  createServerlessHost,
  type ServerlessHost,
  type ServerlessHostConfig,
  type JobMessage,
  type JobResult,
  type ProcessJobsResult,
  type MaintenanceTickResult,
} from "@bratsos/workflow-engine-host-serverless";

const host = createServerlessHost({
  kernel,
  jobTransport,
  workerId: "my-worker",
  // Optional tuning (same defaults as Node host)
  staleLeaseThresholdMs: 60_000,
  maxClaimsPerTick: 10,
  maxSuspendedChecksPerTick: 10,
  maxOutboxFlushPerTick: 100,
});
```

#### `handleJob(msg: JobMessage): Promise<JobResult>`

Execute a single pre-dequeued job. Consumers wire platform-specific ack/retry around the result.

```typescript
// JobMessage shape (matches queue message body)
interface JobMessage {
  jobId: string;
  workflowRunId: string;
  workflowId: string;
  stageId: string;
  attempt: number;
  maxAttempts?: number;
  payload: Record<string, unknown>;
}

// JobResult
interface JobResult {
  outcome: "completed" | "suspended" | "failed";
  error?: string;
}

const result = await host.handleJob(msg);
if (result.outcome === "completed") msg.ack();
else if (result.outcome === "suspended") msg.ack();
else msg.retry();
```

#### `processAvailableJobs(opts?): Promise<ProcessJobsResult>`

Dequeue and process jobs from the job transport. Defaults to 1 job (safe for edge runtimes with CPU limits).

```typescript
const result = await host.processAvailableJobs({ maxJobs: 5 });
// { processed: number, succeeded: number, failed: number }
```

#### `runMaintenanceTick(): Promise<MaintenanceTickResult>`

Run one bounded maintenance cycle: claim pending, poll suspended, reap stale, flush outbox.

```typescript
const tick = await host.runMaintenanceTick();
// { claimed: number, suspendedChecked: number, staleReleased: number, eventsFlushed: number }
// Note: resumed suspended stages are automatically followed by run.transition.
```

## AI Integration & Cost Tracking

```typescript
const ai = createAIHelper(
  `workflow.${ctx.workflowRunId}.stage.${ctx.stageId}`,
  aiCallLogger,
);

const { text, cost } = await ai.generateText("gemini-2.5-flash", prompt);
const { object } = await ai.generateObject("gemini-2.5-flash", prompt, schema);
const { embedding } = await ai.embed("text-embedding-004", ["text1"], { dimensions: 768 });
```

## Persistence Setup

### Required Prisma Models (ALL are required)

Copy the complete schema from the [package README](../../README.md#1-database-setup). This includes:
WorkflowRun, WorkflowStage, WorkflowLog, WorkflowArtifact, AICall, JobQueue, OutboxEvent, IdempotencyKey.

### Create Persistence

```typescript
import {
  createPrismaWorkflowPersistence,
  createPrismaJobQueue,
  createPrismaAICallLogger,
} from "@bratsos/workflow-engine/persistence/prisma";

const persistence = createPrismaWorkflowPersistence(prisma);
const jobQueue = createPrismaJobQueue(prisma);
const aiCallLogger = createPrismaAICallLogger(prisma);

// SQLite - MUST pass databaseType option
const persistence = createPrismaWorkflowPersistence(prisma, { databaseType: "sqlite" });
const jobQueue = createPrismaJobQueue(prisma, { databaseType: "sqlite" });
```

## Testing

```typescript
// In-memory persistence and job queue
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

// Create kernel with all in-memory adapters
const persistence = new InMemoryWorkflowPersistence();
const jobQueue = new InMemoryJobQueue();
const kernel = createKernel({
  persistence,
  blobStore: new InMemoryBlobStore(),
  jobTransport: jobQueue,
  eventSink: new CollectingEventSink(),
  scheduler: new NoopScheduler(),
  clock: new FakeClock(),
  registry: { getWorkflow: (id) => workflows.get(id) },
});

// Test a full workflow lifecycle
await kernel.dispatch({ type: "run.create", idempotencyKey: "test", workflowId: "my-wf", input: {} });
await kernel.dispatch({ type: "run.claimPending", workerId: "test-worker" });
const job = await jobQueue.dequeue();
await kernel.dispatch({ type: "job.execute", workflowRunId: job.workflowRunId, workflowId: job.workflowId, stageId: job.stageId, config: {} });
await kernel.dispatch({ type: "run.transition", workflowRunId: job.workflowRunId });
```

## Reference Files

- [01-stage-definitions.md](references/01-stage-definitions.md) - Complete stage API
- [02-workflow-builder.md](references/02-workflow-builder.md) - WorkflowBuilder patterns
- [03-kernel-host-setup.md](references/03-runtime-setup.md) - Kernel & host configuration
- [04-ai-integration.md](references/04-ai-integration.md) - AI helper methods
- [05-persistence-setup.md](references/05-persistence-setup.md) - Database setup
- [06-async-batch-stages.md](references/06-async-batch-stages.md) - Async operations
- [07-testing-patterns.md](references/07-testing-patterns.md) - Testing with kernel
- [08-common-patterns.md](references/08-common-patterns.md) - Kernel patterns & best practices

## Key Principles

1. **Type Safety**: All schemas are Zod - types flow through the entire pipeline
2. **Command Kernel**: All operations are typed commands dispatched through `kernel.dispatch()`
3. **Environment-Agnostic**: Kernel has no timers, no signals, no global state
4. **Context Access**: Use `ctx.require()` and `ctx.optional()` for type-safe stage output access
5. **Transactional Outbox**: Events written to outbox, published via `outbox.flush` command
6. **Idempotency**: `run.create` and `job.execute` replay cached results by key; concurrent same-key dispatch throws `IdempotencyInProgressError`
7. **Cost Tracking**: All AI calls automatically track tokens and costs
