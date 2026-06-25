# Migrating from 0.8 to 0.9

## Summary

0.9 adds **reasoning-model support** to the AI helper: a per-call `providerOptions` passthrough on `generateText` / `generateObject` / `streamText` (matching `embed`, which already had it), plus access to the model's separate reasoning channel. The change is additive and backward-compatible — no schema migration, and no changes to existing call sites.

Before 0.9, reasoning models (e.g. `anthropic/claude-opus-4.x`, OpenRouter reasoning models) could not be used as writers through `generateText()` / `streamText()`: they emit on a separate reasoning channel, so the text channel came back empty and the stage failed as "no output generated," with no per-call lever to control reasoning.

## Required actions

None. 0.8 → 0.9 is a drop-in upgrade — no schema migration, no API changes to existing code.

## New features

### `providerOptions` passthrough (per-call reasoning control)

`generateText`, `generateObject`, and `streamText` now forward `options.providerOptions` to the AI SDK — the standard per-call lever to control reasoning. `TextOptions`, `ObjectOptions`, and `StreamOptions` all gained the field. It complements the existing global `providerResolver` hook (which is fixed at provider-creation time and cannot vary per call).

```ts
// Disable reasoning for a single call
const { text } = await ai.generateText("anthropic/claude-opus-4.x", prompt, {
  providerOptions: { anthropic: { thinking: { type: "disabled" } } },
});

// OpenRouter
const { object } = await ai.generateObject(model, prompt, schema, {
  providerOptions: { openrouter: { reasoning: { enabled: false } } },
});
```

### Reasoning-channel access

- `AITextResult.reasoning?: string` — `generateText` / `generateObject` surface the model's reasoning text when present.
- `AIStreamResult.getText(): Promise<string>` — the full answer text, reconciled with the buffered result so a non-incrementally-streamed answer isn't lost. Empty for a reasoning-only response.
- `AIStreamResult.getReasoning(): Promise<string | undefined>` — the reasoning text. The streamed `.stream` continues to carry only the answer channel; reasoning stays separate.

```ts
const { text, reasoning } = await ai.generateText(reasoningModel, prompt);
// `reasoning` holds the thinking trace when the model emits one

const stream = await ai.streamText(reasoningModel, prompt);
const answer = await stream.getText();          // full answer, reconciled with the buffer
const thinking = await stream.getReasoning();   // reasoning trace (or undefined)
```

## Deprecations

None.

## Bug fixes

### Reasoning-only responses no longer look like "no output"

When the text channel streams nothing, the engine now falls back to the buffered `result.text` before treating the stream as empty. This fixes reasoning models failing a stage with "no output generated" when their answer arrived only on the buffered/non-incremental path.

## Gotcha: reasoning tokens count against `maxTokens`

Reasoning tokens are billed against `maxTokens` (`maxOutputTokens`). If the budget is too small, a model can spend it all reasoning and emit no answer — raise `maxTokens`, or disable reasoning via `providerOptions`.

## Reference

See [`../references/04-ai-integration.md`](../references/04-ai-integration.md) → "Reasoning Models & Provider Options" for the full API surface and examples.
