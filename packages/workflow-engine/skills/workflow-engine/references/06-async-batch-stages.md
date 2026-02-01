# Async Batch Stages

Complete guide for creating stages that suspend and resume for long-running batch operations.

## Overview

Async batch stages allow workflows to:
1. Submit work to external batch APIs (Anthropic, Google, OpenAI)
2. Suspend while waiting for completion
3. Resume automatically when results are ready
4. Achieve 50% cost savings on large AI workloads

## Creating an Async Batch Stage

```typescript
import { defineAsyncBatchStage } from "@bratsos/workflow-engine";
import { z } from "zod";

const batchStage = defineAsyncBatchStage({
  id: "batch-process",
  name: "Batch Process",
  mode: "async-batch",  // Required marker

  schemas: {
    input: InputSchema,
    output: OutputSchema,
    config: ConfigSchema,
  },

  // Called when stage starts OR resumes
  async execute(ctx) {
    // Check if resuming from suspension
    if (ctx.resumeState) {
      // Stage was suspended, resumeState contains cached data
      return handleResume(ctx);
    }

    // First execution - submit batch and suspend
    return submitAndSuspend(ctx);
  },

  // Called by orchestrator to check batch status
  async checkCompletion(suspendedState, ctx) {
    return checkBatchStatus(suspendedState, ctx);
  },
});
```

## Execute Function

The `execute` function handles both initial execution and resume:

```typescript
async execute(ctx) {
  // ===================
  // Resume Path
  // ===================
  if (ctx.resumeState) {
    // Check for cached results
    const cached = await ctx.storage.load("batch-result");
    if (cached) {
      return { output: cached };
    }

    // If no cache, the checkCompletion already saved results
    // This path shouldn't normally be hit
    throw new Error("Resume called but no cached results found");
  }

  // ===================
  // Initial Execution
  // ===================

  // Get data from previous stages
  const extraction = ctx.require("data-extraction");

  // Prepare batch requests
  const requests = extraction.items.map((item, i) => ({
    id: `item-${i}`,
    prompt: `Process this item: ${JSON.stringify(item)}`,
    // Optional: include schema for structured output
    schema: ItemResultSchema,
  }));

  // Submit to batch API
  const ai = createAIHelper(`batch.${ctx.workflowRunId}`, aiLogger);
  const batch = ai.batch("claude-sonnet-4-20250514", "anthropic");
  const handle = await batch.submit(requests);

  // Store metadata for resume
  await ctx.storage.save("batch-metadata", {
    requestCount: requests.length,
    requestIds: requests.map(r => r.id),
  });

  // Return suspended result
  return {
    suspended: true,
    state: {
      batchId: handle.id,
      submittedAt: new Date().toISOString(),
      pollInterval: 60000,      // Check every 60 seconds
      maxWaitTime: 3600000,     // Max 1 hour
      metadata: {
        provider: "anthropic",
        requestCount: requests.length,
      },
    },
    pollConfig: {
      pollInterval: 60000,
      maxWaitTime: 3600000,
      nextPollAt: new Date(Date.now() + 60000),
    },
  };
}
```

## SimpleSuspendedResult Structure

```typescript
interface SimpleSuspendedResult {
  suspended: true;           // Required marker

  state: {
    batchId: string;         // External batch job ID
    submittedAt: string;     // ISO timestamp
    pollInterval: number;    // Milliseconds between checks
    maxWaitTime: number;     // Maximum wait before timeout
    metadata?: Record<string, unknown>;  // Custom data
    apiKey?: string;         // Optional: for provider auth
  };

  pollConfig: {
    pollInterval: number;    // Milliseconds
    maxWaitTime: number;     // Milliseconds
    nextPollAt: Date;        // First poll time
  };

  customMetrics?: Record<string, number>;  // Optional metrics
}
```

## Check Completion Function

The `checkCompletion` function is called by the orchestrator:

```typescript
async checkCompletion(suspendedState, ctx) {
  // suspendedState contains the state from SimpleSuspendedResult
  const { batchId, metadata } = suspendedState;

  // Create AI helper for batch operations
  const ai = createAIHelper(`batch.${ctx.workflowRunId}`, aiLogger);
  const batch = ai.batch(ctx.config.model, metadata?.provider as "anthropic");

  // Check batch status
  const status = await batch.getStatus(batchId);

  // ===================
  // Still Processing
  // ===================
  if (status.status === "pending" || status.status === "processing") {
    return {
      ready: false,
      nextCheckIn: 60000,  // Check again in 60 seconds
    };
  }

  // ===================
  // Failed
  // ===================
  if (status.status === "failed") {
    return {
      ready: false,
      error: `Batch ${batchId} failed`,
    };
  }

  // ===================
  // Completed
  // ===================
  // Get results
  const results = await batch.getResults(batchId, metadata);

  // Process results
  const processedResults = results.map(r => ({
    id: r.id,
    result: r.result,
    success: r.status === "succeeded",
    error: r.error,
  }));

  // Calculate metrics
  const totalInputTokens = results.reduce((sum, r) => sum + r.inputTokens, 0);
  const totalOutputTokens = results.reduce((sum, r) => sum + r.outputTokens, 0);

  // Cache results for potential resume
  await ctx.storage.save("batch-result", { items: processedResults });

  // Return completed result
  return {
    ready: true,
    output: { items: processedResults },
    metrics: {
      inputTokens: totalInputTokens,
      outputTokens: totalOutputTokens,
      itemsProcessed: processedResults.length,
      successCount: processedResults.filter(r => r.success).length,
    },
  };
}
```

## CompletionCheckResult Structure

```typescript
interface CompletionCheckResult<TOutput> {
  ready: boolean;            // Is batch complete?

  // If ready === true
  output?: TOutput;          // Stage output
  metrics?: Record<string, number>;
  embeddings?: unknown;      // Optional embedding info

  // If ready === false
  error?: string;            // Failure reason (stops workflow)
  nextCheckIn?: number;      // Milliseconds until next check
}
```

## CheckCompletionContext

```typescript
interface CheckCompletionContext<TConfig> {
  workflowRunId: string;     // Current workflow run
  stageId: string;           // Current stage ID
  stageRecordId: string;     // Database record ID (for LogContext)
  config: TConfig;           // Stage configuration
  log: LogFunction;          // Async logging
  onLog: LogFunction;        // Alias for log
  storage: StageStorage;     // Artifact storage
}
```

## Complete Example: Batch Embedding Stage

```typescript
const batchEmbeddingStage = defineAsyncBatchStage({
  id: "batch-embeddings",
  name: "Generate Embeddings",
  mode: "async-batch",
  dependencies: ["data-extraction"],

  schemas: {
    input: "none",
    output: z.object({
      embeddings: z.array(z.object({
        id: z.string(),
        vector: z.array(z.number()),
      })),
      totalTokens: z.number(),
    }),
    config: z.object({
      model: z.string().default("text-embedding-004"),
      batchSize: z.number().default(100),
    }),
  },

  async execute(ctx) {
    // Handle resume
    if (ctx.resumeState) {
      const cached = await ctx.storage.load<{ embeddings: any[] }>("embeddings");
      if (cached) {
        return { output: { embeddings: cached.embeddings, totalTokens: 0 } };
      }
    }

    // Get texts to embed
    const extraction = ctx.require("data-extraction");
    const texts = extraction.sections.map((s, i) => ({
      id: `section-${i}`,
      text: s.content,
    }));

    // Submit batch
    const ai = createAIHelper(`batch.${ctx.workflowRunId}`, aiLogger);
    const batch = ai.batch<number[]>(ctx.config.model, "google");

    const requests = texts.map(t => ({
      id: t.id,
      prompt: t.text,
    }));

    const handle = await batch.submit(requests);

    await ctx.log("INFO", `Submitted ${texts.length} texts for embedding`);

    return {
      suspended: true,
      state: {
        batchId: handle.id,
        submittedAt: new Date().toISOString(),
        pollInterval: 30000,
        maxWaitTime: 1800000,  // 30 minutes
        metadata: {
          textCount: texts.length,
          customIds: texts.map(t => t.id),
        },
      },
      pollConfig: {
        pollInterval: 30000,
        maxWaitTime: 1800000,
        nextPollAt: new Date(Date.now() + 30000),
      },
    };
  },

  async checkCompletion(state, ctx) {
    const ai = createAIHelper(`batch.${ctx.workflowRunId}`, aiLogger);
    const batch = ai.batch<number[]>(ctx.config.model, "google");

    const status = await batch.getStatus(state.batchId);
    await ctx.log("DEBUG", `Batch status: ${status.status}`);

    if (status.status !== "completed") {
      if (status.status === "failed") {
        return { ready: false, error: "Embedding batch failed" };
      }
      return { ready: false, nextCheckIn: 30000 };
    }

    // Get results with metadata for ID mapping
    const results = await batch.getResults(state.batchId, state.metadata);

    const embeddings = results
      .filter(r => r.status === "succeeded")
      .map(r => ({
        id: r.id,
        vector: r.result,
      }));

    const totalTokens = results.reduce((sum, r) => sum + r.inputTokens, 0);

    // Cache for resume
    await ctx.storage.save("embeddings", { embeddings });

    await ctx.log("INFO", `Generated ${embeddings.length} embeddings`);

    return {
      ready: true,
      output: { embeddings, totalTokens },
      metrics: {
        embeddingsGenerated: embeddings.length,
        totalTokens,
      },
    };
  },
});
```

## Batch Providers

### Anthropic

```typescript
const batch = ai.batch("claude-sonnet-4-20250514", "anthropic");
// 50% discount, results in ~24 hours
```

### Google

```typescript
const batch = ai.batch("gemini-2.5-flash", "google");
// 50% discount, results typically faster
```

### OpenAI

```typescript
const batch = ai.batch("gpt-4o", "openai");
// 50% discount
```

## Polling Configuration

### Quick Jobs (< 10 minutes)

```typescript
pollConfig: {
  pollInterval: 15000,      // Check every 15 seconds
  maxWaitTime: 600000,      // Max 10 minutes
  nextPollAt: new Date(Date.now() + 15000),
}
```

### Medium Jobs (10 minutes - 1 hour)

```typescript
pollConfig: {
  pollInterval: 60000,      // Check every minute
  maxWaitTime: 3600000,     // Max 1 hour
  nextPollAt: new Date(Date.now() + 60000),
}
```

### Long Jobs (1+ hours)

```typescript
pollConfig: {
  pollInterval: 300000,     // Check every 5 minutes
  maxWaitTime: 86400000,    // Max 24 hours
  nextPollAt: new Date(Date.now() + 300000),
}
```

## Error Handling

### Timeout Handling

The runtime automatically fails stages that exceed `maxWaitTime`:

```typescript
// In checkCompletion, check for timeout
const startTime = new Date(state.submittedAt).getTime();
const elapsed = Date.now() - startTime;

if (elapsed > state.maxWaitTime) {
  // Cancel batch if possible
  await cancelBatch(state.batchId);

  return {
    ready: false,
    error: `Batch timeout after ${elapsed}ms`,
  };
}
```

### Partial Failures

Handle individual request failures gracefully:

```typescript
const results = await batch.getResults(batchId);

const succeeded = results.filter(r => r.status === "succeeded");
const failed = results.filter(r => r.status === "failed");

if (failed.length > 0) {
  await ctx.log("WARN", `${failed.length} requests failed`, {
    failedIds: failed.map(f => f.id),
  });
}

// Decide: fail the stage or continue with partial results
if (succeeded.length === 0) {
  return { ready: false, error: "All batch requests failed" };
}

return {
  ready: true,
  output: { results: succeeded.map(r => r.result) },
};
```

### Retry Logic

Implement custom retry for transient failures:

```typescript
async checkCompletion(state, ctx) {
  try {
    const status = await batch.getStatus(state.batchId);
    // ... handle status
  } catch (error) {
    // Transient error - retry on next poll
    if (isTransientError(error)) {
      await ctx.log("WARN", "Transient error checking batch", { error: error.message });
      return { ready: false, nextCheckIn: 30000 };
    }

    // Permanent error
    return { ready: false, error: error.message };
  }
}
```

## Storage Patterns

### Caching Results

```typescript
// In checkCompletion, cache before returning
await ctx.storage.save("batch-results", processedResults);

// In execute resume path
if (ctx.resumeState) {
  const cached = await ctx.storage.load("batch-results");
  if (cached) return { output: cached };
}
```

### Storing Metadata

```typescript
// Save metadata during submission
await ctx.storage.save("batch-metadata", {
  requestCount: requests.length,
  requestIds: requests.map(r => r.id),
  customData: { ... },
});

// Retrieve in checkCompletion
const metadata = await ctx.storage.load("batch-metadata");
```
