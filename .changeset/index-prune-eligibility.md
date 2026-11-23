---
"@bratsos/workflow-engine": patch
---

Outbox and idempotency retention now select from indexes that contain eligible rows. Outbox eligibility updates with the parent run status, including reopening and removal.

The additive schema change is **rolling-safe**. Install the dialect-specific eligibility migration before enabling the updated retention command. Its triggers maintain eligibility for existing writers.
