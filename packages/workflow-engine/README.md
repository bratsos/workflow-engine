# @bratsos/workflow-engine

A TypeScript library that runs durable, multi-stage workflows in **your own
Postgres**. No server, no vendor: hand it a Prisma client and run it from a
Node process, a serverless function or a cron trigger. Built for pipelines
whose expensive steps are model calls — suspend and resume across hours,
per-call cost accounting, and provider batch endpoints as durable steps.

The kernel is a pure command dispatcher with no connection, timers or global
state of its own, so it can run inside a transaction you opened, on your
session, under your row-level security policies.

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
  - [Stage ID Utilities](#stage-id-utilities)
  - [Durable Steps](#durable-steps)
  - [AI Integration](#ai-integration)
  - [Batch AI Calls (`ctx.step.ai.map`)](#batch-ai-calls-ctxstepaimap)
  - [Annotations (Provenance)](#annotations-provenance)
  - [Config Presets](#config-presets)
- [Operations](#operations)
  - [Redrive](#redrive)
  - [Retention](#retention)
  - [Definition Versioning](#definition-versioning)
  - [Enqueue from SQL](#enqueue-from-sql)
- [Testing](#testing)
- [Best Practices](#best-practices)
- [API Reference](#api-reference)
- [Troubleshooting](#troubleshooting)
- [Upgrading](#upgrading)

---

## Features

| Feature | Description |
|---------|-------------|
| **Type-Safe** | Full TypeScript inference from input to output across all stages |
| **Async-First** | Long-running operations: a stage submits a provider batch, releases its lease, and resumes hours later from the step ledger |
| **AI cost as data** | Tokens and cost on `WorkflowRun.totalCost` in the stage's own transaction, priced from the endpoint actually dispatched to — batch prices for a batch call |
| **Event-Driven** | Transactional outbox: system events reach your `EventSink` at least once, with no events for a rolled-back transaction |
| **Parallel Execution** | Independent stages in one execution group run concurrently. Pipelines are linear -- there is no arbitrary DAG and no child workflows |
| **Durable steps** | `ctx.step.*` results are keyed by name in a step ledger: exactly-once *recording*, at-least-once *execution*, with a derived `externalKey` so a reclaim adopts an external effect rather than repeating it |
| **Definition versioning** | A run is pinned to the structural version it was created under, and a host claims only runs it serves, so a rolling deploy cannot change a run's shape mid-flight |
| **Environment-Agnostic** | Pure command kernel: no timers, no signals, no global state, no connection of its own. Node.js, serverless, edge, or inside your transaction |

What it does not do: no arbitrary DAG or child workflows (pipelines are linear execution groups); no exactly-once *execution* of a step body (exactly-once recording, at-least-once execution, with a derived `externalKey` so a repeat is recoverable); no per-tenant throttle, rate limit or debounce (the Postgres queue has priority and an opt-in per-group concurrency cap); TypeScript only. The [introduction](https://github.com/bratsos/workflow-engine/blob/main/apps/docs/docs/getting-started/intro.md) says where another project is the better choice.

---

## Requirements

- **Node.js** >= 22.11
- **TypeScript** >= 5.0.0
- **Zod** ^4.1.12
- **PostgreSQL** >= 14 (for Prisma persistence; `sql/enqueue.sql` needs 13+)

### Optional Peer Dependencies

```bash
# For Anthropic Claude (native or batch)
npm install @ai-sdk/anthropic

# For OpenAI Models (native or batch)
npm install @ai-sdk/openai

# For Prisma persistence (recommended)
npm install @prisma/client
```

> `@ai-sdk/google` and `@openrouter/ai-sdk-provider` are direct dependencies of `@bratsos/workflow-engine`. OpenRouter models and OpenRouter `:batch` processing need no extra vendor SDK; when `@ai-sdk/anthropic` / `@ai-sdk/openai` is not installed and OpenRouter can batch the model, the batch falls back to OpenRouter with a WARN.

---

## Installation

```bash
# Core library
npm install @bratsos/workflow-engine zod

# Node.js host (long-running worker processes)
npm install @bratsos/workflow-engine-host-node

# Serverless host (Cloudflare Workers, AWS Lambda, Vercel Edge, etc.)
npm install @bratsos/workflow-engine-host-serverless

# Optional: embeddable operational console (a fetch handler + UI you mount in your app)
npm install @bratsos/workflow-engine-console
```

---

## Getting Started

### 1. Database Setup

The engine requires persistence tables. The package ships the reference schema at `node_modules/@bratsos/workflow-engine/prisma/schema.prisma`; add these models to your Prisma schema:

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

  // Definition versioning. NULL means the run predates it and stays
  // claimable by any host. See docs: Core Concepts > Definition Versioning.
  definitionVersion String?
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

// Content-addressed definition snapshots. One row per distinct
// (workflowId, version); every run pinned to that version references it.
model WorkflowDefinition {
  workflowId    String
  version       String
  createdAt     DateTime @default(now())
  snapshot      Json
  structureHash String

  // No @@index([workflowId]): the compound primary key already leads with
  // it, so a lookup by workflow alone plans identically with and without
  // one (measured: 0.188 ms vs 0.187 ms at 20k rows) -- and no query in
  // the engine reads this table by workflow alone anyway.
  @@id([workflowId, version])
  @@map("workflow_definitions")
}

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

// Durable step ledger (ctx.step.*). One row per step per stage record.
model WorkflowStep {
  id             String        @id @default(cuid())
  stageRecordId  String
  stage          WorkflowStage @relation(fields: [stageRecordId], references: [id], onDelete: Cascade)
  stepId         String
  seq            Int
  kind           String
  status         String
  attempt        Int           @default(1)
  leaseExpiresAt DateTime?
  deadlineAt     DateTime?
  // Deterministic name for the external effect a `run` step body creates,
  // written before the body runs so an orphaned provider-side effect can be
  // found from the row after a crash.
  externalKey    String?
  result         Json?
  error          String?
  waitState      Json?
  createdAt      DateTime      @default(now())
  updatedAt      DateTime      @updatedAt

  @@unique([stageRecordId, stepId])
  @@index([stageRecordId])
  @@map("workflow_steps")
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
  @@map("workflow_logs")
}

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

  // One job row per stage per run: run.redrive retires the rows of the
  // stages it supersedes and every enqueue path is idempotent on this pair.
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

model IdempotencyKey {
  id          String   @id @default(cuid())
  createdAt   DateTime @default(now())
  key         String
  commandType String
  result      Json

  @@unique([key, commandType])
  @@map("idempotency_keys")
}

// Optional: only when using createPrismaBlobStore. Stage outputs, spilled
// step results and replay inputs are read from the blob store by every
// process that executes or polls a run, so the store must be shared; this
// table makes Prisma that shared store without object storage.
model WorkflowBlob {
  key       String   @id
  data      Json
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  @@map("workflow_blobs")
}
```

Run the migration:

```bash
npx prisma migrate dev --name add-workflow-tables
npx prisma generate
```

Upgrading from 0.13? The database checklist in `skills/workflow-engine/migrations/migrate-0.13-to-1.0.md` has the exact SQL (`workflow_steps`, the two `workflow_runs` columns, `workflow_definitions`, the index set above), `CONCURRENTLY` where it matters.

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
import { defineWorkflow } from "@bratsos/workflow-engine";
import { z } from "zod";
import { extractTextStage } from "./stages/extract-text";
import { summarizeStage } from "./stages/summarize";

export const documentProcessorWorkflow = defineWorkflow({
  id: "document-processor",
  name: "Document Processor",
  description: "Extracts and summarizes documents",
  input: z.object({ url: z.string().url() }),
})
  .pipe(extractTextStage)
  .pipe(summarizeStage)
  .build();
```

The builder checks each prebuilt stage's declared context against what earlier stages produce, so a stage that requires a key nothing before it emits does not compile. You can also define stages inline with `defineWorkflow(id, { input }).stage(id, definition)`, which infers the context for `ctx.require()` from the stages before it:

```typescript
const Input = z.object({ url: z.string().url() });

export const inlineWorkflow = defineWorkflow("document-processor", { input: Input })
  .stage("extract-text", {
    schemas: {
      input: Input,
      output: z.object({ text: z.string() }),
      config: z.object({}),
    },
    async execute(ctx) {
      return { output: { text: await (await fetch(ctx.input.url)).text() } };
    },
  })
  .stage("summarize", {
    schemas: {
      input: "none",
      output: z.object({ summary: z.string() }),
      config: z.object({}),
    },
    async execute(ctx) {
      const { text } = ctx.require("extract-text"); // typed from the stage above
      return { output: { summary: text.slice(0, 200) } };
    },
  })
  .version("2026-09-04.1") // optional; otherwise a structural hash is derived
  .build();
```

`InferWorkflowInput`, `InferWorkflowOutput`, `InferWorkflowContext` and `InferStageOutputById` expose the inferred types. The workflow's output schema is always the last stage's output (or the merged object of the last parallel group).

### 4. Create the Kernel

The kernel is the core command dispatcher. It's environment-agnostic -- no timers, no signals, no global state.

```typescript
import { createKernel, createWorkflowRegistry } from "@bratsos/workflow-engine/kernel";
import {
  createPrismaAICallLogger,
  createPrismaBlobStore,
  createPrismaJobQueue,
  createPrismaStepLedger,
  createPrismaWorkflowPersistence,
} from "@bratsos/workflow-engine";
import { PrismaClient } from "@prisma/client";
import { documentProcessorWorkflow } from "./workflows/document-processor";

const prisma = new PrismaClient();

const kernel = createKernel({
  persistence: createPrismaWorkflowPersistence(prisma),
  blobStore: createPrismaBlobStore(prisma), // any BlobStore shared by every process
  jobTransport: createPrismaJobQueue(prisma),
  stepLedger: createPrismaStepLedger(prisma), // durable steps (ctx.step.*)
  services: { aiLogger: createPrismaAICallLogger(prisma) }, // ctx.ai / ctx.step.ai
  eventSink: myEventSink,                   // EventSink implementation: { emit }
  clock: { now: () => new Date() },
  registry: createWorkflowRegistry([documentProcessorWorkflow]),
});
```

`createWorkflowRegistry` is what makes definition versioning effective: it can enumerate the workflows this build serves, so a host only claims runs it can execute. A hand-written `{ getWorkflow }` registry still works but claims regardless of version. Without `stepLedger` every `ctx.step.*` call throws `StepLedgerNotConfiguredError`; without `services` accessing `ctx.ai` throws `AIServicesNotConfiguredError`. `spillThresholdBytes` (default 64 KiB) moves oversized step results to the blob store behind a claim check.

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

For a request that needs the run's result before it returns, the serverless package also exports `runToCompletion({ kernel, jobTransport, persistence, command })`, a bounded drain loop that creates the run and drives it to a terminal state inside the calling request (see that package's README for its limits).

---

## Core Concepts

### Stages

A stage is the atomic unit of work. Every stage has typed input, output, and config schemas.

Every stage context carries `ctx.step` (durable steps, including `ctx.step.ai` for memoized and batched model calls), `ctx.ai` / `ctx.aiLogger` (the injected AI services), `ctx.abortSignal` (fires when the run is cancelled or the job lease is lost while the stage executes), `ctx.annotate`, `ctx.storage`, `ctx.log` and `ctx.onProgress`. A stage that needs to wait hours — for a provider batch, a webhook, a human — does so with a durable step and suspends; the engine resumes it by replaying `execute()` with completed steps answered from the step ledger. The 0.x `defineAsyncBatchStage` / `checkCompletion` mode is gone from the public entry; use `ctx.step.ai.map` or `ctx.step.waitFor` instead.

### Workflows

Workflows are built as a linear pipeline of **execution groups**. Each group contains one or more stages. Sequential stages (`.pipe()`) form single-stage groups. Parallel stages (`.parallel()`) form multi-stage groups where all stages run concurrently.

```typescript
defineWorkflow({ id, name, description, input })
  .pipe(stageA)              // Group 0: stageA runs first
  .pipe(stageB)              // Group 1: stageB runs after stageA
  .parallel([stageC, stageD]) // Group 2: stageC and stageD run concurrently
  .pipe(stageE)              // Group 3: stageE runs after both complete
  .build();
```

The output of each execution group is stored in the workflow context keyed by stage ID. For parallel groups, the merged output is an object keyed by each stage's ID:

```typescript
// After group 2 completes, stageE receives:
ctx.require("stageC") // output of stageC
ctx.require("stageD") // output of stageD
```

When a workflow completes, the final execution group's output is persisted in `WorkflowRun.output` and included in the `workflow:completed` event.

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

// Redrive a failed run: retry from the last failure, restart, or resume at a stage
await kernel.dispatch({
  type: "run.redrive",
  workflowRunId,
  from: { kind: "lastFailure" }, // | { kind: "start" } | { kind: "stage", stageId: "extract-text" }
});

// Deliver a signal to a stage waiting on ctx.step.waitForSignal
await kernel.dispatch({
  type: "step.signal",
  workflowRunId,
  stageId: "review",
  stepId: "approval",
  payload: { approved: true },
});
```

The kernel depends on six required ports, injected at creation, plus the optional ones below:

| Port | Purpose |
|------|---------|
| `Persistence` | Runs, stages, definitions, logs, outbox, idempotency CRUD |
| `BlobStore` | Large payload storage (put/get/has/delete/list); must be shared by every process that executes or polls a run |
| `JobTransport` | Job queue (enqueueParallel/dequeue/complete/suspend/fail, fenced acknowledgements) |
| `EventSink` | Async event publishing (`{ emit }`) |
| `Clock` | Injectable time source |
| `WorkflowRegistry` | Workflow definition lookup; `createWorkflowRegistry()` adds enumeration for version-filtered claiming |
| `StepLedger` (optional) | Durable step records for `ctx.step.*` (`InMemoryStepLedger`, `PrismaStepLedger`) |
| `KernelServices` (optional) | `{ aiLogger, ai? }` behind `ctx.ai` and `ctx.step.ai` |
| `ActivityExecutor` (optional) | Runs a stage body elsewhere (see `@bratsos/workflow-engine-host-remote`) |

### Hosts

Hosts wrap the kernel with environment-specific process management:

**Node Host** (`@bratsos/workflow-engine-host-node`): Long-running worker process with polling loops, signal handling (SIGTERM/SIGINT), and continuous job dequeuing.

**Serverless Host** (`@bratsos/workflow-engine-host-serverless`): Stateless single-invocation methods for queue-driven environments. Consumers wire platform-specific glue (ack/retry/waitUntil) around the host methods.

### Persistence

| Interface | Purpose |
|-----------|---------|
| `Persistence` | Workflow runs, stages, definitions, logs, outbox, idempotency, purge |
| `JobTransport` | Distributed job queue with priority, retries, fenced acknowledgements and an opt-in per-group concurrency cap |
| `BlobStore` | Large payload storage |
| `StepLedger` | Durable step records |
| `AICallLogger` | AI call tracking with cost aggregation |

**Built-in implementations:**
- `createPrismaWorkflowPersistence(prisma, { statusEnumName?, now?, definitionVersioning? })` - PostgreSQL via Prisma
- `createPrismaJobQueue(prisma, { fairness?: { maxConcurrentPerGroup, groupBy } })` - PostgreSQL with `FOR UPDATE SKIP LOCKED`; the lease runs on the database clock
- `createPrismaStepLedger(prisma)` - PostgreSQL (`workflow_steps`)
- `createPrismaBlobStore(prisma)` - PostgreSQL (`workflow_blobs`), a shared blob store without object storage
- `createPrismaAICallLogger(prisma)` - PostgreSQL
- `InMemoryWorkflowPersistence`, `InMemoryJobQueue`, `InMemoryStepLedger`, `InMemoryAICallLogger` from `@bratsos/workflow-engine/testing`; `InMemoryBlobStore`, `FakeClock`, `CollectingEventSink` from `@bratsos/workflow-engine/kernel/testing`

A custom adapter is held to the same contract as the bundled ones by `persistenceConformanceSuite`, `jobQueueConformanceSuite`, `stepLedgerConformanceSuite` and `aiCallLoggerConformanceSuite` (all from `/testing`, each taking your test primitives as a third argument).

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

Parallel stages run concurrently in the same execution group. Their outputs are keyed by stage ID in the workflow context:

```typescript
const workflow = defineWorkflow({ /* ... */ })
  .pipe(extractStage)
  .parallel([
    sentimentAnalysisStage,   // id: "sentiment"
    keywordExtractionStage,   // id: "keywords"
    languageDetectionStage,   // id: "language"
  ])
  .pipe(aggregateResultsStage)
  .build();

// In aggregateResultsStage:
async execute(ctx) {
  const sentiment = ctx.require("sentiment");   // output of sentimentAnalysisStage
  const keywords = ctx.require("keywords");     // output of keywordExtractionStage
  const language = ctx.require("language");     // output of languageDetectionStage
  // ...
}
```

### Stage ID Utilities

Use `createStageIds` or `defineStageIds` for type-safe stage ID constants with autocomplete:

```typescript
import { createStageIds, defineStageIds } from "@bratsos/workflow-engine";

// From an existing workflow
const STAGES = createStageIds(myWorkflow);
STAGES.EXTRACT_TEXT    // "extract-text" (autocomplete + type-safe)
STAGES.SUMMARIZE       // "summarize"

// Or define upfront
const STAGES = defineStageIds(["extract-text", "summarize"] as const);
```

### Durable Steps

`ctx.step.*` records side effects and waits in the step ledger, keyed by step id. A stage that suspends is resumed by replaying `execute()` from the top with completed steps answered from the ledger, so a body must be deterministic around its steps. Never catch a `ctx.step.*` error without rethrowing (`isStepControlFlowError` tells a suspension apart); a body that swallows one still suspends.

```typescript
import { StageAbortedError } from "@bratsos/workflow-engine";

async execute(ctx) {
  // run: memoize one side effect. `lease` bounds how long a crashed worker
  // holds it before another one takes over (default 5 minutes — this is the
  // crash-recovery latency); `retries`/`retryDelay` re-run a thrown body.
  const invoice = await ctx.step.run(
    "create-invoice",
    async (step) => {
      // step.externalKey is derived from the stage record + step id and written
      // before the body runs: pass it as the provider's idempotency key, or
      // search for the effect when step.isReclaim is true.
      return billing.createInvoice({ idempotencyKey: step.externalKey, ...ctx.input });
    },
    {
      lease: "10m",
      retries: 3,
      retryDelay: "30s",
      retryBackoff: { factor: 2, maxDelay: "5m", jitter: true },
      heartbeat: "1m",     // extend the lease automatically while the body runs
      onReclaim: "fail",   // refuse a lease-expiry takeover: StepNotReplaySafeError
    },
  );

  // waitFor: poll until ready. The deadline is stored once and never slides;
  // expiry throws StepTimeoutError. A throwing poll backs off, not fails.
  const paid = await ctx.step.waitFor("paid", {
    poll: () => billing.getInvoice(invoice.id),
    ready: (inv): inv is PaidInvoice => inv.status === "paid", // type guard narrows
    every: "1m",
    timeout: "3d",
  });

  // waitForSignal: suspend until `step.signal` is dispatched (kernel command,
  // console button, or your own endpoint). `keepalive` bounds how often the
  // stage replays while nothing arrives (default 5 minutes).
  const approval = await ctx.step.waitForSignal<{ approved: boolean }>("approval", {
    timeout: "7d",
    keepalive: "1h",
  });

  await ctx.step.sleep("cool-down", "30s");

  // Cancellation reaches a running body: ctx.abortSignal (also step.abortSignal
  // inside run) fires with a StageAbortedError whose reason is "cancelled" or
  // "lease-lost".
  ctx.abortSignal.throwIfAborted();

  return { output: { invoiceId: invoice.id, paid, approved: approval.approved } };
}
```

- `lease` and `retryDelay` take milliseconds or a duration string (`"30s"`, `"5m"`); `leaseMs` / `retryDelayMs` still work as deprecated aliases.
- Concurrent steps under `Promise.all` are fine: when one suspends, the in-flight siblings are allowed to finish and record first.
- Two steps sharing a key in one stage invocation throw `DuplicateStepKeyError`.
- A step's outcome is recorded first-write-wins under a compare-and-set; if two workers ever ran the same body, a `step.outcome-conflict` annotation says so.
- Step results must be JSON and should be small; a result above `spillThresholdBytes` is moved to the blob store automatically.

### AI Integration

`ctx.ai` is an `AIHelper` built lazily from `createKernel({ services })` under the topic `workflow.<runId>.stage.<stageId>`, with every call logged (prompt, tokens, cost) to the run's log table and rolled up onto `WorkflowRun.totalCost` / `totalTokens` on completion. `ctx.step.ai.*` are the same calls memoized through the step ledger, so a replay does not pay for them again:

```typescript
import { z } from "zod";

async execute(ctx) {
  // Durable: recorded in the ledger, replayed for free, retried like any step
  const { text } = await ctx.step.ai.generateText(
    "summary",
    "gemini-2.5-flash",
    "Summarize: " + ctx.input.text,
    { maxTokens: 400 },
    { retries: 2, retryDelay: "10s" },
  );

  const { object: analysis } = await ctx.step.ai.generateObject(
    "analysis",
    "gemini-2.5-flash",
    "Analyze: " + ctx.input.text,
    z.object({ sentiment: z.enum(["positive", "negative", "neutral"]) }),
  );

  // Streaming, durably: streams on the first execution, replays the stored text
  const draft = await ctx.step.ai.streamText("draft", "gemini-2.5-flash", "Draft a reply", {
    onChunk: (chunk) => ctx.log("DEBUG", chunk),
  });

  // Non-durable: plain call through the same logger (no memoization)
  const { embedding } = await ctx.ai.embed("text-embedding-3-small", text);

  return { output: { text, analysis, draft: draft.text, embedding } };
}
```

Reasoning models work too — control reasoning per call with `providerOptions` and read the reasoning channel via `result.reasoning` (or `getReasoning()` when streaming):

```typescript
const { text, reasoning } = await ctx.ai.generateText("anthropic/claude-opus-4.8", prompt, {
  providerOptions: { anthropic: { thinking: { type: "disabled" } } }, // or { openrouter: { reasoning: { enabled: false } } }
});
```

Models are configured with `registerModels()` and resolved with `getModel(key)` (`supportsAsyncBatch` says whether a batch transport exists). `AIHelperOptions.adapter` swaps the transport below logging and cost; `timeout.perCallMs` / per-call `timeoutMs` throw `AICallTimeoutError`. Schemas that no provider dialect can express fail before submit with `UnportableSchemaError`. Outside a stage, `createAIHelper(topic, logger)` builds the same helper by hand.

### Batch AI Calls (`ctx.step.ai.map`)

`map` runs one prompt per item under a policy: `"realtime"` (in-process concurrency), `"batch"` (OpenAI Batch, Anthropic Message Batches, Google batch or OpenRouter `:batch`, submitted as a durable step that suspends the stage and resumes from the ledger), or `"auto"` (batch at or above `auto.batchAbove`, default 20, when the model supports it). Schema validation and repair apply identically on both paths, and every item's tokens and cost are recorded.

```typescript
import { z } from "zod";

const Verdict = z.object({ sentiment: z.enum(["positive", "negative", "neutral"]) });

async execute(ctx) {
  const results = await ctx.step.ai.map("classify", ctx.input.reviews, {
    model: "gemini-2.5-flash",
    prompt: (review) => `Classify: ${review.text}`,
    schema: Verdict,
    itemId: (review) => review.id,        // stable per-item step id
    policy: "auto",
    repair: { attempts: 1 },
    realtime: { concurrency: 8, budget: 500, minDelayMs: "100ms" },
    batch: { pollEvery: "60s", timeout: "24h", onExpiry: "partial" },
  });

  const failed = results.filter((r) => r.status === "failed");
  ctx.log("INFO", "classified", { ok: results.length - failed.length, failed: failed.length });
  return { output: { results } };
}
```

A worker that dies between the provider accepting a batch and the ledger recording it is the expensive failure. On a replay the submit step adopts the batch carrying its `externalKey` (OpenAI metadata, Google `displayName`); on transports with nothing to search (Anthropic, OpenRouter) it throws `BatchNotAdoptableError` rather than pay twice — `batch: { onReclaim: "resubmit" }` opts back into resubmitting. Batch capability comes from the model registry: `getModel(key).supportsAsyncBatch`, with `batchProvider` naming the transport.

### Annotations (Provenance)

Available from **v0.8.0**. A first-class API for attaching typed key-value facts to runs and stages so future agents can understand *why* something happened. Inspired by OpenTelemetry semantic conventions: dot-namespaced flat keys, scalar/array values, separate `payload` slot for rich blobs.

Annotations are **durable** — writes are buffered during stage execution and flushed atomically with the stage outcome. Not fire-and-forget.

```typescript
import { Decision, Trigger } from "@bratsos/workflow-engine/conventions";

// Inside a stage's execute() — typed keys give compile-time value checking
ctx.annotate(Decision.outcome, "low");
ctx.annotate(Decision.confidence, 0.42);

// String keys for custom org conventions
ctx.annotate("acme.compliance.signoff", "alice@acme.com");

// Batch form — multiple attributes share one envelope
ctx.annotate({
  actor: { kind: "agent", id: "triage-v3" },
  attributes: {
    "decision.outcome": "low",
    "decision.rationale": "AI confidence below threshold",
    "decision.used_fallback": true,
  },
});

// At run creation — capture trigger context atomically with the run
await kernel.dispatch({
  type: "run.create",
  workflowId: "ticket-triage",
  input: { ticket },
  annotations: [{
    actor: { kind: "system", id: "zendesk" },
    attributes: {
      "trigger.source": "webhook:zendesk",
      "trigger.parent_run_id": previousRunId,
    },
  }],
});

// External attach (plugins, post-hoc reviews) — idempotent retries
await kernel.annotations.attach(runId, {
  actor: { kind: "user", id: "alice" },
  attributes: { "review.disposition": "approved-anyway" },
  idempotencyKey: "review-2026-05-24-alice",
});

// Query
await kernel.annotations.list(runId);                              // everything
await kernel.annotations.list(runId, { keyPrefix: "decision." });  // by namespace
await kernel.annotations.list(runId, { actorId: "triage-v3" });    // by actor
```

**Migration from `WorkflowRun.metadata`**: the `metadata` parameter on `run.create` was removed in 1.0 — pass `annotations` instead. Existing rows are still projected as virtual `legacy.metadata.*` annotations when you call `kernel.annotations.list(...)`. The engine writes annotations of its own: `run.supersededAttempt` archives every stage record a redrive replaces, and `step.outcome-conflict` records a step body that ran more than once.

Well-known conventions live in `@bratsos/workflow-engine/conventions`: `Trigger.*`, `Decision.*`, `Approval.*`, `Revision.*`. Custom org keys keep working with the string form. See the [v0.8 migration guide](skills/workflow-engine/migrations/migrate-0.7-to-0.8.md) and the [annotations skill reference](skills/workflow-engine/references/10-annotations.md) for details.

### Config Presets

```typescript
import { withAIConfig, withStandardConfig } from "@bratsos/workflow-engine";
import { z } from "zod";

const MyConfigSchema = withAIConfig(z.object({ customField: z.string() }));
```

The `maxRetries` field of the presets is not read by the kernel; the job transport's `maxAttempts` is the retry budget.

---

## Operations

### Redrive

`run.redrive` retries, restarts or reruns a terminal run under the same run id, incrementing `redriveCount`. Every stage record it supersedes is archived first as a `run.supersededAttempt` annotation, so the failed attempt survives:

```typescript
await kernel.dispatch({
  type: "run.redrive",
  workflowRunId,
  from: { kind: "lastFailure" },  // default; or { kind: "start" } / { kind: "stage", stageId }
  definitionVersion: "latest",     // optional: re-pin a run stranded on a version nothing serves
});
```

The resumed stage keeps its step ledger: completed steps are answered from it, so a stage that finished 9 of 10 steps re-runs only the tenth, and external keys stay the same. `run.rerunFrom` still works (it delegates to the same code) but is deprecated.

### Retention

Nothing deletes runs unless you ask. `run.purge` — `{ olderThan, statuses?, limit? }` → `{ purged, workflowRunIds }` — clears a terminal run's step ledger, job rows and blobs and deletes the run with everything under it. Both hosts run it on the maintenance tick when given `retention: { olderThanMs, statuses?, limit? }`:

```typescript
createNodeHost({
  kernel,
  jobTransport,
  workerId: "worker-1",
  retention: { olderThanMs: 30 * 24 * 60 * 60 * 1000, limit: 100 },
});
```

### Definition Versioning

`run.create` pins a run to a version of the workflow's *structural contract* — stage ids and order, execution groups, dependencies, modes, and the JSON Schema of every input/output/config schema — and stores that structure in `workflow_definitions`. Stage names, descriptions and bodies are excluded, so editing what a stage does never forks a run in flight. The version is a derived `sha256-…` hash unless you declare one with `defineWorkflow(...).version("2026-09-04.1")`; re-registering a declared version with a different structure throws `DefinitionVersionConflictError`.

With a registry built by `createWorkflowRegistry`, a host claims and polls only runs whose `(workflowId, version)` it serves, so a rolling deploy cannot change a run's shape mid-flight; a job for a version this build cannot serve is deferred, not failed (`ghostReason: "version"`). `serves: "all"` on the host restores the pre-1.0 predicate. `run.listVersions` reports which versions still have runs and which of them nobody here serves (`unservedHere`); `run.redrive` with `definitionVersion` moves those forward. In CI, `shadowVersions` / `shadowRuns` / `assertShadowCompatible` from `/testing` diff a candidate build against the versions with live runs. A database without the `workflow_definitions` table still starts, with versioning off.

### Enqueue from SQL

`sql/enqueue.sql` (shipped in the package; apply it in your own migration after the engine's tables exist) defines `workflow_engine_enqueue(idempotency_key, workflow_id, workflow_name, input, config?, priority?, definition_version?)`, so a trigger or a non-TypeScript service creates a run inside its own transaction:

```sql
PERFORM workflow_engine_enqueue(
  'order:' || v_order_id, 'fulfil-order', 'Fulfil Order',
  jsonb_build_object('orderId', v_order_id));
```

It writes exactly the rows `run.create` writes and leaves the run `PENDING`. It cannot validate input against the Zod schema, creates the run unpinned unless you pass a registered `definition_version`, and stores `config` verbatim. PostgreSQL 13+.

---

## Testing

`createTestHarness` from `@bratsos/workflow-engine/testing` wires the kernel over every in-memory port with a fake clock and a mock AI factory, and drives a run to completion:

```typescript
import { createTestHarness } from "@bratsos/workflow-engine/testing";
import { expect, it } from "vitest";

it("completes", async () => {
  const harness = createTestHarness({ workflows: [documentProcessorWorkflow] });

  // Mock a durable step's outcome before the run: a pre-seeded ledger row
  harness.steps.mockResult("create-invoice", { id: "inv_1" });
  harness.steps.mockError("flaky", new Error("boom"), { attempt: 1 }); // exercise retries
  harness.steps.mockTimeout("paid");                                     // waitFor / waitForSignal only
  harness.steps.skipSleeps();

  const result = await harness.run("document-processor", { url: "https://example.com" });
  expect(result.status).toBe("COMPLETED");
  expect(await harness.steps.status("create-invoice")).toBe("completed");
  expect(harness.steps.wasMocked("create-invoice")).toBe(true);
});
```

`harness.start()` creates a run without driving it; `harness.tick()` runs one round (claim → execute → poll → flush → advance) and returns a `TickReport`; `harness.tickUntil(predicate)` waits for a condition; `harness.cancel(runId)` exercises `ctx.abortSignal`. `harness.mockAi` scripts model responses (`setTextResponse`, `setObjectResponse`, `mockObjectResponseForSchema`, `failOnce`), and `harness.steps.record/records/result/error` read back what the ledger recorded. `createTestKernel([workflows])` gives the bare kernel for dispatch-level tests; the module imports nothing from vitest, so it loads from a plain script too.

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
      progress: Math.round(((index + 1) / items.length) * 100), // 0-100
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
| `run.create` | Create a new workflow run (pinned to the definition version) | `idempotencyKey`, `workflowId`, `input`, `config?`, `priority?`, `annotations?` |
| `run.claimPending` | Claim pending runs this build serves and enqueue first-stage jobs | `workerId`, `maxClaims?`, `serves?` |
| `run.transition` | Advance to next stage group | `workflowRunId` |
| `run.cancel` | Cancel a running workflow (cascades to stages + jobs, aborts the running body) | `workflowRunId`, `reason?` |
| `run.redrive` | Retry from the last failure, restart, or resume at a stage; archives the superseded attempt | `workflowRunId`, `from?`, `definitionVersion?` |
| `run.rerunFrom` | **Deprecated** — use `run.redrive` | `workflowRunId`, `fromStageId` |
| `run.purge` | Delete terminal runs older than a cutoff with everything under them | `olderThan`, `statuses?`, `limit?` |
| `run.listVersions` | Per-version run counts: which versions have drained, which nobody here serves | `workflowId?`, `definitionVersion?` |
| `job.execute` | Execute a single stage (multi-phase transactions) | `idempotencyKey?`, `workflowRunId`, `workflowId`, `stageId`, `config`, `attempt?`, `maxAttempts?`, `abortSignal?` |
| `job.heartbeat` | Renew a job lease and report whether the work is still wanted (feeds `abortSignal`) | `jobId`, `workflowRunId`, `attempt?` |
| `stage.pollSuspended` | Poll suspended stages (per-stage transactions) | `maxChecks?`, `serves?` (returns `resumedWorkflowRunIds`) |
| `step.signal` | Complete a `waitForSignal` step and wake its stage; idempotent | `workflowRunId`, `stageId`, `stepId`, `payload` |
| `lease.reapStale` | Release stale job leases; expire jobs past the absolute cap | `staleThresholdMs`, `absoluteTimeoutMs?` |
| `run.reapStuck` | Fail runs stuck RUNNING with no activity; re-enqueue PENDING stages with no job | `stuckThresholdMs` |
| `outbox.flush` | Publish pending events; reports `eventSinkStatus` | `maxEvents?` |
| `plugin.replayDLQ` | Replay dead-letter queue events | `maxEvents?` |

Idempotency behavior:
- Replaying the same `idempotencyKey` returns cached results.
- If the same key is already executing, dispatch throws `IdempotencyInProgressError`.

Transaction behavior:
- Most commands execute inside a single database transaction (handler + outbox events). Enqueues happen post-commit, so a job never names a run that is not yet visible.
- `job.execute` uses multi-phase transactions: Phase 1 commits `RUNNING` status immediately, Phase 2 runs `stageDef.execute()` outside any transaction, Phase 3 commits the final status. This avoids holding a database connection during long-running stage execution. A failure with job attempts left leaves the stage `PENDING` with the error and returns `willRetry: true`; the stage becomes `FAILED` only when the transport's `maxAttempts` is exhausted.
- `stage.pollSuspended` claims each stage (a version-guarded `nextPollAt` lease) before replaying it, so two orchestrators never replay the same stage; the replay runs outside any transaction and the outcome commits in a short per-stage transaction.

Cancellation semantics:
- `run.cancel` is **authoritative**: it marks the run as `CANCELLED`, cascades to all non-terminal stages (setting them to `CANCELLED` and clearing `nextPollAt`), and cancels all queued/suspended jobs via `jobTransport.cancelByRun()`.
- The running body sees it: the host's job heartbeat (`job.heartbeat`) aborts `ctx.abortSignal` with a `StageAbortedError` (`reason: "cancelled"`, or `"lease-lost"` when another worker took the job). `waitFor` checks the signal before it polls; a `run` body that finishes after a cancel is recorded as failed with the cancellation as its error.
- `stage.pollSuspended` skips stages whose run has been cancelled.
- `job.execute` re-checks run status after stage execution. If the run was cancelled during execution, the result is discarded and `ghost: true` is returned with `ghostReason: "orphan"`; `"race"` (the run was still `PENDING`) and `"version"` (this build does not serve the run) are re-delivered by the hosts rather than dropped.

### Node Host Config

The full table is in the [host-node README](../workflow-engine-host-node/README.md). The options a reader most often needs:

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `kernel` | `Kernel` | required | Kernel instance |
| `jobTransport` | `JobTransport` | required | Job queue |
| `workerId` | `string` | required | Unique worker ID |
| `orchestrationIntervalMs` | `number` | 10000 | Orchestration poll interval |
| `jobPollIntervalMs` | `number` | 1000 | Job dequeue interval |
| `staleLeaseThresholdMs` | `number` | 300000 | Heartbeat lease threshold: a job whose lease is older is re-queued |
| `jobAbsoluteTimeoutMs` | `number` | 3600000 | Absolute cap on one job claim; `0` disables |
| `serves` | `ServedDefinition[] \| "all"` | from registry | Which definition versions this host claims and polls |
| `retention` | `RetentionOptions` | off | `run.purge` on every tick |

### Serverless Host

| Method | Description |
|--------|-------------|
| `handleJob(msg)` | Execute a single pre-dequeued job. Returns `{ outcome, error?, willRetry?, attempt?, maxAttempts?, retryDelayMs?, dead? }` |
| `processAvailableJobs(opts?)` | Dequeue and process jobs. Returns `{ processed, succeeded, failed }` |
| `runMaintenanceTick()` | Claim, poll, reap, flush, purge in one call. Returns structured result |
| `runToCompletion(options)` | Standalone export: create a run and drive it to a terminal state inside the calling request, bounded by `maxJobs` / `maxClaimRounds` |

### Core Exports

```typescript
// Stage definition
import { defineStage } from "@bratsos/workflow-engine";

// Workflow building
import { defineWorkflow, WorkflowBuilder, Workflow } from "@bratsos/workflow-engine";
import type { InferWorkflowInput, InferWorkflowOutput, InferWorkflowContext } from "@bratsos/workflow-engine";

// Durable steps
import type { StepApi, StepRunOptions, StepRunContext, StepWaitOptions, StepSignalOptions } from "@bratsos/workflow-engine";
import {
  StepTimeoutError, StepLeaseLostError, StepNotReplaySafeError, DuplicateStepKeyError,
  StageAbortedError, stageAbortReason, isStepControlFlowError, deriveStepExternalKey,
} from "@bratsos/workflow-engine";
import { AiMapBatchFailedError, AiMapBudgetExceededError, BatchNotAdoptableError } from "@bratsos/workflow-engine";

// Kernel
import { createKernel, createWorkflowRegistry, type Kernel, type KernelConfig } from "@bratsos/workflow-engine/kernel";
import { createStepApi } from "@bratsos/workflow-engine/kernel"; // ledger-less step API for hand-built contexts

// Kernel types
import type { KernelCommand, CommandResult, KernelEvent } from "@bratsos/workflow-engine/kernel";

// Port interfaces
import type { Persistence, BlobStore, JobTransport, EventSink, Clock, StepLedger, KernelServices } from "@bratsos/workflow-engine/kernel";

// Host helpers (what the host packages are built from)
import { runMaintenanceTick, executeJobWithHeartbeat, HOST_DEFAULTS, createSpillingJobTransport } from "@bratsos/workflow-engine/kernel";

// Plugins
import { definePlugin, createPluginRunner } from "@bratsos/workflow-engine/kernel";

// Persistence (Prisma)
import {
  createPrismaWorkflowPersistence, createPrismaJobQueue, createPrismaStepLedger,
  createPrismaBlobStore, createPrismaAICallLogger,
} from "@bratsos/workflow-engine";

// AI Helper and models
import { createAIHelper, registerModels, getModel, type AIHelper, type AIAdapter } from "@bratsos/workflow-engine";
import { UnportableSchemaError, AICallTimeoutError } from "@bratsos/workflow-engine";

// Stage ID utilities
import { createStageIds, defineStageIds, isValidStageId, assertValidStageId } from "@bratsos/workflow-engine";

// Testing
import {
  createTestHarness, createTestKernel, createMockAIHelperFactory, createMockStepLedger,
  InMemoryWorkflowPersistence, InMemoryJobQueue, InMemoryStepLedger, InMemoryAICallLogger,
  persistenceConformanceSuite, jobQueueConformanceSuite, stepLedgerConformanceSuite, aiCallLoggerConformanceSuite,
  shadowRuns, shadowVersions, assertShadowCompatible,
} from "@bratsos/workflow-engine/testing";
import { FakeClock, InMemoryBlobStore, CollectingEventSink } from "@bratsos/workflow-engine/kernel/testing";
```

---

## Troubleshooting

### "Workflow not found in registry"

Ensure the workflow is registered in the `registry` passed to `createKernel`:

```typescript
import { createKernel, createWorkflowRegistry } from "@bratsos/workflow-engine/kernel";

const kernel = createKernel({
  // ...
  registry: createWorkflowRegistry([myWorkflow]),
});
```

With `createWorkflowRegistry`, a pending run whose workflow this build does not have is left `PENDING` for a host that has it (and reported by `run.listVersions`) rather than failed.

### "Stage X depends on Y which was not found"

Verify all dependencies are included in the workflow:

```typescript
.pipe(extractStage)   // Must be piped before
.pipe(analyzeStage)   // analyze can now access extract's output
```

### Jobs stuck in "RUNNING"

A worker likely crashed. The stale lease recovery (`lease.reapStale` command) re-queues a job whose heartbeat stopped (`staleLeaseThresholdMs`, `lastError` prefixed `LEASE_HEARTBEAT_LOST`) and fails one that ran past the absolute cap (`jobAbsoluteTimeoutMs`, `LEASE_ABSOLUTE_CAP`). In Node host, this runs on each orchestration tick. For serverless, call `runMaintenanceTick()` from a cron trigger.

### Crash resumption waits minutes

A `ctx.step.run` left `running` by a killed process is held by its step lease until it expires (default five minutes): the ledger row carries no worker identity, so the lease is the only liveness signal, and releasing it early would execute the body twice. `StepRunOptions.lease` is the knob; size it to the body's expected duration, and use `heartbeat` for a long body rather than a long lease.

### `PrismaClient is not assignable to EnginePrismaClient`

One of the delegates the adapter needs is missing from your generated client — after 1.0, almost always `workflowStep` (and `workflowDefinition`). Add the models from the schema above and re-run `prisma generate`.

---

## Upgrading

Migration guides ship inside the package at `node_modules/@bratsos/workflow-engine/skills/workflow-engine/migrations/` (one per release, `migrate-X.Y-to-A.B.md`) and on the docs site. A codemod applies the mechanical renames and lists every manual item with a file and line:

```bash
npx workflow-engine-codemod --from 0.13          # or --from 0.11 / 0.12; add --dry-run to preview
```

The 0.13 → 1.0 guide (`migrate-0.13-to-1.0.md`) has the column-level database checklist with SQL, the API removals with replacements, the `defineAsyncBatchStage` → `ctx.step.ai.map` migration, `createKernel({ services, stepLedger })`, the AI SDK peer ranges and the behaviour changes. The codemod flags `defineAsyncBatchStage`, `checkCompletion`, `requireStageOutput`, `experimental_output` and the removed model helpers with the guide pointer.

## License

MIT
