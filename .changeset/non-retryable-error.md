---
"@bratsos/workflow-engine": minor
---

Retry classification: `NonRetryableError`, `retryIf`, and one verdict wherever a stage throw is retried.

- **`NonRetryableError`** (with `isNonRetryableError`, which recognises it across bundled copies) fails a stage attempt terminally when thrown from a stage or a `ctx.step.run` body: no step `retries`, no job retry, no poll retry. Pass the original error as `cause`. An AI map item whose model call throws it fails at once, with no in-process retry or repair.
- **`StepRunOptions.retryIf(error, { attempt })`** decides per error, synchronously. `false` stops the step's own `retries`, and the stage receives a `NonRetryableError` with the original as `cause`. A predicate that throws or returns a promise is logged, and the error stays retryable. The engine never changes or wraps what the predicate returns; it attaches a no-op rejection handler to a native `Promise` only, so a Promise subclass whose `constructor` or species getter throws, or another thenable, can still reject unhandled. Without it a step retries every error but `NonRetryableError`.
- **One classifier** decides for `job.execute`, for a replay in `stage.pollSuspended`, and for remote workers. It now also rejects:
  - a Zod error from any copy of zod (an application's own copy, another major, `zod/mini`, a core `$ZodError` that is not an `Error`, one decoded from JSON that still has its `issues` array: zod 4 does not serialize `issues`, so a `JSON.stringify` round trip drops it, and zod 3's JSON keeps `issues` but has no `message`, so its text reads `[object Object]`);
  - an expired durable wait and an `onReclaim: "fail"` refusal, as the execution that records them throws them, which used to spend job attempts on the same error.

  It reads brands and shapes, not classes, so another engine copy of this release or later gets the same verdict. `StepTimeoutError` and `StepNotReplaySafeError` from an earlier release carry no brand and are still retried, and so is any of these errors after a JSON round trip.
- **The step ledger stores what it stored before.** A failed step row holds the message only. A replayed step failure is classified as on main: it comes back as a plain `Error` with the stored message (or `StepTimeoutError` for the step's timeout text), with no brand, so a `NonRetryableError` or a `retryIf` refusal is terminal only in the execution that threw it, and a replay with `retries` left runs the body again. Stage retries re-open failed steps and `onReclaim` decides takeovers exactly as before. A numbered delivery past the first, within its attempt budget, that meets a stage a terminal verdict FAILED (the same job delivered again after its acknowledgement was lost) is answered as main's retry: completed steps stay completed and failed ones re-open; any other execution of a FAILED stage (a delivery past its budget, an unnumbered dispatch) starts it fresh, as before.
- **A throwing `checkCompletion` is unchanged.** It fails the stage and the run on that poll.
- **Dead jobs.** `job.execute` throws `JobTargetMissingError` (now exported, with `isJobTargetMissingError`) when the job's workflow, stage or run is missing, with the same text as before and the command's `target`. The host helper acknowledges a job as dead in two cases:
  - the branded error, whose `target` is that job's workflow, stage and run;
  - otherwise, any thrown value (an `Error` or a plain object) whose `name` is `JobTargetMissingError` or `Error` and whose `message` is exactly one of the three texts for that job: `Workflow <workflowId> not found in registry`, `Stage <stageId> not found in workflow <workflowId>` or `WorkflowRun <workflowRunId> not found`. This covers the plain `Error` an earlier release's kernel throws and an error decoded from JSON, and also any other error with that name and text: the stage text does not name the run, and the run text names neither the workflow nor the stage.

  An error with any other name or text, or the branded missing target of another dispatch made inside the job, is rethrown. Without the brand, a nested dispatch's missing workflow with the same id cannot be told apart from the job's own.
- A decoded error object (`{ name, message }`) keeps its message, where it used to read `[object Object]`, in a stage error recorded by `job.execute`, an AI map item and remote input validation, and keeps its name there too. A failed step row stores the text it always did, because a replay reads it, and a stage failure recorded by `stage.pollSuspended` keeps the message only, as before.
- `isRetryableStageError` and `describeThrown` are exported from `@bratsos/workflow-engine/kernel`.

No schema change.
