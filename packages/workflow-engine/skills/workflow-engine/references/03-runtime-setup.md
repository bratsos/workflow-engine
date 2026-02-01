# Runtime Setup

Complete guide for configuring and running WorkflowRuntime.

## Creating a Runtime

```typescript
import { createWorkflowRuntime } from "@bratsos/workflow-engine";
import {
  createPrismaWorkflowPersistence,
  createPrismaJobQueue,
  createPrismaAICallLogger,
} from "@bratsos/workflow-engine/persistence/prisma";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

// PostgreSQL (default)
const runtime = createWorkflowRuntime({
  // Required
  persistence: createPrismaWorkflowPersistence(prisma),
  jobQueue: createPrismaJobQueue(prisma),
  registry: {
    getWorkflow: (id) => workflowMap[id] ?? null,
  },

  // Optional
  aiCallLogger: createPrismaAICallLogger(prisma),
  pollIntervalMs: 10000,
  jobPollIntervalMs: 1000,
  staleJobThresholdMs: 60000,
  workerId: "worker-1",
  getWorkflowPriority: (id) => priorityMap[id] ?? 5,
});

// SQLite - pass databaseType to persistence and job queue
const runtime = createWorkflowRuntime({
  persistence: createPrismaWorkflowPersistence(prisma, { databaseType: "sqlite" }),
  jobQueue: createPrismaJobQueue(prisma, { databaseType: "sqlite" }),
  registry: { getWorkflow: (id) => workflowMap[id] ?? null },
  aiCallLogger: createPrismaAICallLogger(prisma),
});
```

## WorkflowRuntimeConfig

```typescript
interface WorkflowRuntimeConfig {
  /** Persistence implementation (required) */
  persistence: WorkflowPersistence;

  /** Job queue implementation (required) */
  jobQueue: JobQueue;

  /** Workflow registry (required) */
  registry: WorkflowRegistry;

  /** AI call logger for createAIHelper (optional) */
  aiCallLogger?: AICallLogger;

  /** Orchestration poll interval in ms (default: 10000) */
  pollIntervalMs?: number;

  /** Job dequeue interval in ms (default: 1000) */
  jobPollIntervalMs?: number;

  /** Worker ID (default: auto-generated) */
  workerId?: string;

  /** Stale job threshold in ms (default: 60000) */
  staleJobThresholdMs?: number;

  /** Function to determine workflow priority */
  getWorkflowPriority?: (workflowId: string) => number;
}
```

## WorkflowRegistry

The registry maps workflow IDs to workflow definitions:

```typescript
interface WorkflowRegistry {
  getWorkflow(workflowId: string): Workflow<any, any, any> | null;
}

// Simple implementation
const registry: WorkflowRegistry = {
  getWorkflow: (id) => {
    const workflows = {
      "document-analysis": documentAnalysisWorkflow,
      "data-processing": dataProcessingWorkflow,
    };
    return workflows[id] ?? null;
  },
};

// With type safety
const workflowMap: Record<string, Workflow<any, any, any>> = {
  "document-analysis": documentAnalysisWorkflow,
  "data-processing": dataProcessingWorkflow,
};

const registry: WorkflowRegistry = {
  getWorkflow: (id) => workflowMap[id] ?? null,
};
```

## Lifecycle Methods

### start()

Start the runtime as a worker that processes jobs and polls for state changes.

```typescript
await runtime.start();
// Runtime is now:
// - Polling for pending workflows
// - Processing jobs from the queue
// - Checking suspended stages
// - Handling graceful shutdown on SIGTERM/SIGINT
```

### stop()

Stop the runtime gracefully.

```typescript
runtime.stop();
// Stops polling and job processing
// Current job completes before stopping
```

## Creating and Running Workflows

### createRun(options)

Create a new workflow run. The runtime picks it up automatically on the next poll.

```typescript
interface CreateRunOptions {
  workflowId: string;                    // Required
  input: Record<string, unknown>;        // Required
  config?: Record<string, unknown>;      // Optional
  priority?: number;                     // Optional (default: 5)
  metadata?: Record<string, unknown>;    // Optional domain-specific data
}

const { workflowRunId } = await runtime.createRun({
  workflowId: "document-analysis",
  input: { documentUrl: "https://example.com/doc.pdf" },
  config: {
    extract: { maxLength: 5000 },
  },
  priority: 8,  // Higher = more important
  metadata: {
    userId: "user-123",
    requestId: "req-456",
  },
});
```

The method:
1. Validates the workflow exists in the registry
2. Validates input against the workflow's input schema
3. Merges provided config with workflow defaults
4. Validates merged config against all stage config schemas
5. Creates a WorkflowRun record with status PENDING

### transitionWorkflow(workflowRunId)

Manually trigger workflow state transition (usually handled automatically).

```typescript
await runtime.transitionWorkflow(workflowRunId);
```

### pollSuspendedStages()

Manually check suspended stages (usually handled automatically).

```typescript
await runtime.pollSuspendedStages();
```

## AI Helper Integration

### createAIHelper(topic, logContext?)

Create an AIHelper bound to the runtime's logger.

```typescript
// Simple usage
const ai = runtime.createAIHelper("my-task");

// With log context (for batch operations)
const logContext = runtime.createLogContext(workflowRunId, stageRecordId);
const ai = runtime.createAIHelper(`workflow.${workflowRunId}`, logContext);
```

### createLogContext(workflowRunId, stageRecordId)

Create a log context for AIHelper (enables batch logging to persistence).

```typescript
const logContext = runtime.createLogContext(workflowRunId, stageRecordId);
// { workflowRunId, stageRecordId, createLog: fn }
```

## Complete Setup Example

```typescript
import {
  createWorkflowRuntime,
  WorkflowBuilder,
  defineStage,
} from "@bratsos/workflow-engine";
import {
  createPrismaWorkflowPersistence,
  createPrismaJobQueue,
  createPrismaAICallLogger,
} from "@bratsos/workflow-engine/persistence/prisma";
import { PrismaClient } from "@prisma/client";
import { z } from "zod";

// Initialize Prisma
const prisma = new PrismaClient();

// Define stages
const helloStage = defineStage({
  id: "hello",
  name: "Hello Stage",
  schemas: {
    input: z.object({ name: z.string() }),
    output: z.object({ greeting: z.string() }),
    config: z.object({ prefix: z.string().default("Hello") }),
  },
  async execute(ctx) {
    return {
      output: { greeting: `${ctx.config.prefix}, ${ctx.input.name}!` },
    };
  },
});

// Build workflow
const helloWorkflow = new WorkflowBuilder(
  "hello-workflow",
  "Hello Workflow",
  "A simple greeting workflow",
  z.object({ name: z.string() }),
  z.object({ greeting: z.string() })
)
  .pipe(helloStage)
  .build();

// Create registry
const registry = {
  getWorkflow: (id: string) => {
    if (id === "hello-workflow") return helloWorkflow;
    return null;
  },
};

// Create runtime
const runtime = createWorkflowRuntime({
  persistence: createPrismaWorkflowPersistence(prisma),
  jobQueue: createPrismaJobQueue(prisma),
  aiCallLogger: createPrismaAICallLogger(prisma),
  registry,
  pollIntervalMs: 5000,
  jobPollIntervalMs: 500,
});

// Start runtime
async function main() {
  console.log("Starting runtime...");
  await runtime.start();

  // Create a workflow run
  const { workflowRunId } = await runtime.createRun({
    workflowId: "hello-workflow",
    input: { name: "World" },
  });

  console.log(`Created workflow run: ${workflowRunId}`);

  // Runtime will automatically:
  // 1. Pick up the pending workflow
  // 2. Enqueue the first stage
  // 3. Execute the stage
  // 4. Mark workflow as completed
}

main().catch(console.error);

// Graceful shutdown
process.on("SIGTERM", () => {
  runtime.stop();
  prisma.$disconnect();
});
```

## Worker Deployment Patterns

### Single Worker

```typescript
// worker.ts
const runtime = createWorkflowRuntime({ ... });
await runtime.start();
```

### Multiple Workers (Horizontal Scaling)

```typescript
// Each worker gets a unique ID
const workerId = `worker-${process.env.POD_NAME || process.pid}`;

const runtime = createWorkflowRuntime({
  ...config,
  workerId,
});

await runtime.start();
// Workers compete for jobs using atomic dequeue
// Each job is processed by exactly one worker
```

### API Server + Separate Workers

```typescript
// api-server.ts - Only creates runs, doesn't process
const runtime = createWorkflowRuntime({ ...config });
// Don't call runtime.start()

app.post("/workflows/:id/runs", async (req, res) => {
  const { workflowRunId } = await runtime.createRun({
    workflowId: req.params.id,
    input: req.body,
  });
  res.json({ workflowRunId });
});

// worker.ts - Only processes, doesn't create
const runtime = createWorkflowRuntime({ ...config });
await runtime.start();
```

## Configuration Recommendations

### Development

```typescript
const runtime = createWorkflowRuntime({
  ...config,
  pollIntervalMs: 2000,      // Fast polling for development
  jobPollIntervalMs: 500,    // Quick job pickup
  staleJobThresholdMs: 30000, // Short timeout
});
```

### Production

```typescript
const runtime = createWorkflowRuntime({
  ...config,
  pollIntervalMs: 10000,      // Standard polling
  jobPollIntervalMs: 1000,    // Balance between latency and DB load
  staleJobThresholdMs: 60000, // Allow for longer processing
  workerId: `worker-${process.env.HOSTNAME}`,
});
```

### High-Throughput

```typescript
const runtime = createWorkflowRuntime({
  ...config,
  pollIntervalMs: 5000,       // More frequent orchestration
  jobPollIntervalMs: 100,     // Aggressive job pickup
  staleJobThresholdMs: 120000, // Longer timeout for long jobs
});
```

## Monitoring

The runtime logs key events to console:

```
[Runtime] Starting worker worker-12345-hostname
[Runtime] Poll interval: 10000ms, Job poll: 1000ms
[Runtime] Created WorkflowRun abc123 for document-analysis
[Runtime] Found 1 pending workflows
[Runtime] Started workflow abc123
[Runtime] Processing stage extract for workflow abc123
[Runtime] Worker worker-12345-hostname: processed 10 jobs
[Runtime] Workflow abc123 completed
```

For production monitoring, integrate with your observability stack:

```typescript
// Custom logging
const originalLog = console.log;
console.log = (...args) => {
  if (args[0]?.includes("[Runtime]")) {
    metrics.increment("workflow.runtime.log");
    logger.info(args.join(" "));
  }
  originalLog(...args);
};
```
