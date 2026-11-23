---
"@bratsos/workflow-engine": minor
---

Completed idempotency keys record the owning run when it is known, including keys from `run.create`, `job.execute`, signal wake and SQL enqueue. The persistence port takes the run ID as the fourth argument to `completeIdempotencyKey`. The nullable `workflowRunId` and existing `createdAt` columns have indexes for run attribution and key age.

**Rolling-safe.** Add the nullable column and indexes before deploying new clients. Old hosts keep completing keys without a run ID, and their cached results still replay.
