---
"@bratsos/workflow-engine": patch
---

SQLite stats use index searches for unpublished and dead-letter counts even when table statistics are stale. PostgreSQL stats can scan the outbox table when stale statistics still estimate that most rows are active. The separate delivery claim uses indexed live run heads and skips published history. See the outbox delivery changeset for the schema upgrade.
