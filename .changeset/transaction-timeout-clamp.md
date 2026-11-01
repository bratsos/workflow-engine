---
"@bratsos/workflow-engine": patch
---

A `$transaction` `timeout` of 2^31 ms (about 25 days) or more no longer rolls the transaction back after a few milliseconds. The adapters' own timers, on SQLite for Prisma 6 and on Prisma 8, are capped at 2^31 - 1 ms, the longest delay `setTimeout` honours. Prisma 7 still rejects such a timeout in its own timer.
