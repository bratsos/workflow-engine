---
sidebar_position: 1
title: AI Overview
---

# AI Overview

**workflow-engine** features native, type-safe AI integration. At its core, the **`AIHelper`** interface wraps the standard AI SDK to handle text generation, structured outputs, streaming, and embeddings, while automatically logging calls and tracking token usage/pricing.

---

## `ctx.ai`: the helper every stage gets

Give the kernel an `AICallLogger` once, and every stage and `checkCompletion` context carries `ctx.ai` — an `AIHelper` built lazily on first access under the topic `workflow.<workflowRunId>.stage.<stageId>` — and `ctx.aiLogger`, the logger itself. Call logs land in the run's log table.

```typescript
import { createKernel } from "@bratsos/workflow-engine/kernel";
import { createPrismaAICallLogger } from "@bratsos/workflow-engine/persistence/prisma";

const kernel = createKernel({
  // ...ports
  services: {
    aiLogger: createPrismaAICallLogger(prisma),
    // optional: a factory with createAIHelper's signature, to set routing
    // options, an adapter or timeouts for every stage in one place
    ai: (topic, logger, logContext, providerResolver, options) =>
      createAIHelper(topic, logger, logContext, providerResolver, {
        ...options,
        timeout: { perCallMs: 8 * 60 * 1000 },
      }),
  },
});

// Inside a stage's execute() function
async execute(ctx) {
  const result = await ctx.ai.generateText("gemini-2.5-flash", prompt, {
    abortSignal: ctx.abortSignal,
  });
  // tokens and cost are logged under this run and stage
}
```

Accessing `ctx.ai` on a kernel built without `services` throws `AIServicesNotConfiguredError`. In tests, `createTestHarness()` wires an `InMemoryAICallLogger` and a scriptable mock helper for you (see [Testing Workflows](../testing/testing-workflows.md)).

For a call that must survive a replay — memoized through the step ledger so it is not paid for twice — use `ctx.step.ai.generateText` / `generateObject` / `streamText`, and `ctx.step.ai.map` for one prompt per item under a realtime or batch policy. See [Durable Steps](../core-concepts/durable-steps.md#ctxstepai) and [Batch Operations](./batch-operations.md).

### Creating a helper outside a stage

Outside the kernel — a script, a request handler — create one directly from a topic and a logger:

```typescript
import { createAIHelper } from "@bratsos/workflow-engine";

const ai = createAIHelper("cli.reindex", createPrismaAICallLogger(prisma));
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
When a workflow run completes or fails, the kernel queries `services.aiLogger.getStats("workflow.${runId}")` (falling back to the sum of the stages' `metrics` when no services are configured), and writes `totalCost` and `totalTokens` onto the `WorkflowRun` row in the same transaction; `workflow:completed` carries them too. Because it is a column and not a trace, a later stage can read it and gate on spend.

---

## Core Operations

### 1. `generateText`
Sends a prompt and returns the generated text alongside cost and token usage data.

```typescript
const result = await ai.generateText(
  "gemini-2.5-flash", 
  "Summarize this input text: ...",
  {
    temperature: 0.5,              // no default is sent; the provider's own applies
    maxTokens: 1000,
    maxRetries: 3,                 // passed to the provider SDK
    abortSignal: ctx.abortSignal,  // cancellation / lost lease reaches the call
    timeoutMs: 120_000,            // per-call deadline; AICallTimeoutError on expiry
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
Computes vector embeddings. Passing an array of strings triggers the AI SDK's optimized `embedMany()` batch call, performing a single network round-trip.

```typescript
// Single text
const singleResult = await ai.embed("text-embedding-004", "Hello world");
console.log(singleResult.embedding); // number[]

// Batch text
const batchResult = await ai.embed("text-embedding-004", ["doc1", "doc2", "doc3"]);
console.log(batchResult.embeddings); // number[][]
```

### Timeouts and adapters

`AIHelperOptions.timeout.perCallMs` applies a deadline to every non-batch call, and `timeoutMs` on the text, object, embed and stream options overrides it per call. On expiry the call throws `AICallTimeoutError` (with `timeoutMs` and `modelKey`) and the failure is still logged as a cost row.

`AIHelperOptions.adapter: AIAdapter` swaps the transport below logging and cost for any subset of `generateText`, `generateObject`, `embed` and `streamText` (a local model, a subscription CLI); missing operations fall through to the AI SDK, and child helpers inherit it. An adapter response may carry `costUsd`, recorded as the reported cost. An adapter that parses model output itself should throw `NoObjectGeneratedError` (re-exported from the root entry) with `text` set so the `map` repair loop can quote the bad output back to the model.

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

`.stream` only carries the text/answer channel — for a reasoning-only response (nothing emitted as answer text), iterating `for await (const chunk of stream.stream)` yields **no chunks at all**. Use `await stream.getText()` if you need the final answer text: it reconciles against the AI SDK's buffered result independently of `.stream`, so it still returns the full text even when `.stream` was empty.

## Reported vs. estimated cost

Every AI result exposes `reportedCostUsd` (the provider's own figure, when it reports one) and `costSource` (`"reported"` or `"estimated"`). `cost` prefers the reported figure and falls back to the model registry's prices, including long-context pricing tiers. BYOK is handled correctly: the upstream inference cost is added only when the provider bills it separately. Batch cost follows the transport actually used — a native vendor batch bills the vendor's documented discount, the OpenRouter transport bills the `:batch` catalog row's absolute price.

