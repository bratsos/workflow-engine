---
"@bratsos/workflow-engine": patch
---

Native batching works with current vendor AI SDK releases again.

- **The bug:** `@ai-sdk/google` 4.0.65 and the current `@ai-sdk/openai` and `@ai-sdk/anthropic` moved batching off the language model (`experimental_doStartBatch` / `experimental_doGetBatchStatus` / `experimental_doGetBatchResults`) onto the provider (`provider.experimental_batch()`). The engine only looked for the per-model methods, so on a fresh install every native Google, OpenAI and Anthropic batch failed with "not batch-capable". Installs whose lockfile pins an earlier vendor release were unaffected; OpenRouter batching never was.
- **The fix:** the native transport drives whichever seam the installed release exposes, preferring the provider-level batch. The HTTP requests are identical across the two, so Google's union-preserving schema substitution, the Google display-name and OpenAI metadata stamps that make a crashed submit recoverable, and the stored batch refs all behave exactly as before. A batch submitted before a vendor upgrade is polled and collected after it.
- **Fallback:** when a vendor release exposes neither seam, the batch helper now falls back to the OpenRouter transport with a WARN, as it already did when the vendor package is not installed, provided OpenRouter can batch the model. The error it recovers from is the new exported `NotBatchCapableError` (`isNotBatchCapableError` detects it across bundles).
- **New exports:** `fromAiSdkProviderBatch` wraps a provider-level AI SDK batch as an `EngineBatchModel`, alongside the existing `fromAiSdk` for the per-model seam.
