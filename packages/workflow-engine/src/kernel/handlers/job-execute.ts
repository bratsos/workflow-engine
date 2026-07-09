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
import type { Workflow } from "../../core/workflow";
import type { JobExecuteCommand, JobExecuteResult } from "../commands";
import type { KernelEvent } from "../events";
import {
  buildAnnotationEvents,
  loadWorkflowContext,
  resolveExecutionGroupOutput,
  saveStageArtifacts,
  saveStageOutput,
  toErrorMessage,
  toOutboxEvents,
  withClaimedRun,
} from "../helpers/index.js";
import type { HandlerResult, KernelDeps } from "../kernel";
import type { ActivityRunResult } from "../ports.js";

// ---------------------------------------------------------------------------
// Helper: resolve stage input
// ---------------------------------------------------------------------------

function resolveStageInput(
  workflow: Workflow<any, any>,
  stageId: string,
  workflowRun: { input: any },
  workflowContext: Record<string, unknown>,
): unknown {
  const groupIndex = workflow.getExecutionGroupIndex(stageId);

  // First execution group always uses workflow input
  if (groupIndex <= 1) return workflowRun.input;

  // Resolve the previous execution group's output.
  // For single-stage groups this returns that stage's output directly.
  // For parallel groups this returns an object keyed by stage ID.
  const prevOutput = resolveExecutionGroupOutput(
    workflow,
    groupIndex - 1,
    workflowContext,
  );

  // Only the first execution group may fall back to workflow input. A
  // missing previous-group output past group 1 means a blob went
  // missing (or context loading raced a stage completion) — silently
  // feeding workflow input to a downstream stage would corrupt its
  // result instead of surfacing the problem. Fail loudly instead.
  if (prevOutput === undefined) {
    throw new Error(
      `Stage ${stageId} (execution group ${groupIndex}) is missing the ` +
        `output of execution group ${groupIndex - 1} — cannot resolve input`,
    );
  }

  return prevOutput;
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

  // Guard against ghost jobs — only execute if run is actively RUNNING
  if (workflowRun.status !== "RUNNING") {
    return {
      outcome: "failed" as const,
      ghost: true,
      error: `Run ${workflowRunId} is ${workflowRun.status}, expected RUNNING — ghost job discarded`,
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
        await tx.updateStage(stageRecord.id, {
          status: "FAILED",
          completedAt: deps.clock.now(),
          duration,
          errorMessage,
        });

        if (bufferedAnnotations.length > 0) {
          await tx.appendAnnotations(bufferedAnnotations);
        }

        const failedEvent: KernelEvent = {
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
        error: claimResult.message,
        _events: [],
      };
    }

    await deps.persistence
      .createLog({
        workflowRunId,
        workflowStageId: stageRecord.id,
        level: "ERROR",
        message: errorMessage,
      })
      .catch(() => {});

    return {
      outcome: "failed" as const,
      error: errorMessage,
      retryable: run.retryable,
      _events: [],
    };
  }

  // Stage body succeeded — re-check run status (cancellation guard)
  const currentRunStatus = await deps.persistence.getRunStatus(workflowRunId);
  if (currentRunStatus !== "RUNNING") {
    return {
      outcome: "failed" as const,
      ghost: true,
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
