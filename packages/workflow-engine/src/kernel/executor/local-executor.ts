/**
 * LocalExecutor — default ActivityExecutor implementation.
 *
 * Runs stage execute() in the current process.
 *
 * Logs are written live (fire-and-forget createLog) during execution, so
 * this executor returns logs: [] — the handler does not need to persist them.
 */

import { buildStageExecutionContext } from "../helpers/build-stage-execution-context.js";
import { toErrorMessage } from "../helpers/error-message.js";
import { isRetryableStageError } from "../helpers/stage-retry.js";
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
        const error = toErrorMessage(e);
        // An error retrying cannot change (a Zod error, a duplicate durable
        // step key, a NonRetryableError, an expired wait, a refused replay)
        // is marked non-retryable rather than let hosts burn retry attempts
        // on a doomed job.
        const retryable = isRetryableStageError(e) ? undefined : false;
        return {
          error,
          errorName: e instanceof Error ? e.name : undefined,
          errorStack: e instanceof Error ? e.stack : undefined,
          retryable,
          progress: built?.progressEvents ?? [],
          annotations: built?.annotationBuffer.flush() ?? [],
          logs: [],
        };
      }
    },
  };
}
