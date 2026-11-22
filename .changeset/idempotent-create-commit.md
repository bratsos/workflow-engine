---
"@bratsos/workflow-engine": patch
---

A keyed command with no work after its commit (such as `run.create`) now completes its idempotency key in the same transaction as its writes. Before, a crash or a failed key write right after the commit left the run committed while the key was released or stayed in progress, so a retry with the same key created a second run. A retry now returns the run that was created. Commands with post-commit work complete their key after it, as before. No schema change.
