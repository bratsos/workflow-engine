---
"@bratsos/workflow-engine": minor
---

`run.create` accepts optional `tenantId` and `labels` and stores them on the run. The run schema indexes newest-first lookups within a tenant. The AI-call schema adds nullable `workflowRunId`, `tenantId`, `labels` and `textExpiresAt` with indexes for attribution and expiry. `prompt` and `response` stay required.

SQL enqueue accepts trailing `p_tenant_id text DEFAULT NULL` and `p_labels jsonb DEFAULT NULL`. Apply the new `sql/enqueue.sql` in the schema migration. Re-grant `EXECUTE` to any application roles in the same transaction because dropping the original function removes its grants. Restore any revocation from `PUBLIC` at the same time.

**Rolling-safe with fresh connections or with prepared statement caching disabled.** Add the nullable columns and indexes before deploying new clients and update the application's enqueue function in the same migration. Existing seven-argument calls still work through the trailing defaults. On PostgreSQL Prisma 6, stop old hosts first and close their cached connections or roll them onto `statement_cache_size=0` ahead of the migration. A cached run claim's `RETURNING *` otherwise fails after the result shape changes.
