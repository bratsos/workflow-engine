---
"@bratsos/workflow-engine": patch
---

SQLite writes queued through the Prisma adapters during an active transaction can no longer run after that transaction rolls back when external async context is lost. Whole batched enqueues are fenced before Prisma binds their operations, preserving batch transaction semantics without adding an interactive timeout. The fence covers native Prisma 6/7 consumer transactions observed by already-created adapters and Prisma 8 queued transactions. Use the passed transaction client for transactional writes.
