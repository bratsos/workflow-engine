---
"@bratsos/workflow-engine": patch
---

`run.purge` no longer deletes data a redriven run still needs, and no longer leaves data behind from writers that race it.

- Before it touches a run, the sweep takes a per-run purge claim (an idempotency key of type `run.purge.claim`) and re-reads the run and its current stage records. Previously a redrive that landed during the sweep kept the run but lost the blobs, ledger rows or job the sweep had already deleted, and a run redriven and finished again between selection and the sweep was cleaned with its old stage record ids, leaving the new record's spilled step results and signal wake keys behind.
- While the claim is held, `run.redrive`, `run.rerunFrom` and a `step.signal` wake on that run reject with "is being deleted by run.purge". Retry them once the purge has finished. A claim left by a crashed sweep can be taken over after 10 minutes.
- After deleting a run, the sweep repeats its cleanup once. A post-commit enqueue (`run.claimPending`, `run.transition`, `run.redrive`, `run.reapStuck`) that lands after the run was deleted removes its jobs and their spilled payloads, and a signal whose stage record was deleted while it was delivering removes its ledger row, spilled payload and wake key.
- `run.redrive` releases the signal wake keys of the stage records it deletes. They were never released, since neither a later signal nor `run.purge` can find a deleted record.
- `run.rerunFrom` checks COMPLETED/FAILED on the same read its run update is fenced on, so a run cancelled while it was deciding is refused instead of redriven.

No port changes. `job.execute` is unchanged; each post-commit enqueue reads the run once more.
