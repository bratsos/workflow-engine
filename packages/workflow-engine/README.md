# @bratsos/workflow-engine

A **type-safe, distributed workflow engine** for AI-orchestrated processes. Features long-running job support, suspend/resume semantics, parallel execution, and integrated AI cost tracking.

---

## Table of Contents

- [Features](#features)
- [Requirements](#requirements)
- [Installation](#installation)
- [Getting Started](#getting-started)
  - [1. Database Setup](#1-database-setup)
  - [2. Define Your First Stage](#2-define-your-first-stage)
  - [3. Build a Workflow](#3-build-a-workflow)
  - [4. Create the Kernel](#4-create-the-kernel)
  - [5. Choose a Host](#5-choose-a-host)
- [Core Concepts](#core-concepts)
  - [Stages](#stages)
  - [Workflows](#workflows)
  - [Kernel](#kernel)
  - [Hosts](#hosts)
  - [Persistence](#persistence)
- [Common Patterns](#common-patterns)
  - [Accessing Previous Stage Output](#accessing-previous-stage-output)
  - [Parallel Execution](#parallel-execution)
  - [AI Integration](#ai-integration)
  - [Long-Running Batch Jobs](#long-running-batch-jobs)
  - [Config Presets](#config-presets)
- [Best Practices](#best-practices)
- [API Reference](#api-reference)
- [Troubleshooting](#troubleshooting)

---

## Features

| Feature | Description |
|---------|-------------|
| **Type-Safe** | Full TypeScript inference from input to output across all stages |
| **Async-First** | Native support for long-running operations (batch jobs that take hours/days) |
| **AI-Native** | Built-in tracking of prompts, responses, tokens, and costs |
| **Event-Driven** | Transactional outbox pattern for reliable event delivery |
| **Parallel Execution** | Run independent stages concurrently |
| **Resume Capability** | Automatic state persistence and recovery from failures |
| **Distributed** | Job queue with priority support and stale lock recovery |
| **Environment-Agnostic** | Pure command kernel runs on Node.js, serverless, edge, or any runtime |

---

## Requirements

- **TypeScript** >= 5.0.0
- **Zod** >= 4.0.0
- **PostgreSQL** >= 14 (for Prisma persistence)

### Optional Peer Dependencies

```bash
# For Google AI
npm install @google/genai

# For OpenAI
npm install openai

# For Anthropic
npm install @anthropic-ai/sdk

# For Prisma persistence (recommended)
npm install @prisma/client
```

---

## Installation

```bash
# Core library
npm install @bratsos/workflow-engine zod

# Node.js host (long-running worker processes)
npm install @bratsos/workflow-engine-host-node

# Serverless host (Cloudflare Workers, AWS Lambda, Vercel Edge, etc.)
npm install @bratsos/workflow-engine-host-serverless
```

---

## Getting Started

### 1. Database Setup

The engine requires persistence tables. Add these to your Prisma schema:

```prisma
// schema.prisma

enum Status {
  PENDING
  RUNNING
  SUSPENDED
  COMPLETED
  FAILED
  CANCELLED
  SKIPPED
}

model WorkflowRun {
  id            String   @id @default(cuid())
  createdAt     DateTime @default(now())
  updatedAt     DateTime @updatedAt
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

  @@index([status])
  @@index([workflowId])
}

model WorkflowStage {
  id              String              @id @default(cuid())
  createdAt       DateTime            @default(now())
  updatedAt       DateTime            @updatedAt
  workflowRunId   String
  workflowRun     WorkflowRun         @relation(fields: [workflowRunId], references: [id], onDelete: Cascade)
  stageId         String
  stageName       String
  stageNumber     Int
  executionGroup  Int
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

  @@unique([workflowRunId, stageId])
  @@index([status])
  @@index([nextPollAt])
}

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
}

model WorkflowArtifact {
  id            String   @id @default(cuid())
  createdAt     DateTime @default(now())
  workflowRunId String
  workflowRun   WorkflowRun @relation(fields: [workflowRunId], references: [id], onDelete: Cascade)
  key           String
  type          String
  data          Json
  size          Int

  @@unique([workflowRunId, key])
  @@index([workflowRunId])
}

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

  @@index([topic])
}

model JobQueue {
  id            String    @id @default(cuid())
  createdAt     DateTime  @default(now())
  updatedAt     DateTime  @updatedAt
  workflowRunId String
  stageId       String
  status        Status    @default(PENDING)
  priority      Int       @default(5)
  attempt       Int       @default(1)
  maxAttempts   Int       @default(3)
  workerId      String?
  lockedAt      DateTime?
  nextPollAt    DateTime?
  payload       Json?
  lastError     String?

  @@index([status, priority])
  @@index([nextPollAt])
}

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

Run the migration:

```bash
npx prisma migrate dev --name add-workflow-tables
npx prisma generate
```

### 2. Define Your First Stage

```typescript
import { defineStage } from "@bratsos/workflow-engine";
import { z } from "zod";

export const extractTextStage = defineStage({
  id: "extract-text",
  name: "Extract Text",
  schemas: {
    input: z.object({ url: z.string().url() }),
    output: z.object({ text: z.string(), wordCount: z.number() }),
    config: z.object({ maxLength: z.number().default(50000) }),
  },
  async execute(ctx) {
    const response = await fetch(ctx.input.url);
    const text = (await response.text()).slice(0, ctx.config.maxLength);
    ctx.log("INFO", "Extraction complete", { length: text.length });
    return {
      output: { text, wordCount: text.split(/\s+/).length },
    };
  },
});
```

### 3. Build a Workflow

```typescript
import { WorkflowBuilder } from "@bratsos/workflow-engine";
import { z } from "zod";
import { extractTextStage } from "./stages/extract-text";
import { summarizeStage } from "./stages/summarize";

export const documentProcessorWorkflow = new WorkflowBuilder(
  "document-processor",
  "Document Processor",
  "Extracts and summarizes documents",
  z.object({ url: z.string().url() }),
  z.object({ url: z.string().url() }),
)
  .pipe(extractTextStage)
  .pipe(summarizeStage)
  .build();
```

### 4. Create the Kernel

The kernel is the core command dispatcher. It's environment-agnostic -- no timers, no signals, no global state.

```typescript
import { createKernel } from "@bratsos/workflow-engine/kernel";
import {
  createPrismaWorkflowPersistence,
  createPrismaJobQueue,
} from "@bratsos/workflow-engine";
import { PrismaClient } from "@prisma/client";
import { documentProcessorWorkflow } from "./workflows/document-processor";

const prisma = new PrismaClient();

const kernel = createKernel({
  persistence: createPrismaWorkflowPersistence(prisma),
  blobStore: myBlobStore,         // BlobStore implementation
  jobTransport: createPrismaJobQueue(prisma),
  eventSink: myEventSink,         // EventSink implementation
  scheduler: myScheduler,         // Scheduler implementation
  clock: { now: () => new Date() },
  registry: {
    getWorkflow: (id) =>
      id === "document-processor" ? documentProcessorWorkflow : undefined,
  },
});
```

### 5. Choose a Host

#### Option A: Node.js Worker (Recommended for Production)

```typescript
import { createNodeHost } from "@bratsos/workflow-engine-host-node";

const host = createNodeHost({
  kernel,
  jobTransport: createPrismaJobQueue(prisma),
  workerId: "worker-1",
  orchestrationIntervalMs: 10_000,
  jobPollIntervalMs: 1_000,
});

// Start polling loops + signal handlers
await host.start();

// Queue a workflow
await kernel.dispatch({
  type: "run.create",
  idempotencyKey: crypto.randomUUID(),
  workflowId: "document-processor",
  input: { url: "https://example.com/doc.pdf" },
});
```

#### Option B: Serverless (Cloudflare Workers, Lambda, etc.)

```typescript
import { createServerlessHost } from "@bratsos/workflow-engine-host-serverless";

const host = createServerlessHost({
  kernel,
  jobTransport,
  workerId: "my-worker",
});

// Handle a single job from a queue message
const result = await host.handleJob(msg);

// Run maintenance from a cron trigger
const tick = await host.runMaintenanceTick();
```

---

## Core Concepts

### Stages

A stage is the atomic unit of work. Every stage has typed input, output, and config schemas.

**Stage Modes:**

| Mode | Use Case |
|------|----------|
| `sync` (default) | Most stages - execute and return immediately |
| `async-batch` | Long-running batch APIs (OpenAI Batch, Google Batch, etc.) |

### Workflows

A workflow is a directed graph of stages built using the fluent `WorkflowBuilder` API:

```typescript
new WorkflowBuilder(id, name, description, inputSchema, outputSchema)
  .pipe(stageA)              // Sequential: stageA runs first
  .pipe(stageB)              // Sequential: stageB runs after stageA
  .parallel([stageC, stageD]) // Parallel: stageC and stageD run concurrently
  .pipe(stageE)              // Sequential: stageE runs after both complete
  .build();
```

### Kernel

The `Kernel` is a pure command dispatcher. All operations are expressed as typed commands:

```typescript
// Create a run
const { workflowRunId } = await kernel.dispatch({
  type: "run.create",
  idempotencyKey: "unique-key",
  workflowId: "my-workflow",
  input: { data: "hello" },
});

// Cancel a run
await kernel.dispatch({
  type: "run.cancel",
  workflowRunId,
  reason: "User requested",
});

// Rerun from a specific stage
await kernel.dispatch({
  type: "run.rerunFrom",
  workflowRunId,
  fromStageId: "extract-text",
});
```

The kernel depends on 7 port interfaces (injected at creation):

| Port | Purpose |
|------|---------|
| `Persistence` | Runs, stages, logs, outbox, idempotency CRUD |
| `BlobStore` | Large payload storage (put/get/has/delete/list) |
| `JobTransport` | Job queue (enqueue/dequeue/complete/suspend/fail) |
| `EventSink` | Async event publishing |
| `Scheduler` | Deferred command triggers |
| `Clock` | Injectable time source |
| `WorkflowRegistry` | Workflow definition lookup |

### Hosts

Hosts wrap the kernel with environment-specific process management:

**Node Host** (`@bratsos/workflow-engine-host-node`): Long-running worker process with polling loops, signal handling (SIGTERM/SIGINT), and continuous job dequeuing.

**Serverless Host** (`@bratsos/workflow-engine-host-serverless`): Stateless single-invocation methods for queue-driven environments. Consumers wire platform-specific glue (ack/retry/waitUntil) around the host methods.

### Persistence

| Interface | Purpose |
|-----------|---------|
| `Persistence` | Workflow runs, stages, logs, outbox, idempotency |
| `JobTransport` | Distributed job queue with priority and retries |
| `BlobStore` | Large payload storage |
| `AICallLogger` | AI call tracking with cost aggregation |

**Built-in implementations:**
- `createPrismaWorkflowPersistence(prisma)` - PostgreSQL via Prisma
- `createPrismaJobQueue(prisma)` - PostgreSQL with `FOR UPDATE SKIP LOCKED`
- `createPrismaAICallLogger(prisma)` - PostgreSQL

---

## Common Patterns

### Accessing Previous Stage Output

Use `ctx.require()` for type-safe access to any previous stage's output:

```typescript
export const analyzeStage = defineStage({
  id: "analyze",
  name: "Analyze Content",
  schemas: {
    input: "none",
    output: AnalysisOutputSchema,
    config: ConfigSchema,
  },
  async execute(ctx) {
    const extracted = ctx.require("extract-text");  // Throws if missing
    const summary = ctx.optional("summarize");       // Returns undefined if missing
    return { output: { /* ... */ } };
  },
});
```

### Parallel Execution

```typescript
const workflow = new WorkflowBuilder(/* ... */)
  .pipe(extractStage)
  .parallel([
    sentimentAnalysisStage,
    keywordExtractionStage,
    languageDetectionStage,
  ])
  .pipe(aggregateResultsStage)
  .build();
```

### AI Integration

```typescript
import { createAIHelper } from "@bratsos/workflow-engine";

async execute(ctx) {
  const ai = createAIHelper(
    `workflow.${ctx.workflowRunId}.stage.${ctx.stageId}`,
    aiCallLogger,
  );

  const { text, cost } = await ai.generateText("gemini-2.5-flash", "Summarize: " + ctx.input.text);

  const { object: analysis } = await ai.generateObject(
    "gemini-2.5-flash",
    "Analyze: " + ctx.input.text,
    z.object({ sentiment: z.enum(["positive", "negative", "neutral"]) })
  );

  return { output: { text, analysis } };
}
```

### Long-Running Batch Jobs

```typescript
import { defineAsyncBatchStage } from "@bratsos/workflow-engine";

export const batchStage = defineAsyncBatchStage({
  id: "batch-process",
  name: "Batch Processing",
  mode: "async-batch",
  schemas: { input: InputSchema, output: OutputSchema, config: ConfigSchema },

  async execute(ctx) {
    if (ctx.resumeState) {
      return { output: await fetchBatchResults(ctx.resumeState.batchId) };
    }

    const batch = await submitBatch(ctx.input.prompts);
    return {
      suspended: true,
      state: { batchId: batch.id },
      pollConfig: { pollInterval: 3600000, maxWaitTime: 86400000, nextPollAt: new Date(Date.now() + 3600000) },
    };
  },

  async checkCompletion(state) {
    const status = await checkBatchStatus(state.batchId);
    if (status === "completed") {
      const output = await fetchBatchResults(state.batchId);
      return { ready: true, output };
    }
    if (status === "failed") return { ready: false, error: "Batch failed" };
    return { ready: false };
  },
});
```

### Config Presets

```typescript
import { withAIConfig, withStandardConfig } from "@bratsos/workflow-engine";
import { z } from "zod";

const MyConfigSchema = withAIConfig(z.object({ customField: z.string() }));
```

---

## Best Practices

### Schema Design

```typescript
// Good: Strict schemas with descriptions and defaults
const ConfigSchema = z.object({
  modelKey: z.string().default("gemini-2.5-flash").describe("AI model to use"),
  maxRetries: z.number().min(0).max(10).default(3),
});
```

### Logging

```typescript
async execute(ctx) {
  ctx.log("INFO", "Starting processing", { itemCount: items.length });

  for (const [index, item] of items.entries()) {
    ctx.onProgress({
      progress: (index + 1) / items.length,
      message: `Processing item ${index + 1}/${items.length}`,
    });
  }
}
```

### Error Handling

```typescript
async execute(ctx) {
  try {
    const result = await processDocument(ctx.input);
    return { output: result };
  } catch (error) {
    ctx.log("ERROR", "Processing failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}
```

---

## API Reference

### Kernel Commands

| Command | Description | Key Fields |
|---------|-------------|------------|
| `run.create` | Create a new workflow run | `idempotencyKey`, `workflowId`, `input`, `config?`, `priority?` |
| `run.claimPending` | Claim pending runs for processing | `workerId`, `maxClaims?` |
| `run.transition` | Advance to next stage group | `workflowRunId` |
| `run.cancel` | Cancel a running workflow | `workflowRunId`, `reason?` |
| `run.rerunFrom` | Rerun from a specific stage | `workflowRunId`, `fromStageId` |
| `job.execute` | Execute a single stage (multi-phase transactions) | `idempotencyKey?`, `workflowRunId`, `workflowId`, `stageId`, `config` |
| `stage.pollSuspended` | Poll suspended stages | `maxChecks?` (returns `resumedWorkflowRunIds`) |
| `lease.reapStale` | Release stale job leases | `staleThresholdMs` |
| `outbox.flush` | Publish pending events | `maxEvents?` |
| `plugin.replayDLQ` | Replay dead-letter queue events | `maxEvents?` |

Idempotency behavior:
- Replaying the same `idempotencyKey` returns cached results.
- If the same key is already executing, dispatch throws `IdempotencyInProgressError`.

Transaction behavior:
- Most commands execute inside a single database transaction (handler + outbox events).
- `job.execute` uses multi-phase transactions: Phase 1 commits `RUNNING` status immediately, Phase 2 runs `stageDef.execute()` outside any transaction, Phase 3 commits the final status. This avoids holding a database connection during long-running stage execution.

### Node Host Config

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `kernel` | `Kernel` | required | Kernel instance |
| `jobTransport` | `JobTransport` | required | Job queue |
| `workerId` | `string` | required | Unique worker ID |
| `orchestrationIntervalMs` | `number` | 10000 | Orchestration poll interval |
| `jobPollIntervalMs` | `number` | 1000 | Job dequeue interval |
| `staleLeaseThresholdMs` | `number` | 60000 | Stale lease timeout |

### Serverless Host

| Method | Description |
|--------|-------------|
| `handleJob(msg)` | Execute a single pre-dequeued job. Returns `{ outcome, error? }` |
| `processAvailableJobs(opts?)` | Dequeue and process jobs. Returns `{ processed, succeeded, failed }` |
| `runMaintenanceTick()` | Claim, poll, reap, flush in one call. Returns structured result |

### Core Exports

```typescript
// Stage definition
import { defineStage, defineAsyncBatchStage } from "@bratsos/workflow-engine";

// Workflow building
import { WorkflowBuilder, Workflow } from "@bratsos/workflow-engine";

// Kernel
import { createKernel, type Kernel, type KernelConfig } from "@bratsos/workflow-engine/kernel";

// Kernel types
import type { KernelCommand, CommandResult, KernelEvent } from "@bratsos/workflow-engine/kernel";

// Port interfaces
import type { Persistence, BlobStore, JobTransport, EventSink, Scheduler, Clock } from "@bratsos/workflow-engine/kernel";

// Plugins
import { definePlugin, createPluginRunner } from "@bratsos/workflow-engine/kernel";

// Persistence (Prisma)
import { createPrismaWorkflowPersistence, createPrismaJobQueue, createPrismaAICallLogger } from "@bratsos/workflow-engine";

// AI Helper
import { createAIHelper, type AIHelper } from "@bratsos/workflow-engine";

// Testing
import { InMemoryWorkflowPersistence, InMemoryJobQueue } from "@bratsos/workflow-engine/testing";
import { FakeClock, InMemoryBlobStore, CollectingEventSink, NoopScheduler } from "@bratsos/workflow-engine/kernel/testing";
```

---

## Troubleshooting

### "Workflow not found in registry"

Ensure the workflow is registered in the `registry` passed to `createKernel`:

```typescript
const kernel = createKernel({
  // ...
  registry: {
    getWorkflow(id) {
      const workflows = { "my-workflow": myWorkflow };
      return workflows[id];
    },
  },
});
```

### "Stage X depends on Y which was not found"

Verify all dependencies are included in the workflow:

```typescript
.pipe(extractStage)   // Must be piped before
.pipe(analyzeStage)   // analyze can now access extract's output
```

### Jobs stuck in "RUNNING"

A worker likely crashed. The stale lease recovery (`lease.reapStale` command) automatically releases jobs. In Node host, this runs on each orchestration tick. For serverless, call `runMaintenanceTick()` from a cron trigger.

---

## License

MIT
