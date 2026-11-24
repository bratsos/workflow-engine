---
"@bratsos/workflow-engine": minor
---

The job queue has nullable columns for workflow identity, retry backoff, and the duration and deadline of each lease and absolute cap. Apply the schema upgrade before deploying the new engine. It requires no row backfill. Existing jobs retain their workflow identity in the payload and keep the previous retry and timeout defaults.

**Rolling-safe with the new options disabled.** Old hosts can read and write the migrated queue. Stop old hosts first before enabling the controls, because old workers use their own retry delay and timeout rules and can claim jobs above a workflow's limit.
