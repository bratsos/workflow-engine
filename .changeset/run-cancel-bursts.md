---
"@bratsos/workflow-engine": patch
---

Cancelling many runs at once no longer fails with P2028.

- **The bug:** `run.cancel` cancelled the run's queued jobs inside its own transaction, but the job queue works on its own connection, so every cancel in flight held one connection and waited for a second. A burst of cancels as large as the connection pool used every connection and none could finish: each failed with `P2028` after 5 seconds. A cancel that timed out also rolled back its run while its job update still ran afterwards, which left CANCELLED jobs under a run that was still RUNNING.
- **The fix:** the jobs are now cancelled after the transaction commits, so a cancel needs one connection at a time. A burst of 50 cancels on a pool of 10 completes, and every run and job ends CANCELLED.
- **What changes for you:** between the commit and the job update, a worker that dequeues one of the run's jobs finds the run CANCELLED and discards the job as an orphan, so that job ends FAILED instead of CANCELLED. If the job update itself fails, `kernel.dispatch` rejects with that error while the run stays CANCELLED; a PENDING job is then closed the same way when a worker dequeues it, and a SUSPENDED job stays SUSPENDED until `run.purge`. A second `run.cancel` on that run returns `cancelled: false` and does not retry the job update. A `run.redrive` that lands between the cancel's commit and the job update is undone: `run.redrive` accepts a `CANCELLED` run, so the run ends `RUNNING` with its new job `CANCELLED`, and `run.reapStuck` re-enqueues the job later.
