---
"@bratsos/workflow-engine-console": patch
---

The console reads a run whose JSON columns or annotations hold a JSON number on SQLite with Prisma 7. Such a column keeps the number as a SQLite number, which Prisma 7 refused to read as JSON, so the run detail failed.
