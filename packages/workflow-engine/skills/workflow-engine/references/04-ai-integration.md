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
    // ctx.ai is an AIHelper already scoped to
    // `workflow.${ctx.workflowRunId}.stage.${ctx.stageId}` (built lazily from
    // createKernel({ services: { aiLogger } })). ctx.step.ai.* is the durable form.
    const { text } = await ctx.ai.generateText("gemini-2.5-flash", prompt);

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

// Inside a stage (preferred): ctx.ai, already scoped to this run and stage
const { text } = await ctx.ai.generateText("gemini-2.5-flash", prompt);
```

Inside a stage, `ctx.ai` / `ctx.aiLogger` come from `createKernel({ services: { aiLogger, ai? } })`; `services.ai` is an `AIHelperFactory` with `createAIHelper`'s signature, which is where a `providerResolver` or `AIHelperOptions` for every stage helper goes. Accessing `ctx.ai` without services throws `AIServicesNotConfiguredError`.

### Helper options: routing, adapter, timeout

```typescript
const ai = createAIHelper(topic, aiLogger, undefined, undefined, {
  routing: {
    priceHeadroom: 1.25,       // max_price = registry price × 1.25 (default). 0 omits max_price.
    sort: "throughput",        // default
    requireParameters: true,   // default; false lets OpenRouter route to providers that ignore e.g. response_format
  },
  adapter: myAdapter,          // optional AIAdapter: swaps the transport for any subset of generateText/generateObject/embed/streamText, below logging and cost
  timeout: { perCallMs: 60_000 }, // optional default per-call timeout; expiry throws AICallTimeoutError and still logs the failure row
});
```

Per-call `timeoutMs` on text, object, embed and stream options overrides `timeout.perCallMs`. Both must be a number of milliseconds from 1 to 2147483647 (the longest delay a timer honours, about 24.8 days); anything else (`0`, `NaN`, `Infinity`, a negative number, a larger value) throws a `RangeError` naming the option before any request is made (`timeout.perCallMs` when the helper is created); leave both out for no deadline. An adapter response may carry `costUsd`, recorded as the reported cost; `AIStreamResult.rawResult` is `undefined` when the stream came from an adapter. Child helpers inherit all three options.

OpenRouter's "No endpoints found that can handle the requested parameters" is the outcome of `requireParameters: true` excluding endpoints that ignore a requested parameter (typically `maxTokens`); the error names `routing: { requireParameters: false }` as the change to make.

Set `routing.provider` with `only` (provider slugs), `order`, `allowFallbacks` and `dataCollection` (`"allow"` or `"deny"`) to apply an upstream policy to a helper and its children. Built-in OpenRouter calls intersect per-call and helper allow-lists, follow the stricter privacy and fallback settings, and preserve compatible extra restrictions such as `zdr`. Rankings are compared on eligible providers after allowlists and exclusions. An unordered no-fallback policy permits one endpoint, so a compatible singleton order becomes an allowlist with fallbacks disabled and a multi-provider order fails before submission. Direct built-in calls, including transcription and native batches, check their vendor against `only` when set. They reject `dataCollection: "deny"` and an excluded vendor when `order` is set and fallbacks are disabled.

The helper preserves an eligible regional preference within a variant such as `baseten/fp4/us` within `baseten/fp4`. OpenRouter text batches and native-to-OpenRouter fallbacks send allowlists and fallback settings at the top level. A single eligible regional preference can be pinned there with fallbacks disabled. The helper refuses rankings that need multiple eligible providers or backups, data-collection denial, and provider restrictions on the embeddings batch endpoint. [OpenRouter endpoint matching](https://openrouter.ai/docs/guides/routing/provider-selection#base-slug-matching), [OpenRouter Batch Quickstart](https://openrouter.ai/docs/batch-quickstart#choose-a-provider)

Each batch submission checks the helper policy against the transport building the request. Stored refs select the transport for a poll, collection, or cancellation of that batch, and the client keeps that transport for its later calls, including new submissions. A call fixes its transport when it starts, so a concurrent call cannot change where it sends or which provider it is checked as.

The `providerResolver` and the factories registered with `registerEmbeddingProvider`, `registerEvaluationProvider` and `registerTranscriptionProvider` receive the policy as their second argument and must honour it. Calls handled by an `AIAdapter` refuse a configured provider policy.

`max_price` is an exclusive filter on OpenRouter's side — a request whose price ceiling is below the live price fails outright rather than costing more — so the default headroom absorbs ordinary price drift between `workflow-engine-sync` runs. It bounds the per-token price of a routed call, not spend, and not the non-token charges OpenRouter documents as uncovered.

## Call attribution, text retention, and pending writes

Set `AIHelperOptions.attribution` to attach an opaque `tenantId` and string
`labels` to calls made by a standalone helper. Stage helpers inherit both from
the run and also record the workflow run ID. A custom `KernelServices.ai`
factory must forward its fifth argument to `createAIHelper`.

```typescript
const ai = createAIHelper("requests", logger, undefined, undefined, {
  attribution: { tenantId: "tenant-a", labels: { queue: "interactive" } },
  text: { store: "none" },
  onLogError: (_error, call) => countFailedWrite(call.callType),
});

const worker = ai.createChild("worker", "1", {
  attribution: { labels: { queue: "background" } },
  text: { store: "full", ttlMs: 86_400_000 },
});
```

Child helpers inherit the tenant and merge labels by key. A child text policy
inherits the parent's TTL when omitted. The default stores full text without
expiry. `store: "none"` leaves the prompt and response empty and drops stream
instructions from the accounting row. Direct `ctx.aiLogger` writes share the
stage helper's attribution and text policy, including with custom loggers.
A full-text TTL sets `textExpiresAt` on the row so
`engine.prune({ aiCallText: { now } })` can clear it when due. Trace output
requires `WORKFLOW_ENGINE_TRACE_TEXT=1` in addition to
`WORKFLOW_ENGINE_TRACE=1` to include request, response, and error text.

The Prisma logger's `costByTenant({ tenantId, from, to, groupBy })` returns the
total USD cost in the half-open period `[from, to)`. With a label key in
`groupBy`, it also returns `groups` of `{ label, cost }`. A null group
contains rows without the selected label.

Use `recordCall` with `callType: "realtime"` for externally handled sessions
and pass their USD `cost`. A supplied cost bypasses the model registry and
uses the supplied `modelKey` as the recorded model ID. It defaults to
`costSource: "reported"`; set `"estimated"` for a supplied estimate.

Failed calls report safe diagnostics to callers and workflow history,
including errors read from the SDK stream result (`rawResult`). Detailed
provider warnings and error text require both trace flags.
Use those flags only for data you intend to send to process diagnostics.

The accounting policy covers the prompt, response and top-level instructions.
Keep opaque caller metadata free of content that needs that same lifecycle.
Workflow inputs and outputs, durable step results and repair data, blobs,
events, application logs and annotations each have their own lifecycle. The
console can display those workflow copies. This also applies to manually
persisted SDK or batch results. Apply a privacy guarantee after all writers
use the policy and you have addressed historical rows.

At the end of a request, `await ai.flush({ timeoutMs: 5_000 })` returns
`{ failed, pending }`. Failed writes are cumulative for that helper and its
children. Pending includes open streams and writes still in progress when
the timeout expires. A write the database refuses reaches `onLogError`. A
caller that awaits a `ctx.aiLogger` write gets a rejection with a safe
message; an ignored one is handled, and the Prisma logger logs a warning. `getResults` records a batch before it returns, as before, and
rejects if that write fails; `recordResults` retries it. A batch's rows are
written together on both SQLite and PostgreSQL.

Stage helpers do not wait for their accounting writes, so stage outcomes,
retries and deadlines do not depend on them. Run totals sum the ledger rows
under the run's topic, `workflow.<runId>`, when the run ends: a write still in
flight at that moment, or one written with another topic, is not counted. A
worker that exits before a write lands loses that row.
`kernel.flush({ timeoutMs })` waits for the configured logger's pending
writes within its own bound. The Node host calls it during shutdown and the
serverless host calls it after the invocation's work settles.

## AIHelper Interface

```typescript
interface AIHelper {
  readonly topic: string;

  generateText(modelKey, prompt, options?): Promise<AITextResult>;
  generateObject(modelKey, prompt, schema, options?): Promise<AIObjectResult>;
  embed(modelKey, text, options?): Promise<AIEmbedResult>;
  streamText(modelKey, input, options?): AIStreamResult;
  evaluate(modelKey, { state, questions }, options?): Promise<AIEvaluateResult>;
  transcribe(modelKey, audio, options?): Promise<AITranscribeResult>;
  batch<T = string>(modelKey, provider?, options?): AIBatch<T>;

  createChild(segment, id?): AIHelper;
  recordCall(params): void;
  flush(options?: { timeoutMs?: number }): Promise<{ failed: number; pending: number }>;
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
    temperature: 0.7,   // 0-2; sent only when set, else the provider default
    maxTokens: 1000,    // Max output tokens
    maxRetries: 2,       // v0.11+: forwarded to the AI SDK call
    abortSignal: ctx.abortSignal, // v0.11+: forwarded to the AI SDK call; inside a stage pass ctx.abortSignal so run.cancel interrupts the call
    timeoutMs: 30_000,   // 1.0: per-call timeout, overrides AIHelperOptions.timeout.perCallMs; throws AICallTimeoutError
  }
);

console.log(result.text);           // Generated text
console.log(result.inputTokens);    // Token count
console.log(result.outputTokens);
console.log(result.cost);           // Calculated cost
```

`maxRetries` and `abortSignal` (v0.11+) are also available on `generateObject` and `streamText` options — see below. `embed()` options take `abortSignal` and `timeoutMs` but not `maxRetries`.

No default `temperature` is sent by any call (`generateText`, `generateObject`, `streamText`, `ctx.step.ai.*`, `map`, the batch bodies): the provider's own default applies unless you set one. `generateObject` and `generateText` + `Output.object` send identical requests.

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

### Structured output portability

The JSON Schema a Zod schema emits is not what every provider accepts: `z.discriminatedUnion` emits `oneOf`, which OpenAI's strict structured outputs (native, and through OpenRouter) reject with `'oneOf' is not permitted`, and which Gemini silently drops (the union comes back as a flat object). The helper rewrites the schema at the model boundary for every OpenAI, OpenRouter and Google model — `oneOf` → `anyOf`, plus, for OpenAI, `additionalProperties: false` on every object, no `$schema`, and every property listed in `required` (OpenAI strict rejects a `required` that omits a key; an optional, non-nullable property is sent as `anyOf: [<original>, { type: "null" }]`) — through an AI SDK middleware, so `generateObject`, `generateText` + `Output.object`, `streamText`, `ctx.step.ai.*` and the batch bodies all send a portable schema while validation still runs against your Zod schema. On OpenAI targets the reply's `null` for a property that is `.optional()` and not `.nullable()` in your schema is removed before validation (nested objects, arrays and union members included), so `z.string().optional()` stays `string | undefined` on your side; a `null` your schema admits is kept. OpenAI strict has no map type either — it permits neither `propertyNames` nor a schema-valued `additionalProperties`, which is what `z.record()` emits — so a record is sent as an array of `{ key, value }` objects (an enum key constraint stays on `key`) and rebuilt into the object before validation (last duplicate key wins); a `z.looseObject`/`.catchall()` is sent closed. Records nested in objects, arrays, union branches and `$defs` are covered, and an optional record is nullable like any optional property. Both inverse steps are one pass, `restorePortableValue(value, jsonSchema)` (exported alongside `toPortableJsonSchema`; `stripOptionalNulls` remains as an alias). A schema feature strict mode still cannot express and the engine has no rewrite for (`patternProperties`, `if`/`then`/`else`, `not`, `uniqueItems`, `contains`, `minProperties`, `dependentSchemas`, ...) fails at the engine boundary with `UnportableSchemaError` naming the JSON path and the keyword, before any request — a realtime call throws it, a batch submit fails with it — instead of a provider 400 per item. Gemini expresses records natively and is left alone. A model from a `providerResolver` is classified by its provider id (`openai…`, `openrouter…`, `google…`); anything else (Anthropic, a custom provider) is sent as emitted. `toPortableJsonSchema(jsonSchema, "openai" | "google")` is exported for a transport of your own.

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

## evaluate

Answer typed questions about one shared state with a **decision model** — a
model whose output is a typed judgment with probabilities rather than text.
TypeSafe's Jev (`typesafe/jev-1.13`, `~typesafe/jev-latest`) is the first, served
through OpenRouter's Decisions API. Use it for routing, classification,
moderation and other decision points where a fast, calibrated answer matters
more than prose.

```typescript
const result = await ai.evaluate("typesafe/jev-1.13", {
  state: { ticket: { subject, body } },
  questions: {
    team: {
      type: "choice",
      instructions: "Which team should handle `ticket`?",
      criteria: {
        billing: "Charges, refunds and invoices.",
        engineering: "Bugs, errors and outages.",
      },
    },
    outage: {
      type: "boolean",
      instructions: "Does `ticket` report a problem affecting many customers?",
    },
    severity: {
      type: "score",
      instructions: "How severe is `ticket`?",
      criteria: ["Cosmetic.", "Degraded for some users.", "Down for everyone."],
    },
  },
});

result.answers.team.choice;        // "billing" | "engineering"
result.answers.team.probabilities; // { billing: 0, engineering: 1 }
result.answers.team.confidence;    // 0.99
result.answers.outage.probability; // 0.97 — P(true), not a confidence
result.answers.severity.score;     // 2 — position on the scale, 0-based
result.answers.severity.legend;    // { "0": "Cosmetic.", ... }
```

**Question types.**

| `type` | `criteria` | Answer |
|---|---|---|
| `choice` | option name → description | `choice` (one of the option names), `probabilities`, `confidence?` |
| `score` | ordered levels, lowest first (at least two) | `score` (fractional position), `probabilities` keyed `"0"`, `"1"`, ..., `confidence?`, `legend?` |
| `boolean` | optional `{ true, false }`; give both or neither | `probability` that the statement is true |

`state`, `instructions` and each criterion accept text, a JSON object or a JSON
array. Every question is answered against the same `state` in one call.

**Typed answers.** Each answer's type follows from its own question: a `choice`
answer's `choice` is the union of that question's criteria keys. This works on
an inline object literal — no `as const` needed.

**Models.** Only a registry entry with `isEvaluationModel: true` can answer;
any other model throws before a request is made. `workflow-engine-sync` sets
the flag for every model whose OpenRouter output modality is `decisions`
(re-run it if a synced registry predates the flag). Decision models cannot
generate text.

**Transport and routing.** The built-in path is `openrouter.evaluationModel(id)`
from `@openrouter/ai-sdk-provider`, called through the AI SDK's `evaluate`. It
carries the same `max_price` guard as every other OpenRouter call (registry
price × `routing.priceHeadroom`). `registerEvaluationProvider(provider, factory)`
plugs in any other AI SDK evaluation model, the way `registerEmbeddingProvider`
does for embeddings.

**Cost.** Decision models bill input tokens only. The row is logged with
`callType: "evaluate"`, and OpenRouter's reported `usage.cost` is the recorded
cost (`costSource: "reported"`), with the registry's input price as the
fallback estimate.

**Options.** `abortSignal`, `timeoutMs`, `maxRetries` (default 2),
`headers`, `providerOptions`. There is no batch path for decision models.

Inside a stage use `ctx.step.ai.evaluate(id, model, { state, questions })`
(see 12-durable-steps.md), which memoises the answers so a replay takes the
same branch.

## transcribe

Speech to text through the AI SDK's `transcribe`.

```typescript
import { registerModels } from "@bratsos/workflow-engine";

registerModels({
  "whisper-1": {
    id: "whisper-1",
    name: "Whisper",
    provider: "openai",                 // needs @ai-sdk/openai installed
    isTranscriptionModel: true,
    transcriptionCostPerMinute: 0.006,  // billed per minute of audio
    inputCostPerMillion: 0,
    outputCostPerMillion: 0,
  },
  "gemini-transcribe": {
    id: "gemini-3.5-transcribe",
    name: "Gemini Transcribe",
    provider: "google",
    isTranscriptionModel: true,
    inputCostPerMillion: 1,             // billed per token, from reported usage
    outputCostPerMillion: 4,
  },
});

const result = await ai.transcribe("whisper-1", audioBytes);
// or: await ai.transcribe("whisper-1", new URL("https://.../interview.mp3"));

result.text;              // the transcript
result.segments;          // [{ text, startSecond, endSecond }], when returned
result.language;          // "en", when reported
result.durationInSeconds; // 90, when reported
result.cost;
```

**Audio.** A `Uint8Array`, `ArrayBuffer`, base64 string, or a `URL` the AI SDK
downloads first (2 GiB default limit). Providers have their own size limits
(OpenAI's is 25 MB); split long recordings before transcribing.

**Models.** Only a registry entry with `isTranscriptionModel: true` can answer;
any other model throws before a request is made. Transcription models are not
in OpenRouter's catalogue, so `workflow-engine-sync` does not produce them;
register them by hand. Built-in providers are `"openai"` (`openai.transcription`,
from the optional `@ai-sdk/openai` peer) and `"google"` (`google.transcription`).
`registerTranscriptionProvider(provider, factory)` plugs in any other AI SDK
transcription model (Groq, Deepgram, ElevenLabs, AssemblyAI, ...):

```typescript
import { registerTranscriptionProvider } from "@bratsos/workflow-engine";
import { groq } from "@ai-sdk/groq";

registerTranscriptionProvider("groq", (id) => groq.transcription(id));
```

**Cost.** Providers bill one of two ways, and the estimate follows whichever
the provider reports: per minute of audio (`durationInSeconds` times
`transcriptionCostPerMinute`; OpenAI) or per token (the reported usage priced
at `inputCostPerMillion` / `outputCostPerMillion`; Google reports
`total_input_tokens` / `total_output_tokens` in its metadata). The row is
logged with `callType: "transcribe"`, the reported tokens, and a description
of the audio (its URL or byte size) as the prompt; the audio itself is never
logged.

**Options.** `abortSignal`, `timeoutMs`, `maxRetries` (default 2),
`headers`, `providerOptions` (for example
`{ openai: { language: "en", timestampGranularities: ["segment"] } }`).

Inside a stage use `ctx.step.ai.transcribe(id, model, audio)` (see
12-durable-steps.md), which memoises the transcript so a replay neither
re-sends the audio nor pays for it again.

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

// Or use raw AI SDK result for UI streaming (undefined when an AIAdapter supplied the stream)
const response = result.rawResult?.toUIMessageStreamResponse();
```

Inside a stage, `ctx.step.ai.streamText(id, model, prompt, options?, stepOptions?)` is the durable form: it streams on the first execution and a replay returns the stored text without contacting the model (see 12-durable-steps.md).

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

// Check status -- pass the same metadata (batchRefs) getResults takes, so a partitioned
// submit is polled across every upstream batch it fanned out into
const status = await batch.getStatus(handle.id, { batchRefs: handle.refs });
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

// Cancel at the provider (every batch of the handle that has not ended).
// Resolves to [{ ref, outcome: "cancelled" | "already-terminal" | "unsupported" }];
// tries every batch, then throws the first error if a call failed.
const cancelled = await batch.cancel?.(handle.id, { batchRefs: handle.refs });

// Check if already recorded (avoid duplicate logging)
const recorded = await batch.isRecorded(handle.id);
```

### Cancelling batches

`EngineBatchModel.cancel?(ref, opts)` is optional on the transport. It returns `{ outcome: "cancelled" | "already-terminal", rawStatus? }`: it reads the batch, sends the provider's cancel only to one still running, and reports a batch that is already cancelling, cancelled or ended without sending a second call. It throws when the provider rejects the call.

| Transport | Cancel call |
|---|---|
| `openai` | `POST /v1/batches/{id}/cancel` (`cancelling` for up to 10 minutes, then `cancelled`) |
| `anthropic` | `POST /v1/messages/batches/{id}/cancel` (`canceling`, then `ended`) |
| `google` | `POST /v1beta/batches/{name}:cancel` (best effort, then `JOB_STATE_CANCELLED`) |
| `openrouter` | none: the batch API documents "no cancel endpoint yet", so the model has no `cancel` |

The vendor transports call the vendor SDK's `doCancelBatch`; a vendor release without it leaves `cancel` out. `run.cancel` uses this to cancel the batches a run created (see `06-async-batch-stages.md` and the docs page *Batch Operations → Cancelling a run*). Its per-batch outcomes are `cancelled`, `already-terminal`, `unsupported` (no `cancel` on the transport), `unavailable` (no transport could be built in that process), `failed`, `unrecorded` (a submit step holds no batch handle; the outcome carries its `externalKey`) and `unverified` (the engine cannot prove it created the handle, so it is left alone).

`resolveBatchModelForRef(ref, options?)` builds the built-in transport a stored ref names, with credentials from `options` or the environment, for a process that did not create the batch. The kernel uses it unless `createKernel({ services: { batchModels } })` supplies another resolver `(ref) => EngineBatchModel | undefined`.

A batch that is cancelling or cancelled is never adopted: `adopt()` skips it, so a redrive after a cancel creates a new batch. `EngineBatchStatus.cancelled` is `true` when the provider reports a batch cancelling or cancelled (Anthropic reports a cancelled batch as `ended`; its cancel timestamp is what says so). A submit step whose `run.cancel` sweep may have sent a cancel and died before recording the answer (the row's `cancelIntent`) sends the cancel again through `AIBatch.cancel` before it does anything, and goes on from the answer, never from an active status alone.

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
  abortSignal?: AbortSignal;    // Cancels every provider call this handle makes (submit, status polls, result fetches)
}
```

Polling, collecting and cancelling use the provider named by the saved refs, carry the current client options, and leave the client on that provider for later calls. With a provider policy, a noncanonical `baseURL` for a provider other than the configured one makes reads use its default URL and environment credential and refuses submissions through it. A matching or unset URL preserves the inline key. The injected `fetch` applies in every case.

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

The native transports work with every release of the vendor packages. Earlier releases put the batch methods on the language model (`experimental_doStartBatch` and siblings); `@ai-sdk/google` 4.0.65 and the current `@ai-sdk/openai` / `@ai-sdk/anthropic` moved them to the provider (`provider.experimental_batch()`). The engine drives whichever seam the installed release exposes, and the HTTP requests are the same either way, so crash recovery and Google's schema substitution behave identically.

> **Pricing Note:** Batch pricing is per-model (read from `batchInputCostPerMillion` / `batchOutputCostPerMillion` in the catalog), not a flat 50% discount. Many models are discounted by 50% or 75%, while some may differ.

```typescript
// Provider auto-detected based on model
const batch = ai.batch("claude-sonnet-4-20250514");  // Uses anthropic

// Or specify explicitly
const batch = ai.batch("gemini-2.5-flash", "google");
const openrouterBatch = ai.batch("openai/gpt-4o", "openrouter", { apiKey: myKey });
```

Resolution order: the call's explicit provider, then the model's registry field `batchProvider` (`"openrouter" | "google" | "anthropic" | "openai"`), then the slug's native vendor, then OpenRouter. A model whose `batchProvider` is `"openrouter"` is batched there even without a catalog `:batch` row. If none of those yields a provider, `ai.batch()` throws. If the native SDK is absent or exposes neither batch interface and OpenRouter supports the model, automatic fallback logs a WARN and carries the client options. With a provider policy, fallback accepts an unset `baseURL` or `https://openrouter.ai/api/v1`. Other URLs cause refusal before fetch. The canonical URL checks ignore host case and trailing slashes.

**Idempotent submits.** A `submit()` replayed after a crash (a durable `run` step whose lease expired) can create and bill a second batch. Inside `ctx.step.ai.map` the OpenAI and Google adapters stamp the step's external key into the batch (`metadata` / `displayName`) and a reclaimed submit adopts the batch it finds; Anthropic and OpenRouter carry no such field, so a reclaimed submit there throws `BatchNotAdoptableError` unless `batch: { onReclaim: "resubmit" }` accepts the duplicate cost. See 12-durable-steps.md.

### OpenRouter Batch Transport Caveats

- **Text only:** Multimodal inputs (images, audio, video, files) are rejected.
- **24-hour expiration without partial recovery:** OpenRouter returns `results: null` if a batch expires at 24 hours. No partial results are recoverable. Batches are automatically partitioned into chunks of `maxRequestsPerBatch` (default: 500) to bound risk.
- **No cancel or list endpoint:** OpenRouter batch API does not support remote cancellation or listing batches. `run.cancel` reports an OpenRouter batch as `unsupported` and the batch keeps running and billing.
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

Record AI calls made outside the helper (e.g., direct SDK usage). Only the object form exists; the positional `recordCall(modelKey, prompt, response, tokens, options)` overload was removed at 1.0.

```typescript
ai.recordCall({
  modelKey: "gemini-2.5-flash",
  callType: "text",
  prompt: "...",
  response: "...",
  inputTokens: 100,
  outputTokens: 50,
  metadata: { custom: "data" },
});
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

`aiLogger.listCalls(topicPrefix)` reads rows by literal topic prefix on SQLite and PostgreSQL, including when the Prisma client exposes only one raw-read method.

Every result carries two cost numbers since 0.13:

```typescript
const { text, cost, reportedCostUsd, costSource } = await ai.generateText(modelKey, prompt);
// cost            - the best available number; what gets recorded
// reportedCostUsd - the provider's own figure, when it reports one (OpenRouter does)
// costSource      - "reported" | "estimated"
```

`cost` prefers the provider's figure and falls back to the static price table (`inputCostPerMillion` / `outputCostPerMillion`, plus `longContextTier` above its threshold). `AIObjectResult`, `AIEmbedResult`, and the stream's `getUsage()` carry the same fields.

Under BYOK the provider's `cost` is only the routing fee and the inference spend arrives separately as `upstream_inference_cost`; the engine adds it in that case and not otherwise, so the recorded number is the real spend either way. When a call is estimated, `costSource === "estimated"` tells you the number came from the registry, not the bill.

### What the `ai_calls` row records

Every call row (`AICallRecord`, read back with `aiLogger.listCalls(topicPrefix)`) carries the accounting behind that one number, so a consumer can compare the registry against the bill after the fact:

| Field | Meaning |
|---|---|
| `cost` | The authoritative figure — `reportedCost` when the provider gave one, else `estimatedCost`. This is what `getStats` sums and what `WorkflowRun.totalCost` rolls up. |
| `estimatedCost` | The registry figure, always computed: `inputCostPerMillion` / `outputCostPerMillion` (or the long-context tier), with cached input tokens priced at `cachedInputCostPerMillion` when the registry has one. |
| `reportedCost` | The provider's own USD figure (OpenRouter's `usage.cost`, BYOK-adjusted; an adapter's `costUsd`). Absent when the provider reports none. |
| `costSource` | `"reported"` or `"estimated"` — which of the two `cost` is. |
| `servedBy` | The serving provider or comma-separated distinct providers for a multi-step call. `metadata.servedBySteps` records each provider in step order, including the steps reported before a call failed, with `null` for an unknown provider. Rows keep the billable tokens and cost when reading structured output fails or a stream callback throws. |
| `cachedInputTokens` | Input tokens served from the prompt cache. Part of `inputTokens`, not in addition to it. |
| `reasoningTokens` | Reasoning tokens the model emitted. Part of `outputTokens` and billed as output; no separate charge. |

The estimate bills `cachedInputTokens` at the model's `cachedInputCostPerMillion` (from OpenRouter's `pricing.input_cache_read`, which `workflow-engine-sync` emits when the catalogue publishes it) and the remaining input at the full rate; a registry entry without a cached rate bills every input token at the full rate. The token counts come from the AI SDK's `usage.inputTokenDetails.cacheReadTokens` / `usage.outputTokenDetails.reasoningTokens`, with OpenRouter's `promptTokensDetails.cachedTokens` / `completionTokensDetails.reasoningTokens` as the fallback. `AIHelper.recordCall` uses the registry estimate when the caller omits `cost`.

A related figure that is *not* a cost: OpenRouter's `max_price` routing guard is the registry price times `routing.priceHeadroom` (default 1.25), so the estimate and the guard read the same price table. However, a `reportedCost` above `estimatedCost × priceHeadroom` does not prove an extra charge: cache-read rates are not guarded by `max_price` and setting `priceHeadroom: 0` disables the guard entirely. Treat the comparison as a diagnostic that prompts checking the endpoint's rates, prompt caching, routing configuration, and provider fees rather than proof of an overcharge.

A tool-calling call runs several model steps and the provider reports a cost per step. `generateText`, `generateObject` and the stream's `getUsage()` sum those per-step figures into the call's `reportedCostUsd` (each step read with the same BYOK rule). The sum is used only when every step that consumed tokens reported a cost; if any such step did not, the whole call is estimated from the registry (`costSource === "estimated"`) rather than recorded as a partial bill, and the step that lacked a figure is logged at DEBUG.

Batch rows follow the same two-number rule per request. The OpenRouter transport asks for usage accounting on every request and, when a request's result carries `usage.cost`, records it as that row's `reportedCost` with `costSource: "reported"`; a request without it falls back to the batch estimate. The vendor transports (google/anthropic/openai through `@ai-sdk/*`) return tokens only in their batch results, so every row on those transports is `costSource: "estimated"`.

Batch cost follows the transport actually used: a native google/anthropic/openai batch bills the vendor's documented discount (`batchDiscountPercent`), the OpenRouter transport bills the absolute price of the `:batch` catalog row (`batchInputCostPerMillion` / `batchOutputCostPerMillion`). Exactly one adjustment is applied, never both, and there is no cached-token bucket: on a Google batch that hits the implicit cache the flat discount *overstates* the cost of the cached tokens (see 06-async-batch-stages.md). `workflow-engine-sync` now emits absolute batch prices rather than `batchDiscountPercent`.

## Model Configuration

### Available Models

```typescript
import { AVAILABLE_MODELS, getModel, listModels } from "@bratsos/workflow-engine";

// List all models
const models = listModels();
// [
//   { key: "gemini-2.5-flash", config: { id: "google/gemini-2.5-flash-preview-05-20", ... } },
//   { key: "claude-sonnet-4-20250514", config: { id: "anthropic/claude-sonnet-4-20250514", ... } },
//   ...
// ]

// Filter models (`ModelFilter`: isEmbeddingModel, supportsTools, supportsStructuredOutputs, supportsAsyncBatch)
const embeddingModels = listModels({ isEmbeddingModel: true });

// One model; throws for an unregistered key. `getModel(key).supportsAsyncBatch` is the batch-capability check
// (`getModelById`, `getRegisteredModel`, `listRegisteredModels`, `getDefaultModel`, `modelSupportsBatch`,
// `printAvailableModels`, `ModelStatsTracker` and `ModelWithRecorder` were removed at 1.0).
const model = getModel("gemini-2.5-flash");
```

`ModelKey` is open: the type accepts any string and the exported zod schema is `z.string().min(1)`, so a `schemas.config` field typed with it no longer rejects an unregistered key at `run.create`. Validation happens at `getModel()` / the first call.

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
    // Batch: supportsAsyncBatch, batchProvider ("openrouter" | "google" | "anthropic" | "openai"),
    // batchInputCostPerMillion / batchOutputCostPerMillion (absolute, preferred) or batchDiscountPercent
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
  reportedCostUsd?: number;             // provider-reported figure, when any
  costSource?: "reported" | "estimated";
  output?: any;       // Present when `output` is used
  reasoning?: string; // Reasoning/thinking text, when the model emitted any
}

interface AIObjectResult<T> {
  object: T;
  inputTokens: number;
  outputTokens: number;
  cost: number;
  reportedCostUsd?: number;
  costSource?: "reported" | "estimated";
  reasoning?: string;
}

interface AIEmbedResult {
  embedding: number[];      // First embedding
  embeddings: number[][];   // All embeddings
  dimensions: number;
  inputTokens: number;
  cost: number;
  reportedCostUsd?: number;
  costSource?: "reported" | "estimated";
}

interface AIStreamResult {
  stream: AsyncIterable<string>;
  getUsage(): Promise<{ inputTokens, outputTokens, cost, reportedCostUsd?, costSource? }>;
  getText(): Promise<string>;                  // Full answer text, reconciled with the buffered result
  getReasoning(): Promise<string | undefined>; // Reasoning/thinking text, when the model emitted any
  rawResult: AISDKStreamResult | undefined;    // undefined when an AIAdapter supplied the stream
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
