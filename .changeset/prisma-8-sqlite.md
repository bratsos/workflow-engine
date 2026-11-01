---
"@bratsos/workflow-engine": minor
"@bratsos/workflow-engine-console": minor
---

- **Prisma 8 supports SQLite alongside PostgreSQL and Prisma 6/7.** Use the matching `@prisma/orm-sqlite` client and the existing `databaseType: "sqlite"` adapter option; one root client serializes engine writes, while multiple processes sharing a SQLite file remain unsupported.
- **The console read port accepts `databaseType: "sqlite"`.** Its `statementTimeoutMs` applies to PostgreSQL only; SQLite has no `statement_timeout` support.
