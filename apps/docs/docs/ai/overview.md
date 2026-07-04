---
sidebar_position: 1
title: AI Overview
---

# AI Overview

**workflow-engine** features native, type-safe AI integration. At its core, the **`AIHelper`** interface wraps the standard AI SDK to handle text generation, structured outputs, streaming, and embeddings, while automatically logging calls and tracking token usage/pricing.

---

## Creating the AIHelper

You initialize an `AIHelper` by passing a hierarchical cost-tracking topic and an `AICallLogger` implementation.

```typescript
import { createAIHelper } from "@bratsos/workflow-engine";
import { createPrismaAICallLogger } from "@bratsos/workflow-engine/persistence/prisma";

const aiCallLogger = createPrismaAICallLogger(prisma);

// Inside a stage's execute() function
async execute(ctx) {
  const ai = createAIHelper(
    `workflow.${ctx.workflowRunId}.stage.${ctx.stageId}`,
    aiCallLogger
  );
  
  // Now all AI calls will automatically log tokens and calculate cost
}
```

---

## Hierarchical Cost Tracking

AI tokens and dollar costs are tracked using dot-delimited **Topics**. The standard naming convention is:

```
workflow.{workflowRunId}.stage.{stageId}.{optional-tool-suffix}
```

This hierarchical structure allows you to query and aggregate pricing stats at different granularities via `AICallLogger.getStats(topicPrefix)` (which performs an optimized prefix range match):

```typescript
// 1. Get cost stats for a single stage
const stageStats = await aiCallLogger.getStats("workflow.run-123.stage.extraction");

// 2. Get total cost stats for an entire run (aggregating all stages)
const runStats = await aiCallLogger.getStats("workflow.run-123");

// 3. Get total cost stats across ALL workflows in the database
const totalSystemStats = await aiCallLogger.getStats("workflow");
```

### Automatic Run Cost Aggregation
When a workflow run completes, the kernel automatically queries stats for `workflow.${runId}`, aggregates the total cost and tokens, and updates the `totalCost` and `totalTokens` columns in the `WorkflowRun` table.

---

## Core Operations

### 1. `generateText`
Sends a prompt and returns the generated text alongside cost and token usage data.

```typescript
const result = await ai.generateText(
  "gemini-2.5-flash", 
  "Summarize this input text: ...",
  {
    temperature: 0.5,
    maxTokens: 1000,
    maxRetries: 3,                 // v0.11+: passes retries directly to provider SDK
    abortSignal: controller.signal // v0.11+: abort support
  }
);

console.log(result.text);         // The generated string
console.log(result.cost);         // Calculated USD cost (e.g. 0.00015)
console.log(result.inputTokens);  // Input token count
```

#### Multimodal Input
You can pass an array containing text and image/document buffers to `generateText`:
```typescript
const result = await ai.generateText("gemini-2.5-flash", [
  { type: "text", text: "Transcribe the hand-written notes in this document" },
  { type: "file", data: documentBuffer, mediaType: "application/pdf" }
]);
```

### 2. `generateObject`
Generates structured JSON outputs validated against a Zod schema. Returns a type-safe object.

```typescript
const AnalysisSchema = z.object({
  urgency: z.enum(["low", "medium", "high"]),
  tags: z.array(z.string()),
  summary: z.string()
});

const result = await ai.generateObject(
  "gemini-2.5-flash",
  "Categorize this feedback: ...",
  AnalysisSchema
);

// Fully typed as z.infer<typeof AnalysisSchema>
console.log(result.object.urgency);
```

### 3. `streamText`
Streams LLM text completions chunk-by-chunk. You can reconcile costs and tokens after the stream resolves.

```typescript
const result = ai.streamText("gemini-2.5-flash", { 
  prompt: "Write a long essay on photosynthesis..." 
});

for await (const chunk of result.stream) {
  process.stdout.write(chunk);
}

const finalUsage = await result.getUsage();
console.log(`Stream cost: $${finalUsage.cost}`);
```

### 4. `embed`
Computes vector embeddings. In `v0.11`, passing an array of strings triggers the AI SDK's optimized `embedMany()` batch call, performing a single network round-trip.

```typescript
// Single text
const singleResult = await ai.embed("text-embedding-004", "Hello world");
console.log(singleResult.embedding); // number[]

// Batch text (v0.11+)
const batchResult = await ai.embed("text-embedding-004", ["doc1", "doc2", "doc3"]);
console.log(batchResult.embeddings); // number[][]
```

---

## Reasoning / Thinking Models

When using reasoning models (like Claude 3.7 Sonnet or models routed through OpenRouter reasoning parameters), the final output (`text`) and the intermediate thinking process (`reasoning`) occupy different channels.

### Suppressing Reasoning
To prevent a model from using its thinking channel (e.g. to save output token budget), pass provider-specific thinking configurations inside the `providerOptions` argument:

```typescript
const result = await ai.generateText("anthropic/claude-3.7-sonnet", prompt, {
  providerOptions: {
    anthropic: {
      thinking: { type: "disabled" }
    }
  }
});
```

### Accessing Thinking Output
If reasoning is enabled, read it directly from the result:

```typescript
const result = await ai.generateText("anthropic/claude-3.7-sonnet", prompt);
console.log(result.reasoning); // Contains raw thinking channel output
```

For streaming calls, use `await result.getReasoning()` after the stream completes:
```typescript
const stream = ai.streamText("anthropic/claude-3.7-sonnet", { prompt });
const reasoning = await stream.getReasoning();
```
