---
"@bratsos/workflow-engine": patch
---

On SQLite the outbox claim's candidate select (`getUnpublishedOutboxEvents`) no longer reads every published event. SQLite could plan it from `outbox_events_dlqAt_idx`, and `dlqAt IS NULL` is true of every published row: with 100,000 published events and no `ANALYZE` it took 5.0 ms at the median and 81 ms at worst, against 0.3 ms now. It uses `outbox_events_publishedAt_idx`. Postgres is unchanged.

`run.listVersions` is a single read and now runs without opening a transaction. `InMemoryWorkflowPersistence.getAllStages()` returned every stage twice; it returns each once.
