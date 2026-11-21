---
"@bratsos/workflow-engine": minor
---

Retry classification: `NonRetryableError`, `retryIf`, and one verdict wherever a stage throw is retried.

- **`NonRetryableError`** (with `isNonRetryableError`, which recognises it across bundled copies) fails a stage attempt terminally when thrown from a stage or a `ctx.step.run` body: no step `retries`, no job retry, no poll retry. Pass the original error as `cause`. An AI map item whose model call throws it fails at once, with no in-process retry or repair.
- **`StepRunOptions.retryIf(error, { attempt })`** decides per error. An async predicate is awaited. `false` stops the step, and the stage receives a `NonRetryableError` with the original as `cause`. A predicate that throws or rejects is logged and the error stays retryable. Without it a step retries every error but `NonRetryableError`.
- **One classifier** decides for `job.execute`, for a replay in `stage.pollSuspended`, and for remote workers. It reads brands and shapes, not classes, so it gives the same verdict for an error thrown by another copy of the engine or of zod. It now also rejects a Zod error from any copy of zod (an application's own copy, another major, `zod/mini`, a core `$ZodError` that is not an `Error`, one decoded from JSON), an expired durable wait and an `onReclaim: "fail"` refusal. These used to spend job attempts on the same error.
- **The verdict survives the step ledger.** A failed `run` row records the error's name and verdict in its `result`, scoped to its attempt and read only while the row's last outcome is a failure. A replay rethrows the same name with the same verdict, and `isNonRetryableError` gives the same answer as for the first throw. The `error` text is never parsed: an ordinary message that reads like a timeout or starts with `NonRetryableError:` stays retryable.
- **Rows written by earlier releases** carry no record. They replay as a plain `Error` with the stored message and an ordinary verdict, as before. The exception is an `onReclaim: "fail"` refusal, which stays refused: before, a step with `retries` left ran it.
- **Retried steps under `onReclaim: "fail"`.** A stage retry leaves a non-retryable step failed instead of re-opening it. It re-runs a step whose body threw a retryable error even under `onReclaim: "fail"`, where that step used to be refused as if its worker had died. Every other row that is open again with no live lease is still refused: a terminal failure, a completed step, or a refusal that re-running a failed stage re-opened, including after a job was delivered again following a lost acknowledgement.
- **A throwing `checkCompletion` is unchanged.** It fails the stage and the run on that poll.
- **Dead jobs are recognised by type and target.** `job.execute` throws `JobTargetMissingError` (now exported, with `isJobTargetMissingError`) when the job's workflow, stage or run is missing. The host helper acknowledges a job as dead only for that error naming the job's own target, recognised by its brand or, after a transport that keeps only the name and message, by its name. An executor error that only reads like one, or the missing target of another dispatch made inside the job, is rethrown.
- `isRetryableStageError` and `describeThrown` are exported from `@bratsos/workflow-engine/kernel`.

No schema change.
