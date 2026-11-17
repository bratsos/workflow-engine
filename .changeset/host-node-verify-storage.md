---
"@bratsos/workflow-engine-host-node": minor
---

`createNodeHost(...).start()` calls the job transport's optional `verifyStorage()` before it starts a timer, a loop or a signal handler, and rejects with its error when the storage may not be used: with the Prisma SQLite adapters, a file another Prisma major wrote (`SqliteDateStorageError`). Without it the host ran and logged the same error on every tick and acted on nothing. A `stop()` that returns while that check is still pending cancels the start: when the check settles, nothing is installed, and a later `start()` checks again. A transport without `verifyStorage` starts as before. `createNodeHost` also throws a `TypeError` when `onTick` is given and is not a function, instead of failing on the first tick.
