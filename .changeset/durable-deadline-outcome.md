---
"@bratsos/workflow-engine": patch
---

Let stages branch on a durable deadline. Set `onTimeout: "return"` on `ctx.step.waitForSignal` or `ctx.step.waitFor` to receive `{ timedOut: false, value }` or `{ timedOut: true }`. The first completion wins and survives replay.

A wait with an explicit `onTimeout` (`"throw"` or `"return"`) keeps its deadline exactly. The stage wakes at its next poll or deadline, including after a replay that did not reach it. From the deadline on, a signal or a ready poll settles only as a timeout, and a late `step.signal` reports `signalled: false, timedOut: true` without emitting a signal event. A worker that dies mid-replay delays such a deadline by at most the 60-second claim lease. Waits without `onTimeout` behave as before.

`StepLedger` gains an optional `listPendingWaits`, which the Prisma and in-memory ledgers implement, so suspending reads no completed step results. A custom ledger without it falls back to `list`.

Rolling-safe for waits without `onTimeout`. Upgrade every worker and signal dispatcher before setting `onTimeout`, because older versions do not read it. No database schema change is required.
