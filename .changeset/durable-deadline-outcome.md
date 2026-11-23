---
"@bratsos/workflow-engine": patch
---

Let stages branch on a durable deadline. Set `onTimeout: "return"` on `ctx.step.waitForSignal` or `ctx.step.waitFor` to receive `{ timedOut: false, value }` or `{ timedOut: true }`. The first completion wins and survives replay. A late `step.signal` reports `signalled: false, timedOut: true` without emitting a signal event. The default still throws `StepTimeoutError`.

Concurrent waits schedule the stage for the earliest poll or deadline. A signal received strictly after an opted-in deadline can settle only as a timeout, even before the next maintenance tick.

Rolling-safe with the default policy. Upgrade every worker and signal dispatcher before enabling `onTimeout: "return"` because older versions cannot interpret the timeout marker. No database schema change is required.
