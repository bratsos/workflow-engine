/**
 * Handler: job.execute
 *
 * Executes a single stage within a workflow run using a multi-phase
 * transaction pattern:
 *
 *   Phase 1 (Start):   upsert stage to RUNNING + write stage:started
 *                       outbox event in one transaction. Commits
 *                       immediately so RUNNING is visible.
 *
 *   Phase 2 (Execute):  run stageDef.execute() via deps.executor.run()
 *                       outside any database transaction. Progress events,
 *                       annotations, and buffered logs are returned in the
 *                       ActivityRunResult.
 *
 *   Phase 3 (Complete): update stage to COMPLETED/SUSPENDED/FAILED +
 *                       write completion outbox event (and progress
 *                       events) in one transaction.
 *
 * This avoids holding a database transaction open for the duration of
 * potentially long-running stage execution (AI calls, HTTP requests,
 * etc.).  If the process crashes between Phase 1 and Phase 3, the
 * stage stays RUNNING and lease.reapStale will retry the job.
 */

import { isSuspendedResult } from "../../core/types";
import type { JobExecuteCommand, JobExecuteResult } from "../commands";
import type { KernelEvent } from "../events";
import { HOST_DEFAULTS } from "../helpers/host-support.js";
import {
  buildAnnotationEvents,
  loadWorkflowContext,
  resolveStageInput,
  saveStageArtifacts,
  saveStageOutput,
  toErrorMessage,
  toOutboxEvents,
  withClaimedRun,
} from "../helpers/index.js";
import type { HandlerResult, KernelDeps } from "../kernel";
import type { ActivityRunResult } from "../ports.js";

/**
 * Re-open the FAILED `run` steps of a stage record for a new job attempt.
 * The row is put back to `running` with no lease — the state of a step
 * whose worker died — so the replay's compare-and-set re-claims it, bumps
 * `attempt` and executes the step again. `attempt` is never reset: it
 * counts every execution of the step across job attempts (a row that read
 * `failed attempt 3` re-runs as attempt 4), so the ledger keeps the
 * per-step history. The failure text stays on `error` until the re-run
 * overwrites it. Waits, signals and sleeps that failed (a deadline that
 * passed) are terminal and stay so.
 */
async function reopenFailedSteps(
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
 * Re-opening reaches the same place without the loss. Every `run` row goes
 * back to `running` with no lease — the state of a step whose worker died —
 * so the replay's compare-and-set takes it over, bumps `attempt` and executes
 * the body again, exactly as a deleted row would have been executed fresh.
 * The difference is that the row, its `externalKey` and its last result are
 * still there, and the body is told `isReclaim: true`, so a body that names
 * an external effect (an AI map's batch submit, above all) re-adopts the
 * effect an earlier attempt created instead of creating and billing a second
 * one. `attempt` is never reset: it counts every execution across attempts.
 *
 * Rows with no external effect to preserve are deleted as before: waits,
 * signals and sleeps hold only timers and deadlines, which a fresh attempt
 * must re-derive rather than inherit, and pre-alpha.9 `run` rows carry no
 * external key, so there is nothing in them worth keeping.
 */
async function resetStageStepsForFreshAttempt(
  workflowRunId: string,
  stageRecordId: string,
  deps: KernelDeps,
): Promise<void> {
  const ledger = deps.stepLedger;
  if (!ledger) return;
  const rows = await ledger.list(stageRecordId);
  if (rows.length === 0) return;
  const preserved = rows.filter(
    (row) => row.kind === "run" && row.externalKey != null,
  );

  if (preserved.length === 0) {
    await ledger.clear(stageRecordId);
    return;
  }
  if (!ledger.clearExcept) {
    // A third-party ledger with no partial clear. The rows go, as they
    // always did, but not silently: what is being dropped is written to
    // the run's log so an operator can still find the effects.
    await deps.persistence
      .createLog({
        workflowRunId,
        workflowStageId: stageRecordId,
        level: "WARN" as any,
        message:
          `Re-running a failed stage cleared ${preserved.length} durable step row(s) that named an ` +
          `external effect; this StepLedger cannot clear selectively. Any effect still in flight ` +
          `must be found by its external key.`,
        metadata: {
          steps: preserved.map((row) => ({
            stepId: row.stepId,
            status: row.status,
            externalKey: row.externalKey,
          })),
        },
      })
      .catch(() => {});
    await ledger.clear(stageRecordId);
    return;
  }

  if (preserved.length < rows.length) {
    await ledger.clearExcept(
      stageRecordId,
      preserved.map((row) => row.stepId),
    );
  }
  for (const row of preserved) {
    if (row.status === "running" && row.leaseExpiresAt === null) continue;
    await ledger.compareAndSet(
      stageRecordId,
      row.stepId,
      { status: row.status, attempt: row.attempt },
      { status: "running", leaseExpiresAt: null },
    );
  }
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export async function handleJobExecute(
  command: JobExecuteCommand,
  deps: KernelDeps,
): Promise<HandlerResult<JobExecuteResult>> {
  const { workflowRunId, workflowId, stageId, config } = command;
  const startTime = deps.clock.now().getTime();
  const causationId = command.idempotencyKey ?? crypto.randomUUID();

  // ── Pre-flight (no transaction) ──────────────────────────────────
  // Read-only lookups: workflow def, stage def, run record, context.

  const workflow = deps.registry.getWorkflow(workflowId);
  if (!workflow)
    throw new Error(`Workflow ${workflowId} not found in registry`);

  const stageDef = workflow.getStage(stageId);
  if (!stageDef)
    throw new Error(`Stage ${stageId} not found in workflow ${workflowId}`);

  const workflowRun = await deps.persistence.getRun(workflowRunId);
  if (!workflowRun) throw new Error(`WorkflowRun ${workflowRunId} not found`);

  // Guard against ghost jobs — only execute if run is actively RUNNING.
  // A PENDING run is not an orphan: the claim that enqueued this job had
  // not committed when the job loop dequeued it (or the claim rolled back
  // and the run will be claimed again), so the job arrived early and must
  // be re-delivered rather than thrown away.
  if (workflowRun.status !== "RUNNING") {
    const race = workflowRun.status === "PENDING";
    return {
      outcome: "failed" as const,
      ghost: true,
      ghostReason: race ? ("race" as const) : ("orphan" as const),
      error: race
        ? `Run ${workflowRunId} is still PENDING, expected RUNNING — job dequeued ahead of its claim; re-delivering`
        : `Run ${workflowRunId} is ${workflowRun.status}, expected RUNNING — ghost job discarded`,
      _events: [],
    };
  }

  const workflowContext = await loadWorkflowContext(workflowRunId, deps);

  // Idempotent double-execution guard: a stale-lease job re-delivery
  // (e.g. duplicate dequeue during a heartbeat gap) must not re-run a
  // stage that already completed. Without this, Phase 1 below would
  // unconditionally flip a COMPLETED stage back to RUNNING and
  // re-execute it.
  const existingStage = await deps.persistence.getStage(workflowRunId, stageId);
  if (existingStage?.status === "COMPLETED") {
    return {
      outcome: "completed" as const,
      output: workflowContext[stageId],
      _events: [],
    };
  }
  if (existingStage?.status === "FAILED") {
    await resetStageStepsForFreshAttempt(workflowRunId, existingStage.id, deps);
  }

  // A job retry of a stage whose last attempt threw (recorded as PENDING
  // with the error kept — see Phase 3b) is a NEW attempt: completed steps
  // are still answered from the ledger, but every `run` step and every
  // map item that FAILED is re-opened so the retry re-executes it instead
  // of replaying the stored failure. A replay of the same attempt (a poll
  // of a suspended stage) never comes through here.
  const isRetryAttempt =
    existingStage?.status === "PENDING" &&
    existingStage.errorMessage != null &&
    command.attempt !== undefined &&
    command.attempt > 1;
  if (isRetryAttempt && existingStage && deps.stepLedger) {
    await reopenFailedSteps(existingStage.id, deps);
  }

  // ── Phase 1: Start transaction ───────────────────────────────────
  // Upsert stage to RUNNING and write stage:started outbox event.
  // Commits immediately so RUNNING status is visible to observers.

  const stageRecord = await deps.persistence.withTransaction(async (tx) => {
    const record = await tx.upsertStage({
      workflowRunId,
      stageId,
      create: {
        workflowRunId,
        stageId,
        stageName: stageDef.name,
        stageNumber: workflow.getStageIndex(stageId) + 1,
        executionGroup: workflow.getExecutionGroupIndex(stageId),
        status: "RUNNING",
        startedAt: deps.clock.now(),
        // Per-stage slice, matching every other stage-record-creation
        // site (run.claimPending / run.transition / run.rerunFrom) —
        // `config` here is the full run-wide config map keyed by stageId.
        config: (config as any)?.[stageId] || {},
      },
      update: {
        status: "RUNNING",
        startedAt: deps.clock.now(),
        // Each retry of the stage is one more attempt on its row, like a
        // `run.rerunFrom` rerun; a same-attempt re-delivery does not bump.
        ...(isRetryAttempt && existingStage
          ? { attempt: existingStage.attempt + 1 }
          : {}),
      },
    });

    await tx.appendOutboxEvents(
      toOutboxEvents(
        workflowRunId,
        [
          {
            type: "stage:started",
            timestamp: deps.clock.now(),
            workflowRunId,
            stageId,
            stageName: stageDef.name,
            stageNumber: record.stageNumber,
          },
        ],
        causationId,
      ),
    );

    return record;
  });

  // ── Phase 2: Execute (no transaction) ────────────────────────────
  // The stage's execute() function runs through deps.executor.run().
  // Progress events, annotations, and any buffered logs are returned
  // in the ActivityRunResult. A throw from executor.run() itself
  // (infra error) still propagates so the idempotency key is released.

  let run: ActivityRunResult;
  let rawInput: unknown;
  let inputResolutionError: string | undefined;
  try {
    rawInput = resolveStageInput(
      workflow,
      stageId,
      workflowRun,
      workflowContext,
    );
  } catch (inputError) {
    // Missing previous-group output past the first execution group.
    // Treat this the same as a stage-body failure below — do NOT call
    // executor.run() with corrupted input.
    inputResolutionError = toErrorMessage(inputError);
  }

  if (inputResolutionError !== undefined) {
    run = {
      error: inputResolutionError,
      progress: [],
      annotations: [],
      logs: [],
    };
  } else {
    // A throw from executor.run() itself (infra / transport failure — not
    // a stage-body error) propagates so the kernel releases the
    // idempotency key.
    run = await deps.executor.run(
      {
        stageDef,
        workflowId,
        workflowRunId,
        workflowType: workflowRun.workflowType,
        stageId,
        stageName: stageDef.name,
        stageNumber: stageRecord.stageNumber,
        stageRecordId: stageRecord.id,
        attempt: stageRecord.attempt,
        rawInput,
        config: config as Record<string, unknown>,
        resumeState: stageRecord.suspendedState,
        workflowContext,
      },
      deps,
    );
  }

  // Write buffered logs (LocalExecutor returns [] — no-op for local path)
  for (const logEntry of run.logs) {
    await deps.persistence
      .createLog({
        workflowRunId,
        workflowStageId: stageRecord.id,
        level: logEntry.level as any,
        message: logEntry.message,
        metadata: logEntry.meta,
      })
      .catch(() => {});
  }

  // ── Dispatch on run result ────────────────────────────────────────

  if (run.error !== undefined) {
    // Stage body threw; treat as Phase 3b failure (same path as the old catch block)
    const errorMessage =
      run.errorName && run.errorName !== "Error"
        ? `${run.errorName}: ${run.error}`
        : run.error;
    const duration = deps.clock.now().getTime() - startTime;
    const bufferedAnnotations = run.annotations;

    // A retryable failure with attempts left is not terminal: the host is
    // about to re-enqueue the job, so the stage goes back to PENDING (an
    // active status for run.transition) carrying the last error, keeps its
    // ledger rows for the replay, and the run keeps RUNNING. Only when the
    // attempt budget is exhausted (or the error is deterministic) is the
    // stage FAILED. A command without attempt information (a caller that
    // dispatches job.execute directly) keeps the historical FAILED write.
    const willRetry =
      command.attempt !== undefined &&
      run.retryable !== false &&
      command.attempt < (command.maxAttempts ?? HOST_DEFAULTS.maxAttempts);

    // expectedVersion omitted: Phase 3 never writes the run row here (only
    // the stage row), so — unlike stage-poll-suspended's claim — parallel
    // sibling stages completing concurrently must not contend on the run's
    // version. Any persistence failure other than a genuine cancellation
    // still propagates (Stage stays RUNNING; re-throwing releases the
    // idempotency key so lease.reapStale can retry the job).
    const claimResult = await withClaimedRun(
      workflowRunId,
      undefined,
      deps,
      async (tx) => {
        await tx.updateStage(
          stageRecord.id,
          willRetry
            ? { status: "PENDING", duration, errorMessage }
            : {
                status: "FAILED",
                completedAt: deps.clock.now(),
                duration,
                errorMessage,
              },
        );

        if (bufferedAnnotations.length > 0) {
          await tx.appendAnnotations(bufferedAnnotations);
        }

        // `stage:failed` only when the row becomes FAILED; a retry that
        // is about to run is announced as `stage:retrying`.
        const failedEvent: KernelEvent = willRetry
          ? {
              type: "stage:retrying",
              timestamp: deps.clock.now(),
              workflowRunId,
              stageId,
              stageName: stageDef.name,
              attempt: command.attempt!,
              maxAttempts: command.maxAttempts ?? HOST_DEFAULTS.maxAttempts,
              error: errorMessage,
            }
          : {
              type: "stage:failed",
              timestamp: deps.clock.now(),
              workflowRunId,
              stageId,
              stageName: stageDef.name,
              error: errorMessage,
            };

        await tx.appendOutboxEvents(
          toOutboxEvents(
            workflowRunId,
            [
              ...run.progress,
              failedEvent,
              ...buildAnnotationEvents(bufferedAnnotations, deps.clock.now()),
            ],
            causationId,
          ),
        );
      },
    );

    if (claimResult.status === "cancelled") {
      return {
        outcome: "failed" as const,
        ghost: true,
        ghostReason: "orphan" as const,
        error: claimResult.message,
        _events: [],
      };
    }

    await deps.persistence
      .createLog({
        workflowRunId,
        workflowStageId: stageRecord.id,
        level: willRetry ? "WARN" : "ERROR",
        message: willRetry
          ? `${errorMessage} (attempt ${command.attempt} of ${command.maxAttempts ?? HOST_DEFAULTS.maxAttempts}; retry pending)`
          : errorMessage,
      })
      .catch(() => {});

    return {
      outcome: "failed" as const,
      error: errorMessage,
      retryable: run.retryable,
      willRetry,
      ...(command.attempt !== undefined
        ? {
            attempt: command.attempt,
            maxAttempts: command.maxAttempts ?? HOST_DEFAULTS.maxAttempts,
          }
        : {}),
      _events: [],
    };
  }

  // Stage body succeeded — re-check run status (cancellation guard)
  const currentRunStatus = await deps.persistence.getRunStatus(workflowRunId);
  if (currentRunStatus !== "RUNNING") {
    return {
      outcome: "failed" as const,
      ghost: true,
      ghostReason: "orphan" as const,
      error: `Run ${workflowRunId} was ${currentRunStatus} after stage execution — result discarded`,
      _events: [],
    };
  }

  // ── Phase 3a: Complete transaction (success) ─────────────────────
  if (isSuspendedResult(run.result!)) {
    const { state, pollConfig, metrics } = run.result!;
    const nextPollAt = new Date(
      pollConfig.nextPollAt?.getTime() ??
        deps.clock.now().getTime() + (pollConfig.pollInterval || 60000),
    );

    const bufferedAnnotations = run.annotations;

    // expectedVersion omitted — see the comment on the Phase 3b claim above.
    const claimResult = await withClaimedRun(
      workflowRunId,
      undefined,
      deps,
      async (tx) => {
        await tx.updateStage(stageRecord.id, {
          status: "SUSPENDED",
          suspendedState: state as any,
          nextPollAt,
          pollInterval: pollConfig.pollInterval,
          maxWaitUntil: pollConfig.maxWaitTime
            ? new Date(deps.clock.now().getTime() + pollConfig.maxWaitTime)
            : undefined,
          metrics: metrics as any,
        });

        if (bufferedAnnotations.length > 0) {
          await tx.appendAnnotations(bufferedAnnotations);
        }

        const suspendedEvent: KernelEvent = {
          type: "stage:suspended",
          timestamp: deps.clock.now(),
          workflowRunId,
          stageId,
          stageName: stageDef.name,
          nextPollAt,
        };

        const workflowSuspendedEvent: KernelEvent = {
          type: "workflow:suspended",
          timestamp: deps.clock.now(),
          workflowRunId,
          stageId,
        };

        await tx.appendOutboxEvents(
          toOutboxEvents(
            workflowRunId,
            [
              ...run.progress,
              suspendedEvent,
              workflowSuspendedEvent,
              ...buildAnnotationEvents(bufferedAnnotations, deps.clock.now()),
            ],
            causationId,
          ),
        );
      },
    );

    if (claimResult.status === "cancelled") {
      return {
        outcome: "failed" as const,
        ghost: true,
        ghostReason: "orphan" as const,
        error: claimResult.message,
        _events: [],
      };
    }

    return { outcome: "suspended" as const, nextPollAt, _events: [] };
  } else {
    const result = run.result!;
    const duration = deps.clock.now().getTime() - startTime;

    // Save output to blob store (not a DB operation)
    const outputKey = await saveStageOutput(
      workflowRunId,
      workflowRun.workflowType,
      stageId,
      result.output,
      deps,
    );
    const artifactKeys =
      result.artifacts && Object.keys(result.artifacts).length > 0
        ? await saveStageArtifacts(
            workflowRunId,
            workflowRun.workflowType,
            stageId,
            result.artifacts,
            deps,
          )
        : undefined;

    const bufferedAnnotations = run.annotations;

    // expectedVersion omitted — see the comment on the Phase 3b claim above.
    const claimResult = await withClaimedRun(
      workflowRunId,
      undefined,
      deps,
      async (tx) => {
        await tx.updateStage(stageRecord.id, {
          status: "COMPLETED",
          completedAt: deps.clock.now(),
          duration,
          // A retried attempt succeeded: the earlier attempt's error is stale.
          errorMessage: null,
          outputData: {
            _artifactKey: outputKey,
            ...(artifactKeys ? { _artifactKeys: artifactKeys } : {}),
          } as any,
          metrics: result.metrics as any,
          embeddingInfo: result.embeddings as any,
        });

        if (bufferedAnnotations.length > 0) {
          await tx.appendAnnotations(bufferedAnnotations);
        }

        const completedEvent: KernelEvent = {
          type: "stage:completed",
          timestamp: deps.clock.now(),
          workflowRunId,
          stageId,
          stageName: stageDef.name,
          duration,
        };

        await tx.appendOutboxEvents(
          toOutboxEvents(
            workflowRunId,
            [
              ...run.progress,
              completedEvent,
              ...buildAnnotationEvents(bufferedAnnotations, deps.clock.now()),
            ],
            causationId,
          ),
        );
      },
    );

    if (claimResult.status === "cancelled") {
      return {
        outcome: "failed" as const,
        ghost: true,
        ghostReason: "orphan" as const,
        error: claimResult.message,
        _events: [],
      };
    }

    return {
      outcome: "completed" as const,
      output: result.output,
      _events: [],
    };
  }
}
