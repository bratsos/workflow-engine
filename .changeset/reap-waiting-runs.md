---
"@bratsos/workflow-engine": patch
---

`run.reapStuck` no longer fails a run whose suspended stage is waiting on a poll that is not yet due (a `ctx.step.sleep`, `waitFor` `every` or signal `keepalive` longer than the stuck threshold). It reaps the run once that poll has been overdue for more than a threshold, or when the suspended stage has no `nextPollAt`.
