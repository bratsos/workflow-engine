---
"@bratsos/workflow-engine": patch
---

`run.purge` no longer deletes data a redriven run still needs, and no longer leaves data behind from writers that race it.

- Before it touches a run, the sweep takes a per-run purge claim (an idempotency key of type `run.purge.claim`) and re-reads the run and its current stage records. Previously a redrive that landed during the sweep kept the run but lost the blobs, ledger rows or job the sweep had already deleted, and a run redriven and finished again between selection and the sweep was cleaned with its old stage record ids, leaving the new record's spilled step results and signal wake keys behind.
- While the claim is held, `run.redrive`, `run.rerunFrom` and a `step.signal` wake on that run reject with "is being deleted by run.purge". Retry them once the purge has finished. A claim left by a crashed sweep can be taken over after 10 minutes.
- After deleting a run, the sweep repeats its cleanup once. A post-commit enqueue (`run.claimPending`, `run.transition`, `run.redrive`, `run.reapStuck`) that lands after the run was deleted removes its jobs and their spilled payloads, and a signal whose stage record was deleted while it was delivering removes its ledger row, spilled payload and wake key.
- `run.redrive` releases the signal wake keys of the stage records it deletes. They were never released, since neither a later signal nor `run.purge` can find a deleted record.
- `run.rerunFrom` checks COMPLETED/FAILED on the same read its run update is fenced on, so a run cancelled while it was deciding is refused instead of redriven.

- `stage.pollSuspended` no longer fails a stage that a `job.execute` completed while the poll was running. A stale `checkCompletion` that returned or threw an error, a deadline that elapsed, or a durable replay that ran out of attempts used to write FAILED over the COMPLETED stage and fail its run. The failure is now fenced on the stage row's version and the poll moves on.
- More generally, a `checkCompletion` or durable replay that resolves after a `job.execute`, a cancel, a redrive or another poller wrote the stage now writes nothing of its own: no stage update, output, artifacts, annotations or events, and it is not counted as resumed. Each poll reads the stage row once more before its first write. Output and artifacts a poll writes go under a `poll-<stageRecordId>-<version>/` folder of the stage prefix and are removed if its commit loses. What user code writes itself (`ctx.storage`, `ctx.log`, step rows) is not covered. The in-memory persistence now throws `StaleVersionError`, as the Prisma adapter does, for a version-fenced `updateStage` on a deleted row.

- A redrive that deletes stage records now writes their ids, in its transaction, to an idempotency record (`run.redrive.pendingLedgerClear`, keyed by the run id) and releases their signal wake keys there too. If its post-commit step-ledger clear fails, the record stays and `run.purge` clears those ledgers and spilled step results before it reports the run deleted. Previously the checkpoint and spill of such a record outlived the purge.
- A redrive's blob cleanup of deleted records is listed before the commit and keeps the keys their `outputData` points at. A new attempt that writes its output while the cleanup runs keeps it, and a redrive run on a caller's transaction that the caller rolls back no longer leaves the restored records pointing at deleted output. Keys a stage wrote itself through `ctx.storage` under its stage prefix are still deleted after the commit.

No port changes. A redrive that deletes records adds two statements to its transaction (the pending record) and one after the commit; a purge adds one or two per run. `job.execute` is unchanged; each post-commit enqueue reads the run once more.
