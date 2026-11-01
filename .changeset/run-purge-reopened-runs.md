---
"@bratsos/workflow-engine": patch
---

`run.purge` no longer deletes a run redriven during its sweep, and its result names only the runs it deleted. `PersistenceCore.deleteRun` now takes `(id, cutoff, statuses)`, rechecks them in the delete itself and returns whether it deleted, so custom adapters must update it. `releaseIdempotencyKey` removes a key whatever its state.
