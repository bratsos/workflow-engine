---
"@bratsos/workflow-engine": patch
---

Blob lists, annotation key-prefix filters and AI call lists/statistics now treat percent signs, underscores and backslashes in prefixes as literal data on PostgreSQL and SQLite across Prisma 6, 7 and 8. Quotes remain safely bound as parameters.
