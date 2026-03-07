---
"@bratsos/workflow-engine-host-node": patch
"@bratsos/workflow-engine-host-serverless": patch
---

Fix release script to use pnpm -r publish so workspace:* dependencies are resolved to actual versions at publish time
