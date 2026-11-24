---
"@bratsos/workflow-engine": minor
"@bratsos/workflow-engine-host-node": minor
"@bratsos/workflow-engine-host-serverless": minor
---

Node hosts accept `concurrency` to run more than one claimed job per process. The default is one slot. Set `maxConcurrent` on a workflow to limit its RUNNING jobs across workers using the Prisma queue on PostgreSQL or SQLite. Use an enumerable workflow registry and the same cap on all hosts that claim the workflow. The claim skips capped workflows before applying queue order and fairness.
