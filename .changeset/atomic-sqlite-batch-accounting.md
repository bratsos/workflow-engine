---
"@bratsos/workflow-engine": patch
---

On SQLite, `PrismaAICallLogger.logBatchResults` writes a batch's rows in one transaction, as the single PostgreSQL statement already does. A write that failed partway used to leave some rows behind, and `isRecorded` then treated the batch as recorded, so `recordResults` never added the rest.

**Rolling-safe** because no schema changes; an older host still writes row by row.
