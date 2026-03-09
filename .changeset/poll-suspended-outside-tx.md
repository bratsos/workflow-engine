---
"@bratsos/workflow-engine": patch
---

Move checkCompletion() calls outside Prisma interactive transaction in stage.pollSuspended to prevent P2028 timeout errors when batch provider APIs are slow to respond.
