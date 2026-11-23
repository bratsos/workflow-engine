---
"@bratsos/workflow-engine": minor
"@bratsos/workflow-engine-host-node": minor
"@bratsos/workflow-engine-host-serverless": minor
---

Asynchronous call loggers can reject a failed write. Helpers report every failed write through `onLogError`, and a caller that awaits a write through `ctx.aiLogger` gets a rejection with a safe message instead of `undefined`; an ignored write is handled. `ai.flush({ timeoutMs })` returns counts of failed and still-pending writes and streams, including its children's; a stream is pending from the call until its row is written, or until the AI SDK ends the request without one and no `getUsage()` call is still writing its row. An error part or a consumer that stops reading does not end it. `kernel.flush()` waits for the configured logger within its own bound; Node shutdown and the end of each serverless invocation call it. Stage outcomes, retries and run totals do not wait for accounting writes, as before, and `getResults` still records a batch before returning it.

**Rolling-safe** because the change adds no schema requirements. Existing synchronous loggers still work.
