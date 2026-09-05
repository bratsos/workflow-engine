# Async Batch Stages

Complete guide for creating stages that suspend and resume for long-running batch operations.

## Overview

Async batch stages allow workflows to:
1. Submit work to external batch APIs (Google, Anthropic, OpenAI, OpenRouter)
2. Suspend while waiting for completion
3. Resume automatically when results are ready
4. Achieve significant cost savings on large AI workloads (discounted per-model batch pricing)

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

  // Submit to batch API (provider is auto-detected or explicitly specified)
  const ai = createAIHelper(`batch.${ctx.workflowRunId}`, aiLogger);
  const batch = ai.batch("claude-sonnet-4-20250514", "anthropic");
  // Or via OpenRouter with injected credentials:
  // const batch = ai.batch("openai/gpt-4o", "openrouter", { apiKey: ctx.config.openRouterApiKey });
  const handle = await batch.submit(requests);

  // Store metadata for resume
  await ctx.storage.save("batch-metadata", {
    requestCount: requests.length,
    requestIds: requests.map(r => r.id),
  });

  // Return suspended result - persist handle.refs for multi-batch fan-in
  return {
    suspended: true,
    state: {
      batchId: handle.id,
      submittedAt: new Date().toISOString(),
      pollInterval: 60000,      // Check every 60 seconds
      maxWaitTime: 3600000,     // Max 1 hour
      metadata: {
        provider: handle.provider,
        requestCount: requests.length,
        batchRefs: handle.refs,
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
    batchId: string;         // Required: external batch job ID -- the only field you must supply
    submittedAt?: string;    // Optional: ISO timestamp; defaults to now
    pollInterval?: number;   // Optional: ms between checks; defaults to pollConfig.pollInterval or 30s
    maxWaitTime?: number;    // Optional: max wait before timeout; defaults to pollConfig.maxWaitTime or 24h
    metadata?: Record<string, unknown>;  // Custom data
    apiKey?: string;         // Optional: for provider auth
  };

  pollConfig?: {             // Optional (v0.11+): derived automatically from `state` when omitted
    pollInterval: number;    // Milliseconds
    maxWaitTime: number;     // Milliseconds
    nextPollAt: Date;        // First poll time
  };

  customMetrics?: Record<string, number>;  // Optional metrics
}
```

As of v0.11, `pollConfig` is entirely optional and derived from `state` (falling back to a 30s poll interval / 24h max wait) -- `state.batchId` is the only field you must actually compute yourself.

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
  const status = await batch.getStatus(batchId, metadata);

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
  // Get results (pass metadata containing batchRefs for fan-in, and re-supply schemas for validation)
  const results = await batch.getResults(batchId, {
    ...metadata,
    schemas: {
      // Re-supply schemas by requestId because Zod schemas cannot round-trip JSON persistence
      ...Object.fromEntries(requests.map(r => [r.id, ItemResultSchema])),
    },
  });

  // Process results (res.validated is true when schema was re-supplied and validated)
  const processedResults = results.map(r => ({
    id: r.id,
    result: r.result,
    success: r.status === "succeeded",
    validated: r.validated,
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
  onLog: LogFunction;        // Async logging
  log: LogFunction;          // Alias for onLog
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
          provider: handle.provider,
          textCount: texts.length,
          customIds: texts.map(t => t.id),
          batchRefs: handle.refs,
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

    const status = await batch.getStatus(state.batchId, state.metadata);
    await ctx.log("DEBUG", `Batch status: ${status.status}`);

    if (status.status !== "completed") {
      if (status.status === "failed") {
        return { ready: false, error: "Embedding batch failed" };
      }
      return { ready: false, nextCheckIn: 30000 };
    }

    // Get results with metadata for ID mapping and batchRefs resolution
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

Batch processing runs through the AI SDK provider batch interfaces or directly through OpenRouter's Batch API. Supported providers are `"google"`, `"anthropic"`, `"openai"`, and `"openrouter"`.

Batch pricing is model-specific (not a flat 50% discount) and is loaded into `batchInputCostPerMillion` / `batchOutputCostPerMillion` in the model catalog.

### Google

Backed by `@ai-sdk/google` (included by default):

```typescript
const batch = ai.batch("gemini-2.5-flash", "google");
```

### Anthropic

Requires optional peer dependency `@ai-sdk/anthropic` (>=4.0.46):

```typescript
const batch = ai.batch("claude-sonnet-4-20250514", "anthropic");
```

### OpenAI

Requires optional peer dependency `@ai-sdk/openai` (>=4.0.53):

```typescript
const batch = ai.batch("gpt-4o", "openai");
```

### OpenRouter

Direct HTTP transport to OpenRouter Batch API. No vendor SDK required:

```typescript
const batch = ai.batch("openai/gpt-4o", "openrouter", {
  apiKey: process.env.OPENROUTER_API_KEY, // or injected in serverless
});
```

### Batch Options & Injected Credentials

`ai.batch()` accepts an optional `BatchOptions` object as its third parameter:

```typescript
interface BatchOptions {
  apiKey?: string;              // Injected API key (ideal for edge/serverless without process.env)
  baseURL?: string;             // Custom endpoint base URL
  fetch?: typeof globalThis.fetch;
  endpoint?: "/v1/chat/completions" | "/v1/responses" | "/v1/messages" | "/v1/embeddings";
  maxRequestsPerBatch?: number; // Request chunk size per upstream batch (default: 500)
  maxPartitions?: number;       // Maximum allowed partition count (default: 20)
}
```

### Provider Resolution & Auto-Detection

If `provider` is omitted from `ai.batch(modelKey)`, the engine inspects the model key/ID to find a matching provider. If no known batch-capable provider exists for the model, `ai.batch()` **throws an error immediately** with an actionable message directing you to pass an explicit provider.

### OpenRouter Batch Transport Caveats

When using `"openrouter"` batch processing, keep these operational characteristics in mind:
- **Text only:** Image, audio, video, and file multimodal parts are rejected.
- **24-hour expiration without partial recovery:** OpenRouter sets a 24h completion window. If expired, `results` returns `null` and **no partial results are recoverable**. To bound risk, `workflow-engine` automatically caps each batch at `maxRequestsPerBatch` (default: 500).
- **No cancel or list endpoint:** OpenRouter batch API does not support cancelling in-flight batches or listing batches.
- **No idempotency key:** POST submissions are not auto-retried on network failures.
- **Schema partitioning:** Google models require every request in a batch to share the same response schema. `batch.submit()` automatically partitions requests by `(endpoint, modelId, schema)` to satisfy this constraint.

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

**As of v0.11, `maxWaitTime` is actually enforced** -- before v0.11 it was accepted but silently ignored, so a suspended stage would poll forever regardless of the value you set. If any of your stages relied on that (an implicit "poll forever"), they will now time out and fail once `maxWaitTime` elapses; audit values that were set low "because it didn't matter."

The manual check below inside `checkCompletion` is now belt-and-suspenders rather than the only enforcement (note: OpenRouter batch does not support remote cancellation):

```typescript
// In checkCompletion, check for timeout
const startTime = new Date(state.submittedAt).getTime();
const elapsed = Date.now() - startTime;

if (elapsed > state.maxWaitTime) {
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
    const status = await batch.getStatus(state.batchId, state.metadata);
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

## Inspecting a Batch Outside a Stage

An admin page or a CLI can check a batch without going through `ai.batch()`, using the same engine models the batch helper uses. Persist `handle.refs` at submit time; each ref names its provider and model.

```typescript
import {
  createOpenRouterBatchModel,
  resolveAiSdkBatchModel,
  type EngineBatchRef,
} from "@bratsos/workflow-engine";

async function inspect(ref: EngineBatchRef) {
  const model =
    ref.provider === "openrouter"
      ? createOpenRouterBatchModel({ apiKey: process.env.OPENROUTER_API_KEY!, modelId: ref.modelId })
      : await resolveAiSdkBatchModel(ref.provider as "google" | "anthropic" | "openai", ref.modelId);
  return model.status(ref); // { status, rawStatus, requestCounts, error }
}
```

This replaces hand-rolled status checks against the vendor SDKs — the status mapping is the engine's, so it cannot drift from what a running stage sees.

