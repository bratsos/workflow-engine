---
"@bratsos/workflow-engine": patch
---

Keep concurrent definition registration safe inside caller transactions and expose DefinitionRegistrationRetryableError when the caller must retry with a fresh transaction snapshot.
