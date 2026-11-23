---
"@bratsos/workflow-engine": patch
---

Provider failures now expose safe diagnostics through helpers, durable steps and batch operations, including the errors that appear in workflow history. Errors read from the SDK stream result (`rawResult`) are safe too; the SDK still retries a retryable provider failure and still sees an abort. A Zod error thrown inside a call is passed through unchanged, so the stage fails without a retry as before. Provider warning text requires both text trace flags. Direct stage accounting writes through `ctx.aiLogger` use the stage helper's attribution and capture policy, and the logger's other members are those of the configured logger.

**Rolling-safe** for schema compatibility. Enforce the privacy policy after all writers support it and address previously captured data separately.
