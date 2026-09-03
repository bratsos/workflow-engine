/**
 * LocalExecutor — default ActivityExecutor implementation.
 *
 * Runs stage execute() in the current process.
 *
 * Logs are written live (fire-and-forget createLog) during execution, so
 * this executor returns logs: [] — the handler does not need to persist them.
 */

import { ZodError } from "zod";
import { buildStageExecutionContext } from "../helpers/build-stage-execution-context.js";
import { toErrorMessage } from "../helpers/error-message.js";
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
        // Zod input/config validation errors are deterministic — retrying
        // the same rawInput will fail identically, so mark non-retryable
        // rather than let hosts burn retry attempts on a doomed job.
        const retryable = e instanceof ZodError ? false : undefined;
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
