import { StaleVersionError } from "../../persistence/interface.js";
import type { RunReapStuckCommand, RunReapStuckResult } from "../commands";
import type { KernelEvent } from "../events";
import { servesRun } from "../helpers/definition-pinning.js";
import { HOST_DEFAULTS } from "../helpers/host-support.js";
import {
  enqueueForLiveRun,
  stageJobOptions,
} from "../helpers/prepare-execution-group.js";
import type { HandlerResult, KernelDeps } from "../kernel";
import {
  ACTIVE_STAGE_STATUSES,
  handleRunTransition,
} from "./run-transition.js";

export async function handleRunReapStuck(
  command: RunReapStuckCommand,
  deps: KernelDeps,
): Promise<HandlerResult<RunReapStuckResult>> {
  const events: KernelEvent[] = [];
  const postCommits: Array<(deps: KernelDeps) => Promise<unknown>> = [];
  const now = deps.clock.now().getTime();
  const stuckSince = new Date(now - command.stuckThresholdMs);
  const legacyLeaseCutoff =
    now -
    (command.staleLeaseThresholdMs ?? HOST_DEFAULTS.staleLeaseThresholdMs);

  const stuckRuns = await deps.persistence.getStuckRuns(stuckSince);
  let failed = 0;
  let healed = 0;

  for (const run of stuckRuns) {
    // Status guard: only update if run is still RUNNING to avoid
    // overwriting a run that recovered between query and update.
    const currentStatus = await deps.persistence.getRunStatus(run.id);
    if (currentStatus !== "RUNNING") {
      continue;
    }

    // Definition pinning: a run pinned to a version this build does not
    // present looks exactly like a stuck run from here — nothing on this
    // host touches it, so neither the run nor its stages are updated and
    // it crosses the threshold. Reaping it would fail a run that is
    // perfectly healthy on the build that owns it, which is the one thing
    // pinning promises never happens. Leave it, as `run.transition` and
    // `stage.pollSuspended` do; `run.listVersions` reports it and
    // `run.redrive({ definitionVersion: "latest" })` moves it forward.
    const pinnedWorkflow = deps.registry.getWorkflow(run.workflowId);
    if (pinnedWorkflow && !servesRun(run, pinnedWorkflow)) {
      continue;
    }

    const jobs = await deps.jobTransport.getJobsByWorkflowRun(run.id, {
      includePayload: false,
    });
    if (
      jobs.some(
        (job) =>
          job.status === "PENDING" ||
          (job.status === "RUNNING" &&
            (job.leaseExpiresAt
              ? job.leaseExpiresAt.getTime() >= now
              : job.lockedAt !== null &&
                job.lockedAt.getTime() >= legacyLeaseCutoff)),
      )
    ) {
      continue;
    }

    const stages = await deps.persistence.getStagesByRun(run.id);
    // Recovery sweep: a PENDING stage with no queued job means the run
    // isn't actually dead, it's just missing the job that job.execute
    // needs to pick it up — the classic symptom of the enqueue-outside-
    // the-transaction race (run.transition / run.claimPending commit the
    // stage as PENDING, but the process crashes before — or the tx
    // rolls back after — the corresponding job is enqueued). Re-enqueue
    // instead of failing the run.
    const pendingStages = stages.filter((s) => s.status === "PENDING");
    if (pendingStages.length > 0) {
      const missingJobStages = pendingStages.filter(
        (stage) =>
          !jobs.some(
            (job) =>
              job.stageId === stage.stageId &&
              (job.status === "PENDING" || job.status === "RUNNING"),
          ),
      );
      if (missingJobStages.length > 0) {
        // Refresh the run's activity and version on every transport. The
        // re-enqueue below is a post-commit that touches neither the run
        // nor a stage row, so without this the next sweep (a queued scoped
        // one, or another host's before any worker dequeues the job) still
        // finds the run stuck, sees the recovered PENDING job as nothing
        // missing and reaps the run it just healed. The version bump also
        // fences a sweep that read the run before this one committed.
        try {
          await deps.persistence.updateRun(run.id, {
            expectedVersion: run.version,
          });
        } catch (error) {
          if (error instanceof StaleVersionError) continue;
          throw error;
        }

        // INVARIANT: no handler enqueues a job from inside the kernel
        // transaction. The handler body runs under
        // `persistence.withTransaction`; a job enqueued there is visible
        // to other workers the instant the queue's own connection
        // commits, which is *before* this transaction commits — so a
        // worker can dequeue the job and read stage rows that do not
        // exist yet, and a rollback leaves a job pointing at state that
        // was never written. That is the shape that wedged 62 runs in
        // 100 before alpha.8. Every enqueue goes on `_postCommit`, which
        // the kernel runs only after the transaction has committed
        // (kernel.ts, "Runs only now that the transaction has
        // committed"). Do not move this back inline just because the
        // enqueue is idempotent and the run is already committed
        // RUNNING.
        const jobsToEnqueue = missingJobStages.map((stage) => ({
          workflowRunId: run.id,
          workflowId: run.workflowId,
          stageId: stage.stageId,
          priority: run.priority,
          payload: { config: run.config || {} },
          // See prepare-execution-group.ts: the version travels with the
          // job so the dequeue can filter on it.
          definitionVersion: run.definitionVersion,
          ...stageJobOptions(
            pinnedWorkflow,
            pinnedWorkflow?.getStage(stage.stageId),
          ),
        }));
        postCommits.push(async (postDeps: KernelDeps) => {
          await enqueueForLiveRun(postDeps, run.id, jobsToEnqueue);
        });
        continue;
      }
    }

    // Dropped-transition heal: every stage is terminal but the run still says
    // RUNNING — the run.transition that should have advanced or resolved it
    // was dropped (a stale-claim race where the competing writer also nooped,
    // or the dispatching process died before firing it). The run is one
    // transition away from resolving on its own merits; failing it here would
    // discard finished work. Attempt the transition and only reap if it
    // cannot resolve the run.
    const hasActiveStage = stages.some((s) =>
      ACTIVE_STAGE_STATUSES.has(s.status),
    );
    if (stages.length > 0 && !hasActiveStage) {
      const transition = await handleRunTransition(
        { type: "run.transition", workflowRunId: run.id },
        deps,
      );
      if (transition.action !== "noop") {
        events.push(...(transition._events ?? []));
        if (transition._postCommit) postCommits.push(transition._postCommit);
        healed++;
        continue;
      }
    }

    // Waiting guard: a SUSPENDED stage is touched only when its poll comes
    // due, so a sleep, `waitFor` `every` or signal `keepalive` longer than
    // the threshold leaves the run looking exactly like a stuck one. While
    // a poll is still due, or came due less than one threshold ago, the
    // poller has not had its chance to wake it; past that, nothing is
    // polling it and the reap below is right. Placed after the heals so a
    // sibling PENDING stage with no job is still re-enqueued.
    const waiting = stages.some(
      (s) =>
        s.status === "SUSPENDED" &&
        s.nextPollAt != null &&
        s.nextPollAt.getTime() > stuckSince.getTime(),
    );
    if (waiting) {
      continue;
    }

    // Version guard: two hosts racing to reap the same run would
    // otherwise both pass the status check above and both write
    // updateRun + emit workflow:failed. expectedVersion turns the second
    // writer's update into a StaleVersionError instead of a double-reap.
    try {
      await deps.persistence.updateRun(run.id, {
        expectedVersion: run.version,
        status: "FAILED",
        completedAt: deps.clock.now(),
        output: {
          error: {
            code: "STUCK_RUN_REAPED",
            message: `Run stuck for >${command.stuckThresholdMs}ms with no activity`,
            stageStatuses: stages.map((s) => ({
              stageId: s.stageId,
              status: s.status,
            })),
          },
        },
      });
    } catch (error) {
      if (error instanceof StaleVersionError) {
        continue;
      }
      throw error;
    }

    // INVARIANT: a reaped run and all its active stages become terminal in
    // the same transaction. A stale stage update rolls back the run failure.
    for (const stage of stages) {
      if (!ACTIVE_STAGE_STATUSES.has(stage.status)) continue;
      const error = `Run stuck for >${command.stuckThresholdMs}ms with no activity`;
      await deps.persistence.updateStage(stage.id, {
        expectedVersion: stage.version,
        status: "FAILED",
        completedAt: deps.clock.now(),
        nextPollAt: null,
        errorMessage: error,
      });
      events.push({
        type: "stage:failed",
        timestamp: deps.clock.now(),
        workflowRunId: run.id,
        stageId: stage.stageId,
        stageName: stage.stageName,
        error,
      });
    }

    events.push({
      type: "workflow:failed",
      timestamp: deps.clock.now(),
      workflowRunId: run.id,
      error: `Stuck run reaped after ${command.stuckThresholdMs}ms inactivity`,
    });

    failed++;
  }

  // `transitioned` reports the count of runs this call moved to FAILED;
  // `healed` counts wedged runs the dropped-transition heal resolved by
  // firing the run.transition they were missing instead of reaping them.
  return {
    transitioned: failed,
    failed,
    healed,
    _events: events,
    ...(postCommits.length > 0
      ? {
          _postCommit: async (postDeps: KernelDeps) => {
            for (const postCommit of postCommits) {
              await postCommit(postDeps);
            }
          },
        }
      : {}),
  };
}
