---
"@bratsos/workflow-engine": patch
---

SQLite hosts sharing a Prisma client now claim jobs one at a time. Concurrent claims no longer read the same job and fail each other's update, which used most of the database's time on Prisma 6 and could make `dequeue()` return `null` with jobs still pending. On Prisma 6 and 7, the SQLite adapters also stop listing a transaction client's keys for each transaction.
