---
"@bratsos/workflow-engine": patch
---

Dead-letter replay clears a legacy publication stamp left by an older crashed flush. The new delivery protocol stores claims separately and atomically records a failed attempt, releases its claim, and dead-letters at the retry limit. See the outbox at-least-once changeset for the delivery guarantee and upgrade requirements.
