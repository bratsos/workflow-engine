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
  - [4. Create the Runtime](#4-create-the-runtime)
  - [5. Run a Workflow](#5-run-a-workflow)
- [Core Concepts](#core-concepts)
  - [Stages](#stages)
  - [Workflows](#workflows)
  - [Runtime](#runtime)
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
| **Event-Driven** | Real-time progress updates via Server-Sent Events |
| **Parallel Execution** | Run independent stages concurrently |
| **Resume Capability** | Automatic state persistence and recovery from failures |
| **Distributed** | Job queue with priority support and stale lock recovery |

---

## Requirements

- **Node.js** >= 18.0.0
- **TypeScript** >= 5.0.0
- **PostgreSQL** >= 14 (for Prisma persistence)
- **Zod** >= 3.22.0

### Optional Peer Dependencies

Install based on which AI providers you use:

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
npm install @bratsos/workflow-engine zod
# or
pnpm add @bratsos/workflow-engine zod
# or
yarn add @bratsos/workflow-engine zod
```

---

## Getting Started

This guide walks you through creating your first workflow from scratch.

### 1. Database Setup

The engine requires persistence tables. Add these to your Prisma schema:

```prisma
// schema.prisma

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

model WorkflowRun {
  id            String   @id @default(cuid())
  createdAt     DateTime @default(now())
  updatedAt     DateTime @updatedAt
  workflowId    String   // e.g., "document-processor"
  workflowName  String   // e.g., "Document Processor"
  workflowType  String   // For grouping/filtering
  status        Status   @default(PENDING)
  startedAt     DateTime?
  completedAt   DateTime?
  duration      Int?           // milliseconds
  input         Json
  output        Json?
  config        Json           @default("{}")
  totalCost     Float          @default(0)
  totalTokens   Int            @default(0)
  priority      Int            @default(5)
  metadata      Json?          // Optional domain-specific data

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
  stageId         String              // e.g., "extract-text"
  stageName       String              // e.g., "Extract Text"
  stageNumber     Int                 // 1-based execution order
  executionGroup  Int                 // For parallel grouping
  status          Status              @default(PENDING)
  startedAt       DateTime?
  completedAt     DateTime?
  duration        Int?                // milliseconds
  inputData       Json?
  outputData      Json?               // May contain { _artifactKey: "..." }
  config          Json?
  suspendedState  Json?               // State for async batch stages
  resumeData      Json?
  nextPollAt      DateTime?           // When to check again
  pollInterval    Int?                // milliseconds
  maxWaitUntil    DateTime?
  metrics         Json?               // { cost, tokens, custom... }
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
  level           String          // DEBUG, INFO, WARN, ERROR
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
  key           String   // Unique key within the run
  type          String   // STAGE_OUTPUT, ARTIFACT, METADATA
  data          Json
  size          Int      // bytes

  @@unique([workflowRunId, key])
  @@index([workflowRunId])
}

model AICall {
  id            String   @id @default(cuid())
  createdAt     DateTime @default(now())
  topic         String   // Hierarchical: "workflow.{runId}.stage.{stageId}"
  callType      String   // text, object, embed, stream
  modelKey      String   // e.g., "gemini-2.5-flash"
  modelId       String   // e.g., "google/gemini-2.5-flash-preview"
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
```

Run the migration:

```bash
npx prisma migrate dev --name add-workflow-tables
npx prisma generate
```

### 2. Define Your First Stage

Create a file `stages/extract-text.ts`:

```typescript
import { defineStage } from "@bratsos/workflow-engine";
import { z } from "zod";

// Define schemas for type safety
const InputSchema = z.object({
  url: z.string().url().describe("URL of the document to process"),
});

const OutputSchema = z.object({
  text: z.string().describe("Extracted text content"),
  wordCount: z.number().describe("Number of words extracted"),
  metadata: z.object({
    title: z.string().optional(),
    author: z.string().optional(),
  }),
});

const ConfigSchema = z.object({
  maxLength: z.number().default(50000).describe("Maximum text length to extract"),
  includeMetadata: z.boolean().default(true),
});

export const extractTextStage = defineStage({
  id: "extract-text",
  name: "Extract Text",
  description: "Extracts text content from a document URL",

  schemas: {
    input: InputSchema,
    output: OutputSchema,
    config: ConfigSchema,
  },

  async execute(ctx) {
    const { url } = ctx.input;
    const { maxLength, includeMetadata } = ctx.config;

    // Log progress
    ctx.log("INFO", "Starting text extraction", { url });

    // Simulate fetching document (replace with real implementation)
    const response = await fetch(url);
    const text = await response.text();
    const truncatedText = text.slice(0, maxLength);

    ctx.log("INFO", "Extraction complete", { 
      originalLength: text.length,
      truncatedLength: truncatedText.length,
    });

    return {
      output: {
        text: truncatedText,
        wordCount: truncatedText.split(/\s+/).length,
        metadata: includeMetadata ? { title: "Document Title" } : {},
      },
      // Optional: custom metrics for observability
      customMetrics: {
        bytesProcessed: text.length,
      },
    };
  },
});

// Export types for use in other stages
export type ExtractTextOutput = z.infer<typeof OutputSchema>;
```

### 3. Build a Workflow

Create a file `workflows/document-processor.ts`:

```typescript
import { WorkflowBuilder } from "@bratsos/workflow-engine";
import { z } from "zod";
import { extractTextStage } from "../stages/extract-text";
import { summarizeStage } from "../stages/summarize";
import { analyzeStage } from "../stages/analyze";

const InputSchema = z.object({
  url: z.string().url(),
  options: z.object({
    generateSummary: z.boolean().default(true),
    analyzeContent: z.boolean().default(true),
  }).optional(),
});

export const documentProcessorWorkflow = new WorkflowBuilder(
  "document-processor",       // Unique ID
  "Document Processor",       // Display name
  "Extracts, summarizes, and analyzes documents",
  InputSchema,
  InputSchema                 // Initial output type (will be inferred)
)
  .pipe(extractTextStage)     // Stage 1: Extract
  .pipe(summarizeStage)       // Stage 2: Summarize
  .pipe(analyzeStage)         // Stage 3: Analyze
  .build();

// Export input type for API consumers
export type DocumentProcessorInput = z.infer<typeof InputSchema>;
```

### 4. Create the Runtime

Create a file `runtime.ts`:

```typescript
import {
  createWorkflowRuntime,
  createPrismaWorkflowPersistence,
  createPrismaJobQueue,
  createPrismaAICallLogger,
  type WorkflowRegistry,
} from "@bratsos/workflow-engine";
import { PrismaClient } from "@prisma/client";
import { documentProcessorWorkflow } from "./workflows/document-processor";

// Initialize Prisma client
const prisma = new PrismaClient();

// Create persistence implementations
const persistence = createPrismaWorkflowPersistence(prisma);
const jobQueue = createPrismaJobQueue(prisma);
const aiCallLogger = createPrismaAICallLogger(prisma);

// Create a workflow registry
const registry: WorkflowRegistry = {
  getWorkflow(id: string) {
    const workflows: Record<string, any> = {
      "document-processor": documentProcessorWorkflow,
      // Add more workflows here
    };
    return workflows[id];
  },
};

// Optional: Define priority function for different workflow types
function getWorkflowPriority(workflowId: string): number {
  const priorities: Record<string, number> = {
    "document-processor": 5,   // Normal priority
    "urgent-task": 10,         // High priority
    "background-job": 2,       // Low priority
  };
  return priorities[workflowId] ?? 5;
}

// Create the runtime
export const runtime = createWorkflowRuntime({
  persistence,
  jobQueue,
  registry,
  aiCallLogger,
  pollIntervalMs: 10000,      // Check for suspended stages every 10s
  jobPollIntervalMs: 1000,    // Poll job queue every 1s
  getWorkflowPriority,        // Optional priority function
});

// Convenience exports
export { prisma, persistence, jobQueue };
```

### 5. Run a Workflow

#### Option A: Worker Process (Recommended for Production)

Create a file `worker.ts`:

```typescript
import { runtime } from "./runtime";

// Register shutdown handlers
process.on("SIGTERM", () => runtime.stop());
process.on("SIGINT", () => runtime.stop());

// Start the worker
console.log("Starting workflow worker...");
runtime.start();
```

Run the worker:

```bash
npx tsx worker.ts
```

#### Option B: Queue from API Endpoint

```typescript
import { runtime } from "./runtime";

// In your API route handler
export async function POST(request: Request) {
  const { url } = await request.json();

  const { workflowRunId } = await runtime.createRun({
    workflowId: "document-processor",
    input: { url },
    config: {
      "extract-text": { maxLength: 100000 },
      "summarize": { modelKey: "gemini-2.5-flash" },
    },
  });

  return Response.json({ workflowRunId });
}
```

---

## Core Concepts

### Stages

A stage is the atomic unit of work. Every stage has:

| Property | Description |
|----------|-------------|
| `id` | Unique identifier within the workflow |
| `name` | Human-readable name |
| `inputSchema` | Zod schema for input validation |
| `outputSchema` | Zod schema for output validation |
| `configSchema` | Zod schema for stage configuration |
| `execute(ctx)` | The function that performs the work |

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

### Runtime

The `WorkflowRuntime` manages workflow execution:

```typescript
const runtime = createWorkflowRuntime({
  persistence,    // Database operations
  jobQueue,       // Distributed job queue
  registry,       // Workflow definitions
  aiCallLogger,   // AI call tracking (optional)
});

// Start as a worker process
await runtime.start();

// Queue a new workflow run
await runtime.createRun({ workflowId, input, config });

// Create AI helper for a stage
const ai = runtime.createAIHelper("workflow.run-123.stage.extract");
```

### Persistence

The engine uses three persistence interfaces:

| Interface | Purpose |
|-----------|---------|
| `WorkflowPersistence` | Workflow runs, stages, logs, artifacts |
| `JobQueue` | Distributed job queue with priority and retries |
| `AICallLogger` | AI call tracking with cost aggregation |

**Built-in implementations:**
- `createPrismaWorkflowPersistence(prisma)` - PostgreSQL via Prisma
- `createPrismaJobQueue(prisma)` - PostgreSQL with `FOR UPDATE SKIP LOCKED`
- `createPrismaAICallLogger(prisma)` - PostgreSQL

**Prisma version compatibility:**

The persistence layer supports both Prisma 6.x and 7.x. Enum values are automatically resolved based on your Prisma version:

```typescript
import { createPrismaWorkflowPersistence } from "@bratsos/workflow-engine/persistence/prisma";

// Works with both Prisma 6.x (string enums) and Prisma 7.x (typed enums)
const persistence = createPrismaWorkflowPersistence(prisma);
```

For advanced use cases, you can use the enum helper directly:

```typescript
import { createEnumHelper } from "@bratsos/workflow-engine/persistence/prisma";

const enums = createEnumHelper(prisma);
const status = enums.status("PENDING");  // Returns typed enum for Prisma 7.x, string for 6.x
```

---

## Common Patterns

### Accessing Previous Stage Output

Use `ctx.require()` for type-safe access to any previous stage's output:

```typescript
export const analyzeStage = defineStage({
  id: "analyze",
  name: "Analyze Content",

  schemas: {
    input: "none",  // This stage reads from workflowContext
    output: AnalysisOutputSchema,
    config: ConfigSchema,
  },

  async execute(ctx) {
    // Type-safe access to previous stage output
    const extracted = ctx.require("extract-text");  // Throws if missing
    const summary = ctx.optional("summarize");       // Returns undefined if missing

    // Use the data
    console.log(`Analyzing ${extracted.wordCount} words`);

    return {
      output: { /* ... */ },
    };
  },
});
```

> **Important:** Use `input: "none"` for stages that read from `workflowContext` instead of receiving direct input from the previous stage.

### Parallel Execution

Run independent stages concurrently:

```typescript
const workflow = new WorkflowBuilder(/* ... */)
  .pipe(extractStage)
  .parallel([
    sentimentAnalysisStage,  // These three run
    keywordExtractionStage,  // at the same time
    languageDetectionStage,  
  ])
  .pipe(aggregateResultsStage)  // Runs after all parallel stages complete
  .build();
```

In subsequent stages, access parallel outputs by stage ID:

```typescript
async execute(ctx) {
  const sentiment = ctx.require("sentiment-analysis");
  const keywords = ctx.require("keyword-extraction");
  const language = ctx.require("language-detection");
  // ...
}
```

### AI Integration

Use the `AIHelper` for tracked AI calls:

```typescript
import { createAIHelper, type AIHelper } from "@bratsos/workflow-engine";

async execute(ctx) {
  // Create AI helper with topic for cost tracking
  const ai = runtime.createAIHelper(`workflow.${ctx.workflowRunId}.${ctx.stageId}`);

  // Generate text
  const { text, cost, inputTokens, outputTokens } = await ai.generateText(
    "gemini-2.5-flash",
    "Summarize this document: " + ctx.input.text
  );

  // Generate structured object
  const { object: analysis } = await ai.generateObject(
    "gemini-2.5-flash",
    "Analyze this text: " + ctx.input.text,
    z.object({
      sentiment: z.enum(["positive", "negative", "neutral"]),
      topics: z.array(z.string()),
    })
  );

  // Generate embeddings
  const { embedding, dimensions } = await ai.embed(
    "gemini-embedding-001",
    ctx.input.text,
    { dimensions: 768 }
  );

  // All calls are automatically logged with cost tracking
  return { output: { text, analysis, embedding } };
}
```

### Long-Running Batch Jobs

For operations that may take hours (OpenAI Batch API, Google Vertex Batch, etc.):

```typescript
import { defineAsyncBatchStage } from "@bratsos/workflow-engine";

export const batchProcessingStage = defineAsyncBatchStage({
  id: "batch-process",
  name: "Batch Processing",
  mode: "async-batch",  // Required for async stages

  schemas: { input: InputSchema, output: OutputSchema, config: ConfigSchema },

  async execute(ctx) {
    // If we're resuming from suspension, the batch is complete
    if (ctx.resumeState) {
      const results = await fetchBatchResults(ctx.resumeState.batchId);
      return { output: results };
    }

    // First execution: submit the batch job
    const batch = await submitBatchToOpenAI(ctx.input.prompts);

    // Return suspended state - workflow will pause here
    return {
      suspended: true,
      state: {
        batchId: batch.id,
        submittedAt: new Date().toISOString(),
        pollInterval: 3600000,   // 1 hour
        maxWaitTime: 86400000,   // 24 hours
      },
      pollConfig: {
        pollInterval: 3600000,
        maxWaitTime: 86400000,
        nextPollAt: new Date(Date.now() + 3600000),
      },
    };
  },

  // Called by the orchestrator to check if batch is ready
  async checkCompletion(state, ctx) {
    const status = await checkBatchStatus(state.batchId);

    if (status === "completed") {
      return { ready: true };  // Workflow will resume
    }

    if (status === "failed") {
      return { ready: true, error: "Batch processing failed" };
    }

    // Not ready yet - check again later
    return {
      ready: false,
      nextCheckIn: 60000,  // Override poll interval for this check
    };
  },
});
```

### Config Presets

Use built-in config presets for common patterns:

```typescript
import { 
  withAIConfig, 
  withStandardConfig, 
  withFullConfig 
} from "@bratsos/workflow-engine";
import { z } from "zod";

// AI-focused config (model, temperature, maxTokens)
const MyConfigSchema = withAIConfig(z.object({
  customField: z.string(),
}));

// Standard config (AI + concurrency + featureFlags)
const StandardConfigSchema = withStandardConfig(z.object({
  specificOption: z.boolean().default(true),
}));

// Full config (Standard + debug options)
const DebugConfigSchema = withFullConfig(z.object({
  processType: z.string(),
}));
```

---

## Best Practices

### 1. Schema Design

```typescript
// ✅ Good: Strict schemas with descriptions and defaults
const ConfigSchema = z.object({
  modelKey: z.string()
    .default("gemini-2.5-flash")
    .describe("AI model to use for processing"),
  maxRetries: z.number()
    .min(0)
    .max(10)
    .default(3)
    .describe("Maximum retry attempts on failure"),
});

// ❌ Bad: Loose typing
const ConfigSchema = z.object({
  model: z.any(),
  retries: z.number(),
});
```

### 2. Stage Dependencies

```typescript
// ✅ Good: Declare dependencies explicitly
export const analyzeStage = defineStage({
  id: "analyze",
  dependencies: ["extract-text", "summarize"],  // Build-time validation
  schemas: { input: "none", /* ... */ },
  // ...
});

// ❌ Bad: Hidden dependencies
export const analyzeStage = defineStage({
  id: "analyze",
  schemas: { input: SomeSchema, /* ... */ },  // Where does input come from?
  // ...
});
```

### 3. Logging

```typescript
async execute(ctx) {
  // ✅ Good: Structured logging with context
  ctx.log("INFO", "Starting processing", { 
    itemCount: items.length,
    config: ctx.config,
  });

  // ✅ Good: Progress updates for long operations
  for (const [index, item] of items.entries()) {
    ctx.onProgress({
      progress: (index + 1) / items.length,
      message: `Processing item ${index + 1}/${items.length}`,
    });
  }

  // ❌ Bad: Console.log (not persisted)
  console.log("Processing...");
}
```

### 4. Error Handling

```typescript
async execute(ctx) {
  try {
    // Validate early
    if (!ctx.input.url.startsWith("https://")) {
      throw new Error("Only HTTPS URLs are supported");
    }

    const result = await processDocument(ctx.input);
    return { output: result };

  } catch (error) {
    // Log errors with context
    ctx.log("ERROR", "Processing failed", {
      error: error instanceof Error ? error.message : String(error),
      input: ctx.input,
    });

    // Re-throw to mark stage as failed
    throw error;
  }
}
```

### 5. Performance

```typescript
// ✅ Good: Use parallel stages for independent work
.parallel([
  fetchDataFromSourceA,
  fetchDataFromSourceB,
  fetchDataFromSourceC,
])

// ✅ Good: Use batch processing for many AI calls
const results = await ai.batch("gpt-4o").submit(
  items.map((item, i) => ({
    id: `item-${i}`,
    prompt: `Process: ${item}`,
    schema: OutputSchema,
  }))
);

// ❌ Bad: Sequential AI calls when parallel would work
for (const item of items) {
  await ai.generateText("gpt-4o", `Process: ${item}`);
}
```

---

## API Reference

### Core Exports

```typescript
// Stage definition
import { defineStage, defineAsyncBatchStage } from "@bratsos/workflow-engine";

// Workflow building
import { WorkflowBuilder, Workflow } from "@bratsos/workflow-engine";

// Runtime
import { createWorkflowRuntime, WorkflowRuntime } from "@bratsos/workflow-engine";

// Persistence (Prisma)
import {
  createPrismaWorkflowPersistence,
  createPrismaJobQueue,
  createPrismaAICallLogger,
} from "@bratsos/workflow-engine";

// AI Helper
import { createAIHelper, type AIHelper } from "@bratsos/workflow-engine";

// Types
import type {
  WorkflowPersistence,
  JobQueue,
  AICallLogger,
  WorkflowRunRecord,
  WorkflowStageRecord,
} from "@bratsos/workflow-engine";
```

### `createWorkflowRuntime(config)`

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `persistence` | `WorkflowPersistence` | required | Database operations |
| `jobQueue` | `JobQueue` | required | Job queue implementation |
| `registry` | `WorkflowRegistry` | required | Workflow definitions |
| `aiCallLogger` | `AICallLogger` | optional | AI call tracking |
| `pollIntervalMs` | `number` | 10000 | Interval for checking suspended stages |
| `jobPollIntervalMs` | `number` | 1000 | Interval for polling job queue |
| `workerId` | `string` | auto | Unique worker identifier |
| `staleJobThresholdMs` | `number` | 60000 | Time before a job is considered stale |
| `getWorkflowPriority` | `(id: string) => number` | optional | Priority function (1-10, higher = more important) |

### `WorkflowRuntime`

| Method | Description |
|--------|-------------|
| `start()` | Start polling for jobs (runs forever until stopped) |
| `stop()` | Stop the worker gracefully |
| `createRun(options)` | Queue a new workflow run |
| `createAIHelper(topic)` | Create an AI helper bound to the logger |
| `transitionWorkflow(runId)` | Manually transition a workflow to next stage |
| `pollSuspendedStages()` | Manually poll suspended stages |

### `CreateRunOptions`

| Option | Type | Required | Description |
|--------|------|----------|-------------|
| `workflowId` | `string` | yes | ID of the workflow to run |
| `input` | `object` | yes | Input data matching workflow's input schema |
| `config` | `object` | no | Stage configurations keyed by stage ID |
| `priority` | `number` | no | Priority (1-10, overrides `getWorkflowPriority`) |
| `metadata` | `object` | no | Domain-specific metadata |

---

## Troubleshooting

### "Workflow not found in registry"

Ensure the workflow is registered before creating runs:

```typescript
const registry = {
  getWorkflow(id) {
    const workflows = {
      "my-workflow": myWorkflow,  // Add your workflow here
    };
    return workflows[id];
  },
};
```

### "Stage X depends on Y which was not found"

Verify all dependencies are included in the workflow:

```typescript
// If stage "analyze" depends on "extract":
.pipe(extractStage)   // Must be piped before
.pipe(analyzeStage)   // analyze can now access extract's output
```

### Jobs stuck in "PROCESSING"

This usually means a worker crashed. The stale lock recovery will automatically release jobs after `staleJobThresholdMs` (default 60s).

To manually release stale jobs:

```typescript
await jobQueue.releaseStaleJobs(60000);  // Release jobs locked > 60s
```

### AI calls not being tracked

Ensure you pass `aiCallLogger` to the runtime:

```typescript
const runtime = createWorkflowRuntime({
  // ...
  aiCallLogger: createPrismaAICallLogger(prisma),  // Required for tracking
});
```

---

## License

MIT
