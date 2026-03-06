---
"@bratsos/workflow-engine": minor
---

Add `registerEmbeddingProvider()` for custom embedding providers. Consumers can now register any AI SDK community provider (Voyage, Cohere, Jina, etc.) without library changes. The `ModelConfig.provider` field is now an open string instead of a closed enum.
