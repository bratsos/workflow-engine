# AI Integration

Complete guide for using AIHelper for text generation, structured output, embeddings, and batch operations.

## Topic Convention for Cost Tracking

**Topics are hierarchical strings that enable cost aggregation at different levels.**

### The Convention

```
workflow.{workflowRunId}.stage.{stageId}.{optional-suffix}
```

| Topic Pattern | Use Case | Example |
|---------------|----------|---------|
| `workflow.{runId}` | Root topic for a workflow run | `workflow.abc123` |
| `workflow.{runId}.stage.{stageId}` | Specific stage | `workflow.abc123.stage.extraction` |
| `workflow.{runId}.stage.{stageId}.tool.{name}` | Tool call within a stage | `workflow.abc123.stage.extraction.tool.search` |
| `task.{taskId}` | Standalone task (not a workflow) | `task.process-document-456` |

### How Cost Aggregation Works

The `AICallLogger.getStats(topicPrefix)` method uses **prefix matching** to aggregate costs:

```typescript
// All AI calls are logged with their topic
ai.generateText("gemini-2.5-flash", prompt);  // Logged with topic "workflow.abc123.stage.extraction"

// Later, aggregate by prefix:
const workflowStats = await aiLogger.getStats("workflow.abc123");
// Returns: all costs for that workflow run (all stages)

const stageStats = await aiLogger.getStats("workflow.abc123.stage.extraction");
// Returns: costs for just that stage

const allStats = await aiLogger.getStats("workflow");
// Returns: costs for ALL workflows
```

### Automatic Workflow Cost Tracking

When a workflow completes, the executor automatically calculates total cost:

```typescript
// Inside WorkflowExecutor (automatic)
const stats = await aiLogger.getStats(`workflow.${workflowRunId}`);
await persistence.updateRun(workflowRunId, {
  totalCost: stats.totalCost,
  totalTokens: stats.totalInputTokens + stats.totalOutputTokens,
});
```

**Result:** `WorkflowRun.totalCost` and `WorkflowRun.totalTokens` are populated automatically.

### Using Topics in Stages

```typescript
const extractStage = defineStage({
  id: "extraction",
  // ...
  async execute(ctx) {
    // Create AI helper with proper topic convention
    const ai = runtime.createAIHelper(
      `workflow.${ctx.workflowRunId}.stage.${ctx.stageId}`
    );

    // All AI calls are now tracked under this topic
    const { text } = await ai.generateText("gemini-2.5-flash", prompt);

    return { output: { extracted: text } };
  },
});
```

### Querying Costs

```typescript
// Get costs for a specific workflow run
const runStats = await aiLogger.getStats(`workflow.${workflowRunId}`);
console.log(`Workflow cost: $${runStats.totalCost.toFixed(4)}`);
console.log(`Total tokens: ${runStats.totalInputTokens + runStats.totalOutputTokens}`);
console.log(`Calls by model:`, runStats.perModel);

// Get costs for a specific stage
const stageStats = await aiLogger.getStats(`workflow.${workflowRunId}.stage.extraction`);

// Get costs across all workflows (for reporting)
const allStats = await aiLogger.getStats("workflow");
```

### Stats Response Type

```typescript
interface AIHelperStats {
  totalCalls: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCost: number;
  perModel: {
    [modelKey: string]: {
      calls: number;
      inputTokens: number;
      outputTokens: number;
      cost: number;
    };
  };
}
```

## Creating an AIHelper

```typescript
import { createAIHelper } from "@bratsos/workflow-engine";
import { createPrismaAICallLogger } from "@bratsos/workflow-engine/persistence/prisma";

// Basic usage (with topic convention)
const ai = createAIHelper(`workflow.${runId}.stage.${stageId}`, aiCallLogger);

// With log context (for batch persistence)
const logContext = {
  workflowRunId: "run-123",
  stageRecordId: "stage-456",
  createLog: (data) => persistence.createLog(data),
};
const ai = createAIHelper("workflow.run-123", aiCallLogger, logContext);

// From runtime (preferred in stages)
const ai = runtime.createAIHelper(`workflow.${ctx.workflowRunId}.stage.${ctx.stageId}`);
```

### Custom Provider Resolver (`LanguageModelV4`)

Pass a `ProviderResolver` as `createAIHelper`'s 4th (optional) argument to override how a `ModelConfig` resolves to an AI SDK language model — useful for providers this library doesn't build in, or to inject a differently-configured client (custom base URL, API key rotation, etc.). The resolver returns an AI SDK v7 `LanguageModelV4` (from `@ai-sdk/provider`), or `null`/`undefined` to fall back to built-in resolution:

```typescript
import { createAIHelper, type ProviderResolver } from "@bratsos/workflow-engine";
import { anthropic } from "@ai-sdk/anthropic";

const myResolver: ProviderResolver = (modelConfig) => {
  if (modelConfig.provider === "anthropic") {
    return anthropic(modelConfig.id); // LanguageModelV4
  }
  return undefined; // fall back to built-in resolution
};

const ai = createAIHelper("workflow.abc123", aiCallLogger, undefined, myResolver);
```

> Upgrading from AI SDK v6 (0.11 and earlier)? `ProviderResolver` now returns `LanguageModelV4` instead of `LanguageModelV3` — see [migrate-0.11-to-0.12.md](../migrations/migrate-0.11-to-0.12.md#required-actions).

## AIHelper Interface

```typescript
interface AIHelper {
  readonly topic: string;

  generateText(modelKey, prompt, options?): Promise<AITextResult>;
  generateObject(modelKey, prompt, schema, options?): Promise<AIObjectResult>;
  embed(modelKey, text, options?): Promise<AIEmbedResult>;
  streamText(modelKey, input, options?): AIStreamResult;
  batch(modelKey, provider?): AIBatch;

  createChild(segment, id?): AIHelper;
  recordCall(params): void;
  getStats(): Promise<AIHelperStats>;
}
```

## generateText

Generate text from a prompt.

```typescript
const result = await ai.generateText(
  "gemini-2.5-flash",  // Model key
  "Explain quantum computing in simple terms",
  {
    temperature: 0.7,   // 0-2, default 0.7
    maxTokens: 1000,    // Max output tokens
    maxRetries: 2,       // v0.11+: forwarded to the AI SDK call
    abortSignal: controller.signal, // v0.11+: forwarded to the AI SDK call
  }
);

console.log(result.text);           // Generated text
console.log(result.inputTokens);    // Token count
console.log(result.outputTokens);
console.log(result.cost);           // Calculated cost
```

`maxRetries` and `abortSignal` (v0.11+) are also available on `generateObject` and `streamText` options — see below. `embed()` gained the same two options in v0.12 (see [embed](#embed) below).

### Messages Input (v0.12+)

`generateText`/`generateObject` accept `{ messages: [...] }` as an alternative to a string/multimodal `prompt` — the array is a full AI SDK model-message list (`Parameters<typeof generateText>[0]["messages"]`), useful for multi-turn conversations or per-message roles. The string/multimodal prompt path shown above is unchanged; pick whichever shape fits the call.

```typescript
const result = await ai.generateText("gemini-2.5-flash", {
  messages: [
    { role: "user", content: "What's the capital of France?" },
    { role: "assistant", content: "Paris." },
    { role: "user", content: "And Germany?" },
  ],
});
```

`generateObject` accepts the same `{ messages: [...] }` shape in place of its `prompt` argument.

### Sampling Params, Headers, Telemetry & Agentic Control (v0.12+)

`generateText`/`generateObject`/`streamText` options all accept the following, each typed as a passthrough sourced directly from the AI SDK's own parameter type (`Parameters<typeof generateText>[0]["<field>"]` or the `streamText` equivalent), so they track the SDK instead of drifting:

- **Sampling:** `topP`, `topK`, `frequencyPenalty`, `presencePenalty`, `seed`, `stopSequences`
- **Transport:** `headers` (additional HTTP headers, HTTP-based providers only)
- **Telemetry:** `telemetry` — OpenTelemetry tracing config for the call. This library does **not** depend on `@ai-sdk/otel`; install and register it yourself (once, at startup) to actually collect the spans:
  ```typescript
  // consumer's own dependency, registered once at startup
  import "@ai-sdk/otel";

  await ai.generateText("gemini-2.5-flash", prompt, {
    telemetry: { isEnabled: true, functionId: "extract-summary" },
  });
  ```
- **Agentic control:** `activeTools` (restrict which of the provided `tools` the model may call this step) and `prepareStep` (hook to adjust model/tools/settings before each step)

`StreamOptions` additionally accepts `experimental_transform` (AI SDK v7's stable name for stream transforms, e.g. `smoothStream()`):

```typescript
import { smoothStream } from "ai";

const result = ai.streamText("gemini-2.5-flash", { prompt }, {
  experimental_transform: smoothStream({ chunking: "word" }),
});
```

### Multimodal Input

```typescript
// With images/PDFs
const result = await ai.generateText("gemini-2.5-flash", [
  { type: "text", text: "What's in this image?" },
  {
    type: "file",
    data: imageBuffer,  // Buffer, Uint8Array, or base64 string
    mediaType: "image/png",
    filename: "image.png",
  },
]);
```

### With Tools

```typescript
import { tool } from "ai";

const result = await ai.generateText("gemini-2.5-flash", "What's the weather?", {
  tools: {
    getWeather: tool({
      description: "Get weather for a location",
      parameters: z.object({ location: z.string() }),
      execute: async ({ location }) => {
        return { temperature: 72, condition: "sunny" };
      },
    }),
  },
  toolChoice: "auto",  // or "required", "none", { type: "tool", toolName: "getWeather" }
  onStepEnd: async (step) => {
    console.log("Tool results:", step.toolResults);
  },
});
```

## generateObject

Generate structured output with Zod schema validation.

```typescript
const OutputSchema = z.object({
  title: z.string(),
  tags: z.array(z.string()),
  sentiment: z.enum(["positive", "negative", "neutral"]),
});

const result = await ai.generateObject(
  "gemini-2.5-flash",
  "Analyze this article: ...",
  OutputSchema,
  {
    temperature: 0,  // Lower for structured output
    maxTokens: 500,
  }
);

console.log(result.object);  // Typed as z.infer<typeof OutputSchema>
// { title: "...", tags: ["tech", "ai"], sentiment: "positive" }
```

`generateObject` accepts every option `generateText` does (`maxRetries`, `abortSignal`, sampling params, `headers`, `telemetry`, `reasoning`, `activeTools`, `prepareStep`), and the same `{ messages: [...] }` alternative to a string/multimodal `prompt` — see [Messages Input](#messages-input-v012) and [Sampling Params, Headers, Telemetry & Agentic Control](#sampling-params-headers-telemetry--agentic-control-v012) above.

### Multimodal with Schema

```typescript
const result = await ai.generateObject(
  "gemini-2.5-flash",
  [
    { type: "text", text: "Extract text from this document" },
    { type: "file", data: pdfBuffer, mediaType: "application/pdf" },
  ],
  z.object({
    title: z.string(),
    content: z.string(),
    pageCount: z.number(),
  })
);
```

## embed

Generate embeddings for text. Supports Google and OpenRouter as built-in providers, plus any custom provider registered via `registerEmbeddingProvider()`.

```typescript
// Google embedding model (with Google-specific options)
const result = await ai.embed(
  "text-embedding-004",
  "The quick brown fox",
  {
    dimensions: 768,  // Output dimensions (default: 768)
    taskType: "RETRIEVAL_DOCUMENT",  // Google-only: "RETRIEVAL_QUERY", "SEMANTIC_SIMILARITY"
  }
);

console.log(result.embedding);     // number[] (768 dimensions)
console.log(result.dimensions);    // 768
console.log(result.inputTokens);
console.log(result.cost);

// OpenRouter embedding model (OpenAI, Cohere, etc.)
const result = await ai.embed(
  "openai/text-embedding-3-small",
  "The quick brown fox",
);

// Multiple texts (batch) -- as of v0.11, backed by the AI SDK's embedMany()
// (a single round-trip) instead of one embed() call per text.
const result = await ai.embed("text-embedding-004", [
  "First document",
  "Second document",
  "Third document",
]);

console.log(result.embeddings);    // number[][] (3 embeddings)
console.log(result.embedding);     // First embedding (convenience)
```

### Retries, Abort & Telemetry (v0.12+)

`embed()` gained the same `maxRetries`/`abortSignal` options `generateText`/`generateObject`/`streamText` already had, plus `headers` and `telemetry`:

```typescript
const controller = new AbortController();
const result = await ai.embed("text-embedding-004", "The quick brown fox", {
  maxRetries: 5,
  abortSignal: controller.signal,
  headers: { "x-request-id": requestId },
  telemetry: { isEnabled: true }, // requires your own @ai-sdk/otel registration - see Sampling Params section above
});
```

### Provider Options Passthrough

Pass provider-specific options directly to the AI SDK's `embed()` call using `providerOptions`. These are merged after any auto-mapped options (e.g., Google's `outputDimensionality`), so they can override defaults.

```typescript
// Voyage-specific options
const result = await ai.embed("voyage-4-large", ["text"], {
  providerOptions: {
    voyage: { outputDimension: 512, inputType: "document" },
  },
});

// Cohere-specific options
const result = await ai.embed("cohere-embed-v4", ["text"], {
  providerOptions: {
    cohere: { inputType: "search_document", truncate: "END" },
  },
});

// Override Google's auto-mapped options
const result = await ai.embed("text-embedding-004", "query text", {
  providerOptions: {
    google: { outputDimensionality: 256, taskType: "RETRIEVAL_QUERY" },
  },
});
```

> **Note:** `taskType` and `outputDimensionality` are auto-mapped for Google models.
> For all other providers, use `providerOptions` to pass provider-specific settings.
> The provider is determined by the `provider` field in the model's `ModelConfig`.

### Custom Embedding Providers

Use `registerEmbeddingProvider()` to add support for any AI SDK community embedding provider (Voyage, Cohere, Jina, etc.) without modifying the library. Call this once at application startup, before any `embed()` calls.

```typescript
import { registerEmbeddingProvider, registerModels } from "@bratsos/workflow-engine";
import { voyage } from "voyage-ai-provider";

// 1. Register the provider factory (once at startup)
registerEmbeddingProvider("voyage", (modelId) => voyage.embeddingModel(modelId));

// 2. Register models that use the provider
registerModels({
  "voyage-4-large": {
    id: "voyage-4-large",
    name: "Voyage 4 Large",
    provider: "voyage",           // Must match the name in registerEmbeddingProvider()
    inputCostPerMillion: 0.06,
    outputCostPerMillion: 0,
    isEmbeddingModel: true,
  },
});

// 3. Use it like any other embedding model
const { embedding } = await ai.embed("voyage-4-large", "Hello world");
```

**How it works:**
- The factory receives the model's `id` from `ModelConfig` and must return an `EmbeddingModelV4` instance (from `@ai-sdk/provider`)
- Custom providers are checked **before** built-in providers, so you can even override `"openrouter"` or `"google"` if needed
- The workflow engine stays provider-agnostic — install your chosen provider package as your app's dependency, not the library's
- Provider-specific options (like Google's `taskType`) are handled by each provider through the AI SDK's standard mechanism

## streamText

Stream text generation.

```typescript
const result = ai.streamText(
  "gemini-2.5-flash",
  { prompt: "Write a story about a robot" },
  {
    temperature: 0.9,
    onChunk: (chunk) => process.stdout.write(chunk),
  }
);

// Consume the stream
for await (const chunk of result.stream) {
  console.log(chunk);
}

// Get usage after stream completes
const usage = await result.getUsage();
console.log(usage.cost);

// Or use raw AI SDK result for UI streaming
const response = result.rawResult.toUIMessageStreamResponse();
```

### With Messages

```typescript
const result = ai.streamText("gemini-2.5-flash", {
  instructions: "You are a helpful assistant.",
  messages: [
    { role: "user", content: "Hello!" },
    { role: "assistant", content: "Hi! How can I help?" },
    { role: "user", content: "Tell me a joke." },
  ],
});
```

`streamText` also accepts the same sampling params, `headers`, `telemetry`, `reasoning`, `activeTools`, `prepareStep`, and `experimental_transform` options described in [Sampling Params, Headers, Telemetry & Agentic Control](#sampling-params-headers-telemetry--agentic-control-v012) above.

### Result Richness (v0.12+)

Beyond `getUsage()`/`getText()`/`getReasoning()`, `AIStreamResult` exposes async getters for the same result-richness fields `generateText`/`generateObject` return directly. Like `getUsage()`, none of them force eager resolution of the stream:

```typescript
const result = ai.streamText("gemini-2.5-flash", { prompt: "Write a story" });

for await (const chunk of result.stream) {
  process.stdout.write(chunk);
}

console.log(await result.getFinishReason());  // "stop" | "length" | "tool-calls" | ...
console.log(await result.getWarnings());      // provider warnings, if any
console.log(await result.getToolCalls());     // tool calls across all steps
console.log(await result.getToolResults());   // tool results across all steps
console.log(await result.getSteps());         // per-step detail
```

## Reasoning Models & Provider Options

Reasoning models (e.g. `anthropic/claude-opus-4.x`, OpenRouter reasoning models) emit
on a **separate reasoning channel**. Two facts drive how you use them here:

1. **The answer (`text`) and the reasoning are different channels.** A model can reason
   *and* answer, or reason *instead of* answering. When it reasons instead of answering,
   the text channel — including the buffered `result.text` — is genuinely empty; the
   content is in the reasoning channel.
2. **Control reasoning per call with `reasoning` (v0.12+, preferred) or `providerOptions`.**
   `reasoning` is AI SDK v7's portable reasoning-effort knob (`"none" | "low" | "medium" |
   "high" | ...`), mapped by each provider to its own controls — prefer it when a portable
   value is enough. `providerOptions` remains available (and composes with `reasoning`) for
   provider-specific knobs it doesn't cover. Both are forwarded by `generateText`,
   `generateObject`, and `streamText` (just like `embed`, for `providerOptions`).

### Controlling reasoning (unified `reasoning` option, v0.12+)

```typescript
// Portable across providers - each maps "low"/"medium"/"high" to its own controls
await ai.generateText("anthropic/claude-opus-4.8", prompt, { reasoning: "low" });
await ai.generateText("some-openrouter-reasoning-model", prompt, { reasoning: "none" });

// Works the same on streamText / generateObject
const result = ai.streamText("anthropic/claude-opus-4.8", { prompt }, { reasoning: "high" });
```

### Controlling reasoning (`providerOptions`)

```typescript
// Disable reasoning so the model emits a normal text answer
await ai.generateText("anthropic/claude-opus-4.8", prompt, {
  providerOptions: { anthropic: { thinking: { type: "disabled" } } },
});

// OpenRouter reasoning controls
await ai.generateText("some-openrouter-reasoning-model", prompt, {
  providerOptions: { openrouter: { reasoning: { enabled: false } } }, // or { effort: "low" }
});

// Works the same on streamText / generateObject
const result = ai.streamText("anthropic/claude-opus-4.8", { prompt }, {
  providerOptions: { anthropic: { thinking: { type: "disabled" } } },
});
```

> `providerOptions` is a per-call lever (`Record<string, Record<string, unknown>>`). It
> complements the global `providerResolver` hook, which is set once at provider-creation
> time and cannot vary per call.

### Reading reasoning output

`generateText` exposes `reasoning` on its result; `streamText` exposes `getText()` and
`getReasoning()`. The streamed `.stream` carries only the **answer** text, never reasoning.

```typescript
// Non-streaming
const { text, reasoning } = await ai.generateText("anthropic/claude-opus-4.8", prompt);
if (!text && reasoning) {
  // Model reasoned but did not answer — usually means reasoning should be
  // suppressed (providerOptions above) or maxTokens raised (see budget note).
}

// Streaming
const result = ai.streamText("anthropic/claude-opus-4.8", { prompt });
let answer = "";
for await (const chunk of result.stream) answer += chunk; // answer channel only
const text = await result.getText();        // reconciled answer (== answer here)
const reasoning = await result.getReasoning(); // reasoning channel, if any
```

> **Token budget (gap to be aware of):** reasoning tokens count against `maxTokens`
> (`maxOutputTokens`). If `maxTokens` is small, the model can spend the whole budget
> reasoning and emit no answer. Either raise `maxTokens` or disable reasoning via
> `providerOptions` for a normal text answer.

## batch

Submit batch operations for 50% cost savings.

```typescript
const batch = ai.batch<OutputType>("claude-sonnet-4-20250514", "anthropic");

// Submit requests
const handle = await batch.submit([
  { id: "req-1", prompt: "Summarize: ..." },
  { id: "req-2", prompt: "Summarize: ...", schema: SummarySchema },
]);

console.log(handle.id);       // Batch ID
console.log(handle.status);   // "pending"
console.log(handle.provider); // "anthropic"

// Check status
const status = await batch.getStatus(handle.id);
// { id: "...", status: "processing" | "completed" | "failed", provider: "anthropic" }

// Get results (when completed) -- a request submitted with a `schema` has
// its JSON output validated against it; a response that fails validation
// comes back as status: "failed" rather than an unvalidated blob.
const results = await batch.getResults(handle.id);
// [
//   { id: "req-1", result: "...", inputTokens: 100, outputTokens: 50, status: "succeeded" },
//   { id: "req-2", result: { parsed: "object" }, inputTokens: 100, outputTokens: 50, status: "succeeded" },
// ]

// Check if already recorded (avoid duplicate logging)
const recorded = await batch.isRecorded(handle.id);
```

### Cross-process result checking: re-supplying `schema`s (v0.11+)

A `z.ZodTypeAny` passed to `submit()` isn't serializable, so it only survives for the lifetime of the `AIBatch` instance that submitted the request. If you check results from a *different* process or a fresh `AIBatch` instance (the common case for async-batch stages resuming after a suspend), re-supply the schemas keyed by request id so validation still applies:

```typescript
// submit() -- process/instance A
const handle = await batch.submit([
  { id: "req-1", prompt: "...", schema: ItemSchema },
]);

// getResults() -- process/instance B (e.g. checkCompletion() after resume)
const results = await batch.getResults(handle.id, {
  schemas: { "req-1": ItemSchema },
});
```

Without `schemas`, results are still returned but without schema validation for requests whose schema wasn't re-supplied.

### Batch Providers

| Provider | Models | Discount |
|----------|--------|----------|
| `anthropic` | Claude models | 50% |
| `google` | Gemini models | 50% |
| `openai` | GPT models | 50% |

```typescript
// Provider auto-detected based on model
const batch = ai.batch("claude-sonnet-4-20250514");  // Uses anthropic

// Or specify explicitly
const batch = ai.batch("gemini-2.5-flash", "google");
```

## Child Helpers

Create child helpers for hierarchical topic tracking.

```typescript
const rootAI = createAIHelper("workflow.abc123", logger);

// Create child for a specific stage
const stageAI = rootAI.createChild("stage", "extraction");
// topic: "workflow.abc123.stage.extraction"

// Create child for a tool call
const toolAI = stageAI.createChild("tool", "search");
// topic: "workflow.abc123.stage.extraction.tool.search"
```

## Manual Recording

Record AI calls made outside the helper (e.g., direct SDK usage).

```typescript
// Object-based API
ai.recordCall({
  modelKey: "gemini-2.5-flash",
  callType: "text",
  prompt: "...",
  response: "...",
  inputTokens: 100,
  outputTokens: 50,
  metadata: { custom: "data" },
});

// Legacy positional API
ai.recordCall(
  "gemini-2.5-flash",
  "prompt text",
  "response text",
  { input: 100, output: 50 },
  { callType: "text", isBatch: false }
);
```

## Statistics

Get aggregated stats for a topic prefix.

```typescript
const stats = await ai.getStats();
// {
//   totalCalls: 42,
//   totalInputTokens: 50000,
//   totalOutputTokens: 25000,
//   totalCost: 0.15,
//   perModel: {
//     "gemini-2.5-flash": { calls: 30, inputTokens: 40000, outputTokens: 20000, cost: 0.10 },
//     "claude-sonnet-4-20250514": { calls: 12, inputTokens: 10000, outputTokens: 5000, cost: 0.05 },
//   },
// }
```

## Model Configuration

### Available Models

```typescript
import { AVAILABLE_MODELS, listModels } from "@bratsos/workflow-engine";

// List all models
const models = listModels();
// [
//   { key: "gemini-2.5-flash", id: "google/gemini-2.5-flash-preview-05-20", ... },
//   { key: "claude-sonnet-4-20250514", id: "anthropic/claude-sonnet-4-20250514", ... },
//   ...
// ]

// Filter models
const flashModels = listModels({ provider: "google", capabilities: ["embedding"] });
```

### Register Custom Models

```typescript
import { registerModels } from "@bratsos/workflow-engine";

registerModels({
  "my-custom-model": {
    id: "openrouter/my-model",
    provider: "openrouter",
    inputCostPerMillion: 0.5,
    outputCostPerMillion: 1.0,
    contextWindow: 128000,
    maxOutput: 4096,
    capabilities: ["text", "vision"],
  },
});

// Now usable
const result = await ai.generateText("my-custom-model", prompt);
```

### Register Custom Embedding Models

```typescript
import { registerModels } from "@bratsos/workflow-engine";

registerModels({
  "openai/text-embedding-3-small": {
    id: "openai/text-embedding-3-small",
    name: "OpenAI text-embedding-3-small",
    provider: "openrouter",
    inputCostPerMillion: 0.02,
    outputCostPerMillion: 0,
    isEmbeddingModel: true,
  },
});

// Now usable
const { embedding } = await ai.embed("openai/text-embedding-3-small", "text");
```

### Cost Calculation

```typescript
import { calculateCost } from "@bratsos/workflow-engine";

const cost = calculateCost("gemini-2.5-flash", 1000, 500);
// {
//   inputCost: 0.00015,
//   outputCost: 0.0003,
//   totalCost: 0.00045,
// }
```

`calculateCost` computes the flat (unrefined) cost from `inputCostPerMillion`/`outputCostPerMillion` only. The AI helper's internal `calculateCostWithDiscount` (used by `generateText`/`generateObject`/`streamText`/`embed`) additionally applies `ModelConfig.cachedInputCostPerMillion`/`reasoningCostPerMillion` when the model config sets them — see [Usage Detail & Cost Refinement](#usage-detail--cost-refinement-v012) below.

### Usage Detail & Cost Refinement (v0.12+)

`ModelConfig` accepts two optional per-model rates:

```typescript
registerModels({
  "my-caching-model": {
    id: "provider/my-model",
    provider: "openrouter",
    inputCostPerMillion: 3,
    outputCostPerMillion: 15,
    cachedInputCostPerMillion: 0.3,  // optional - price for cached-read input tokens
    reasoningCostPerMillion: 60,     // optional - price for reasoning output tokens
  },
});
```

When a call reports `cachedInputTokens`/`reasoningTokens` (see `AITextResult` below) **and** the model config sets the matching rate, that token slice is billed at the refined rate instead of the flat `inputCostPerMillion`/`outputCostPerMillion`. When a model has neither field set — true for every built-in model today — cost is unchanged from pre-0.12 behavior. The `sync-models` CLI does not populate these two fields yet; set them via `registerModels()` if you need refined pricing today.

## Result Types

`FinishReason`, `CallWarning`, `TypedToolCall`, `TypedToolResult`, and `StepResult` below are AI SDK types (from `"ai"`), not redefined by this library - the result-richness fields are typed directly off `generateText`'s own result shape so they can't drift from the SDK.

```typescript
interface AITextResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
  cost: number;
  output?: any;       // Present when `output` is used
  reasoning?: string; // Reasoning/thinking text, when the model emitted any

  // v0.12+: usage detail, present when the provider reports it
  totalTokens?: number;
  cachedInputTokens?: number;
  reasoningTokens?: number;

  // v0.12+: result richness
  finishReason?: FinishReason;              // "stop" | "length" | "tool-calls" | ...
  warnings?: CallWarning[];
  toolCalls?: TypedToolCall<ToolSet>[];
  toolResults?: TypedToolResult<ToolSet>[];
  steps?: StepResult<ToolSet>[];
}

interface AIObjectResult<T> {
  object: T;
  inputTokens: number;
  outputTokens: number;
  cost: number;

  // v0.12+: same usage-detail and result-richness fields as AITextResult
  totalTokens?: number;
  cachedInputTokens?: number;
  reasoningTokens?: number;
  finishReason?: FinishReason;
  warnings?: CallWarning[];
  toolCalls?: TypedToolCall<ToolSet>[];
  toolResults?: TypedToolResult<ToolSet>[];
  steps?: StepResult<ToolSet>[];
}

interface AIEmbedResult {
  embedding: number[];      // First embedding
  embeddings: number[][];   // All embeddings
  dimensions: number;
  inputTokens: number;
  cost: number;
}

interface AIStreamResult {
  stream: AsyncIterable<string>;
  getUsage(): Promise<{ inputTokens, outputTokens, cost, totalTokens?, cachedInputTokens?, reasoningTokens? }>;
  getText(): Promise<string>;                  // Full answer text, reconciled with the buffered result
  getReasoning(): Promise<string | undefined>; // Reasoning/thinking text, when the model emitted any

  // v0.12+: async getters mirroring generateText's result-richness fields.
  // None force eager resolution of the stream.
  getFinishReason(): Promise<FinishReason>;
  getWarnings(): Promise<CallWarning[] | undefined>;
  getToolCalls(): Promise<TypedToolCall<ToolSet>[]>;
  getToolResults(): Promise<TypedToolResult<ToolSet>[]>;
  getSteps(): Promise<StepResult<ToolSet>[]>;

  rawResult: AISDKStreamResult;
}

// v0.11+: discriminated union -- `result` only exists on "succeeded",
// `error` only exists on "failed". Check `status` before reading either.
type AIBatchResult<T = string> =
  | {
      id: string;
      prompt: string;
      result: T;              // validated against the request's schema, if one was supplied
      inputTokens: number;
      outputTokens: number;
      status: "succeeded";
      error?: undefined;
    }
  | {
      id: string;
      prompt: string;
      result?: undefined;     // no result on failure -- do not read this
      inputTokens: number;
      outputTokens: number;
      status: "failed";
      error: string;
    };
```

**Breaking in v0.11:** before this release, a failed result still carried a `result: T` field (an empty/placeholder value). Code that read `.result` without checking `.status` first will now see `undefined` instead of a placeholder. See [`../migrations/migrate-0.10-to-0.11.md`](../migrations/migrate-0.10-to-0.11.md) for the before/after migration pattern.

## Complete Example

```typescript
import {
  createAIHelper,
  createPrismaAICallLogger,
  registerModels,
} from "@bratsos/workflow-engine";
import { z } from "zod";

// Setup
const logger = createPrismaAICallLogger(prisma);
const ai = createAIHelper("document-processor", logger);

// Register a custom model if needed
registerModels({
  "fast-model": {
    id: "openrouter/fast-model",
    provider: "openrouter",
    inputCostPerMillion: 0.1,
    outputCostPerMillion: 0.2,
  },
});

// Processing pipeline
async function processDocument(content: string) {
  // 1. Extract structure
  const { object: structure } = await ai.generateObject(
    "gemini-2.5-flash",
    `Extract structure from:\n\n${content}`,
    z.object({
      title: z.string(),
      sections: z.array(z.object({
        heading: z.string(),
        content: z.string(),
      })),
    })
  );

  // 2. Generate embeddings for each section
  const embeddings = await ai.embed(
    "text-embedding-004",
    structure.sections.map(s => s.content)
  );

  // 3. Generate summary
  const { text: summary } = await ai.generateText(
    "gemini-2.5-flash",
    `Summarize in 2 sentences:\n\n${content}`,
    { maxTokens: 100 }
  );

  // 4. Check stats
  const stats = await ai.getStats();
  console.log(`Total cost: $${stats.totalCost.toFixed(4)}`);

  return {
    structure,
    embeddings: embeddings.embeddings,
    summary,
    cost: stats.totalCost,
  };
}
```
