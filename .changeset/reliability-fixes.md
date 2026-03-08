---
"@bratsos/workflow-engine": patch
"@bratsos/workflow-engine-host-node": patch
"@bratsos/workflow-engine-host-serverless": patch
---

Fix reliability issues: idempotent stage creation (prevents P2002 loops), ghost job detection with no-retry in hosts, per-run error isolation in claimPending, stuck run detection via run.reapStuck with race condition guard, and orchestration tick step isolation.
