---
sidebar_position: 2
title: Batch Operations
---

# Batch Operations

AI batch APIs (such as OpenAI Batch, Anthropic Batch, or Google Batch) offer a **50% discount** on API costs. However, these jobs run asynchronously, often taking anywhere from 10 minutes to 24 hours to execute. 

**workflow-engine** includes first-class support for asynchronously running batch operations. By leveraging the engine's native **suspend/resume** architecture, a workflow stage can submit an AI batch job, release its database lease to suspend the process, and wake up once the provider indicates completion.

---

## The Batch lifecycle

A typical batch stage is defined using `defineAsyncBatchStage`:
1. **`execute` (First Run)**: Submits a list of prompts via `ai.batch(model).submit([...])` and returns `suspended: true` along with the batch ID.
2. **Suspension**: The engine marks the stage as `SUSPENDED` and deletes the active job queue record. No resources are consumed.
3. **Polling**: The host runtime calls `stage.pollSuspended` (triggered via orchestration ticks). This runs `checkCompletion()`, which checks the provider's batch status.
4. **`checkCompletion` (Ready)**: When the provider completes the batch, `checkCompletion` retrieves the results, validates them, and returns `ready: true`.
5. **Resume**: The kernel restores the workflow run to `RUNNING` status and schedules the next downstream stage.

---

## Code Implementation

```typescript
import { defineAsyncBatchStage } from "@bratsos/workflow-engine";
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
    if (ctx.resumeState?.cachedResult) {
      return { output: ctx.resumeState.cachedResult };
    }

    const ai = ctx.createAIHelper(`workflow.${ctx.workflowRunId}.stage.${ctx.stageId}`);
    const batch = ai.batch("gemini-2.5-flash", "google");

    // Submit batch requests to the provider
    const handle = await batch.submit(
      ctx.input.items.map(item => ({
        id: item.id,
        prompt: `Analyze sentiment and extract topics: ${item.feedback}`,
        schema: AnalysisResultSchema // Passes native json_schema to the provider
      }))
    );

    // Suspend the stage execution and save the batch handler state
    return {
      suspended: true,
      state: {
        batchId: handle.id,
        provider: handle.provider,
        modelKey: "gemini-2.5-flash"
      },
      pollConfig: {
        pollInterval: 60_000,      // Check status every 60s
        maxWaitTime: 3600_000 * 2, // Timeout after 2 hours
      }
    };
  },

  async checkCompletion(suspendedState, ctx) {
    const ai = ctx.createAIHelper(`workflow.${ctx.workflowRunId}.stage.${ctx.stageId}`);
    const batch = ai.batch(suspendedState.modelKey, suspendedState.provider);

    const status = await batch.getStatus(suspendedState.batchId);
    
    if (status.status === "processing" || status.status === "pending") {
      return { ready: false }; // Poll again on the next tick
    }

    if (status.status === "failed") {
      return { ready: false, error: "AI provider batch processing failed." };
    }

    // Batch is complete. Retrieve and validate outputs.
    // NOTE: Re-supply the schemas here because the Zod object is not serialized in DB state
    const results = await batch.getResults(suspendedState.batchId, {
      schemas: Object.fromEntries(
        ctx.input.items.map(item => [item.id, AnalysisResultSchema])
      )
    });

    const parsedOutput = results.map(res => {
      if (res.status === "failed") {
        throw new Error(`Item ${res.id} failed validation: ${res.error}`);
      }
      return {
        id: res.id,
        analysis: res.result // Fully typed as z.infer<typeof AnalysisResultSchema>
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

## Discriminated Union Result Types (v0.11+)

In `v0.11`, `AIBatchResult` was updated to a strict **discriminated union** to prevent silent evaluation errors.

```typescript
type AIBatchResult<T> =
  | {
      id: string;
      prompt: string;
      result: T;            // Present ONLY on success
      inputTokens: number;
      outputTokens: number;
      status: "succeeded";
      error?: undefined;
    }
  | {
      id: string;
      prompt: string;
      result?: undefined;   // Under v0.11, this is undefined on failure (not a placeholder object)
      inputTokens: number;
      outputTokens: number;
      status: "failed";
      error: string;        // Present ONLY on failure
    };
```

> [!WARNING]
> Prior to `v0.11`, failed batch results returned an empty placeholder object (`{} as T`) inside the `.result` property. Ensure your code verifies that `res.status === "succeeded"` before accessing `res.result`.

---

## Schema Re-Supply Across Process Boundaries

Zod schemas contain JavaScript functions and regular expressions, which makes them **non-serializable**. 
* When you submit a batch, the Zod schemas are converted to JSON Schema specs for the LLM providers.
* When the stage suspends, only the `suspendedState` JSON is stored in the database.
* When a host process wakes up to resume the stage and calls `batch.getResults()`, it has lost the original Zod schema objects.
* To apply schema parsing and validation during recovery, you must **re-supply the schemas** map (mapping request IDs to their respective Zod schemas) as an option to `batch.getResults(batchId, { schemas })`. If schemas are omitted, the results are returned as unvalidated JSON strings.
