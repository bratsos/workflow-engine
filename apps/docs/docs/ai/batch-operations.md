---
sidebar_position: 2
title: Batch Operations
---

# Batch Operations

AI batch APIs (such as Google Batch, Anthropic Batch, OpenAI Batch, or OpenRouter Batch) offer substantial cost discounts for non-realtime workloads. However, these jobs run asynchronously, taking anywhere from minutes to 24 hours to execute.

**workflow-engine** includes first-class support for asynchronously running batch operations. By leveraging the engine's native **suspend/resume** architecture, a workflow stage can submit an AI batch job, release its database lease to suspend the process, and wake up once the provider indicates completion.

---

## The Batch Lifecycle

A typical batch stage is defined using `defineAsyncBatchStage`:
1. **`execute` (First Run)**: Submits a list of prompts via `ai.batch(model).submit([...])` and returns `suspended: true` along with the primary batch ID and versioned batch refs in `metadata.batchRefs`.
2. **Suspension**: The engine marks the stage as `SUSPENDED` and deletes the active job queue record. No server resources are consumed.
3. **Polling**: The host runtime calls `stage.pollSuspended` (triggered via orchestration ticks). This runs `checkCompletion()`, which checks the provider's batch status.
4. **`checkCompletion` (Ready)**: When the provider completes the batch, `checkCompletion` retrieves results via `getResults(batchId, metadata)` (with schemas re-supplied for validation) and returns `ready: true`.
5. **Resume**: The kernel restores the workflow run to `RUNNING` status and schedules downstream stages.

---

## Code Implementation

```typescript
import { defineAsyncBatchStage, createAIHelper } from "@bratsos/workflow-engine";
import { z } from "zod";

const FeedbackItemSchema = z.object({
  id: z.string(),
  feedback: z.string()
});

const AnalysisResultSchema = z.object({
  sentiment: z.enum(["positive", "negative"]),
  topics: z.array(z.string())
});

export const batchAnalysisStage = defineAsyncBatchStage({
  id: "batch-analysis",
  name: "Batch Analysis",
  mode: "async-batch",
  schemas: {
    input: z.object({ items: z.array(FeedbackItemSchema) }),
    output: z.array(
      z.object({
        id: z.string(),
        analysis: AnalysisResultSchema
      })
    ),
    config: z.object({}),
  },

  async execute(ctx) {
    // If we already have the cached output, return immediately
    if (ctx.resumeState) {
      return { output: await ctx.storage.load("batch-result") };
    }

    const ai = createAIHelper(`workflow.${ctx.workflowRunId}.stage.${ctx.stageId}`, aiCallLogger);
    const batch = ai.batch("gemini-2.5-flash", "google");

    // Submit batch requests to the provider
    const handle = await batch.submit(
      ctx.input.items.map(item => ({
        id: item.id,
        prompt: `Analyze sentiment and extract topics: ${item.feedback}`,
        schema: AnalysisResultSchema // Passes native json_schema to the provider
      }))
    );

    // Suspend stage execution and save the batch handle state
    return {
      suspended: true,
      state: {
        batchId: handle.id,
        metadata: {
          provider: handle.provider,
          modelKey: "gemini-2.5-flash",
          batchRefs: handle.refs,
          requestIds: ctx.input.items.map(item => item.id),
        },
      },
      pollConfig: {
        pollInterval: 60_000,      // Check status every 60s
        maxWaitTime: 3600_000 * 2, // Timeout after 2 hours
      }
    };
  },

  async checkCompletion(suspendedState, ctx) {
    const ai = createAIHelper(`workflow.${ctx.workflowRunId}.stage.${ctx.stageId}`, aiCallLogger);
    const batch = ai.batch(
      suspendedState.metadata?.modelKey as string,
      suspendedState.metadata?.provider as any
    );

    const status = await batch.getStatus(suspendedState.batchId);
    
    if (status.status === "processing" || status.status === "pending") {
      return { ready: false }; // Poll again on the next tick
    }

    if (status.status === "failed") {
      return { ready: false, error: "AI provider batch processing failed." };
    }

    // Batch is complete. Retrieve and validate outputs.
    // NOTE: Re-supply the schemas here because Zod schemas do not round-trip DB JSON state
    const requestIds = (suspendedState.metadata?.requestIds as string[]) ?? [];
    const results = await batch.getResults(suspendedState.batchId, {
      ...suspendedState.metadata,
      schemas: Object.fromEntries(
        requestIds.map(id => [id, AnalysisResultSchema])
      )
    });

    const parsedOutput = results.map(res => {
      if (res.status === "failed") {
        throw new Error(`Item ${res.id} failed: ${res.error}`);
      }
      return {
        id: res.id,
        analysis: res.result // Validated and typed as z.infer<typeof AnalysisResultSchema>
      };
    });

    return {
      ready: true,
      output: parsedOutput
    };
  }
});
```

---

## Batch Providers & Options

Batch execution supports four providers:

| Provider | Description | Required Dependencies |
|----------|-------------|-----------------------|
| `google` | Gemini models via AI SDK | `@ai-sdk/google` (included by default) |
| `anthropic` | Claude models via AI SDK | `@ai-sdk/anthropic` (optional peer >=4.0.46) |
| `openai` | OpenAI models via AI SDK | `@ai-sdk/openai` (optional peer >=4.0.53) |
| `openrouter` | OpenRouter Batch API (HTTP) | None (direct fetch) |

> **Pricing:** Batch pricing is per-model (stored in `batchInputCostPerMillion` and `batchOutputCostPerMillion` in the catalog), not a flat 50% discount. Many models offer 50% to 75% discounts, while some variants may differ.

### Injected Options (`BatchOptions`)

When running in edge or serverless environments where `process.env` may not exist, pass `BatchOptions` as the third parameter to `ai.batch()`:

```typescript
const batch = ai.batch("openai/gpt-4o", "openrouter", {
  apiKey: ctx.config.openRouterApiKey,
  baseURL: "https://openrouter.ai/api/beta",
  maxRequestsPerBatch: 500,
});
```

### OpenRouter Batch Transport Caveats

- **Text only:** Multimodal inputs (images, audio, video, files) are rejected.
- **24-hour expiration without partial recovery:** OpenRouter returns `results: null` if a batch expires at 24 hours. No partial results are recoverable. Batches are automatically partitioned into chunks of `maxRequestsPerBatch` (default: 500) to bound risk.
- **No cancel or list endpoint:** OpenRouter batch API does not support remote cancellation or listing batches.
- **No idempotency key:** POST submissions are not auto-retried.
- **Schema partitioning:** Google models require all requests in a single batch to share the same response schema; `submit()` handles this by partitioning requests by schema automatically.

---

## Discriminated Union Result Types

`AIBatchResult` is a strict **discriminated union**:

```typescript
type AIBatchResult<T = string> =
  | {
      id: string;
      prompt: string;
      result: T;            // Present ONLY on success (unvalidated unless schema was re-supplied)
      inputTokens: number;
      outputTokens: number;
      status: "succeeded";
      error?: undefined;
      validated?: boolean;  // True when validated against re-supplied schema; false otherwise
    }
  | {
      id: string;
      prompt: string;
      result?: undefined;   // Undefined on failure
      inputTokens: number;
      outputTokens: number;
      status: "failed";
      error: string;        // Error message describing failure
      validated?: boolean;  // Always false on failure
    };
```

---

## Schema Re-Supply Across Process Boundaries

Zod schemas contain JavaScript functions and regular expressions, which makes them **non-serializable**:
* When you submit a batch, the Zod schemas are converted to JSON Schema specs for the LLM providers.
* When the stage suspends, only JSON-serializable `suspendedState` is stored in the database.
* When a host process wakes up to resume the stage and calls `batch.getResults()`, it has lost the original Zod schema objects.
* To apply schema parsing and validation during recovery, you must **re-supply the schemas** map via `batch.getResults(batchId, { schemas: { [requestId]: schema } })`.
* If schemas are omitted at retrieval time, results return with `validated: false` and a `WARN` is logged. Re-supplying schemas ensures `validated: true` and validates outputs against your Zod types.
