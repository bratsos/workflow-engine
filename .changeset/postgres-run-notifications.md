---
"@bratsos/workflow-engine": minor
---

PostgreSQL `run.create` and `workflow_engine_enqueue` send the new run ID to `workflow_engine_runs` when the transaction commits. Replays and rollbacks send no notification. Kernel notifications use the transaction client’s raw query or raw execute method. Delegate-only transaction views still rely on polling.

**Rolling-safe.** Apply the table upgrade before replacing the application-owned SQL function in a separate transaction. Old hosts continue polling for pending runs. Restore any custom `EXECUTE` grants and `PUBLIC` revocations on the new function signature before committing. Follow the Prisma 6 connection notes in the schema migration guide.
