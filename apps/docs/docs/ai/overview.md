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

#### Messages Input (v0.12+)
As an alternative to a string/multimodal `prompt`, pass a full AI SDK model-message array via `{ messages: [...] }` — useful for multi-turn conversations or per-message roles:
```typescript
const result = await ai.generateText("gemini-2.5-flash", {
  messages: [
    { role: "user", content: "What's the capital of France?" },
    { role: "assistant", content: "Paris." },
    { role: "user", content: "And Germany?" },
  ],
});
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

`generateObject` accepts every option `generateText` does — sampling params, `headers`, `telemetry`, `reasoning`, `activeTools`, `prepareStep`, `maxRetries`/`abortSignal` — and the same `{ messages: [...] }` alternative to `prompt` shown above. See [Sampling Params, Headers & Agentic Control](#sampling-params-headers--agentic-control-v012) below.

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

`getUsage()` also optionally carries `totalTokens`, `cachedInputTokens`, and `reasoningTokens` (v0.12+) — see [Usage Detail & Cost Refinement](#usage-detail--cost-refinement-v012) below.

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

#### Retries, Abort, Headers & Telemetry (v0.12+)
`embed()` accepts the same `maxRetries`/`abortSignal` options `generateText`/`generateObject`/`streamText` already had, plus `headers` and `telemetry`:

```typescript
const controller = new AbortController();
const result = await ai.embed("text-embedding-004", "Hello world", {
  maxRetries: 5,
  abortSignal: controller.signal,
  headers: { "x-request-id": requestId },
  telemetry: { isEnabled: true }, // requires your own @ai-sdk/otel registration
});
```

---

## Usage Detail & Cost Refinement (v0.12+)

`generateText`, `generateObject`, and `streamText`'s `getUsage()` optionally return `totalTokens`, `cachedInputTokens`, and `reasoningTokens` when the provider reports them (`undefined` when it doesn't). The same detail is persisted into the `AICall` record's existing `metadata` field as `metadata.usageDetail` — no Prisma schema change.

```typescript
const { text, totalTokens, cachedInputTokens, reasoningTokens } =
  await ai.generateText("anthropic/claude-opus-4.8", prompt);
```

By default this is informational only — cost still comes from the flat `inputCostPerMillion`/`outputCostPerMillion` rate. To bill cached-read or reasoning tokens at a separate rate, set the matching optional fields when registering a model — see [Cached Input & Reasoning Token Pricing](./model-registry.md) in the Model Registry guide. When those fields are unset (true for every built-in model today), cost is unchanged from pre-0.12 behavior.

---

## Result Richness (v0.12+)

`generateText`/`generateObject` return additional optional fields, sourced directly from the AI SDK's own result shape so they can't drift: `finishReason`, `warnings`, `toolCalls`, `toolResults`, `steps`.

```typescript
const { text, finishReason, warnings, toolCalls, toolResults, steps } =
  await ai.generateText("gemini-2.5-flash", prompt, { tools });
```

`streamText` exposes the same detail as async getters, matching the existing `getUsage()`/`getText()`/`getReasoning()` style — none of them force eager resolution of the stream:

```typescript
const result = ai.streamText("gemini-2.5-flash", { prompt: "Write a story" });
for await (const chunk of result.stream) process.stdout.write(chunk);

console.log(await result.getFinishReason()); // "stop" | "length" | "tool-calls" | ...
console.log(await result.getWarnings());     // provider warnings, if any
console.log(await result.getToolCalls());    // tool calls across all steps
console.log(await result.getToolResults());  // tool results across all steps
console.log(await result.getSteps());        // per-step detail
```

---

## Sampling Params, Headers & Agentic Control (v0.12+)

`generateText`, `generateObject`, and `streamText` options all accept the following, each typed as a direct passthrough to the underlying AI SDK call so they can't drift from the SDK:

- **Sampling:** `topP`, `topK`, `frequencyPenalty`, `presencePenalty`, `seed`, `stopSequences`
- **Transport:** `headers` — additional HTTP headers (HTTP-based providers only)
- **Telemetry:** `telemetry` — OpenTelemetry tracing config for the call. workflow-engine does not depend on `@ai-sdk/otel`; install and register it yourself (once, at startup) to actually collect the spans.
- **Agentic control:** `activeTools` (restrict which of the provided `tools` the model may call this step) and `prepareStep` (adjust model/tools/settings before each step)

```typescript
import "@ai-sdk/otel"; // your own dependency, registered once at startup

await ai.generateText("gemini-2.5-flash", prompt, {
  topP: 0.9,
  stopSequences: ["\n\n"],
  telemetry: { isEnabled: true, functionId: "extract-summary" },
});
```

`streamText` additionally accepts `experimental_transform` (AI SDK v7's stable name for stream transforms, e.g. `smoothStream()`):

```typescript
import { smoothStream } from "ai";

const result = ai.streamText("gemini-2.5-flash", { prompt: "Write a story" }, {
  experimental_transform: smoothStream({ chunking: "word" }),
});
```

---

## Reasoning / Thinking Models

When using reasoning models (like Claude 3.7 Sonnet or models routed through OpenRouter reasoning parameters), the final output (`text`) and the intermediate thinking process (`reasoning`) occupy different channels.

### Unified `reasoning` Option (v0.12+)
Instead of reaching for provider-specific `providerOptions`, prefer the portable `reasoning` knob — AI SDK v7's own effort scale — which each provider maps to its own controls:

```typescript
await ai.generateText("anthropic/claude-opus-4.8", prompt, { reasoning: "low" });
await ai.generateText("some-openrouter-reasoning-model", prompt, { reasoning: "none" });
```

`reasoning` accepts `"none" | "low" | "medium" | "high" | ...` and works the same on `generateObject`/`streamText`. `providerOptions` remains available (and composes with `reasoning`) for provider-specific controls it doesn't cover.

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
