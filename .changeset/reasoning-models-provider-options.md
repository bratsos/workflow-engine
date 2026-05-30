---
"@bratsos/workflow-engine": minor
---

Support reasoning models in the AI helper: per-call `providerOptions` passthrough and reasoning-channel access.

Reasoning models (e.g. `anthropic/claude-opus-4.x`, OpenRouter reasoning models) emit on a separate reasoning channel. Previously they could not be used as writers through `generateText()` / `streamText()`: the text channel was empty, there was no per-call lever to control reasoning, and the engine surfaced only the text stream — so reasoning-only output looked like "no output generated" and failed the stage.

**`providerOptions` passthrough (gap #1)**

`generateText`, `generateObject`, and `streamText` now forward `options.providerOptions` to the AI SDK — matching `embed`, which already did. This is the standard per-call lever to control reasoning, e.g. `{ anthropic: { thinking: { type: "disabled" } } }` or `{ openrouter: { reasoning: { enabled: false } } }`. It complements the existing global `providerResolver` hook (which is fixed at provider-creation time and cannot vary per call). `TextOptions`, `ObjectOptions`, and `StreamOptions` all gained the field.

**Reasoning-channel access (gap #2)**

- `AITextResult.reasoning?: string` — `generateText`/`generateObject` surface the model's reasoning text when present.
- `AIStreamResult.getText(): Promise<string>` — the full answer text, reconciled with the buffered result so a non-incrementally-streamed answer isn't lost. Empty for a reasoning-only response.
- `AIStreamResult.getReasoning(): Promise<string | undefined>` — the reasoning text. The streamed `.stream` continues to carry only the answer channel; reasoning stays separate.
- When the text channel streams nothing, the engine falls back to the buffered `result.text` before treating the stream as empty.

All additions are backward-compatible (new optional option fields, new result fields, new methods). No schema change.

> Note: reasoning tokens count against `maxTokens` (`maxOutputTokens`). If the budget is too small, a model can spend it all reasoning and emit no answer — raise `maxTokens` or disable reasoning via `providerOptions`. See `skills/workflow-engine/references/04-ai-integration.md` (“Reasoning Models & Provider Options”).
