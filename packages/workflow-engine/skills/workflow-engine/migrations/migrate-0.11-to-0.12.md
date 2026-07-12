# Migrating from 0.11 to 0.12

## Summary

0.12 upgrades the underlying AI SDK from v6 to v7 (`ai@7`, `@ai-sdk/provider@4`, `@ai-sdk/google@4`, `@openrouter/ai-sdk-provider@3`). There is no schema migration and no runtime behavior change — every breaking change here is TypeScript-only, driven by the AI SDK renaming a handful of its own public names. Four of the workflow engine's AI-layer types were renamed to track the SDK's new names: `ProviderResolver`/`registerEmbeddingProvider` now type against the SDK's v4 provider interface, `TextOptions.experimental_output` became `output`, `onStepFinish` became `onStepEnd` across `TextOptions`/`ObjectOptions`/`StreamOptions`, and `StreamTextInput.system` became `instructions`. The batch API (`ai.batch()`) is untouched — its own `system` field is unrelated and was deliberately left alone.

0.12 also expands the AI helper's consumer-facing surface to track more of what AI SDK v7 exposes — see [New features](#new-features) below. That part is purely additive: no existing field was renamed or removed.

## Required actions

- [ ] **Rename `experimental_output` to `output` on `generateText` calls.** This is a hard rename in the AI SDK itself (no deprecated alias), so the old field name no longer does anything.
  ```typescript
  // Before
  await ai.generateText(modelKey, prompt, { tools, experimental_output: { schema } });

  // After
  await ai.generateText(modelKey, prompt, { tools, output: { schema } });
  ```

- [ ] **Rename `onStepFinish` to `onStepEnd`** wherever you pass it to `generateText`/`generateObject`/`streamText` through this library's `TextOptions`, `ObjectOptions`, or `StreamOptions`.
  ```typescript
  // Before
  await ai.generateText(modelKey, prompt, {
    tools,
    onStepFinish: (step) => console.log(step.toolResults),
  });

  // After
  await ai.generateText(modelKey, prompt, {
    tools,
    onStepEnd: (step) => console.log(step.toolResults),
  });
  ```

- [ ] **Rename `system` to `instructions` on `streamText` input.** This only applies to `ai.streamText(modelKey, input, options)`'s `input.system` — **not** the batch API's `system` field (`AnthropicBatchRequest`/`GoogleBatchRequest`/`OpenAIBatchRequest`), which is unchanged.
  ```typescript
  // Before
  const result = ai.streamText("gemini-2.5-flash", {
    prompt: "Hello",
    system: "You are a helpful assistant.",
  });

  // After
  const result = ai.streamText("gemini-2.5-flash", {
    prompt: "Hello",
    instructions: "You are a helpful assistant.",
  });
  ```

- [ ] **Upgrade custom providers passed via `ProviderResolver` or `registerEmbeddingProvider` to the AI SDK v7 provider interface.** `ProviderResolver` now returns `LanguageModelV4` (from `@ai-sdk/provider`) instead of `LanguageModelV3`, and `registerEmbeddingProvider`'s factory now returns `EmbeddingModelV4` instead of `EmbeddingModelV3`. If you inject a custom model — either directly or via a community AI SDK provider package — make sure that provider package has also been upgraded to one that implements the v4 model interface (most AI SDK v6-compatible community providers have a v7-compatible major release; check the provider's own changelog).
  ```typescript
  // Before: a provider package built against @ai-sdk/provider v3
  import { voyage } from "voyage-ai-provider"; // v6-compatible version
  registerEmbeddingProvider("voyage", (modelId) => voyage.embeddingModel(modelId));

  // After: upgrade the provider package to its v7-compatible major version first,
  // then the same call site works unchanged
  import { voyage } from "voyage-ai-provider"; // v7-compatible version
  registerEmbeddingProvider("voyage", (modelId) => voyage.embeddingModel(modelId));
  ```

- [ ] **Confirm your Node version.** No change here beyond what 0.11 already required (Node 22+) — called out because the AI SDK v7 itself also targets modern Node; there's nothing additional to do if you're already on a supported version.

## New features

All additive - no existing field was renamed or removed, and no generic type inference on the wrappers was degraded. Every new option is a typed passthrough sourced from `Parameters<typeof generateText>[0]` (or the `streamText`/`embed` equivalent), so it tracks the AI SDK instead of drifting.

- **Usage detail + cost refinement.** `AITextResult`/`AIObjectResult`/`AIStreamResult.getUsage()` now optionally carry `totalTokens`, `cachedInputTokens`, and `reasoningTokens` when the provider reports them, and the same detail is persisted into the `AICall` record's existing `metadata` JSON field as `metadata.usageDetail` (no schema change). `ModelConfig` gains optional `cachedInputCostPerMillion`/`reasoningCostPerMillion`; when set, `calculateCostWithDiscount` prices the cached/reasoning-token slice at the refined rate. When unset — true for every built-in model today — cost is byte-identical to 0.11. The `sync-models` CLI does not populate these two fields yet.
  ```typescript
  const { text, totalTokens, cachedInputTokens, reasoningTokens } =
    await ai.generateText("anthropic/claude-opus-4.8", prompt);
  ```

- **Telemetry passthrough.** `telemetry` added to `TextOptions`/`ObjectOptions`/`StreamOptions`/`EmbedOptions`. This library does not depend on `@ai-sdk/otel` — register it yourself to actually collect spans.
  ```typescript
  import "@ai-sdk/otel"; // consumer's own dependency, registered once at startup
  await ai.generateText(modelKey, prompt, {
    telemetry: { isEnabled: true, functionId: "extract-summary" },
  });
  ```

- **Result richness.** `AITextResult`/`AIObjectResult` gain optional `finishReason`, `warnings`, `toolCalls`, `toolResults`, `steps`. `AIStreamResult` gains matching async getters — `getFinishReason()`, `getWarnings()`, `getToolCalls()`, `getToolResults()`, `getSteps()` — consistent with the existing `getUsage()`/`getText()`/`getReasoning()` style; none of them force eager resolution of the stream.

- **Messages input.** `generateText`/`generateObject` accept `{ messages: [...] }` as an alternative to `prompt`, mirroring `streamText`'s existing `messages` support. The string/multimodal `ContentPart[]` prompt path is unchanged.
  ```typescript
  const { text } = await ai.generateText("gemini-2.5-flash", {
    messages: [
      { role: "user", content: "What's the capital of France?" },
      { role: "assistant", content: "Paris." },
      { role: "user", content: "And Germany?" },
    ],
  });
  ```

- **Unified `reasoning` option.** `reasoning?: "none" | "low" | "medium" | "high" | ...` added to `TextOptions`/`ObjectOptions`/`StreamOptions` — AI SDK v7's portable reasoning-effort knob. It composes with the existing `providerOptions` (unchanged); prefer `reasoning` when a portable value is enough, and fall back to `providerOptions` (e.g. `anthropic.thinking`, `openrouter.reasoning`) for provider-specific controls it doesn't cover.

- **Sampling params + headers.** `topP`, `topK`, `frequencyPenalty`, `presencePenalty`, `seed`, `stopSequences`, `headers` added to `TextOptions`/`ObjectOptions`/`StreamOptions`.

- **Embeddings symmetry.** `maxRetries`, `abortSignal`, `headers` added to `EmbedOptions` (text/object/stream already had `maxRetries`/`abortSignal` since 0.11).

- **Agentic control.** `activeTools` and `prepareStep` added to `TextOptions`/`ObjectOptions`/`StreamOptions`. `StreamOptions` also gains `experimental_transform` (AI SDK v7's stable name for stream transforms, e.g. `smoothStream()`).

**Not included:** `toolApproval` (human-in-the-loop tool gating) is intentionally not exposed here. Its real value is tied to workflow suspend/resume (a `stage.resume`-style command) — that's a separate, planned feature; a bare passthrough would be misleading in a server/batch workflow context.

## Deprecations

None in this release.

## Bug fixes

None — this is a pure dependency/type-surface upgrade. Cost calculation, streaming behavior, reasoning extraction, and tool-call logging are all unchanged.

## Code examples

### Structured output with tools

```typescript
// Before (0.11 and earlier)
const { text, output } = await ai.generateText("gemini-2.5-flash", "Search and summarize", {
  tools: { search: searchTool },
  experimental_output: { schema: z.object({ summary: z.string() }) },
});

// After (0.12)
const { text, output } = await ai.generateText("gemini-2.5-flash", "Search and summarize", {
  tools: { search: searchTool },
  output: { schema: z.object({ summary: z.string() }) },
});
```

### Step-completion callback

```typescript
// Before
await ai.generateObject("gemini-2.5-flash", prompt, schema, {
  tools,
  onStepFinish: (step) => recordToolUsage(step),
});

// After
await ai.generateObject("gemini-2.5-flash", prompt, schema, {
  tools,
  onStepEnd: (step) => recordToolUsage(step),
});
```

### Streaming with a system prompt

```typescript
// Before
const stream = ai.streamText("anthropic/claude-3.7-sonnet", {
  messages,
  system: "Answer concisely.",
});

// After
const stream = ai.streamText("anthropic/claude-3.7-sonnet", {
  messages,
  instructions: "Answer concisely.",
});
```

### Custom provider resolver

```typescript
// Before: typed against LanguageModelV3
import type { LanguageModelV3 } from "@ai-sdk/provider";

const resolver: ProviderResolver = (modelConfig) => {
  if (modelConfig.provider === "my-provider") {
    return myProvider(modelConfig.id) as LanguageModelV3;
  }
};

// After: typed against LanguageModelV4 (upgrade myProvider's package too)
import type { LanguageModelV4 } from "@ai-sdk/provider";

const resolver: ProviderResolver = (modelConfig) => {
  if (modelConfig.provider === "my-provider") {
    return myProvider(modelConfig.id) as LanguageModelV4;
  }
};
```
