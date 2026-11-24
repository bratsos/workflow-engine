---
"@bratsos/workflow-engine": minor
"@bratsos/workflow-engine-host-node": minor
"@bratsos/workflow-engine-host-serverless": minor
---

Set `leaseTimeoutMs` on a workflow or stage to change how long a claimed job can go without heartbeating. The stage value takes precedence, with the host's stale lease threshold used when neither sets a duration. For an override, workers heartbeat at the lesser of the host interval and one third of its lease. Other jobs keep the host's heartbeat cadence and lock-based expiry, including during a rolling upgrade. The queue stamps and refreshes the lease deadline using the same clock as the claim. Rows claimed before the upgrade still use the legacy lock timestamp.
