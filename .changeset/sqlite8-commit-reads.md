---
"@bratsos/workflow-engine": patch
---

Prisma 8 SQLite: an engine transaction no longer fails while a root read in the same process is returning rows. The driver hands rows over across microtasks and holds the read lock in between; on a rollback-journal file a commit on another connection waited its busy timeout synchronously and failed with `Transaction commit failed`, and in WAL a root write behind it could fail with `SQLITE_BUSY_SNAPSHOT`. On a rollback-journal file the adapter's transactions (`$transaction`, chunked `createMany`) now commit once the root reads in flight have finished, and root reads that start meanwhile wait for the commit; in WAL a root write that fails `SQLITE_BUSY_SNAPSHOT` waits for the reads in flight and runs once more. WAL commits do not wait. A consumer's own `db.transaction(...)` still needs WAL for concurrent work in one process.
