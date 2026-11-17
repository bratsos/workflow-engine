---
"@bratsos/workflow-engine": patch
---

Prisma 8 SQLite on its documented Node floors (22.20, 24.11, 26.0). `fromPrisma8` binds a boolean raw parameter as `1` or `0`, because `node:sqlite` rejected one before Node 24.21 and 26.8 (`Provided value cannot be bound to SQLite parameter N`). It also throws, before the statement runs, on a text parameter that contains a NUL character where `node:sqlite` reads the value back cut at the NUL (every Node 22 release, Node 24 before 24.16, Node 26.0): a stage or step ID changed without an error there. NUL-safe text needs Node 24.16+ or 26.1+. The SQLite CI job now also runs Prisma 8 on Node 22.20.0, 24.11.0 and 26.0.0.
