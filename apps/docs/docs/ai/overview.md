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

### Provider policy

Set `routing.provider` on the helper to apply a policy to its calls and those of its children.

```typescript
const ai = createAIHelper(topic, logger, undefined, undefined, {
  routing: {
    provider: {
      only: ["openai", "azure"],
      order: ["azure", "openai"],
      allowFallbacks: false,
      dataCollection: "deny",
    },
  },
});
```

Built-in OpenRouter text, object, streaming, embedding and evaluation calls combine the helper policy with per-call OpenRouter provider settings. Allow-lists intersect, the stricter privacy and fallback settings win, and extra restrictions such as `zdr` are preserved. The helper compares rankings after applying allowlists and exclusions. If either side disables fallbacks without an order, a compatible singleton preference becomes an allowlist with fallbacks disabled. A ranking that would require backups fails before submission.

Direct built-in calls, including transcription and native batches, require their vendor to appear in `only` when set. They also reject a provider outside `order` when fallbacks are disabled and reject `dataCollection: "deny"` because the direct transports cannot enforce that setting.

An OpenRouter variant slug such as `baseten/fp4` can include regional endpoints such as `baseten/fp4/us`. The helper preserves an eligible regional preference when it combines two rankings. [OpenRouter endpoint matching](https://openrouter.ai/docs/guides/routing/provider-selection#base-slug-matching)

OpenRouter text batches, including fallback from a native transport, send supported constraints in the top-level `provider` object. A single eligible preference with fallbacks disabled can be sent as an allowlist, including a regional endpoint. The helper refuses rankings that need multiple eligible providers or backups, data-collection denial, and provider restrictions on the embeddings batch endpoint. [OpenRouter Batch Quickstart](https://openrouter.ai/docs/batch-quickstart#choose-a-provider)

Each submission checks its provider policy against the transport that builds the batch. Polling, collecting, and cancelling a saved batch use its stored refs, and the batch client keeps that transport for its later calls, including new submissions. A call fixes its transport when it starts, so a concurrent poll does not change where an in-flight submission sends.

`providerResolver(modelConfig, policy)` and the factories registered with `registerEmbeddingProvider`, `registerEvaluationProvider` and `registerTranscriptionProvider` receive the policy as their second argument. The application is responsible for enforcing it in those models. Calls handled by an `AIAdapter` refuse a configured provider policy.

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
instructions from the accounting row, including when the logger is custom.
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

At the end of a request, `await ai.flush({ timeoutMs: 5_000 })` returns
`{ failed, pending }`. Failed writes are cumulative for that helper and its
children. Pending includes open streams and writes still in progress when
the timeout expires. Stage attempts flush before recording their outcome
using `createKernel({ aiFlushTimeoutMs })`, which defaults to five seconds.
The kernel logs a run warning with the counts if either is nonzero.
`kernel.flush()` drains the configured logger when it implements `flush`.
The Node host calls it during shutdown and the serverless host calls it
before returning from an invocation.

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
    timeoutMs: 120_000,            // per-call deadline, 1 to 2147483647 ms (else a RangeError before the call); AICallTimeoutError on expiry
  }
);

console.log(result.text);         // The generated string
console.log(result.cost);         // Calculated USD cost (e.g. 0.00015)
console.log(result.inputTokens);  // Input token count
```

A per-call `timeoutMs` and the helper-level `timeout.perCallMs` must be a number of milliseconds from `1` to `2147483647` (the longest delay a timer honours, about 24.8 days): `0`, a fraction below 1, `NaN`, `Infinity`, a negative number or a larger value throws a `RangeError` that names the option (`timeoutMs` per call, `timeout.perCallMs` when the helper is created) before any request is made, because a timer fires after 1 ms on such a value. Leave both out for no deadline.

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

### 5. `evaluate`
Answers typed questions about one shared state with a **decision model** such as TypeSafe's Jev (`typesafe/jev-1.13`, served through OpenRouter's Decisions API). Instead of text, each question comes back as a typed answer with probabilities: `choice` picks one named option, `score` places the state on an ordered scale, and `boolean` gives the probability a statement is true.

```typescript
const { answers, cost } = await ai.evaluate("typesafe/jev-1.13", {
  state: { ticket: { subject, body } },
  questions: {
    team: {
      type: "choice",
      instructions: "Which team should handle `ticket`?",
      criteria: { billing: "Charges and refunds.", engineering: "Bugs and outages." },
    },
    outage: { type: "boolean", instructions: "Does `ticket` report an outage?" },
  },
});

answers.team.choice;        // "billing" | "engineering", typed from the criteria
answers.team.confidence;    // provider confidence, when reported
answers.outage.probability; // P(true)
```

Only registry entries with `isEvaluationModel: true` can answer; `workflow-engine-sync` sets it for every model whose OpenRouter output modality is `decisions`. Decision models bill input tokens only, and OpenRouter's reported cost is recorded with the call. Inside a stage, `ctx.step.ai.evaluate(id, model, spec)` memoises the answers so a replay takes the same branch. `registerEvaluationProvider(provider, factory)` plugs in other evaluation providers.

### 6. `transcribe`
Speech to text through the AI SDK's `transcribe`, with OpenAI's (`whisper-1`, `gpt-4o-transcribe`) or Google's transcription models, or any AI SDK transcription provider registered with `registerTranscriptionProvider`.

```typescript
const { text, segments, durationInSeconds, cost } = await ai.transcribe(
  "whisper-1",
  new URL("https://example.com/interview.mp3"),
);
```

Transcription models are registered by hand with `isTranscriptionModel: true`, since OpenRouter's catalogue has none. Cost follows how the provider bills: per minute of audio (`transcriptionCostPerMinute`) when it reports a duration, or per token when it reports usage, as Google does. Inside a stage, `ctx.step.ai.transcribe(id, model, audio)` memoises the transcript so a replay does not re-send the audio.

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

`aiLogger.listCalls(topicPrefix)` reads rows by literal topic prefix on SQLite and PostgreSQL, including when the Prisma client exposes only one raw-read method.

Every AI result exposes `reportedCostUsd` (the provider's own figure, when it reports one) and `costSource` (`"reported"` or `"estimated"`). `cost` prefers the reported figure and falls back to the model registry's prices, including long-context pricing tiers. BYOK is handled correctly: the upstream inference cost is added only when the provider bills it separately. Batch cost follows the transport actually used — a native vendor batch bills the vendor's documented discount, the OpenRouter transport bills the `:batch` catalog row's absolute price.

The `ai_calls` row behind each result keeps both figures rather than the winner alone: `cost` (the authoritative number `getStats` sums and `WorkflowRun.totalCost` rolls up), `estimatedCost` (the registry figure, always computed), `reportedCost` (the provider's figure, when any), `costSource` (which of the two `cost` is), `servedBy` (the serving provider or comma-separated distinct providers), plus `cachedInputTokens` and `reasoningTokens` (breakdowns of `inputTokens` and `outputTokens`, not additions to them). The estimate prices cached input tokens at the model's `cachedInputCostPerMillion` when the registry has one (`workflow-engine-sync` emits it from OpenRouter's `input_cache_read` price) and at the full input rate otherwise; reasoning tokens are billed as output. `aiLogger.listCalls(topicPrefix)` reads the rows back. OpenRouter's `max_price` guard is the same registry price times `routing.priceHeadroom` (default 1.25). Comparing `reportedCost` against `estimatedCost × priceHeadroom` is a diagnostic, not proof of an overcharge: cache-read rates are not guarded and `priceHeadroom: 0` disables the guard, so unexpected differences should prompt checking the endpoint's rates, caching, routing, and fees.

Multi-step call rows store the provider for each step in order under `metadata.servedBySteps`. Unknown providers are represented as `null`. The row keeps the billable usage and cost reported by the SDK or adapter if reading structured output fails or a stream callback throws.

