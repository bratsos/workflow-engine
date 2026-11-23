---
"@bratsos/workflow-engine": patch
---

The bundled Prisma setup reference now states a known limitation of `fromPrisma8` on SQLite under Bun: changing `journal_mode` at runtime, or leaving WAL, after the engine has committed a transaction can fail with `database is locked`, because Bun's `node:sqlite` `close()` keeps a connection open until its statements are collected and the Prisma 8 driver gives each transaction a connection of its own. Staying in one journal mode is unaffected; set it before the engine starts. Documentation only. Rolling-safe.
