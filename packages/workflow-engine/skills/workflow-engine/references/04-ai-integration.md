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

When a run completes, `run.transition` rolls the run's cost up from the AI call logger configured on the kernel (`createKernel({ services: { aiLogger } })`), because every model call made under `workflow.<runId>` — stages, `ctx.step.ai`, batches — is logged there:

```typescript
// Inside run.transition (automatic when services.aiLogger is set)
const stats = await aiLogger.getStats(`workflow.${workflowRunId}`);
await persistence.updateRun(workflowRunId, {
  totalCost: stats.totalCost,
  totalTokens: stats.totalInputTokens + stats.totalOutputTokens,
});
```

**Result:** `WorkflowRun.totalCost` and `WorkflowRun.totalTokens` are populated on completion (and carried on the `workflow:completed` event). Without `services.aiLogger` the kernel falls back to summing the stages' `metrics.totalCost` / `metrics.totalTokens`, which stay 0 unless a stage sets them — that is why runs on 0.x showed `totalCost: 0` while `ai_calls` carried the cost.

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

### Routing options

```typescript
const ai = createAIHelper(topic, aiLogger, undefined, undefined, {
  routing: {
    priceHeadroom: 1.25,       // max_price = registry price × 1.25 (default). 0 omits max_price.
    sort: "throughput",        // default
    requireParameters: true,   // default; false lets OpenRouter route to providers that ignore e.g. response_format
  },
});
```

`max_price` is an exclusive filter on OpenRouter's side — a request whose price ceiling is below the live price fails outright rather than costing more — so the default headroom absorbs ordinary price drift between `workflow-engine-sync` runs. Child helpers inherit the options.

## AIHelper Interface

```typescript
interface AIHelper {
  readonly topic: string;

  generateText(modelKey, prompt, options?): Promise<AITextResult>;
  generateObject(modelKey, prompt, schema, options?): Promise<AIObjectResult>;
  embed(modelKey, text, options?): Promise<AIEmbedResult>;
  streamText(modelKey, input, options?): AIStreamResult;
  batch<T = string>(modelKey, provider?, options?): AIBatch<T>;

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

`maxRetries` and `abortSignal` (v0.11+) are also available on `generateObject` and `streamText` options — see below. They are not available on `embed()` options.

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

## Reasoning Models & Provider Options

Reasoning models (e.g. `anthropic/claude-opus-4.x`, OpenRouter reasoning models) emit
on a **separate reasoning channel**. Two facts drive how you use them here:

1. **The answer (`text`) and the reasoning are different channels.** A model can reason
   *and* answer, or reason *instead of* answering. When it reasons instead of answering,
   the text channel — including the buffered `result.text` — is genuinely empty; the
   content is in the reasoning channel.
2. **Control reasoning per call with `providerOptions`.** This is the standard lever and
   is forwarded by `generateText`, `generateObject`, and `streamText` (just like `embed`).

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

Submit batch operations for asynchronous execution with model-specific batch discounts.

```typescript
const batch = ai.batch<OutputType>("claude-sonnet-4-20250514", "anthropic");
// Or using OpenRouter with injected credentials:
// const batch = ai.batch<OutputType>("openai/gpt-4o", "openrouter", { apiKey: "..." });

// Submit requests (AIBatchRequest accepts optional maxTokens, system, temperature, and schema)
const handle = await batch.submit([
  { id: "req-1", prompt: "Summarize: ...", maxTokens: 2000 },
  { id: "req-2", prompt: "Summarize: ...", schema: SummarySchema, system: "You are a concise summarizer." },
]);

console.log(handle.id);       // Primary batch ID (string)
console.log(handle.status);   // "pending"
console.log(handle.provider); // "anthropic"
console.log(handle.refs);     // EngineBatchRef[] (persist in suspendedState.metadata.batchRefs)

// Check status
const status = await batch.getStatus(handle.id);
// { id: "...", status: "pending" | "processing" | "completed" | "failed", provider: "anthropic", ... }

// Get results (when completed)
// Pass metadata with batchRefs for fan-in, and re-supply schemas to validate structured output
const results = await batch.getResults(handle.id, {
  batchRefs: handle.refs,
  schemas: { "req-2": SummarySchema },
});
// [
//   { id: "req-1", result: "...", inputTokens: 100, outputTokens: 50, status: "succeeded", validated: false },
//   { id: "req-2", result: { parsed: "object" }, inputTokens: 100, outputTokens: 50, status: "succeeded", validated: true },
// ]

// Check if already recorded (avoid duplicate logging)
const recorded = await batch.isRecorded(handle.id);
```

### Batch Options & Injected Credentials

`ai.batch()` accepts an optional `BatchOptions` configuration as its third argument:

```typescript
interface BatchOptions {
  apiKey?: string;              // Injected API key (crucial for edge/serverless without process.env)
  baseURL?: string;             // Custom endpoint base URL
  fetch?: typeof globalThis.fetch;
  endpoint?: "/v1/chat/completions" | "/v1/responses" | "/v1/messages" | "/v1/embeddings";
  maxRequestsPerBatch?: number; // Request chunk size per upstream batch (default: 500)
  maxPartitions?: number;       // Maximum allowed partition count (default: 20)
}
```

### Batch Request Configuration (`AIBatchRequest`)

```typescript
interface AIBatchRequest {
  id: string;
  prompt: string;
  schema?: z.ZodTypeAny;
  maxTokens?: number;      // Output token ceiling (defaults to model's maxCompletionTokens)
  system?: string;         // System prompt
  temperature?: number;    // Sampling temperature
}
```

`maxTokens` defaults to the model's `maxCompletionTokens` from the model registry.

### Cross-Process Result Checking: Re-supplying `schema`s & `validated`

Zod schemas are JavaScript objects and cannot round-trip JSON serialization across workflow suspend/resume. 

When retrieving results from a resumed stage:
- **With re-supplied schemas:** Pass `{ schemas: { [requestId]: schema } }` to `getResults(batchId, metadata)`. Responses are validated against the schema and returned with `validated: true`. If parsing or validation fails, the item returns `status: "failed"`.
- **Without re-supplied schemas:** Results return the raw parsed JSON or text with `validated: false`. A `WARN` is logged indicating unvalidated results.

```typescript
// submit() -- initial execution
const handle = await batch.submit([
  { id: "req-1", prompt: "...", schema: ItemSchema },
]);

// getResults() -- after resume in checkCompletion()
const results = await batch.getResults(handle.id, {
  batchRefs: suspendedState.metadata?.batchRefs,
  schemas: { "req-1": ItemSchema },
});
```

### Batch Providers

Batch processing runs through AI SDK batch providers or OpenRouter's Batch API:

| Provider | Description | Required Dependencies |
|----------|-------------|-----------------------|
| `google` | Gemini models via AI SDK | `@ai-sdk/google` (included by default) |
| `anthropic` | Claude models via AI SDK | `@ai-sdk/anthropic` (optional peer >=4.0.46) |
| `openai` | OpenAI models via AI SDK | `@ai-sdk/openai` (optional peer >=4.0.53) |
| `openrouter` | OpenRouter Batch API (HTTP) | None (uses direct fetch) |

> **Pricing Note:** Batch pricing is per-model (read from `batchInputCostPerMillion` / `batchOutputCostPerMillion` in the catalog), not a flat 50% discount. Many models are discounted by 50% or 75%, while some may differ.

```typescript
// Provider auto-detected based on model
const batch = ai.batch("claude-sonnet-4-20250514");  // Uses anthropic

// Or specify explicitly
const batch = ai.batch("gemini-2.5-flash", "google");
const openrouterBatch = ai.batch("openai/gpt-4o", "openrouter", { apiKey: myKey });
```

If no provider is specified and the model has no known batch-capable provider, `ai.batch()` **throws an error immediately** with an actionable message.

### OpenRouter Batch Transport Caveats

- **Text only:** Multimodal inputs (images, audio, video, files) are rejected.
- **24-hour expiration without partial recovery:** OpenRouter returns `results: null` if a batch expires at 24 hours. No partial results are recoverable. Batches are automatically partitioned into chunks of `maxRequestsPerBatch` (default: 500) to bound risk.
- **No cancel or list endpoint:** OpenRouter batch API does not support remote cancellation or listing batches.
- **No idempotency key:** POST submissions are not auto-retried.
- **Schema partitioning:** Google models require all requests in a single batch to share the exact same response schema; `submit()` handles this by partitioning requests by schema automatically.

### Partial submit failure

A `submit()` may fan out into several upstream batches. If a later one fails after earlier ones were created, those batches keep running and bill the account, so the error carries their refs:

```typescript
import { BatchSubmitError } from "@bratsos/workflow-engine";

try {
  await batch.submit(requests);
} catch (err) {
  if (err instanceof BatchSubmitError) {
    // Persist err.createdRefs so the surviving batches can be polled and drained:
    await batch.getStatus(err.createdRefs[0].id, { batchRefs: err.createdRefs });
  }
  throw err;
}
```

The POST is never retried automatically — there is no idempotency key on the batch APIs, so a retry would create and bill a second batch.

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

## Provider-Reported Cost

Every result carries two cost numbers since 0.13:

```typescript
const { text, cost, reportedCostUsd, costSource } = await ai.generateText(modelKey, prompt);
// cost            - the best available number; what gets recorded
// reportedCostUsd - the provider's own figure, when it reports one (OpenRouter does)
// costSource      - "reported" | "estimated"
```

`cost` prefers the provider's figure and falls back to the static price table (`inputCostPerMillion` / `outputCostPerMillion`, plus `longContextTier` above its threshold). `AIObjectResult`, `AIEmbedResult`, and the stream's `getUsage()` carry the same fields.

Under BYOK the provider's `cost` is only the routing fee and the inference spend arrives separately as `upstream_inference_cost`; the engine adds it in that case and not otherwise, so the recorded number is the real spend either way. When a call is estimated, `costSource === "estimated"` tells you the number came from the registry, not the bill.

Batch cost follows the transport actually used: a native google/anthropic/openai batch bills the vendor's documented discount (`batchDiscountPercent`), the OpenRouter transport bills the absolute price of the `:batch` catalog row (`batchInputCostPerMillion` / `batchOutputCostPerMillion`).

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
const flashModels = listModels({ isEmbeddingModel: true });
```

### Register Custom Models

```typescript
import { registerModels } from "@bratsos/workflow-engine";

registerModels({
  "my-custom-model": {
    id: "openrouter/my-model",
    name: "My Custom Model",
    provider: "openrouter",
    inputCostPerMillion: 0.5,
    outputCostPerMillion: 1.0,
    contextLength: 128000,
    maxCompletionTokens: 4096,
    supportsTools: true,
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

## Result Types

```typescript
interface AITextResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
  cost: number;
  output?: any;       // Present when `output` is used
  reasoning?: string; // Reasoning/thinking text, when the model emitted any
}

interface AIObjectResult<T> {
  object: T;
  inputTokens: number;
  outputTokens: number;
  cost: number;
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
  getUsage(): Promise<{ inputTokens, outputTokens, cost }>;
  getText(): Promise<string>;                  // Full answer text, reconciled with the buffered result
  getReasoning(): Promise<string | undefined>; // Reasoning/thinking text, when the model emitted any
  rawResult: AISDKStreamResult;
}

// v0.11+: discriminated union -- `result` only exists on "succeeded",
// `error` only exists on "failed". Check `status` before reading either.
// v0.13+: `validated` indicates whether the result was validated against a re-supplied schema.
type AIBatchResult<T = string> =
  | {
      id: string;
      prompt: string;
      result: T;              // unvalidated parsed JSON/string unless a schema was re-supplied at retrieval time
      inputTokens: number;
      outputTokens: number;
      status: "succeeded";
      error?: undefined;
      validated?: boolean;    // true only when schema was re-supplied and validated; false/undefined otherwise
    }
  | {
      id: string;
      prompt: string;
      result?: undefined;     // no result on failure -- do not read this
      inputTokens: number;
      outputTokens: number;
      status: "failed";
      error: string;
      validated?: boolean;    // always false on failed requests
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
    name: "Fast Model",
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
