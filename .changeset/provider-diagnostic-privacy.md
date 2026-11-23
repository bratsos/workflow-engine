---
"@bratsos/workflow-engine": patch
---

Callers and the AI SDK receive provider errors unchanged, so SDK retries, `retryIf` predicates and stage retry decisions behave as before. When a helper's text policy is `store: "none"` or has a TTL, the engine's own outputs describe a failed AI call by its error name and HTTP status instead of its message: AI call rows, stage and durable-step error columns, the logs and warnings the engine writes, events, outbox payloads, console reads and the engine's console and trace lines. This covers errors thrown by helpers, stream errors and tool errors read from the SDK result (`rawResult`), errors that carry one of these as `cause`, and messages that repeat their text. Provider warning text requires both text trace flags. Direct stage accounting writes through `ctx.aiLogger` follow the policy and attribution of the helper the `services.ai` factory returns, including a child helper, and frozen loggers and providers keep working.

**Rolling-safe** for schema compatibility. Enforce the privacy policy after all writers support it and address previously captured data separately.
