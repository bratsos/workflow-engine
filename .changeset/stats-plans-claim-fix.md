---
"@bratsos/workflow-engine": patch
---

The outbox claim no longer reads one `outbox_events_dlqAt_idx` entry per published event. `dlqAt IS NULL` is true of nearly every row and both databases planned as if it were selective: SQLite drove the claim's candidate select (`getUnpublishedOutboxEvents`) from that index and walked every published event (100,000 events, no `ANALYZE`: 5.0 ms median and 81 ms worst, against 0.3 ms now), and Postgres with no statistics put the index's whole NULL range into a BitmapAnd (500,000 events: 432 buffers and 9.1 ms, against 38 buffers and 0.1 ms now). The unpublished filter now carries a disjunct that is false for every row (`publishedAt IS NOT NULL` next to `publishedAt IS NULL`), so only `outbox_events_publishedAt_idx` is usable; the rows selected are the same. It applies to the stats count, the candidate select and the Postgres claim statement. On an unanalysed Postgres table the claim can still walk the unique `(workflowRunId, sequence)` index at a limit below about 50; `ANALYZE` settles it.

The dead-lettered count of `engine.stats` is planned from `outbox_events_dlqAt_idx` on a Postgres table with no statistics too (a one-sided `dlqAt > epoch` was a parallel sequential scan of 500,000 events in a plan check), and on SQLite no longer depends on whether the file stores dates as integers (Prisma 6) or text (Prisma 7 and 8). A SQLite file still belongs to the Prisma major that created it: the date comparisons the engine sends (`nextPollAt <= now`, retention, `run.reapStuck`) are decided by storage class across majors, and the docs now say so.

`run.listVersions` is a single read and now runs without opening a transaction. `InMemoryWorkflowPersistence.getAllStages()` returned every stage twice; it returns each once.
