---
"@bratsos/workflow-engine": minor
---

Expanded the AI helper's consumer-facing surface to track more of AI SDK v7 - all additive and non-breaking (no existing field renamed or removed, no generic type inference degraded).

**Usage detail + cost refinement:**

- `AITextResult`/`AIObjectResult`/`AIStreamResult.getUsage()` now optionally carry `totalTokens`, `cachedInputTokens`, and `reasoningTokens` when the provider reports them.
- These detailed counts are persisted into the `AICall` record's existing `metadata` JSON field as `metadata.usageDetail` - no Prisma schema change.
- `ModelConfig` gains optional `cachedInputCostPerMillion` and `reasoningCostPerMillion`. When set, `calculateCostWithDiscount` prices the cached-input/reasoning-token slice at the refined rate instead of the flat input/output rate. When unset (the default for every built-in model today), cost is byte-identical to before. The `sync-models` CLI does not populate these fields yet (follow-up).

**Telemetry:** `telemetry` passthrough added to `TextOptions`/`ObjectOptions`/`StreamOptions`/`EmbedOptions`, typed directly off the AI SDK's own parameter types. This library does not depend on `@ai-sdk/otel` - register it yourself to actually collect the spans.

**Result richness:** `AITextResult`/`AIObjectResult` gain optional `finishReason`, `warnings`, `toolCalls`, `toolResults`, `steps`. `AIStreamResult` gains `getFinishReason()`, `getWarnings()`, `getToolCalls()`, `getToolResults()`, `getSteps()` - async getters consistent with the existing `getUsage()`/`getText()`/`getReasoning()` style, so nothing is eagerly resolved.

**Messages input:** `generateText`/`generateObject` accept `{ messages: [...] }` as an alternative to `prompt`, alongside the existing string/multimodal `ContentPart[]` prompt (which is unchanged).

**Unified `reasoning` option:** `reasoning?: "none" | "low" | "medium" | "high" | ...` added to `TextOptions`/`ObjectOptions`/`StreamOptions` - AI SDK v7's portable reasoning-effort knob. Composes with the existing `providerOptions` (unchanged); prefer `reasoning` when a portable value suffices.

**Sampling params + headers:** `topP`, `topK`, `frequencyPenalty`, `presencePenalty`, `seed`, `stopSequences`, `headers` added to `TextOptions`/`ObjectOptions`/`StreamOptions`.

**Embeddings symmetry:** `maxRetries`, `abortSignal`, `headers` added to `EmbedOptions` (text/object/stream already had `maxRetries`/`abortSignal`).

**Agentic control:** `activeTools` and `prepareStep` added to `TextOptions`/`ObjectOptions`/`StreamOptions`. `StreamOptions` also gains `experimental_transform` (AI SDK v7's stable name for stream transforms, e.g. `smoothStream()`).

Every new field is a typed passthrough sourced from `Parameters<typeof generateText>[0]`/`Parameters<typeof streamText>[0]`/`Parameters<typeof embed>[0]`, so it tracks the AI SDK instead of drifting.

Not included: `toolApproval` (human-in-the-loop tool gating). Its real value ties to workflow suspend/resume (a `stage.resume`-style command), which is a separate planned feature - a bare passthrough would be misleading in a server/batch context.
