/**
 * LocalExecutor — default ActivityExecutor implementation.
 *
 * Runs stage execute() in the current process.
 *
 * Logs are written live (fire-and-forget createLog) during execution, so
 * this executor returns logs: [] — the handler does not need to persist them.
 */

import { buildStageExecutionContext } from "../helpers/build-stage-execution-context.js";
import { describeThrown, toErrorMessage } from "../helpers/error-message.js";
import { retryableStageError } from "../helpers/stage-error-class.js";
import type {
  ActivityExecutor,
  ActivityRunInput,
  ActivityRunResult,
  ExecutorDeps,
} from "../ports.js";

export function createLocalExecutor(): ActivityExecutor {
  return {
    async run(
      input: ActivityRunInput,
      deps: ExecutorDeps,
    ): Promise<ActivityRunResult> {
      let built: ReturnType<typeof buildStageExecutionContext> | undefined;
      try {
        built = buildStageExecutionContext(input, deps);
        const result = await input.stageDef.execute(built.context);

        return {
          result,
          progress: built.progressEvents,
          annotations: built.annotationBuffer.flush(),
          logs: [],
        };
      } catch (e) {
        // An Error is read as main reads it, each field once: a throwing
        // `name` or `stack` getter propagates as it always has. Any other
        // value keeps its decoded `name` and `message` (never throws).
        const isError = e instanceof Error;
        let error: string;
        let name: string | undefined;
        if (isError) {
          error = toErrorMessage(e);
          name = e.name;
        } else {
          ({ name, message: error } = describeThrown(e));
        }
        // An error retrying cannot change (a Zod error, a duplicate durable
        // step key, a NonRetryableError, an expired wait, a refused replay)
        // is marked non-retryable rather than let hosts burn retry attempts
        // on a doomed job. The verdict checks the name recorded below.
        const retryable = retryableStageError(e, () => name)
          ? undefined
          : false;
        return {
          error,
          errorName: name,
          errorStack: isError ? e.stack : undefined,
          retryable,
          progress: built?.progressEvents ?? [],
          annotations: built?.annotationBuffer.flush() ?? [],
          logs: [],
        };
      }
    },
  };
}
