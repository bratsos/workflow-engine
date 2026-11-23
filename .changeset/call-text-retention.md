---
"@bratsos/workflow-engine": minor
---

Choose whether to store request and response text through `AIHelperOptions.text`. Full text remains the default and can have a TTL. Disabled capture also omits stream instructions and tool inputs and outputs. Text in trace output requires both `WORKFLOW_ENGINE_TRACE` and `WORKFLOW_ENGINE_TRACE_TEXT=1`.

**Rolling-safe** after the additive expiry schema migration. Rows without captured text keep empty strings in the existing required columns. Apply the privacy guarantee after every writer supports it and historical capture has been addressed.
