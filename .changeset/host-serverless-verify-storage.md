---
"@bratsos/workflow-engine-host-serverless": minor
---

The first call of `handleJob`, `processAvailableJobs` or `runMaintenanceTick` calls the job transport's optional `verifyStorage()` and throws its error when the storage may not be used: with the Prisma SQLite adapters, a file another Prisma major wrote (`SqliteDateStorageError`), before anything is dispatched. A success is remembered; a failure is asked again on the next call. A transport without `verifyStorage` behaves as before. `createServerlessHost` also throws a `TypeError` when `onTick` is given and is not a function.
