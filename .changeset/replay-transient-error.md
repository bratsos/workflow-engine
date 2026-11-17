---
"@bratsos/workflow-engine": patch
---

A durable stage that throws while `stage.pollSuspended` replays it (a failed commit, a step-ledger or blob write error, a body error) is now retried with the attempts its job has left, as `job.execute` retries the same throw, instead of failing the stage and the run on the first transient error. The retry keeps the step ledger, re-opens failed `run` steps, leaves the stage `SUSPENDED` with the error on `errorMessage` and emits `stage:retrying`; an expired wait, `onReclaim: "fail"`, a duplicate step key and a cancelled run still end the stage at once. A `ctx.step.run` that spends its own `retries` during a replay therefore no longer fails the run on that poll: the stage is retried, and each remaining attempt runs the step once more.
