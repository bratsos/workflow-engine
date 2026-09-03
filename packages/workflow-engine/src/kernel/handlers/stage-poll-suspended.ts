/**
 * Handler: stage.pollSuspended
 *
 * Polls suspended stages whose nextPollAt has passed, calls each stage's
 * checkCompletion() method or replays durable execute() methods, and either
 * resumes (completes) or re-schedules them for a future poll.
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

import type { CheckCompletionContext, Stage } from "../../core/stage";
import { DURABLE_SUSPEND_MARKER, StepTimeoutError } from "../../core/steps.js";
import {
  isSuspendedResult,
  type StageResult,
  type SuspendedResult,
} from "../../core/types.js";
import type { CreateAnnotationInput } from "../../persistence/interface";
import type {
  StagePollSuspendedCommand,
  StagePollSuspendedResult,
} from "../commands";
import {
  buildAnnotationEvents,
  buildStageExecutionContext,
  createAnnotationBuffer,
  createStepApi,
  createStorageShim,
  defineLazyAIContext,
  failStageAndRun,
  handleClaimOutcome,
  loadWorkflowContext,
  markStageCancelled,
  normalizeAnnotateArgs,
  resolveStageInput,
  saveStageArtifacts,
  saveStageOutput,
  toErrorMessage,
  toOutboxEvents,
  withClaimedRun,
} from "../helpers/index.js";
import type { HandlerResult, KernelDeps } from "../kernel";
import type {
  ActivityRunInput,
  WorkflowRunRecord,
  WorkflowStageRecord,
} from "../ports.js";

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
 * Fails a suspended stage before its resume operation ever runs (workflow
 * missing from the registry, or the stage no longer supports its configured
 * resume strategy) — the run itself isn't touched, unlike
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

type ReplayOutcome = "resumed" | "suspended" | "failed" | "skip";

async function failExpiredDurableWait(
  stageRecordId: string,
  deps: KernelDeps,
): Promise<void> {
  if (!deps.stepLedger) return;
  const now = deps.clock.now().getTime();
  const expired = (await deps.stepLedger.list(stageRecordId)).find(
    (record) =>
      (record.kind === "wait" || record.kind === "signal") &&
      record.status === "pending" &&
      record.deadlineAt !== null &&
      record.deadlineAt.getTime() <= now,
  );
  if (!expired) return;

  const error = new StepTimeoutError(expired.stepId);
  const failed = await deps.stepLedger.compareAndSet(
    stageRecordId,
    expired.stepId,
    { status: expired.status, attempt: expired.attempt },
    {
      status: "failed",
      error: error.message,
      leaseExpiresAt: null,
    },
  );
  if (failed.applied) throw error;
}

/** Replays a durable stage's full execute context outside a transaction. */
async function replayStage(
  stageRecord: WorkflowStageRecord,
  run: WorkflowRunRecord,
  stageDef: Stage<any, any, any, any, any>,
  deps: KernelDeps,
): Promise<ReplayOutcome> {
  let built: ReturnType<typeof buildStageExecutionContext> | undefined;

  try {
    const workflow = deps.registry.getWorkflow(run.workflowId);
    if (!workflow) {
      throw new Error(`Workflow ${run.workflowId} not found in registry`);
    }
    await failExpiredDurableWait(stageRecord.id, deps);
    const workflowContext = await loadWorkflowContext(run.id, deps);
    const rawInput = resolveStageInput(
      workflow,
      stageRecord.stageId,
      run,
      workflowContext,
    );
    const input: ActivityRunInput = {
      stageDef,
      workflowId: run.workflowId,
      workflowRunId: run.id,
      workflowType: run.workflowType,
      stageId: stageRecord.stageId,
      stageName: stageDef.name,
      stageNumber: stageRecord.stageNumber,
      stageRecordId: stageRecord.id,
      attempt: stageRecord.attempt,
      rawInput,
      config: {
        [stageRecord.stageId]: stageRecord.config ?? {},
      } as Record<string, unknown>,
      resumeState: stageRecord.suspendedState,
      workflowContext,
    };
    built = buildStageExecutionContext(input, deps);
    const result = await stageDef.execute(built.context);

    if (isSuspendedResult(result)) {
      const suspended = result as SuspendedResult;
      const nextPollAt = suspended.pollConfig.nextPollAt;
      const bufferedAnnotations = built.annotationBuffer.flush();
      const claimResult = await withClaimedRun(
        stageRecord.workflowRunId,
        run.version,
        deps,
        async (tx) => {
          await tx.updateStage(stageRecord.id, {
            status: "SUSPENDED",
            suspendedState: suspended.state as any,
            nextPollAt,
            pollInterval: suspended.pollConfig.pollInterval,
            maxWaitUntil: new Date(
              deps.clock.now().getTime() + suspended.pollConfig.maxWaitTime,
            ),
            metrics: suspended.metrics as any,
          });
          if (bufferedAnnotations.length > 0) {
            await tx.appendAnnotations(bufferedAnnotations);
          }
          const events = [
            ...built!.progressEvents,
            {
              type: "stage:suspended" as const,
              timestamp: deps.clock.now(),
              workflowRunId: stageRecord.workflowRunId,
              stageId: stageRecord.stageId,
              stageName: stageRecord.stageName,
              nextPollAt,
            },
            {
              type: "workflow:suspended" as const,
              timestamp: deps.clock.now(),
              workflowRunId: stageRecord.workflowRunId,
              stageId: stageRecord.stageId,
            },
            ...buildAnnotationEvents(bufferedAnnotations, deps.clock.now()),
          ];
          await tx.appendOutboxEvents(
            toOutboxEvents(stageRecord.workflowRunId, events),
          );
        },
      );
      if (await handleClaimOutcome(claimResult, stageRecord, deps))
        return "skip";
      return "suspended";
    }

    const stageResult = result as StageResult<unknown>;
    let validatedOutput = stageResult.output;
    if (stageResult.output !== undefined) {
      try {
        validatedOutput = stageDef.outputSchema.parse(stageResult.output);
      } catch (validationError) {
        await deps.persistence
          .createLog({
            workflowRunId: stageRecord.workflowRunId,
            workflowStageId: stageRecord.id,
            level: "WARN",
            message: `Stage ${stageRecord.stageId} execute output failed schema validation; persisting raw output`,
            metadata: { error: toErrorMessage(validationError) },
          })
          .catch(() => {});
      }
    }

    const outputKey = await saveStageOutput(
      stageRecord.workflowRunId,
      run.workflowType,
      stageRecord.stageId,
      validatedOutput,
      deps,
    );
    const artifactKeys =
      stageResult.artifacts && Object.keys(stageResult.artifacts).length > 0
        ? await saveStageArtifacts(
            stageRecord.workflowRunId,
            run.workflowType,
            stageRecord.stageId,
            stageResult.artifacts,
            deps,
          )
        : undefined;
    const duration =
      deps.clock.now().getTime() -
      (stageRecord.startedAt?.getTime() ?? deps.clock.now().getTime());
    const bufferedAnnotations = built.annotationBuffer.flush();
    const claimResult = await withClaimedRun(
      stageRecord.workflowRunId,
      run.version,
      deps,
      async (tx) => {
        await tx.updateStage(stageRecord.id, {
          status: "COMPLETED",
          completedAt: deps.clock.now(),
          duration,
          outputData: {
            _artifactKey: outputKey,
            ...(artifactKeys ? { _artifactKeys: artifactKeys } : {}),
          },
          nextPollAt: null,
          metrics: stageResult.metrics as any,
          embeddingInfo: stageResult.embeddings as any,
        });
        if (bufferedAnnotations.length > 0) {
          await tx.appendAnnotations(bufferedAnnotations);
        }
        const events = [
          ...built!.progressEvents,
          {
            type: "stage:completed" as const,
            timestamp: deps.clock.now(),
            workflowRunId: stageRecord.workflowRunId,
            stageId: stageRecord.stageId,
            stageName: stageRecord.stageName,
            duration,
          },
          ...buildAnnotationEvents(bufferedAnnotations, deps.clock.now()),
        ];
        await tx.appendOutboxEvents(
          toOutboxEvents(stageRecord.workflowRunId, events),
        );
      },
    );
    if (await handleClaimOutcome(claimResult, stageRecord, deps)) return "skip";
    await completeSuspendedJobRow(
      stageRecord.workflowRunId,
      stageRecord.stageId,
      deps,
    );
    return "resumed";
  } catch (error) {
    const claimResult = await failStageAndRun(
      stageRecord,
      run,
      toErrorMessage(error),
      built?.annotationBuffer.flush() ?? [],
      deps,
    );
    if (await handleClaimOutcome(claimResult, stageRecord, deps)) return "skip";
    return "failed";
  }
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
    const suspendedMetadata = (
      stageRecord.suspendedState as
        | { metadata?: Record<string, unknown> }
        | null
        | undefined
    )?.metadata;
    const isDurableReplay =
      suspendedMetadata?.[DURABLE_SUSPEND_MARKER] === true;
    if (!stageDef || (!isDurableReplay && !stageDef.checkCompletion)) {
      const errorMsg = !stageDef
        ? `Stage ${stageRecord.stageId} not found in workflow ${run.workflowId}`
        : `Stage ${stageRecord.stageId} does not support checkCompletion`;

      await failStageOnly(stageRecord, errorMsg, deps);
      failed++;
      continue;
    }

    if (isDurableReplay) {
      const outcome = await replayStage(stageRecord, run, stageDef, deps);
      if (outcome === "resumed") {
        resumed++;
        resumedWorkflowRunIds.add(stageRecord.workflowRunId);
      } else if (outcome === "failed") {
        failed++;
      }
      continue;
    }

    // 3d. Create storage shim and log function (uses non-transactional deps)
    const storage = createStorageShim(
      stageRecord.workflowRunId,
      run.workflowType,
      deps,
    );

    const logFn = (
      level: "DEBUG" | "INFO" | "WARN" | "ERROR",
      message: string,
      meta?: Record<string, unknown>,
    ): void => {
      void deps.persistence
        .createLog({
          workflowRunId: stageRecord.workflowRunId,
          workflowStageId: stageRecord.id,
          level,
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
    const checkContextBase = defineLazyAIContext(
      {
        workflowRunId: run.id,
        stageId: stageRecord.stageId,
        stageRecordId: stageRecord.id,
        config: stageRecord.config || {},
        log: logFn,
        onLog: logFn,
        annotate: annotateFn,
        storage,
      },
      {
        workflowRunId: run.id,
        stageId: stageRecord.stageId,
        stageRecordId: stageRecord.id,
      },
      deps,
    );
    const checkContext = Object.assign(checkContextBase, {
      step: createStepApi({
        stageRecordId: stageRecord.id,
        stepLedger: deps.stepLedger,
        clock: deps.clock,
        onLog: (level, message) => void logFn(level, message),
        ai: () => checkContextBase.ai,
      }),
    });

    try {
      // ── Phase 1: checkCompletion (no transaction) ──────────────────
      // External HTTP calls happen here — no DB connection held open.
      const checkResult = await stageDef.checkCompletion!(
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
            logFn(
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
