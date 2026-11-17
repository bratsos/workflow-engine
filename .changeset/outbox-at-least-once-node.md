---
"@bratsos/workflow-engine-host-node": minor
---

Bound maintenance outbox waits with the new `outboxFlushTimeoutMs` option (default 5 seconds), and set claim lifetimes beyond the applicable maintenance or shutdown timeout. A slow in-flight sink call can finish or be recovered after its claim expires.
