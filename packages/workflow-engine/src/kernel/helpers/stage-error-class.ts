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
  return !(
    isZodError(error) ||
    isDuplicateStepKeyError(error) ||
    isNonRetryableError(error) ||
    isTerminalStepFailure(error)
  );
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

/** What a failed `run` row remembers about its failure, beyond the text. */
export interface StepFailure {
  /** `Error.name` of the thrown error, restored when a replay rethrows it. */
  readonly name?: string;
  /**
   * Stage-level verdict: `isRetryableStageError` rejected the error. A
   * replay rethrows it as a `NonRetryableError`, and a stage retry leaves
   * the row failed.
   */
  readonly final: boolean;
  /**
   * Step-level verdict: the body threw `NonRetryableError` or `retryIf`
   * said no, so the step's own `retries` stop here.
   */
  readonly stop: boolean;
  /**
   * The engine refused to replay a step whose worker died (`onReclaim:
   * "fail"`): the body's outcome is unknown, unlike a body that threw.
   */
  readonly refused: boolean;
  /** `Error.name` of a `retryIf` refusal's original error (its `cause`). */
  readonly causeName?: string;
  /**
   * A stage retry re-opened this row because its body threw a retryable
   * error: the body said its effect did not take, so the next execution
   * runs it even under `onReclaim: "fail"`. Only `reopenFailedSteps` sets
   * it; a row re-opened any other way (re-running a failed stage) is
   * treated as a takeover.
   */
  readonly retry?: boolean;
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
  verdict: Omit<StepFailure, "name" | "retry">,
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

/** `result` for a row a stage retry re-opens: its record, granted a rerun. */
export function retryGrantedResult(row: {
  attempt: number;
  result?: unknown;
  error?: string | null;
}): Record<string, unknown> | undefined {
  const failure = readStepFailure(row);
  if (!failure) return undefined;
  return {
    [STEP_FAILURE_KEY]: { attempt: row.attempt, ...failure, retry: true },
  };
}

/**
 * The failure record a `run` row holds for its current attempt, whatever
 * its status: a failed row, or one a stage retry or a reset re-opened
 * (`running`, no lease, attempt unchanged). Only a row whose last outcome
 * was a failure carries one: the `error` column is set on every failed
 * write and cleared by every completion, so a completed body's own result
 * is never read as a record, whatever it contains. Rows written before
 * this record existed have none and read as an ordinary failure.
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
  const { attempt, name, final, stop, refused, causeName, retry } =
    record as Record<string, unknown>;
  if (attempt !== row.attempt) return undefined;
  return {
    ...(typeof name === "string" ? { name } : {}),
    ...(typeof causeName === "string" ? { causeName } : {}),
    final: final === true,
    stop: stop === true,
    refused: refused === true,
    ...(retry === true ? { retry: true } : {}),
  };
}

/**
 * The error a replay rethrows for a failed `run` row: the message as
 * thrown, under its original name, and with the verdict of the first throw.
 * A `NonRetryableError` (thrown, or made by a `retryIf` refusal, whose
 * original comes back as `cause` by name and message) is one again; any
 * other error the classifier rejected carries the terminal brand but not
 * the `NonRetryableError` one, so `isNonRetryableError` answers the same
 * directly and after a replay.
 */
export function replayedStepError(
  message: string,
  failure: StepFailure | undefined,
): Error {
  let error: Error;
  if (failure?.stop && !failure.refused) {
    const cause =
      failure.causeName !== undefined
        ? Object.assign(new Error(message), { name: failure.causeName })
        : undefined;
    error = new NonRetryableError(message, cause ? { cause } : undefined);
  } else {
    error = new Error(message);
    if (failure?.final)
      Object.defineProperty(error, STEP_TERMINAL_FAILURE, { value: true });
  }
  if (failure?.name) error.name = failure.name;
  return error;
}
