---
"@bratsos/workflow-engine": patch
---

Suspended-stage polling now keeps a durable settlement marker until its job acknowledgement succeeds. Later polls retry failed completion and failure acknowledgements without executing the terminal stage again, including after a restart.
