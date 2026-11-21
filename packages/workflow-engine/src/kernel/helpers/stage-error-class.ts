/**
 * The one answer to "can retrying this error change anything?", shared by
 * every place that decides a retry: `job.execute` (through the local and
 * remote executors), `stage.pollSuspended`, a remote worker's report, and
 * `step.run`, which records the answer with a failed step's ledger row so a
 * replay reaches the same verdict as the first throw.
 */

import { ZodError } from "zod";
import {
  isDuplicateStepKeyError,
  isNonRetryableError,
  NonRetryableError,
  STEP_TERMINAL_FAILURE,
} from "../../core/steps.js";
import { describeThrown } from "./error-message.js";

/**
 * `false` for an error that retrying cannot change, so nothing may spend an
 * attempt on it:
 *  - a Zod error, from any copy of zod (the same input fails the same way);
 *  - a duplicate durable step key (a collision between two call sites);
 *  - a `NonRetryableError`, thrown by the stage or a step (or made by a
 *    step's `retryIf`), including one a replay reads back from the ledger;
 *  - an expired durable wait (`StepTimeoutError`) and a step that refuses to
 *    be replayed (`StepNotReplaySafeError`): each is recorded on its ledger
 *    row, which the next attempt answers with the same error;
 *  - a failure of any of these kinds that a ledger replay rethrows.
 * Every check is a brand or a shape, never `instanceof` alone, so an error
 * thrown by another copy of the engine or of zod gets the same verdict.
 */
export function isRetryableStageError(error: unknown): boolean {
  try {
    return !(
      isZodError(error) ||
      isDuplicateStepKeyError(error) ||
      isNonRetryableError(error) ||
      isTerminalStepFailure(error)
    );
  } catch {
    // A diagnostic getter that throws (`name`, `issues`) proves no verdict:
    // the error stays ordinary, and its failure is still recorded.
    return true;
  }
}

function isTerminalStepFailure(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { [STEP_TERMINAL_FAILURE]?: unknown })[STEP_TERMINAL_FAILURE] ===
      true
  );
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

/** Key a failed `run` row's `result` carries its failure record under. */
const STEP_FAILURE_KEY = "__failure";

/**
 * What a failed `run` row remembers about its failure, beyond the text. It
 * is read-only metadata: it decides which error a replay rethrows and with
 * what verdict, never whether a step runs again (except that a step whose
 * body gave up spends no more of its own `retries`).
 */
export interface StepFailure {
  /** `Error.name` of the thrown error, restored when a replay rethrows it. */
  readonly name?: string;
  /** Stage-level verdict: `isRetryableStageError` rejected the error. */
  readonly final: boolean;
  /**
   * Step-level verdict: the body threw `NonRetryableError` or `retryIf`
   * said no, so the step's own `retries` stop here. Never set for an
   * engine refusal, which leaves the step's retries as they were.
   */
  readonly stop: boolean;
  /** A `retryIf` refusal wrapped the original error as its `cause`. */
  readonly wrapped?: boolean;
  /** `Error.name` of that original error, when it had one. */
  readonly causeName?: string;
}

/**
 * The `result` to write with a failed `run` row. The ledger has no column
 * for the verdict, and the `error` column must stay the message as thrown
 * (a message that looks like a marker must not become one), so it travels
 * in `result`, which nothing reads on a failed row (an AI map item replaces
 * it with its own verdict). It names the attempt it was written for, so a
 * row that is taken over and run again does not inherit it.
 */
export function stepFailureResult(
  thrown: unknown,
  attempt: number,
  verdict: Omit<StepFailure, "name">,
): Record<string, unknown> {
  const { name } = describeThrown(thrown);
  return {
    [STEP_FAILURE_KEY]: {
      attempt,
      ...(name ? { name } : {}),
      ...verdict,
    },
  };
}

/**
 * The failure record a failed `run` row holds for its current attempt. Only
 * a row whose last outcome was a failure carries one: the `error` column is
 * set on every failed write and cleared by every completion, so a completed
 * body's own result is never read as a record, whatever it contains. A
 * record written for another attempt (a late write from an execution whose
 * lease was taken over) is ignored, and so are rows written before this
 * record existed: those read as an ordinary failure, as before.
 */
export function readStepFailure(row: {
  attempt: number;
  result?: unknown;
  error?: string | null;
}): StepFailure | undefined {
  if (typeof row.error !== "string") return undefined;
  const result = row.result;
  if (typeof result !== "object" || result === null) return undefined;
  const record = (result as Record<string, unknown>)[STEP_FAILURE_KEY];
  if (typeof record !== "object" || record === null) return undefined;
  const { attempt, name, final, stop, wrapped, causeName } = record as Record<
    string,
    unknown
  >;
  if (attempt !== row.attempt) return undefined;
  return {
    ...(typeof name === "string" ? { name } : {}),
    final: final === true,
    stop: stop === true,
    ...(wrapped === true ? { wrapped: true } : {}),
    ...(typeof causeName === "string" ? { causeName } : {}),
  };
}

/**
 * The error a replay rethrows for a failed `run` row: the message as
 * thrown, under its original name, and with the verdict of the first throw.
 * A `NonRetryableError` is one again; a `retryIf` refusal's `cause` comes
 * back as an `Error` with the original's message (and name, when it had
 * one), since a row holds text, not the value. Any other error the
 * classifier rejected carries the terminal brand but not the
 * `NonRetryableError` one, so `isNonRetryableError` answers the same
 * directly and after a replay.
 */
export function replayedStepError(
  message: string,
  failure: StepFailure | undefined,
): Error {
  let error: Error;
  if (failure?.stop) {
    const cause = failure.wrapped ? new Error(message) : undefined;
    if (cause && failure.causeName) cause.name = failure.causeName;
    error = new NonRetryableError(message, cause ? { cause } : undefined);
  } else {
    error = new Error(message);
    if (failure?.final)
      Object.defineProperty(error, STEP_TERMINAL_FAILURE, { value: true });
  }
  if (failure?.name) error.name = failure.name;
  return error;
}
