---
"@bratsos/workflow-engine": patch
---

`run.reapStuck` keeps a run active while a pending job or a job with a live lease can still advance it. This includes jobs returned to the queue by the stale-lease sweep in the same maintenance tick. Recovery still re-enqueues a pending stage whose job is missing.
