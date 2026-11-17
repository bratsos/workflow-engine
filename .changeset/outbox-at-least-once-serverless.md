---
"@bratsos/workflow-engine-host-serverless": minor
---

Bound maintenance and `runToCompletion` outbox waits as well as post-job waits with `outboxFlushTimeoutMs` (default 5 seconds), and set claim lifetimes beyond that timeout. An in-flight sink call can finish or be recovered after its claim expires.
