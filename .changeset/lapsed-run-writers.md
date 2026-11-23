---
"@bratsos/workflow-engine": patch
---

A run writer whose lease lapsed can no longer revive it. `refreshRunWrite` renews a registration only while it was refreshed within `RUN_WRITE_LEASE_MS`; a writer that stalled for longer than that, after targeted erasure saw no writer, falls back to a registration of its own, which is refused once the run has ended or is gone, so it cannot write behind the erasure. `engine.prune` with `idempotencyKeys` now also removes run writer registrations that nobody has refreshed for ten leases, such as those a crashed host left, within the clause's limit; the ten leases keep a host whose clock runs ahead from removing a live registration.

`step.signal` registers its sender as a writer of the run, as `job.execute` does. A payload it spills to the blob store can no longer land after `run.purge` reported the run erased: erasure reports `writers` while the sender holds its registration, and a sender whose run has ended writes nothing and is rejected.

On SQLite, every `engine.prune` clause now reads and mutates its rows through the primary-key index and the `ai_calls` age indexes, so statistics taken while a table was small no longer turn a prune into a scan of the whole table. The indexes are read from the table itself and named only when the table has them; one without them is pruned with the plain statement, as before. The Getting Started models in the README now declare every index of the shipped schema.

The change is **rolling-safe**: it adds no column and changes no command. Old and new hosts can run side by side, because the refresh condition only narrows what a host may renew and a host without it keeps registering as before. Pruning the registrations uses the additive partial index `idempotency_keys_writer_prune_idx` from the updated `sql/retention-eligibility.postgresql.sql` or `sql/retention-eligibility.sqlite.sql` (`CREATE INDEX IF NOT EXISTS`, so running the script again is safe); without it `engine.prune` skips the registrations and prunes keys as before. For erasure of signalled runs, **stop old hosts first**: earlier hosts do not register their signal senders.
