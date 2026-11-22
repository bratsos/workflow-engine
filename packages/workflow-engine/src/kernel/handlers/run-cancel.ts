/**
 * Handler: run.cancel
 *
 * Cancels a running workflow authoritatively:
 * 1. Marks the run as CANCELLED
 * 2. Marks every stage that has not ended as CANCELLED (fenced on its version,
 *    so a stage another execution completed first keeps its outcome)
 * 3. Cancels queued/suspended jobs via job transport, in `_postCommit`
 * 4. Cancels the provider batches the run created, in `_postCommit`
 *
 * INVARIANT: the jobs and the provider batches are cancelled after the
 * transaction commits, never inside it. The job transport runs on its own
 * connection, so inside the kernel transaction every cancel held one
 * connection and waited for a second: a burst as large as the pool wedged it
 * until the transactions timed out, and a timed-out cancel rolled back its run
 * while its queued job update still ran afterwards, leaving CANCELLED jobs
 * under a run that was not. Provider calls are network calls of unbounded
 * duration and belong outside a transaction for the same reason.
 *
 * In the window between the commit and the job update, a worker that dequeues
 * one of the jobs finds the run CANCELLED and discards it as an orphan
 * (`job.execute`, `ghostReason: "orphan"`, the job ends FAILED). If the job
 * update fails, the run stays CANCELLED and a PENDING job is closed that way
 * when dequeued; a SUSPENDED job is never dequeued, so it stays SUSPENDED until
 * `run.purge`.
 *
 * `run.redrive` accepts a CANCELLED run, so one that lands in that window is
 * undone: the run ends RUNNING with its new job CANCELLED, and
 * `run.reapStuck` re-enqueues the job later.
 *
 * PROVIDER BATCHES. A batch is billed from the moment the provider accepts it,
 * so the batches a run's `ctx.step.ai.map` steps created (and the ones a
 * legacy async-batch stage listed in `suspendedState.metadata.batchRefs`) are
 * cancelled too; see `helpers/cancel-run-batches.ts` for how they are found,
 * how a transport is obtained for a stored ref, and what each outcome means.
 * Only a CANCELLED run is swept (here, and where a handler that ran a stage
 * body finds the run CANCELLED: the `job.execute` ghost exits that follow a
 * body, a `stage.pollSuspended` replay whose stage the cancel moved, and the
 * `handleClaimOutcome` claim of a replay).
 * A FAILED run keeps its batches, because `run.redrive` re-adopts a live one.
 * The job update goes first and is attempted even if the provider cancels
 * fail, and the provider cancels are attempted even if the job update throws.
 *
 * LATENCY. The command waits for the providers: 30 s per batch and 60 s for
 * the whole sweep (`KernelServices.batchCancelTimeouts`), four calls at a
 * time, so at most 60 s of provider time plus its database reads and writes.
 * A batch the sweep did not reach is reported as `failed`.
 *
 * - The run ends CANCELLED whatever the providers do. A provider cancel that is
 *   impossible or fails does not fail or undo the cancel: it is reported per
 *   batch in `RunCancelResult.batches` and as a WARN log on the run.
 * - `cancelled` keeps its meaning: `true` only when THIS command moved the run
 *   to CANCELLED. A second `run.cancel` on a CANCELLED run therefore answers
 *   `cancelled: false`, but it is also the recovery for a provider cancel that
 *   did not take effect: it re-reads every batch of the run and cancels each
 *   one that is not yet cancelling, cancelled or ended, and reports them all
 *   in `batches`. (It does not retry the job update; see above.) A run that
 *   COMPLETED or FAILED, or does not exist, answers `cancelled: false` and
 *   `batches: []` and touches nothing.
 * - A stage body that was executing when the run was cancelled sees
 *   `ctx.abortSignal` abort. No durable step body starts once it has, and
 *   `ctx.step.ai.map` cancels a batch whose submit was already in flight. A
 *   body whose signal had not fired can still create a batch after this
 *   handler read the ledger: the sweeps named above find it once the body's
 *   handler finds the run CANCELLED, and so does a repeated command.
 * - When every batch of a submit step is cancelled, the step is re-opened with
 *   a tombstone so a `run.redrive` creates a new batch on every transport
 *   instead of waiting on the dead one (see `cancel-run-batches.ts`).
 */

import { StaleVersionError } from "../../persistence/interface.js";
import type { RunCancelCommand, RunCancelResult } from "../commands";
import { cancelRunBatches } from "../helpers/cancel-run-batches.js";
import type { HandlerResult, KernelDeps } from "../kernel";

const TERMINAL_STATUSES = new Set(["COMPLETED", "FAILED", "CANCELLED"]);

export async function handleRunCancel(
  command: RunCancelCommand,
  deps: KernelDeps,
): Promise<HandlerResult<RunCancelResult>> {
  // The run write is fenced on the version read, so this command cancels the
  // generation it read: a cancel held up while another cancelled the run and
  // a redrive started a new generation reads the run again and decides anew.
  let run = await deps.persistence.getRun(command.workflowRunId);
  for (;;) {
    if (!run) return { cancelled: false, batches: [], _events: [] };

    // Already CANCELLED: nothing to change, but the provider cancels may not
    // have taken effect the first time. The batches reach the caller through
    // the kernel, which merges what `_postCommit` returns into the result.
    if (run.status === "CANCELLED") {
      const generation = run.redriveCount;
      return {
        cancelled: false,
        batches: [],
        _events: [],
        _postCommit: (postDeps) =>
          cancelRunBatches(command.workflowRunId, postDeps, { generation }),
      };
    }

    if (TERMINAL_STATUSES.has(run.status)) {
      return { cancelled: false, batches: [], _events: [] };
    }

    // 1. Mark run as CANCELLED
    try {
      await deps.persistence.updateRun(command.workflowRunId, {
        status: "CANCELLED",
        completedAt: deps.clock.now(),
        expectedVersion: run.version,
      });
      break;
    } catch (error) {
      if (!(error instanceof StaleVersionError)) throw error;
      run = await deps.persistence.getRun(command.workflowRunId);
    }
  }
  const generation = run.redriveCount;

  // 2. Mark all non-terminal stages as CANCELLED. Each write is fenced on
  // the version read: a `job.execute` that committed the stage meanwhile (its
  // Phase 3 is fenced the same way) moved the version, and a stage that has
  // ended keeps its outcome. A version moved by a write that did not end it
  // (a `step.signal` wake) is read again.
  const stages = await deps.persistence.getStagesByRun(command.workflowRunId);
  for (let stage of stages) {
    while (!TERMINAL_STATUSES.has(stage.status)) {
      try {
        await deps.persistence.updateStage(stage.id, {
          status: "CANCELLED",
          completedAt: deps.clock.now(),
          nextPollAt: null,
          expectedVersion: stage.version,
        });
        break;
      } catch (error) {
        if (!(error instanceof StaleVersionError)) throw error;
        const current = await deps.persistence.getStage(
          command.workflowRunId,
          stage.stageId,
        );
        if (current?.id !== stage.id) break;
        stage = current;
      }
    }
  }

  return {
    cancelled: true,
    batches: [],
    _events: [
      {
        type: "workflow:cancelled",
        timestamp: deps.clock.now(),
        workflowRunId: command.workflowRunId,
        reason: command.reason,
      },
    ],
    // 3. Cancel queued/suspended jobs, 4. cancel the provider batches
    _postCommit: async (postDeps) => {
      let jobsFailed = false;
      let jobsError: unknown;
      try {
        await postDeps.jobTransport.cancelByRun(command.workflowRunId);
      } catch (error) {
        jobsFailed = true;
        jobsError = error;
      }
      // Tied to this cancel: a sweep held up past a `run.redrive` does nothing.
      const batches = await cancelRunBatches(command.workflowRunId, postDeps, {
        generation,
      });
      if (jobsFailed) throw jobsError;
      return batches;
    },
  };
}
