---
"@bratsos/workflow-engine": minor
---

Upgraded the AI SDK from v6 to v7 (`ai@7`, `@ai-sdk/provider@4`, `@ai-sdk/google@4`, `@openrouter/ai-sdk-provider@3`).

**Breaking (TypeScript-only, no runtime behavior change):**

- `ProviderResolver` and `registerEmbeddingProvider()` now type against `LanguageModelV4`/`EmbeddingModelV4` (from `@ai-sdk/provider`) instead of V3. Custom providers passed in must satisfy the v7 provider interface.
- `TextOptions.experimental_output` renamed to `output` (matches the AI SDK's own hard rename - there is no deprecated alias).
- `onStepFinish` renamed to `onStepEnd` on `TextOptions`, `ObjectOptions`, and `StreamOptions` (aligns with the AI SDK's v7 canonical name; `onStepFinish` still works on the underlying SDK call as a deprecated alias, but our option types now only expose the new name).
- `StreamTextInput.system` renamed to `instructions` (aligns with `streamText`'s v7 canonical input field).

The batch API (`ai.batch()`, `AIBatchRequest`, and the Google/Anthropic/OpenAI batch providers) is unaffected - its `system` field is unrelated to `streamText` and was left untouched. Cost/usage calculation behavior is unchanged.
