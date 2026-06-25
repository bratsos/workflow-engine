/**
 * RoutingExecutor — per-stage ActivityExecutor routing.
 *
 * Routes specific stage IDs to a remote executor, all others to a local
 * executor (defaults to createLocalExecutor()). This enables a mixed model:
 * heavy/expensive stages run on remote workers, lightweight stages run
 * in-process without the overhead of a round-trip.
 */

import type {
  ActivityExecutor,
  ActivityRunInput,
  ActivityRunResult,
  ExecutorDeps,
} from "../ports.js";
import { createLocalExecutor } from "./local-executor.js";

export interface RoutingExecutorOptions {
  /** Executor used for stage IDs listed in remoteStageIds. */
  remote: ActivityExecutor;
  /** Stage IDs that should be routed to the remote executor. */
  remoteStageIds: ReadonlyArray<string>;
  /**
   * Executor used for all other stage IDs.
   * Defaults to createLocalExecutor() — lazily created on first use.
   */
  local?: ActivityExecutor;
}

export function createRoutingExecutor(
  opts: RoutingExecutorOptions,
): ActivityExecutor {
  let localExecutor: ActivityExecutor | undefined = opts.local;

  return {
    run(
      input: ActivityRunInput,
      deps: ExecutorDeps,
    ): Promise<ActivityRunResult> {
      if (opts.remoteStageIds.includes(input.stageId)) {
        return opts.remote.run(input, deps);
      }
      if (!localExecutor) {
        localExecutor = createLocalExecutor();
      }
      return localExecutor.run(input, deps);
    },
  };
}
