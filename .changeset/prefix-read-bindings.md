"@bratsos/workflow-engine": patch
---

SQLite prefix reads bind parameters through unsafe-only Prisma clients on Prisma 6, 7, and 8. `createPrismaBlobStore` accepts an optional `databaseType` for native SQLite facades.
