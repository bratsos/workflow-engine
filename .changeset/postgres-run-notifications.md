---
"@bratsos/workflow-engine": minor
---

PostgreSQL `run.create` and `workflow_engine_enqueue` send the new run ID to `workflow_engine_runs` when the transaction commits. Replays and rollbacks send no notification. A kernel with an interactive transaction or a caller-owned transaction can send this notification.

**Rolling-safe.** Deploy the schema and replace the application-owned SQL function in the same migration. Old hosts continue polling for pending runs. Restore any custom `EXECUTE` grants and `PUBLIC` revocations on the new function signature before committing. Follow the Prisma 6 connection notes in the schema migration guide.
