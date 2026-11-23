---
"@bratsos/workflow-engine": minor
---

`run.create` accepts optional `tenantId` and `labels` and stores them on the run. The run schema indexes newest-first lookups within a tenant. The AI-call schema adds nullable `workflowRunId`, `tenantId`, `labels` and `textExpiresAt` with indexes for attribution and expiry. `prompt` and `response` stay required.

Both create paths validate a flat map of string labels and reject the `__proto__` key consistently across Postgres and SQLite. SQL enqueue accepts trailing `p_tenant_id text DEFAULT NULL` and `p_labels jsonb DEFAULT NULL`. After the table upgrade, apply the new `sql/enqueue.sql` in a separate transaction with error checking. Recreate any tracked dependents there. Re-grant `EXECUTE` to any application roles in the same transaction because dropping the original function removes its grants. Restore any revocation from `PUBLIC` at the same time.

**Rolling-safe with compatible prepared statements.** The PostgreSQL table upgrade uses separate 500 ms lock attempts and concurrent index builds. Old traffic may briefly wait on the table being altered. Apply the column and index steps before replacing the optional enqueue function in a separate transaction. Valid seven-argument calls still work through the trailing defaults. On PostgreSQL Prisma 6, stop old hosts first and keep their cached connections closed across the schema change, or roll them onto `statement_cache_size=0` beforehand. A warmed `RETURNING *` plan otherwise fails after the result shape changes.
