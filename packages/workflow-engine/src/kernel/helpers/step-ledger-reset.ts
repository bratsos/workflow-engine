/**
 * Putting a stage record's step ledger back to a state a new attempt can
 * execute from, without destroying what the ledger knows.
 *
 * Two callers need this and they want different amounts kept:
 *
 *  - `job.execute`, executing a stage whose attempts are exhausted
 *    (`"restart"`): the attempt must start clean, or the replay answers
 *    every step from the last attempt's rows and nothing actually re-runs.
 *    Only the rows naming an external effect survive, and those are
 *    re-opened so the body runs again and re-adopts the effect.
 *  - `run.redrive` resuming at a stage (`"resume"`): the operator wants the
 *    progress the stage made. Every `completed` row survives as it is, so
 *    a completed step's body never runs again and the external key it was
 *    given still names the effect it made; a row naming an external effect
 *    that did not complete is re-opened, exactly as the restart does.
 *
 * Everything else is dropped: waits, signals and sleeps hold only timers
 * and deadlines, which a fresh attempt must re-derive rather than inherit,
 * and pre-alpha.9 `run` rows carry no external key, so there is nothing in
 * them worth keeping.
 *
 * Re-opening puts a row back to `running` with no lease — the state of a
 * step whose worker died — so the replay's compare-and-set takes it over,
 * bumps `attempt` and executes the body again, exactly as a deleted row
 * would have been executed fresh. The difference is that the row, its
 * `externalKey` and its last result are still there, and the body is told
 * `isReclaim: true`, so a body that names an external effect (an AI map's
 * batch submit, above all) re-adopts the effect an earlier attempt created
 * instead of creating and billing a second one. `attempt` is never reset:
 * it counts every execution across attempts.
 *
 * The partial delete is `StepLedger.clearExcept`, optional on the port. A
 * ledger without it cannot keep some rows and drop others, so when
 * anything has to go, everything goes — the rows the caller wanted kept
 * included — and the plan says so (`fallback`) so the caller can write
 * down what it is about to lose.
 *
 * The decision (`planStepLedgerReset`) is separated from the writes
 * (`applyStepLedgerReset`) because `run.redrive` archives what it drops in
 * the same transaction as the stage rows, and touches the ledger — which
 * takes no part in that transaction — only after the commit.
 */

import type { KernelDeps } from "../kernel.js";
import type { StepLedger, StepRecord } from "../ports.js";

/** How much of the ledger the next attempt inherits. */
export type StepLedgerResetMode = "restart" | "resume";

export interface StepLedgerResetPlan {
  /** Rows that stay in the ledger. */
  readonly keep: readonly StepRecord[];
  /** Kept rows to put back to `running` with no lease. */
  readonly reopen: readonly StepRecord[];
  /** Rows the reset deletes. */
  readonly dropped: readonly StepRecord[];
  /**
   * The ledger cannot clear selectively, so rows the mode would have kept
   * are in `dropped` too. `false` whenever nothing had to be dropped.
   */
  readonly fallback: boolean;
}

/** A `run` row that holds the key of an effect a provider may still hold. */
export function namesExternalEffect(row: StepRecord): boolean {
  return row.kind === "run" && row.externalKey != null;
}

export function planStepLedgerReset(
  rows: readonly StepRecord[],
  ledger: Pick<StepLedger, "clearExcept">,
  mode: StepLedgerResetMode,
): StepLedgerResetPlan {
  const keep = rows.filter(
    (row) =>
      namesExternalEffect(row) ||
      (mode === "resume" && row.status === "completed"),
  );
  const dropped = rows.filter((row) => !keep.includes(row));

  if (keep.length > 0 && dropped.length > 0 && !ledger.clearExcept) {
    return { keep: [], reopen: [], dropped: rows, fallback: true };
  }

  const reopen = keep.filter(
    (row) => !(mode === "resume" && row.status === "completed"),
  );
  return { keep, reopen, dropped, fallback: false };
}

export async function applyStepLedgerReset(
  ledger: StepLedger,
  stageRecordId: string,
  plan: StepLedgerResetPlan,
): Promise<void> {
  if (plan.dropped.length > 0) {
    if (plan.keep.length === 0) {
      await ledger.clear(stageRecordId);
    } else {
      // `planStepLedgerReset` only keeps a partial set on a ledger that
      // has the method.
      await ledger.clearExcept?.(
        stageRecordId,
        plan.keep.map((row) => row.stepId),
      );
    }
  }
  for (const row of plan.reopen) {
    if (row.status === "running" && row.leaseExpiresAt === null) continue;
    await ledger.compareAndSet(
      stageRecordId,
      row.stepId,
      { status: row.status, attempt: row.attempt },
      { status: "running", leaseExpiresAt: null },
    );
  }
}

/**
 * Put a terminally FAILED stage's step ledger back to the state a stage that
 * has never run is in, without destroying it.
 *
 * The intent this replaces is sound: executing a stage whose attempts are
 * exhausted must start clean, or the replay answers every step from the last
 * attempt's rows and nothing actually re-runs. It used to be met by deleting
 * the rows — which also deleted the row holding a live batch's handle and,
 * since 1.0.0-alpha.9, its external key. A stage that failed terminally while
 * a batch was still being processed (and still being billed) lost the only
 * record of that batch. Nobody could find it afterwards.
 *
 * Re-opening reaches the same place without the loss; see the module
 * comment for what is kept, re-opened and dropped. A third-party ledger
 * with no partial clear loses the rows, as it always did, but not
 * silently: what is being dropped is written to the run's log so an
 * operator can still find the effects.
 */
export async function resetStageStepsForFreshAttempt(
  workflowRunId: string,
  stageRecordId: string,
  deps: KernelDeps,
): Promise<void> {
  const ledger = deps.stepLedger;
  if (!ledger) return;
  const rows = await ledger.list(stageRecordId);
  if (rows.length === 0) return;
  const plan = planStepLedgerReset(rows, ledger, "restart");

  if (plan.fallback) {
    const lost = plan.dropped.filter(namesExternalEffect);
    await deps.persistence
      .createLog({
        workflowRunId,
        workflowStageId: stageRecordId,
        level: "WARN" as any,
        message:
          `Re-running a failed stage cleared ${lost.length} durable step row(s) that named an ` +
          `external effect; this StepLedger cannot clear selectively. Any effect still in flight ` +
          `must be found by its external key.`,
        metadata: {
          steps: lost.map((row) => ({
            stepId: row.stepId,
            status: row.status,
            externalKey: row.externalKey,
          })),
        },
      })
      .catch(() => {});
  }

  await applyStepLedgerReset(ledger, stageRecordId, plan);
}
