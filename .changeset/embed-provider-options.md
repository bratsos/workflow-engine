---
"@bratsos/workflow-engine": minor
---

Add `providerOptions` passthrough to `EmbedOptions` interface, allowing consumers to pass provider-specific options (e.g., Voyage's `outputDimension`, Cohere's `inputType`) directly to the AI SDK's `embed()` call. User-specified options are merged after auto-mapped provider defaults (like Google's `outputDimensionality`), so they can override when needed.
