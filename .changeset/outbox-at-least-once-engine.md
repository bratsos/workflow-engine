---
"@bratsos/workflow-engine": minor
---

Deliver outbox events at least once with expiring owner-guarded claims. Delivery can duplicate whenever the sink effect happens without a durable acknowledgement. Examples include a crash or write error after acceptance, an emit in flight at expiry, a sink that commits and then rejects, and partial plugin success. Sinks and plugins can deduplicate using the provided outbox event ID. A run and sequence order its events but are not a permanent key: deleting the newest rows by SQL can permit a sequence to be reused. Order is decided at claim time. A replayed dead letter is delivered after later events of its run already claimed or published before replay. After replay, later unclaimed events wait behind it. Failed events are retried up to the budget and then require `plugin.replayDLQ`. Engine progress remains independent of the sink.

Custom persistence adapters must implement the new outbox methods. Stop all alpha.20 flushers and close their connections before the schema upgrade. On SQLite stop every process using the file, close its clients, and upgrade the schema in a separate process. Add the nullable `deliveryClaim` field and all three outbox indexes in one schema migration. Flushers find run heads from the current rows and rotate past the last run served. Existing rows need no backfill. Legacy publication stamps remain published. A caller-owned transaction defers delivery to a root-client flush after commit.

The Prisma claim and unpublished inspection support a client with either raw-read method. On SQLite the date-storage check runs before outbox operations, including completion, retry, and append.

Autocommit root wrappers without `$transaction` can flush and append an atomic batch. Wrap caller-owned clients with their transaction marker intact or pass `transactionView: true`. PostgreSQL honours `skipInteractiveTransactions: true` for claims. A durable cursor in the outbox rotates service across fresh adapters. Different runs in a page can reach the sink concurrently.
