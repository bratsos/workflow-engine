---
"@bratsos/workflow-engine": patch
"@bratsos/workflow-engine-console": patch
---

Prisma 7 with a driver adapter now behaves the same as Prisma 6.

- **Retries and duplicate-key handling work on Prisma 7.** A serialization failure or unique violation raised by raw SQL reaches the engine in a different shape on each Prisma major, and Prisma 7's was not recognised: concurrent definition registration threw a raw Prisma error instead of `DefinitionRegistrationRetryableError`. Every such check now reads the SQLSTATE through one function that understands the Prisma 6, 7 and 8 error shapes, and the console's statement-timeout detection reads the same fields.
- **Timestamps in raw SQL are right on any session timezone on Prisma 7.** A JS `Date` bound to a raw statement is sent as zone-less text by Prisma 7's Postgres adapter, so on a database session that is not on UTC the run claim, the outbox sweep and the console's time filters, queue counts and cost rollups were off by the session's offset. These statements now bind `date.toISOString()`, which means one instant on every major.
- **`workflow-console --database-url` works on Prisma 6 and 7.** It no longer fails on Prisma 7 with `Unknown property datasources`: on 7 it connects through `@prisma/adapter-pg`, and if that package is not installed the error says to install it.
- **Comments no longer claim typed enums on Prisma 7.** Neither major exposes `$Enums` on a client instance, so enum values were always plain strings; behaviour is unchanged.
