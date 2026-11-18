---
"@bratsos/workflow-engine": patch
---

Prisma 8 SQLite: a write on the client's root connection is no longer lost after that connection leaves WAL. SQLite 3.53.4 (`node:sqlite` on Node 22 and 24) keeps a connection's page cache as of its last read when `PRAGMA journal_mode` takes it out of WAL, even though another connection, such as an engine transaction's, committed since. Its next write then dropped rows or left damaged indexes in the file. `fromPrisma8` now reads the database header on the root connection just before a root `PRAGMA` that sets `journal_mode`, whether it is sent through the wrapper or through `db.query`, `db.orm` or `db.sql`.
