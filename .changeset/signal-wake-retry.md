---
"@bratsos/workflow-engine": patch
---

Retrying `step.signal` after a failed stage wake now wakes the stage and records its signal event once. The first accepted payload is preserved, including when the ledger completed before the wake failed.
