---
sidebar_position: 2
title: Batch Operations
---

# Batch Operations

AI batch APIs (Google Batch, Anthropic Message Batches, OpenAI Batch, OpenRouter's `:batch` endpoint) offer substantial per-model discounts for non-realtime workloads. They are asynchronous: a batch takes anywhere from minutes to 24 hours.

In **workflow-engine** a batch is a [durable step](../core-concepts/durable-steps.md). `ctx.step.ai.map` submits the fan-out once, records the handle in the step ledger, suspends the stage while the provider works, polls from the host's maintenance tick, and collects the results with your schema re-applied. A crash between submit and collect resumes from the ledger rather than resubmitting. The same call runs realtime for small inputs, so one stage serves both.

The 0.x `defineAsyncBatchStage` with a hand-written `checkCompletion` is not exported from 1.0; see [Migrating from 0.13 to 1.0](../migrations/migrate-0.13-to-1.0.md) for the before/after.

---

## `ctx.step.ai.map`

One prompt per item under an execution policy, with schema validation and repair applied identically on the realtime and batch paths. Results come back in input order.

```typescript
import { defineStage } from "@bratsos/workflow-engine";
import { z } from "zod";

const AnalysisResultSchema = z.object({
  sentiment: z.enum(["positive", "negative"]),
  topics: z.array(z.string()),
});

export const batchAnalysisStage = defineStage({
  id: "batch-analysis",
  name: "Batch Analysis",
  schemas: {
    input: z.object({ items: z.array(z.object({ id: z.string(), feedback: z.string() })) }),
    output: z.object({ analysed: z.number(), failed: z.array(z.string()) }),
    config: z.object({}),
  },
  async execute(ctx) {
    const results = await ctx.step.ai.map("analyse", ctx.input.items, {
      model: "gemini-2.5-flash",
      schema: AnalysisResultSchema,
      prompt: (item) => `Analyze sentiment and extract topics: ${item.feedback}`,
      itemId: (item) => item.id,           // stable per-item step id; defaults to the index
      repair: { attempts: 1 },             // re-prompt once on a schema failure
      policy: "auto",                      // batch at or above `auto.batchAbove` items
      auto: { batchAbove: 20 },
      batch: { pollEvery: "60s", timeout: "24h", onExpiry: "fail" },
      realtime: { concurrency: 10, budget: 500, minDelayMs: "1s" },
    });

    const failed = results.filter((r) => r.status === "failed").map((r) => r.id);
    return { output: { analysed: results.length - failed.length, failed } };
  },
});
```

### The spec

| Field | Meaning |
| :--- | :--- |
| `model` | Registry key of the model to call. |
| `prompt(item, index)` | Builds the prompt for one item (string or content parts). |
| `schema?` | Zod schema each result is validated against and repaired towards. |
| `itemId?(item, index)` | Stable id used to key the item's durable step (`${id}:${itemId}`). Must be unique; `submit`, `poll` and `collect` are reserved. |
| `repair?` | `{ attempts }` re-prompts after a schema failure with the previous output and the Zod issues appended. Default `{ attempts: 1 }`. |
| `policy?` | `"auto"` (default), `"realtime"` or `"batch"`. Forcing batch on a model that cannot batch throws. |
| `auto?` | `{ batchAbove }` — item count at or above which `auto` uses batch (default 20). |
| `batch?` | `provider`, `options` (`BatchOptions`), `pollEvery` (default `"60s"`), `timeout` (default `"24h"`, non-sliding), `onExpiry: "fail" \| "partial"`, `onReclaim: "adopt" \| "resubmit"`. |
| `realtime?` | `concurrency` (default 10), `budget` (max model calls per stage invocation), `retries` (default 1), `retryDelayMs`, `minDelayMs`. |
| `stream?` | Run realtime items through `ctx.ai.streamText` and collect the text (for hosts that kill an idle connection). Ignored by the batch path. |
| `system?`, `maxTokens?`, `temperature?` | Forwarded to the model call. No default `temperature` is sent. |

### Policy resolution

`auto` uses batch when there are at least `auto.batchAbove` items, the model's registry entry has `supportsAsyncBatch`, a batch provider resolves, and every prompt is a string; otherwise realtime. The provider resolves in this order: `batch.provider` on the call, the model's `batchProvider` registry field, the native vendor (the entry's `provider` when it is `"google"`, `"anthropic"` or `"openai"`, else the vendor named by the slug), then OpenRouter. Register `batchProvider: "openrouter"` on a model you call through OpenRouter to batch it there. When a vendor SDK is not installed and OpenRouter can batch the model, the helper falls back to OpenRouter with a WARN.

Once a batch is submitted, its polls and collect go through the transport recorded in the stored refs, whatever the registry resolves later.

### Realtime path

Each item is a durable step `${id}:${itemId}` run under an in-process semaphore of `concurrency`. A thrown model call (transport, quota, timeout) is retried **in-process** — wait `retryDelayMs`, bump the ledger row's `attempt`, call again — up to `realtime.retries` times; the stage never suspends for a map item. `budget` caps model calls including repairs per stage invocation: exceeding it before an item's first call throws `AiMapBudgetExceededError`; a repair that would exceed it returns the item as failed. `minDelayMs` is the minimum spacing between calls *on one concurrency slot* (with `concurrency: 4` and `minDelayMs: "1s"`, at most four calls per second) and replaces hand-written cooldowns.

### Batch path

- **`${id}:submit`** submits the fan-out exactly once and stores the handle, refs and request ids. Because a crashed worker's re-run of a submit is the one replay that costs real money, the submit is stamped with the step's `externalKey` (OpenAI batch `metadata`, Google `displayName`), and a reclaimed submit adopts the batch already carrying that key instead of creating a second one. Anthropic Message Batches and OpenRouter have no field the engine can stamp and search, so a reclaimed submit there throws `BatchNotAdoptableError` rather than silently paying twice; `batch: { onReclaim: "resubmit" }` accepts the duplicate cost.
- **`${id}:poll`** is a `waitFor` with a stored, non-sliding deadline (`batch.timeout`).
- **`${id}:collect`** fetches results with the schemas re-supplied (so `validated` is true), stores a summary on the collect row, and writes each item's verdict to its own `${id}:${itemId}` row. Items that failed or did not validate then go through the realtime repair pass.
- Requests are partitioned per response schema (Google requires one schema per batch) and into chunks of `maxRequestsPerBatch` (OpenRouter, default 500). Structured-output schemas are rewritten per target at the model boundary (`oneOf` → `anyOf`, `additionalProperties: false` and every property `required` for OpenAI strict mode, records as `{ key, value }` arrays, Gemini's OpenAPI dialect) and the reply is transformed back before validation; a schema keyword no rewrite can express fails at submit with `UnportableSchemaError` rather than a provider error per item.
- When the batch settles with provider-side item failures the poll logs a WARN, and when more than half of a batch fails validation `getResults` logs a WARN naming the batch id and the first issue — the signal that every item is being paid for twice.

### Results

```typescript
type AiMapResult<TOut> =
  | { id: string; index: number; status: "succeeded"; result: TOut; validated: boolean;
      attempts: number; inputTokens: number; outputTokens: number; cost: number }
  | { id: string; index: number; status: "failed"; error: string; errorName?: string;
      attempts: number; inputTokens: number; outputTokens: number; cost: number };
```

**Failed items do not fail the stage.** An item whose retries and repairs are exhausted comes back as `status: "failed"` and the map still resolves; deciding what that means is the stage's job. `errorName` is the `Error.name` of the last failure (`StepTimeoutError`, `AiMapBatchFailedError`, `AiMapBatchItemFailedError`, `AiMapBatchItemMissingError`, or a transport error's name), so a caller can tell a quota error from a content failure without matching on the message. `onExpiry: "fail"` (default) throws `AiMapBatchFailedError` when the batch fails or the wait times out; `"partial"` returns every item as failed with that error instead. `cost` per item is the recorded cost summed over its attempts; batch items use the transport-aware batch price.

A new job attempt of the stage re-opens failed item rows and re-prompts them; a replay of the same attempt reports the stored verdict without a model call.

---

## Batch Providers & Options

| Provider | Description | Required Dependencies |
|----------|-------------|-----------------------|
| `google` | Gemini models via AI SDK | `@ai-sdk/google` (included by default) |
| `anthropic` | Claude models via AI SDK | `@ai-sdk/anthropic` (optional peer >=4.0.46) |
| `openai` | OpenAI models via AI SDK | `@ai-sdk/openai` (optional peer >=4.0.53) |
| `openrouter` | OpenRouter Batch API (HTTP) | None (direct fetch) |

> **Pricing:** Batch pricing is per-model (`batchInputCostPerMillion` / `batchOutputCostPerMillion` in the registry, or the OpenRouter `:batch` catalog row), not a flat 50% discount. Exactly one adjustment is applied — the batch discount never compounds with a cache discount — so on a Google batch that hits the implicit cache the flat figure *overstates* cost for the cached tokens, and OpenRouter does not discount non-token components at all.

### Injected Options (`BatchOptions`)

In edge or serverless environments where `process.env` may not exist, pass `BatchOptions` through `batch.options` (or as the third argument of `ai.batch()` when using the lower-level API):

```typescript
batch: {
  provider: "openrouter",
  options: {
    apiKey: ctx.config.openRouterApiKey,
    baseURL: "https://openrouter.ai/api/beta",
    maxRequestsPerBatch: 500,
  },
}
```

`apiKey`, `baseURL` and `fetch` are honoured by every vendor transport.

### OpenRouter Batch Transport Caveats

- **Text only:** Multimodal inputs (images, audio, video, files) are rejected.
- **24-hour expiration without partial recovery:** OpenRouter returns `results: null` if a batch expires at 24 hours. Batches are partitioned into chunks of `maxRequestsPerBatch` (default: 500) to bound risk.
- **No cancel or list endpoint:** the OpenRouter batch API does not support remote cancellation or listing batches, which is why a reclaimed submit cannot adopt an existing batch there.
- **No idempotency key:** POST submissions are not auto-retried.
- A creation error `does not have a :batch endpoint` means the catalog row exists but the endpoint is not live for that model.

---

## The lower-level `ai.batch()` API

`ctx.step.ai.map` is built on `ctx.ai.batch(modelKey, provider?, options?)`, which is still public: `submit(requests)` returns a handle (`id`, `provider`, `refs`), `getStatus(batchId, metadata)` reports `pending | processing | completed | failed`, and `getResults(batchId, { ...metadata, schemas })` returns `AIBatchResult[]` — a discriminated union on `status: "succeeded" | "failed"` with `validated: true` only when the schema for that request id was re-supplied. Zod schemas do not survive a suspend/resume (they contain functions), which is why `map` re-supplies them for you; if you drive `ai.batch()` yourself from inside `ctx.step.run` / `waitFor`, you must do the same at collect time or results come back `validated: false` with a WARN.
