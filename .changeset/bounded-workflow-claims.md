---
"@bratsos/workflow-engine": patch
---

Keep capped workflow claims fast behind a large saturated backlog. PostgreSQL and SQLite seek to each eligible workflow's next job and keep the queue's priority and creation-time ordering. The index upgrade is rolling-safe with the controls disabled. The packaged expression index is required for bounded `maxConcurrent` claims on a Prisma-provisioned database. Without it, the queue still enforces the cap using a slower scan and logs a warning once per adapter with the SQL file to apply. Restart workers after installing the index. The job runtime controls SQL upgrade includes it.
