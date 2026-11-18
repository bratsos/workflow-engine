---
"@bratsos/workflow-engine": minor
---

Deliver outbox events at least once with expiring owner-guarded claims. Delivery can duplicate whenever the sink effect happens without a durable acknowledgement. Examples include a crash or write error after acceptance, an emit in flight at expiry, a sink that commits and then rejects, and partial plugin success. Sinks and plugins can deduplicate using the provided outbox event ID. A run and sequence order its events but are not a permanent key: deleting the newest rows by SQL can permit a sequence to be reused. Order is decided when a run head is claimed. A dead letter replayed after a successor was claimed can arrive after it. Failed events are retried up to the budget and then require `plugin.replayDLQ`. Engine progress remains independent of the sink.

Custom persistence adapters must implement the new outbox methods. Stop all alpha.20 flushers and close their connections before the schema upgrade. Add the nullable `deliveryClaim` field and both outbox indexes in one schema migration. Flushers find run heads from the current rows and rotate past the last run served. Existing rows need no backfill. Legacy publication stamps remain published. A caller-owned transaction defers delivery to a root-client flush after commit.

The Prisma claim and unpublished inspection support a client with either raw-read method. On SQLite the date-storage check runs before outbox operations, including completion, retry, and append.
