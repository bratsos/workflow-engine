---
"@bratsos/workflow-engine": patch
---

Text capture now covers the error text on AI call rows. Under `store: "none"` or a TTL, a failed call's row records the error's name and HTTP status instead of its message, and a failed batch item's row records `Batch request failed`. The engine's console lines print provider error text and provider warnings only when both `WORKFLOW_ENGINE_TRACE=1` and `WORKFLOW_ENGINE_TRACE_TEXT=1` are set; otherwise a failed call prints its error name and HTTP status. A provider error message can contain text the provider echoed from the request. Values thrown to callers and the SDK, stage and step error columns, events, outbox payloads, workflow logs and console reads keep it, as before. Direct stage accounting writes through `ctx.aiLogger` follow the policy and attribution of the helper the `services.ai` factory returns, including a child helper, and frozen loggers and providers keep working.

**Rolling-safe** for schema compatibility. Enforce the privacy policy after all writers support it and address previously captured data separately.
