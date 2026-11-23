---
"@bratsos/workflow-engine": minor
---

Erase terminal workflow runs with `run.purge` by passing `workflowRunIds` or `tenantId` and an optional tenant batch limit. The command reports rows and blobs removed, live runs skipped, and incomplete cleanup that can be retried. Configure an AI call logger with `deleteForRuns`, and cancel live runs before erasure. Prisma also removes legacy workflow topics and idempotency keys.

For targeted erasure, **stop old hosts first**: hosts without writer registration can write for a run while it is erased. Add the retention indexes in the attribution migration before enabling the command; erasure on SQLite requires them.
