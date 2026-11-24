---
"@bratsos/workflow-engine": minor
---

Set `absoluteTimeoutMs` on a workflow or stage to cap the wall time of one claimed job attempt. The stage value takes precedence. Each claim starts a new deadline that heartbeats leave unchanged. The runaway sweep uses the host cap for claims without a recorded deadline.
