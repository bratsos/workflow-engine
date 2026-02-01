---
"@bratsos/workflow-engine": patch
---

Migrate from deprecated `generateObject()` to AI SDK v6 pattern using `generateText()` with `Output.object()`.

Add `require_parameters: true` to OpenRouter provider config to ensure routing only to providers that actually support requested features like `json_schema` structured output. This prevents errors when a model is hosted by multiple providers with different capability support.

Also fixes `workflow-engine-sync` CLI binary which was missing from the 0.0.11 release.
