---
"@bratsos/workflow-engine": minor
---

Retry classification: `NonRetryableError`, `retryIf`, and one verdict wherever a throw is met.

- **`NonRetryableError`** (with `isNonRetryableError`, which recognises it across bundled copies) fails a stage attempt terminally when thrown from a stage, a `checkCompletion` or a `ctx.step.run` body: no step `retries`, no job retry, no poll retry. Pass the original error as `cause`. An AI map item whose model call throws it fails at once, with no in-process retry or repair.
- **`StepRunOptions.retryIf(error, { attempt })`** decides per error: `false` treats the failure as a `NonRetryableError`, which the stage receives with the original as `cause`. A predicate that throws is logged and counts as retryable. Without it a step retries every error but `NonRetryableError`.
- **One classifier** decides for `job.execute`, for a replay and a throwing `checkCompletion` in `stage.pollSuspended`, and for remote workers. It now also rejects a Zod error from any copy of zod (an application's own copy, another major, `zod/mini`), an expired durable wait and an `onReclaim: "fail"` refusal, which used to spend job attempts on the same error.
- **The verdict survives the step ledger.** A failed `run` row records the error's name and verdict in its `result`, scoped to its attempt, so a replay rethrows the same name and reaches the same verdict as the first throw. The `error` text is never parsed: an ordinary message that reads like a timeout or starts with `NonRetryableError:` stays retryable. A stage retry leaves a non-retryable step failed instead of re-opening it, and re-runs a step whose body threw even under `onReclaim: "fail"`, which used to refuse it as if its worker had died; a real refusal stays refused after a retry, a restart or a redrive.
- **A throwing `checkCompletion` is retried** with the attempts the stage's `SUSPENDED` job row has left, as a throwing replay is; only consecutive throws count, and a poll that answers cleanly clears the error. The retry is written only while the stage is as the poller claimed it. A `checkCompletion` that returns `{ error }` still fails at once. A poll records a named error as `"Name: message"`, as `job.execute` does.
- **Dead jobs are recognised by type.** The host helper acknowledges a job as dead only when `job.execute` reports its workflow, stage or run missing, not when any error's text reads like that; such an error from a custom `ActivityExecutor` is now rethrown.
- `isRetryableStageError` is exported from `@bratsos/workflow-engine/kernel`.

No schema change.
