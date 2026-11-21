---
"@bratsos/workflow-engine": patch
---

Keep the original SQLite date probe rejection in `SqliteDateStorageUnverifiedError.cause`. If the value cannot be formatted, use `Unprintable error` in the message. The operation stays blocked and the next call probes again. Host timer validation also keeps its `RangeError` when the invalid value cannot be formatted.
