/**
 * The retry decision for a stage whose attempt threw, shared by the two
 * places a stage body runs: `job.execute` (through the executor) and the
 * replay in `stage.pollSuspended`. Keeping it here is what makes "the same
 * throw gets the same treatment" true by construction.
 */

import type { KernelDeps } from "../kernel.js";
import { HOST_DEFAULTS } from "./host-support.js";

export { isRetryableStageError } from "./stage-error-class.js";

/**
 * Whether a failed attempt is retried: the error is not deterministic and
 * the attempt budget has room. A caller that has no attempt information
 * (a direct `job.execute` dispatch) never retries.
 */
export function willRetryStage(options: {
  attempt: number | undefined;
  maxAttempts: number | undefined;
  retryable: boolean | undefined;
}): boolean {
  return (
    options.attempt !== undefined &&
    options.retryable !== false &&
    options.attempt < (options.maxAttempts ?? HOST_DEFAULTS.maxAttempts)
  );
}

/**
 * Re-open the FAILED `run` steps of a stage record for a new attempt.
 * The row is put back to `running` with no lease — the state of a step
 * whose worker died — so the replay's compare-and-set re-claims it, bumps
 * `attempt` and executes the step again. `attempt` is never reset: it
 * counts every execution of the step across attempts (a row that read
 * `failed attempt 3` re-runs as attempt 4), so the ledger keeps the
 * per-step history. The failure text stays on `error` until the re-run
 * overwrites it. Waits, signals and sleeps that failed (a deadline that
 * passed) are terminal and stay so.
 */
export async function reopenFailedSteps(
  stageRecordId: string,
  deps: KernelDeps,
): Promise<void> {
  const ledger = deps.stepLedger;
  if (!ledger) return;
  const rows = await ledger.list(stageRecordId);
  for (const row of rows) {
    if (row.status !== "failed" || row.kind !== "run") continue;
    await ledger.compareAndSet(
      stageRecordId,
      row.stepId,
      { status: "failed", attempt: row.attempt },
      { status: "running", leaseExpiresAt: null },
    );
  }
}
