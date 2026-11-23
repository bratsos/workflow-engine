---
"@bratsos/workflow-engine": minor
---

`run.create` accepts optional `tenantId` and `labels` and stores them on the run. The run schema indexes newest-first lookups within a tenant. The AI-call schema adds nullable `workflowRunId`, `tenantId`, `labels` and `textExpiresAt` with indexes for attribution and expiry. `prompt` and `response` stay required.

Both create paths validate a flat map of string labels and reject the `__proto__` key consistently across Postgres and SQLite. SQL enqueue accepts trailing `p_tenant_id text DEFAULT NULL` and `p_labels jsonb DEFAULT NULL`. After the table upgrade, apply the new `sql/enqueue.sql` with error checking. The file is one statement, so it commits or rolls back as a whole however it is run. It replaces the seven-argument signature only in the schema of the `workflow_runs` table on the search path and keeps that function's owner and ACL, including any `PUBLIC` revocation. A view or SQL function that depends on the old signature makes it fail with SQLSTATE `2BP01` and change nothing; the migration guide shows how to recreate those dependents in the same transaction.

**Rolling-safe with compatible prepared statements.** The PostgreSQL table upgrade uses separate 500 ms lock attempts and concurrent index builds. Old traffic may briefly wait on the table being altered. Apply the column and index steps before replacing the optional enqueue function in a separate transaction. Valid seven-argument calls still work through the trailing defaults. On PostgreSQL Prisma 6, stop old hosts first and keep their cached connections closed across the schema change, or roll them onto `statement_cache_size=0` beforehand. A warmed `RETURNING *` plan otherwise fails after the result shape changes.
