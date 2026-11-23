---
"@bratsos/workflow-engine": patch
---

Outbox and idempotency retention now select from indexes that contain eligible rows. Outbox eligibility updates with the parent run status, including reopening and removal; that update touches the run's published events, so its cost grows with the run's published history. On PostgreSQL every `engine.prune` clause now deletes or updates its selected rows by primary key, even when statistics were taken before a backlog became eligible.

The additive schema change is **rolling-safe**. Install the dialect-specific eligibility migration before enabling the updated retention command. Its triggers maintain eligibility for existing writers.
