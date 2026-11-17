---
"@bratsos/workflow-engine-console": patch
---

On SQLite, `createPrismaConsoleReadPort` refuses a file that another Prisma major wrote, with the engine's own `SqliteDateStorageError`, instead of listing the wrong runs. It binds dates in its filters and keyset cursors, and across majors (Prisma 6 integer milliseconds, Prisma 7 and 8 ISO text) every such comparison is decided by the storage type. The check runs before each read until it has seen a stored date, and is shared with the engine's adapters on the same client. It runs through `$queryRawUnsafe`, the one raw read the port's published minimum client type has; a check that cannot run throws `SqliteDateStorageUnverifiedError` and reads nothing, and the next read checks again. It needs `@bratsos/workflow-engine` with `assertSqliteDateStorage`, which the console already requires as a peer; PostgreSQL is not affected.
