---
"@bratsos/workflow-engine-host-node": patch
"@bratsos/workflow-engine-host-serverless": patch
---

Stop starting outbox claims and sink calls when a host flush times out or Node shutdown cancels the tick. An in-flight sink call can settle under its original claim. Transactional ticks report deferred delivery until a root-client flush after commit.
