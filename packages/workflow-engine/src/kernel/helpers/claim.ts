/**
 * Shared "claim the run, do work, survive a concurrent cancel/rerun"
 * choreography used by stage-poll-suspended (every Phase-2 transaction)
 * and job-execute (the three Phase-3 completion transactions).
 */

import {
  type CreateAnnotationInput,
  StaleVersionError,
} from "../../persistence/interface.js";
import { RunNotRunningError } from "../errors.js";
import type { KernelEvent } from "../events.js";
import type { KernelDeps } from "../kernel.js";
import type { WorkflowRunRecord, WorkflowStageRecord } from "../ports.js";
import { buildAnnotationEvents } from "./annotation-events.js";
import { toOutboxEvents } from "./outbox-events.js";

export type ClaimOutcome<T> =
  | { status: "claimed"; value: T }
  | { status: "stale" }
  | { status: "cancelled"; runStatus: string; message: string };

/**
 * Runs `fn` inside a transaction guarded by a RUNNING-status check.
 *
 * When `expectedVersion` is supplied, the guard also claims the run via a
 * version-guarded `updateRun` before invoking `fn` — this additionally
 * detects (and rolls back on) a concurrent writer racing the SAME run
 * (e.g. two hosts polling overlapping suspended-stage batches). Callers
 * that don't need that extra guard (job-execute's Phase-3 stage-only
 * writes, which never touch the run row and must not contend with a
 * parallel sibling stage's own completion) omit it and get just the
 * status check.
 *
 * Returns:
 *  - `{status: "claimed", value}` — `fn` ran and the transaction committed.
 *  - `{status: "stale"}` — only possible when `expectedVersion` was
 *    passed: another writer claimed the run first: roll back and let the
 *    caller decide (typically: re-check status, otherwise defer to the
 *    next cycle).
 *  - `{status: "cancelled", runStatus, message}` — the run was no longer
 *    RUNNING (e.g. `run.cancel` committed between the caller's outer
 *    status check and this transaction): all pending writes (stage
 *    update, annotations, outbox events) rolled back atomically.
 *
 * Any other error propagates unchanged.
 */
export async function withClaimedRun<T>(
  workflowRunId: string,
  expectedVersion: number | undefined,
  deps: KernelDeps,
  fn: (tx: KernelDeps["persistence"]) => Promise<T>,
): Promise<ClaimOutcome<T>> {
  try {
    const value = await deps.persistence.withTransaction(async (tx) => {
      // Status guard: if cancel committed between the outer status check
      // and this transaction, abort to roll back the pending writes
      // (stage update, annotations, outbox events).
      const runStatus = await tx.getRunStatus(workflowRunId);
      if (runStatus !== "RUNNING") {
        throw new RunNotRunningError(workflowRunId, runStatus ?? "DELETED");
      }
      if (expectedVersion !== undefined) {
        await tx.updateRun(workflowRunId, { expectedVersion });
      }
      return fn(tx);
    });
    return { status: "claimed", value };
  } catch (error) {
    // Only treat a StaleVersionError as "stale" when we ourselves
    // attempted the version-guarded update above — otherwise it's an
    // unrelated persistence error and must propagate like any other.
    if (expectedVersion !== undefined && error instanceof StaleVersionError) {
      return { status: "stale" };
    }
    if (error instanceof RunNotRunningError) {
      return {
        status: "cancelled",
        runStatus: error.currentStatus,
        message: error.message,
      };
    }
    throw error;
  }
}

/** Marks a suspended stage CANCELLED after its run was found cancelled. */
export async function markStageCancelled(
  stageId: string,
  deps: KernelDeps,
): Promise<void> {
  await deps.persistence.updateStage(stageId, {
    status: "CANCELLED",
    completedAt: deps.clock.now(),
    nextPollAt: null,
  });
}

/**
 * Resolves the "stale" / "cancelled" branches of a `withClaimedRun` call
 * the same way at every call site: a stale claim re-checks for
 * cancellation (a sibling claim may have raced ahead), a cancelled claim
 * marks the stage cancelled outright. Both signal the caller to move on
 * to the next suspended stage without further processing.
 *
 * Returns `true` when the caller should `continue` to its next iteration
 * (the intended call-site idiom is
 * `if (await handleClaimOutcome(...)) continue;`), `false` when the claim
 * succeeded and the caller should proceed with its own post-claim
 * bookkeeping (counters, etc.) — `claimResult`'s `value` (unused by every
 * current call site) is available to the caller directly since narrowing
 * already happened here.
 */
export async function handleClaimOutcome<T>(
  claimResult: ClaimOutcome<T>,
  stageRecord: { id: string; workflowRunId: string },
  deps: KernelDeps,
): Promise<boolean> {
  if (claimResult.status === "stale") {
    const latestStatus = await deps.persistence.getRunStatus(
      stageRecord.workflowRunId,
    );
    if (latestStatus === "CANCELLED") {
      await markStageCancelled(stageRecord.id, deps);
    }
    return true;
  }
  if (claimResult.status === "cancelled") {
    // Run was cancelled between the outer status check and the Phase-2
    // transaction. Mark this suspended stage as cancelled and move on;
    // the Phase-2 writes (stage update, annotations, outbox events) all
    // rolled back atomically.
    await markStageCancelled(stageRecord.id, deps);
    return true;
  }
  return false;
}

/**
 * Fails a stage and its run atomically: stage → FAILED, run → FAILED,
 * buffered annotations flushed, and a `stage:failed` + `workflow:failed`
 * outbox pair appended — the shape shared by every terminal failure path
 * in stage-poll-suspended (checkCompletion error, maxWaitUntil timeout,
 * unexpected throw). Wraps `withClaimedRun` so a concurrent cancel/claim
 * race is handled the same way as every other Phase-2 transaction.
 */
export async function failStageAndRun(
  stageRecord: WorkflowStageRecord,
  run: WorkflowRunRecord,
  errorMessage: string,
  bufferedAnnotations: CreateAnnotationInput[],
  deps: KernelDeps,
): Promise<ClaimOutcome<void>> {
  return withClaimedRun(
    stageRecord.workflowRunId,
    run.version,
    deps,
    async (tx) => {
      await tx.updateStage(stageRecord.id, {
        status: "FAILED",
        completedAt: deps.clock.now(),
        errorMessage,
        nextPollAt: null,
      });

      await tx.updateRun(stageRecord.workflowRunId, {
        status: "FAILED",
        completedAt: deps.clock.now(),
      });

      if (bufferedAnnotations.length > 0) {
        await tx.appendAnnotations(bufferedAnnotations);
      }

      const events: KernelEvent[] = [
        {
          type: "stage:failed",
          timestamp: deps.clock.now(),
          workflowRunId: stageRecord.workflowRunId,
          stageId: stageRecord.stageId,
          stageName: stageRecord.stageName,
          error: errorMessage,
        },
        {
          type: "workflow:failed",
          timestamp: deps.clock.now(),
          workflowRunId: stageRecord.workflowRunId,
          error: errorMessage,
        },
        ...buildAnnotationEvents(bufferedAnnotations, deps.clock.now()),
      ];

      await tx.appendOutboxEvents(
        toOutboxEvents(stageRecord.workflowRunId, events),
      );
    },
  );
}
