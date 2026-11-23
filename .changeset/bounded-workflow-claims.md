---
"@bratsos/workflow-engine": patch
---

Keep capped workflow claims fast behind a large saturated backlog. PostgreSQL and SQLite seek to each eligible workflow's next job and keep the queue's priority and creation-time ordering. The index upgrade is rolling-safe with the controls disabled. Install the packaged workflow index before enabling `maxConcurrent` on a Prisma-provisioned database. The job runtime controls SQL upgrade includes the index.
