---
"@bratsos/workflow-engine": patch
---

Provider failures now expose safe diagnostics through helpers, durable steps and batch operations, including the errors that appear in workflow history. Provider warning text requires both text trace flags. Direct stage accounting writes through `ctx.aiLogger` use the stage helper's attribution and capture policy.

**Rolling-safe** for schema compatibility. Enforce the privacy policy after all writers support it and address previously captured data separately.
