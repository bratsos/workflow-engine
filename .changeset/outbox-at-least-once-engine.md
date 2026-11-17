---
"@bratsos/workflow-engine": minor
---

Deliver outbox events at least once with expiring owner-guarded claims. A crash after emit, an emit that outlives its claim, or a partial plugin failure can duplicate delivery; sinks and plugins can deduplicate using the provided outbox event ID. A run and sequence order its events but are not a permanent key: deleting the newest rows by SQL can permit a sequence to be reused. Failed events are retried up to the budget and then require `plugin.replayDLQ`. Engine progress remains independent of the sink.

Breaking change for custom persistence adapters: the required outbox methods have changed. Add `deliveryClaim String?` to `OutboxEvent`, apply the schema change and stop all alpha.20 flushers before relying on this guarantee; legacy publication stamps are treated as published.
