---
"@bratsos/workflow-engine-host-serverless": minor
---

Every call of `handleJob`, `processAvailableJobs` or `runMaintenanceTick` first calls the job transport's optional `verifyStorage()` and throws its error when the storage may not be used: with the Prisma SQLite adapters, a file another Prisma major wrote (`SqliteDateStorageError`), before anything is dispatched. The host remembers nothing: the transport decides (the Prisma job queue answers from its own cache once a check is conclusive, and checks again after a failure or on a file with no stored date). A transport without `verifyStorage` behaves as before. `createServerlessHost` also throws a `TypeError` when `onTick` is given and is not a function.
