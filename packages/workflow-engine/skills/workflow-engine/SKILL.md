---
name: workflow-engine
description: Guide for @bratsos/workflow-engine - a type-safe workflow engine with AI integration, stage pipelines, and persistence. Use when building multi-stage workflows, AI-powered pipelines, implementing workflow persistence, defining stages, or working with batch AI operations.
license: MIT
metadata:
  author: bratsos
  version: "0.1.0"
  repository: https://github.com/bratsos/workflow-engine
---

# @bratsos/workflow-engine Skill

Type-safe workflow engine for building AI-powered, multi-stage pipelines with persistence and batch processing support.

## ⚠️ CRITICAL: Required Prisma Models

**Before using this library, your Prisma schema MUST include ALL of these models with EXACT field names:**

| Model | Required | Purpose |
|-------|----------|---------|
| `WorkflowRun` | ✅ Yes | Workflow execution records |
| `WorkflowStage` | ✅ Yes | Stage execution state |
| `WorkflowLog` | ✅ Yes | Stage logging |
| `WorkflowArtifact` | ✅ Yes | Stage output storage |
| `JobQueue` | ✅ Yes | Job scheduling |
| `AICall` | Optional | AI call tracking |

**Common Errors:**
- `Cannot read properties of undefined (reading 'create')` → Missing `WorkflowLog` model
- `Cannot read properties of undefined (reading 'upsert')` → Missing `WorkflowArtifact` model
- `Unknown argument 'duration'. Did you mean 'durationMs'?` → Field name mismatch (use `duration`, not `durationMs`)

**See [05-persistence-setup.md](references/05-persistence-setup.md) for the complete schema.**

## When to Apply

- User wants to create workflow stages or pipelines
- User mentions `defineStage`, `defineAsyncBatchStage`, `WorkflowBuilder`
- User is implementing workflow persistence with Prisma
- User needs AI integration (generateText, generateObject, embeddings, batch)
- User is building multi-stage data processing pipelines
- User mentions workflow runtime, job queues, or stage execution
- User needs to test workflows with mocks

## Quick Start

```typescript
import {
  defineStage,
  WorkflowBuilder,
  createWorkflowRuntime,
  createPrismaWorkflowPersistence,
  createPrismaJobQueue,
  createPrismaAICallLogger,
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
    const processed = ctx.input.data.toUpperCase();
    return { output: { result: processed } };
  },
});

// 2. Build a workflow
const workflow = new WorkflowBuilder(
  "my-workflow",
  "My Workflow",
  "Processes data",
  z.object({ data: z.string() }),
  z.object({ result: z.string() })
)
  .pipe(processStage)
  .build();

// 3. Create runtime and execute
const runtime = createWorkflowRuntime({
  persistence: createPrismaWorkflowPersistence(prisma),
  jobQueue: createPrismaJobQueue(prisma),
  aiCallLogger: createPrismaAICallLogger(prisma),
  registry: { getWorkflow: (id) => (id === "my-workflow" ? workflow : null) },
});

await runtime.start();
const { workflowRunId } = await runtime.createRun({
  workflowId: "my-workflow",
  input: { data: "hello" },
});
```

## Core Exports Reference

| Export | Type | Purpose |
|--------|------|---------|
| `defineStage` | Function | Create sync stages |
| `defineAsyncBatchStage` | Function | Create async/batch stages |
| `WorkflowBuilder` | Class | Chain stages into workflows |
| `Workflow` | Class | Built workflow definition |
| `WorkflowRuntime` | Class | Execute workflows with persistence |
| `createAIHelper` | Function | AI operations (text, object, embed, batch) |
| `AVAILABLE_MODELS` | Object | Model configurations |
| `registerModels` | Function | Add custom models |
| `calculateCost` | Function | Estimate token costs |
| `NoInputSchema` | Schema | For stages without input |

## Stage Definition

### Sync Stage

```typescript
const myStage = defineStage({
  id: "my-stage",           // Unique identifier
  name: "My Stage",         // Display name
  description: "Optional",  // Description
  dependencies: ["prev"],   // Required previous stages

  schemas: {
    input: InputSchema,     // Zod schema or "none"
    output: OutputSchema,   // Zod schema
    config: ConfigSchema,   // Zod schema with defaults
  },

  async execute(ctx) {
    // Access input, config, workflow context
    const { input, config, workflowContext } = ctx;

    // Get output from previous stages
    const prevOutput = ctx.require("prev");      // Throws if missing
    const optOutput = ctx.optional("other");     // Returns undefined if missing

    // Access services
    await ctx.log("INFO", "Processing...");
    await ctx.storage.save("key", data);

    return {
      output: { ... },
      customMetrics: { itemsProcessed: 10 },
      artifacts: { rawData: data },
    };
  },
});
```

### Async Batch Stage

```typescript
const batchStage = defineAsyncBatchStage({
  id: "batch-process",
  name: "Batch Process",
  mode: "async-batch",  // Required

  schemas: {
    input: "none",
    output: OutputSchema,
    config: ConfigSchema,
  },

  async execute(ctx) {
    // Check if resuming from suspension
    if (ctx.resumeState) {
      return { output: ctx.resumeState.cachedResult };
    }

    // Submit batch and suspend
    const batchId = await submitBatchJob(ctx.input);

    return {
      suspended: true,
      state: {
        batchId,
        submittedAt: new Date().toISOString(),
        pollInterval: 60000,
        maxWaitTime: 3600000,
      },
      pollConfig: {
        pollInterval: 60000,
        maxWaitTime: 3600000,
        nextPollAt: new Date(Date.now() + 60000),
      },
    };
  },

  async checkCompletion(suspendedState, ctx) {
    const status = await checkBatchStatus(suspendedState.batchId);

    if (status === "completed") {
      const results = await getBatchResults(suspendedState.batchId);
      return { ready: true, output: { results } };
    }

    if (status === "failed") {
      return { ready: false, error: "Batch failed" };
    }

    return { ready: false, nextCheckIn: 60000 };
  },
});
```

## WorkflowBuilder

```typescript
const workflow = new WorkflowBuilder(
  "workflow-id",
  "Workflow Name",
  "Description",
  InputSchema,
  OutputSchema
)
  .pipe(stage1)                    // Sequential
  .pipe(stage2)
  .parallel([stage3a, stage3b])    // Parallel execution
  .pipe(stage4)
  .build();

// Workflow utilities
workflow.getStageIds();            // ["stage1", "stage2", ...]
workflow.getExecutionPlan();       // Grouped by execution order
workflow.getDefaultConfig();       // Default config for all stages
workflow.validateConfig(config);   // Validate config object
```

## AI Integration & Cost Tracking

### Topic Convention for Cost Aggregation

Use hierarchical topics to enable cost tracking at different levels:

```typescript
// In a stage - use the standard convention
const ai = runtime.createAIHelper(`workflow.${ctx.workflowRunId}.stage.${ctx.stageId}`);

// Later, query costs by prefix:
const workflowCost = await aiLogger.getStats(`workflow.${workflowRunId}`);  // All stages
const stageCost = await aiLogger.getStats(`workflow.${workflowRunId}.stage.extraction`);  // One stage
```

**Note:** When a workflow completes, `WorkflowRun.totalCost` and `totalTokens` are automatically populated.

### AI Methods

```typescript
// Text generation
const { text, cost } = await ai.generateText("gemini-2.5-flash", prompt, {
  temperature: 0.7,
  maxTokens: 1000,
});

// Structured output
const { object } = await ai.generateObject(
  "gemini-2.5-flash",
  prompt,
  z.object({ items: z.array(z.string()) })
);

// Embeddings
const { embedding, embeddings } = await ai.embed(
  "text-embedding-004",
  ["text1", "text2"],
  { dimensions: 768 }
);

// Batch operations (50% cost savings)
const batch = ai.batch("claude-sonnet-4-20250514", "anthropic");
const handle = await batch.submit([
  { id: "req1", prompt: "..." },
  { id: "req2", prompt: "...", schema: OutputSchema },
]);

// Check status and get results
const status = await batch.getStatus(handle.id);
const results = await batch.getResults(handle.id);

// Get aggregated stats
const stats = await ai.getStats();
console.log(`Cost: $${stats.totalCost.toFixed(4)}, Tokens: ${stats.totalInputTokens + stats.totalOutputTokens}`);
```

**See [04-ai-integration.md](references/04-ai-integration.md) for complete topic convention and cost tracking docs.**

## Persistence Setup

### ⚠️ Required Prisma Models (ALL are required)

Copy this complete schema. Missing models or wrong field names will cause runtime errors.

```prisma
// Required enums
enum Status {
  PENDING
  RUNNING
  SUSPENDED
  COMPLETED
  FAILED
  CANCELLED
  SKIPPED
}

enum LogLevel {
  DEBUG
  INFO
  WARN
  ERROR
}

enum ArtifactType {
  STAGE_OUTPUT
  ARTIFACT
  METADATA
}

// ✅ REQUIRED: WorkflowRun
model WorkflowRun {
  id           String    @id @default(cuid())
  createdAt    DateTime  @default(now())
  updatedAt    DateTime  @updatedAt
  workflowId   String
  workflowName String
  workflowType String
  status       Status    @default(PENDING)
  startedAt    DateTime?
  completedAt  DateTime?
  duration     Int?                          // ⚠️ Must be "duration", not "durationMs"
  input        Json
  output       Json?
  config       Json      @default("{}")
  totalCost    Float     @default(0)
  totalTokens  Int       @default(0)
  priority     Int       @default(5)

  stages       WorkflowStage[]
  logs         WorkflowLog[]
  artifacts    WorkflowArtifact[]

  @@index([status])
  @@map("workflow_runs")
}

// ✅ REQUIRED: WorkflowStage
model WorkflowStage {
  id              String    @id @default(cuid())
  createdAt       DateTime  @default(now())
  updatedAt       DateTime  @updatedAt
  workflowRunId   String
  stageId         String
  stageName       String
  stageNumber     Int
  executionGroup  Int
  status          Status    @default(PENDING)
  startedAt       DateTime?
  completedAt     DateTime?
  duration        Int?                        // ⚠️ Must be "duration", not "durationMs"
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

  workflowRun     WorkflowRun        @relation(fields: [workflowRunId], references: [id], onDelete: Cascade)
  logs            WorkflowLog[]
  artifacts       WorkflowArtifact[]

  @@unique([workflowRunId, stageId])
  @@map("workflow_stages")
}

// ✅ REQUIRED: WorkflowLog (missing = "Cannot read 'create'" error)
model WorkflowLog {
  id              String         @id @default(cuid())
  createdAt       DateTime       @default(now())
  workflowRunId   String?
  workflowStageId String?
  level           LogLevel
  message         String
  metadata        Json?

  workflowRun     WorkflowRun?   @relation(fields: [workflowRunId], references: [id], onDelete: Cascade)
  workflowStage   WorkflowStage? @relation(fields: [workflowStageId], references: [id], onDelete: Cascade)

  @@index([workflowRunId])
  @@map("workflow_logs")
}

// ✅ REQUIRED: WorkflowArtifact (missing = "Cannot read 'upsert'" error)
model WorkflowArtifact {
  id              String       @id @default(cuid())
  createdAt       DateTime     @default(now())
  updatedAt       DateTime     @updatedAt
  workflowRunId   String
  workflowStageId String?
  key             String
  type            ArtifactType
  data            Json
  size            Int
  metadata        Json?

  workflowRun     WorkflowRun   @relation(fields: [workflowRunId], references: [id], onDelete: Cascade)
  workflowStage   WorkflowStage? @relation(fields: [workflowStageId], references: [id], onDelete: Cascade)

  @@unique([workflowRunId, key])
  @@map("workflow_artifacts")
}

// ✅ REQUIRED: JobQueue
model JobQueue {
  id            String    @id @default(cuid())
  createdAt     DateTime  @default(now())
  updatedAt     DateTime  @updatedAt
  workflowRunId String
  stageId       String
  status        Status    @default(PENDING)
  priority      Int       @default(5)
  workerId      String?
  lockedAt      DateTime?
  startedAt     DateTime?
  completedAt   DateTime?
  attempt       Int       @default(0)
  maxAttempts   Int       @default(3)
  lastError     String?
  nextPollAt    DateTime?
  payload       Json      @default("{}")

  @@index([status, nextPollAt])
  @@map("job_queue")
}
```

### Create Persistence

```typescript
import {
  createPrismaWorkflowPersistence,
  createPrismaJobQueue,
  createPrismaAICallLogger,
} from "@bratsos/workflow-engine/persistence/prisma";

// PostgreSQL (default)
const persistence = createPrismaWorkflowPersistence(prisma);
const jobQueue = createPrismaJobQueue(prisma);

// SQLite - MUST pass databaseType option
const persistence = createPrismaWorkflowPersistence(prisma, { databaseType: "sqlite" });
const jobQueue = createPrismaJobQueue(prisma, { databaseType: "sqlite" });

const aiCallLogger = createPrismaAICallLogger(prisma);
```

## Runtime Configuration

```typescript
const runtime = createWorkflowRuntime({
  persistence,
  jobQueue,
  aiCallLogger,
  registry: {
    getWorkflow: (id) => workflowMap[id] ?? null,
  },

  // Optional configuration
  pollIntervalMs: 10000,      // Orchestration poll interval
  jobPollIntervalMs: 1000,    // Job dequeue interval
  staleJobThresholdMs: 60000, // Stale job timeout
  workerId: "worker-1",       // Custom worker ID
});

// Lifecycle
await runtime.start();        // Start processing
runtime.stop();               // Graceful shutdown

// Manual operations
await runtime.createRun({ workflowId, input });
await runtime.transitionWorkflow(runId);
await runtime.pollSuspendedStages();
```

## Testing

```typescript
import {
  TestWorkflowPersistence,
  TestJobQueue,
  MockAIHelper,
} from "@bratsos/workflow-engine/testing";

const persistence = new TestWorkflowPersistence();
const jobQueue = new TestJobQueue();
const mockAI = new MockAIHelper();

// Configure mock responses
mockAI.mockGenerateText("Expected response");
mockAI.mockGenerateObject({ items: ["a", "b"] });

// Test stage execution
const result = await myStage.execute({
  input: { data: "test" },
  config: { verbose: true },
  workflowContext: {},
  workflowRunId: "test-run",
  stageId: "my-stage",
  log: async () => {},
  storage: persistence.createStorage("test-run"),
});
```

## Reference Files

For detailed documentation, see the reference files:

- [01-stage-definitions.md](references/01-stage-definitions.md) - Complete stage API
- [02-workflow-builder.md](references/02-workflow-builder.md) - WorkflowBuilder patterns
- [03-runtime-setup.md](references/03-runtime-setup.md) - Runtime configuration
- [04-ai-integration.md](references/04-ai-integration.md) - AI helper methods
- [05-persistence-setup.md](references/05-persistence-setup.md) - Database setup
- [06-async-batch-stages.md](references/06-async-batch-stages.md) - Async operations
- [07-testing-patterns.md](references/07-testing-patterns.md) - Testing utilities
- [08-common-patterns.md](references/08-common-patterns.md) - Best practices

## Key Principles

1. **Type Safety**: All schemas are Zod - types flow through the entire pipeline
2. **Context Access**: Use `ctx.require()` and `ctx.optional()` for type-safe stage output access
3. **Unified Status**: Single `Status` enum for workflows, stages, and jobs
4. **Cost Tracking**: All AI calls automatically track tokens and costs
5. **Batch Savings**: Use async-batch stages for 50% cost savings on large operations
