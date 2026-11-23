---
"@bratsos/workflow-engine": patch
"@bratsos/workflow-engine-host-node": patch
"@bratsos/workflow-engine-host-serverless": patch
---

Automatic accounting writes and stage drains run independently of workflow outcomes, deadlines and leases. The kernel applies its own timeout to custom logger drains, and infrastructure failures during the drain preserve the host result. Explicit `flush()` waits for accounting within its configured bound.

**Rolling-safe** because the existing storage contract is unchanged.
