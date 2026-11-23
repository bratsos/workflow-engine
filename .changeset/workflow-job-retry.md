---
"@bratsos/workflow-engine": minor
---

Set `jobRetry: { maxAttempts, backoff: { initialDelayMs, factor?, maxDelayMs? } }` on a workflow or stage to control retries of failed jobs and suspended polls. A stage policy overrides its workflow policy. `maxAttempts` includes the first attempt. The initial delay applies after the first failure, the multiplier defaults to 2, and `factor: 1` gives a fixed delay. Existing jobs keep their stored attempt budget and default backoff.
