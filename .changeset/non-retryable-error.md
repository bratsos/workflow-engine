---
"@bratsos/workflow-engine": minor
---

Retry classification: `NonRetryableError`, `retryIf`, and one verdict wherever a stage throw is retried.

- **`NonRetryableError`** (with `isNonRetryableError`, which recognises it across bundled copies) fails a stage attempt terminally when thrown from a stage or a `ctx.step.run` body: no step `retries`, no job retry, no poll retry. Pass the original error as `cause`. An AI map item whose model call throws it fails at once, with no in-process retry or repair.
- **`StepRunOptions.retryIf(error, { attempt })`** decides per error, synchronously. `false` stops the step's own `retries`, and the stage receives a `NonRetryableError` with the original as `cause`. A predicate that throws or returns a promise is logged, and the error stays retryable. Without it a step retries every error but `NonRetryableError`.
- **One classifier** decides for `job.execute`, for a replay in `stage.pollSuspended`, and for remote workers. It now also rejects:
  - a Zod error from any copy of zod (an application's own copy, another major, `zod/mini`, a core `$ZodError` that is not an `Error`, one decoded from JSON);
  - an expired durable wait and an `onReclaim: "fail"` refusal, which used to spend job attempts on the same error.

  It reads brands and shapes, not classes, so another engine copy of this release or later gets the same verdict. `StepTimeoutError` and `StepNotReplaySafeError` from an earlier release carry no brand and are still retried, and so is any of these errors after a JSON round trip.
- **The verdict travels with the step ledger, as metadata only.** A failed `run` row records the error's name and verdict in its `result`, for the attempt that wrote it. A replay rethrows the same name with the same verdict, and `isNonRetryableError` gives the same answer as for the first throw. A `retryIf` refusal's `cause` comes back as an `Error` with the original's message (and name, when it had one), not the original value. The record never decides whether a step runs again: stage retries re-open failed steps and `onReclaim` decides takeovers exactly as before. The `error` text is never parsed.
- **Rows written by earlier releases** carry no record. They replay as a plain `Error` with the stored message and an ordinary verdict, as before.
- **A throwing `checkCompletion` is unchanged.** It fails the stage and the run on that poll.
- **Dead jobs.** `job.execute` throws `JobTargetMissingError` (now exported, with `isJobTargetMissingError`) when the job's workflow, stage or run is missing, with the same text as before and the command's `target`. The host helper acknowledges a job as dead in two cases:
  - the branded error, whose `target` is that job's workflow, stage and run;
  - an error carried as name and message, or the plain `Error` an earlier release's kernel throws, whose message is exactly the one thrown for that job's own workflow, stage or run.

  An executor error that only reads like one, or the branded missing target of another dispatch made inside the job, is rethrown. Without the brand, a nested dispatch's missing workflow with the same id cannot be told apart from the job's own.
- A decoded error object (`{ name, message }`) keeps its message wherever the engine records a failure, where it used to read `[object Object]`.
- `isRetryableStageError` and `describeThrown` are exported from `@bratsos/workflow-engine/kernel`.

No schema change.
