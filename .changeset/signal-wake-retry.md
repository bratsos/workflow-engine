---
"@bratsos/workflow-engine": patch
---

Retrying `step.signal` after a failed stage wake now wakes the stage and records its signal event once. The first accepted payload is preserved, including when the ledger completed before the wake failed. A signal delivered after its ledger row was reset wakes the stage and records its own event instead of being swallowed, and `run.purge` removes the `step.signal.wake` idempotency keys of the steps it clears.
