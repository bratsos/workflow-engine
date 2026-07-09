/**
 * Handler: stage.pollSuspended
 *
 * Polls suspended stages whose nextPollAt has passed, calls each stage's
 * checkCompletion() method, and either resumes (completes) or re-schedules
 * them for a future poll.
 *
 * Uses a multi-phase pattern per stage so that checkCompletion() — which
 * typically makes external HTTP calls to batch providers — runs outside
 * any database transaction:
 *
 *   Phase 1 (no transaction): Call checkCompletion() — external I/O
 *   Phase 2 (transaction):    Persist results + append outbox events
 *
 * This avoids Prisma P2028 interactive-transaction timeout errors when
 * batch provider APIs are slow to respond.
 */

import type { CheckCompletionContext } from "../../core/stage";
import type { CreateAnnotationInput } from "../../persistence/interface";
import type {
  StagePollSuspendedCommand,
  StagePollSuspendedResult,
} from "../commands";
import {
  buildAnnotationEvents,
  createAnnotationBuffer,
  createStorageShim,
  failStageAndRun,
  handleClaimOutcome,
  markStageCancelled,
  normalizeAnnotateArgs,
  saveStageOutput,
  toErrorMessage,
  toOutboxEvents,
  withClaimedRun,
} from "../helpers/index.js";
import type { HandlerResult, KernelDeps } from "../kernel";
import type { WorkflowStageRecord } from "../ports.js";

async function completeSuspendedJobRow(
  workflowRunId: string,
  stageId: string,
  deps: KernelDeps,
): Promise<void> {
  try {
    const jobs = await deps.jobTransport.getJobsByWorkflowRun(workflowRunId);
    const job = jobs.find(
      (j) => j.stageId === stageId && j.status === "SUSPENDED",
    );
    if (job) {
      await deps.jobTransport.complete(job.id);
    }
  } catch {
    // Best-effort cleanup — a failure here must not fail the resume.
  }
}

/**
 * Fails a suspended stage before checkCompletion ever runs (workflow
 * missing from the registry, or the stage no longer supports
 * checkCompletion) — the run itself isn't touched, unlike
 * `failStageAndRun`, since these are pre-flight config problems rather
 * than a checkCompletion outcome.
 */
async function failStageOnly(
  stageRecord: WorkflowStageRecord,
  errorMessage: string,
  deps: KernelDeps,
): Promise<void> {
  await deps.persistence.withTransaction(async (tx) => {
    await tx.updateStage(stageRecord.id, {
      status: "FAILED",
      completedAt: deps.clock.now(),
      errorMessage,
    });
    await tx.appendOutboxEvents(
      toOutboxEvents(stageRecord.workflowRunId, [
        {
          type: "stage:failed",
          timestamp: deps.clock.now(),
          workflowRunId: stageRecord.workflowRunId,
          stageId: stageRecord.stageId,
          stageName: stageRecord.stageName,
          error: errorMessage,
        },
      ]),
    );
  });
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export async function handleStagePollSuspended(
  command: StagePollSuspendedCommand,
  deps: KernelDeps,
): Promise<HandlerResult<StagePollSuspendedResult>> {
  const maxChecks = command.maxChecks ?? 50;

  // 1. Get suspended stages that are ready to be polled (no transaction)
  const suspendedStages = await deps.persistence.getSuspendedStages(
    deps.clock.now(),
  );

  // 2. Limit to maxChecks
  const stagesToCheck = suspendedStages.slice(0, maxChecks);

  let checked = 0;
  let resumed = 0;
  let failed = 0;
  const resumedWorkflowRunIds = new Set<string>();

  // 3. Process each suspended stage
  for (const stageRecord of stagesToCheck) {
    checked++;

    // 3a. Get workflow run (no transaction — read-only lookup)
    const run = await deps.persistence.getRun(stageRecord.workflowRunId);
    if (!run) continue;

    // 3a.1 Skip cancelled runs — mark the suspended stage as cancelled
    if (run.status === "CANCELLED") {
      await markStageCancelled(stageRecord.id, deps);
      continue;
    }

    // 3b. Get workflow from registry
    const workflow = deps.registry.getWorkflow(run.workflowId);
    if (!workflow) {
      await failStageOnly(
        stageRecord,
        `Workflow ${run.workflowId} not found in registry`,
        deps,
      );
      failed++;
      continue;
    }

    // 3c. Get stage definition
    const stageDef = workflow.getStage(stageRecord.stageId);
    if (!stageDef || !stageDef.checkCompletion) {
      const errorMsg = !stageDef
        ? `Stage ${stageRecord.stageId} not found in workflow ${run.workflowId}`
        : `Stage ${stageRecord.stageId} does not support checkCompletion`;

      await failStageOnly(stageRecord, errorMsg, deps);
      failed++;
      continue;
    }

    // 3d. Create storage shim and log function (uses non-transactional deps)
    const storage = createStorageShim(
      stageRecord.workflowRunId,
      run.workflowType,
      deps,
    );

    const logFn = async (
      level: any,
      message: string,
      meta?: Record<string, unknown>,
    ) => {
      await deps.persistence
        .createLog({
          workflowRunId: stageRecord.workflowRunId,
          workflowStageId: stageRecord.id,
          level: level as any,
          message,
          metadata: meta,
        })
        .catch(() => {});
    };

    // Buffer annotations made during checkCompletion. Flushed inside
    // the Phase-2 transaction (via withClaimedRun) so they persist
    // atomically with the stage outcome — or are dropped if the
    // transaction rolls back on StaleVersionError, preventing the
    // phantom-annotation race the adversarial review surfaced.
    const annotationBuffer = createAnnotationBuffer();
    const annotateFn = ((...args: unknown[]) => {
      const stageScopeFields = {
        workflowRunId: stageRecord.workflowRunId,
        workflowStageRecordId: stageRecord.id,
        attempt: stageRecord.attempt,
        scope: "stage" as const,
        scopeId: stageRecord.stageId,
      };
      for (const { key, value, opts } of normalizeAnnotateArgs(args)) {
        if (value === undefined || value === null) continue;
        annotationBuffer.push({
          ...stageScopeFields,
          actor: opts?.actor,
          key,
          value,
          payload: opts?.payload,
          idempotencyKey: opts?.idempotencyKey,
          emitEvent: opts?.emitEvent,
        } satisfies CreateAnnotationInput);
      }
    }) as CheckCompletionContext<unknown>["annotate"];

    // 3e. Build check context
    const checkContext = {
      workflowRunId: run.id,
      stageId: stageRecord.stageId,
      stageRecordId: stageRecord.id,
      config: stageRecord.config || {},
      log: logFn,
      onLog: logFn,
      annotate: annotateFn,
      storage,
    };

    try {
      // ── Phase 1: checkCompletion (no transaction) ──────────────────
      // External HTTP calls happen here — no DB connection held open.
      const checkResult = await stageDef.checkCompletion(
        stageRecord.suspendedState as any,
        checkContext,
      );

      // ── Phase 2: persist results (transaction) ─────────────────────
      if (checkResult.error) {
        const claimResult = await failStageAndRun(
          stageRecord,
          run,
          checkResult.error,
          annotationBuffer.flush(),
          deps,
        );

        if (await handleClaimOutcome(claimResult, stageRecord, deps)) continue;

        failed++;
      } else if (checkResult.ready) {
        // Save output to blob store (not a DB operation)
        let outputRef: { _artifactKey: string } | undefined;
        if (checkResult.output !== undefined) {
          let validatedOutput = checkResult.output;
          try {
            validatedOutput = stageDef.outputSchema.parse(checkResult.output);
          } catch (validationError) {
            // Fall back to raw output on validation failure
            await logFn(
              "WARN",
              `Stage ${stageRecord.stageId} checkCompletion output failed schema validation; persisting raw output`,
              { error: toErrorMessage(validationError) },
            );
          }

          const outputKey = await saveStageOutput(
            stageRecord.workflowRunId,
            run.workflowType,
            stageRecord.stageId,
            validatedOutput,
            deps,
          );
          outputRef = { _artifactKey: outputKey };
        }

        const duration =
          deps.clock.now().getTime() -
          (stageRecord.startedAt?.getTime() ?? deps.clock.now().getTime());

        const bufferedAnnotations = annotationBuffer.flush();
        const claimResult = await withClaimedRun(
          stageRecord.workflowRunId,
          run.version,
          deps,
          async (tx) => {
            await tx.updateStage(stageRecord.id, {
              status: "COMPLETED",
              completedAt: deps.clock.now(),
              duration,
              outputData: outputRef as any,
              nextPollAt: null,
              metrics: checkResult.metrics as any,
              embeddingInfo: checkResult.embeddings as any,
            });

            if (bufferedAnnotations.length > 0) {
              await tx.appendAnnotations(bufferedAnnotations);
            }

            await tx.appendOutboxEvents(
              toOutboxEvents(stageRecord.workflowRunId, [
                {
                  type: "stage:completed",
                  timestamp: deps.clock.now(),
                  workflowRunId: stageRecord.workflowRunId,
                  stageId: stageRecord.stageId,
                  stageName: stageRecord.stageName,
                  duration,
                },
                ...buildAnnotationEvents(bufferedAnnotations, deps.clock.now()),
              ]),
            );
          },
        );

        if (await handleClaimOutcome(claimResult, stageRecord, deps)) continue;

        resumed++;
        resumedWorkflowRunIds.add(stageRecord.workflowRunId);
        // Resuming here bypasses the normal job.execute → jobTransport
        // .complete() path entirely (this poll loop resumes stages
        // purely via persistence), so the SUSPENDED job row for this
        // stage is never marked complete. Without this, job_queue
        // accumulates a permanently-SUSPENDED row per suspended stage.
        await completeSuspendedJobRow(
          stageRecord.workflowRunId,
          stageRecord.stageId,
          deps,
        );
      } else if (
        stageRecord.maxWaitUntil &&
        stageRecord.maxWaitUntil.getTime() <= deps.clock.now().getTime()
      ) {
        // Not ready, and the stage's maxWaitUntil deadline has now
        // passed. checkCompletion() didn't report its own deadline
        // error (stages that track their own deadline, e.g. remote
        // activity workers, already fail via checkResult.error above),
        // so this is the generic backstop: without it, a suspended
        // stage whose provider never reports readiness or an error
        // would reschedule via nextCheckIn forever.
        const timeoutError = `Stage ${stageRecord.stageId} exceeded maxWaitUntil (${stageRecord.maxWaitUntil.toISOString()}) while suspended`;
        const claimResult = await failStageAndRun(
          stageRecord,
          run,
          timeoutError,
          annotationBuffer.flush(),
          deps,
        );

        if (await handleClaimOutcome(claimResult, stageRecord, deps)) continue;

        failed++;
        continue;
      } else {
        // Not ready -- update nextPollAt for next check
        const pollInterval =
          checkResult.nextCheckIn ?? stageRecord.pollInterval ?? 60000;

        const nextPollAt = new Date(deps.clock.now().getTime() + pollInterval);

        const bufferedAnnotations = annotationBuffer.flush();
        const claimResult = await withClaimedRun(
          stageRecord.workflowRunId,
          run.version,
          deps,
          async (tx) => {
            await tx.updateStage(stageRecord.id, {
              nextPollAt,
            });

            if (bufferedAnnotations.length > 0) {
              await tx.appendAnnotations(bufferedAnnotations);
            }
          },
        );

        if (await handleClaimOutcome(claimResult, stageRecord, deps)) continue;
      }
    } catch (error) {
      // Unexpected error during checkCompletion. Flush any annotations
      // recorded before the throw so they persist alongside the FAILED
      // outcome.
      const claimResult = await failStageAndRun(
        stageRecord,
        run,
        toErrorMessage(error),
        annotationBuffer.flush(),
        deps,
      );

      if (await handleClaimOutcome(claimResult, stageRecord, deps)) continue;

      failed++;
    }
  }

  // Events are written directly to outbox per-stage above, so _events is empty
  return {
    checked,
    resumed,
    failed,
    resumedWorkflowRunIds: [...resumedWorkflowRunIds],
    _events: [],
  };
}
