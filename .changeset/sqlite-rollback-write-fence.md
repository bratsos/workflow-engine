---
"@bratsos/workflow-engine": patch
---

SQLite writes queued through the Prisma adapters during an active transaction can no longer run after that transaction rolls back when external async context is lost. Native SQLite adapters serialize root writes and both transaction forms before Prisma starts them, keeping driver acquisition waits outside the connection pool. Batched enqueues retain batch semantics without gaining an interactive timeout. The fence covers native Prisma 6/7 consumer transactions observed by already-created adapters and Prisma 8 queued transactions. Expired native transaction callbacks release the queue even when the callback never settles. Use the passed transaction client for transactional writes.
