---
"@bratsos/workflow-engine": patch
---

Split job.execute into multi-phase transactions so RUNNING status is visible immediately and long-running stage execution does not hold a database connection open
