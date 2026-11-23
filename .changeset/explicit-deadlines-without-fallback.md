---
"@bratsos/workflow-engine": patch
"@bratsos/workflow-engine-host-node": patch
"@bratsos/workflow-engine-host-serverless": patch
---

Enforce explicit workflow and stage job deadlines when the host fallback `jobAbsoluteTimeoutMs` is zero. Jobs without an explicit deadline have no absolute cap in this configuration.
