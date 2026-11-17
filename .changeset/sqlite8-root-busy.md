---
"@bratsos/workflow-engine": patch
---

Prisma 8 SQLite: a root write that failed with a busy error no longer leaves the later root writes uncommitted. On the root client a write that returns rows (`create`, `update`, `upsert`, `delete`, raw `... RETURNING`) that hit `SQLITE_BUSY` at its first step left a statement active on the shared connection, because `node:sqlite` does not reset an iterator whose first step throws. Every root write after it reported success, was not committed, and was rolled back when the statement object was collected. `fromPrisma8` now takes the write lock with `BEGIN IMMEDIATE` before such a statement and commits after it. The decision to read SQLite integers as text now comes from the statement's plan, not from which executor runs it.
