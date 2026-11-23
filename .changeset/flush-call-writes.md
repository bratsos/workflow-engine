---
"@bratsos/workflow-engine": minor
"@bratsos/workflow-engine-host-node": minor
"@bratsos/workflow-engine-host-serverless": minor
---

Asynchronous call loggers can reject a failed write. Helpers report failures through `onLogError` and return counts from a bounded `flush()` of pending writes and streams. The kernel waits for stage writes before saving outcomes, reports incomplete writes as run warnings, and exposes `kernel.flush()` to drain its logger. Node shutdown and serverless invocation completion now drain that logger.

**Rolling-safe** because the change adds no schema requirements. Existing synchronous loggers still work.
