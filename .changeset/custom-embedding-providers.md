---
"@bratsos/workflow-engine": minor
---

Add custom provider support for embeddings in AI helper. The `embed()` method now routes to OpenRouter or Google based on the model's `provider` field, instead of being hardcoded to Google. This enables using OpenAI, Cohere, and other embedding models available through OpenRouter.
