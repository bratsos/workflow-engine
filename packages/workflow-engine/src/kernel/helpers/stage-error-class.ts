/**
 * The one answer to "can retrying this error change anything?", shared by
 * every place that decides a retry: `job.execute` (through the local and
 * remote executors), `stage.pollSuspended` and a remote worker's report.
 * It sees errors thrown live in the current execution; a durable step
 * failure replayed from the ledger is rebuilt from its text, as on main.
 */

import { ZodError } from "zod";
import {
  isDuplicateStepKeyError,
  isNonRetryableError,
  STEP_TERMINAL_FAILURE,
} from "../../core/steps.js";

/**
 * `false` for an error that retrying cannot change, so nothing may spend an
 * attempt on it:
 *  - a duplicate durable step key (a collision between two call sites);
 *  - a `NonRetryableError`, thrown by the stage or a step (or made by a
 *    step's `retryIf`);
 *  - an expired durable wait (`StepTimeoutError`) and a step that refuses to
 *    be replayed (`StepNotReplaySafeError`), as the execution that recorded
 *    them throws them;
 *  - a Zod error, from any copy of zod (the same input fails the same way).
 * Every check is a brand or a shape, never `instanceof` alone, so an error
 * thrown by another copy of the engine or of zod gets the same verdict. Each
 * check stands alone: a diagnostic that cannot be read (a throwing `issues`
 * or `name` getter) proves nothing, and never hides a brand.
 */
export function isRetryableStageError(error: unknown): boolean {
  return !(
    holds(() => isDuplicateStepKeyError(error)) ||
    holds(() => isNonRetryableError(error)) ||
    holds(
      () =>
        typeof error === "object" &&
        error !== null &&
        (error as { [STEP_TERMINAL_FAILURE]?: unknown })[
          STEP_TERMINAL_FAILURE
        ] === true,
    ) ||
    holds(() => isZodError(error))
  );
}

/** `check()`, or `false` when reading the error throws. */
function holds(check: () => boolean): boolean {
  try {
    return check();
  } catch {
    return false;
  }
}

/**
 * A Zod error from any copy of zod. The application's own copy, another
 * major or `zod/mini` is not an instance of this package's `ZodError`, so the
 * class alone would let its failure be retried. What every flavour shares is
 * the name and an `issues` array.
 */
function isZodError(error: unknown): boolean {
  if (error instanceof ZodError) return true;
  if (typeof error !== "object" || error === null) return false;
  const { name, issues } = error as { name?: unknown; issues?: unknown };
  return (name === "ZodError" || name === "$ZodError") && Array.isArray(issues);
}
