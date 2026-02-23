/**
 * Handler: stage.pollSuspended
 *
 * Polls suspended stages whose nextPollAt has passed, calls each stage's
 * checkCompletion() method, and either resumes (completes) or re-schedules
 * them for a future poll.
 *
 * Extracted from WorkflowRuntime.pollSuspendedStages() + checkAndResume().
 */

import type {
  StagePollSuspendedCommand,
  StagePollSuspendedResult,
} from "../commands";
import type { KernelEvent } from "../events";
import { createStorageShim, saveStageOutput } from "../helpers/index.js";
import type { HandlerResult, KernelDeps } from "../kernel";

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export async function handleStagePollSuspended(
  command: StagePollSuspendedCommand,
  deps: KernelDeps,
): Promise<HandlerResult<StagePollSuspendedResult>> {
  const events: KernelEvent[] = [];
  const maxChecks = command.maxChecks ?? 50;

  // 1. Get suspended stages that are ready to be polled
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

    // 3a. Get workflow run
    const run = await deps.persistence.getRun(stageRecord.workflowRunId);
    if (!run) continue;

    // 3b. Get workflow from registry
    const workflow = deps.registry.getWorkflow(run.workflowId);
    if (!workflow) {
      await deps.persistence.updateStage(stageRecord.id, {
        status: "FAILED",
        completedAt: deps.clock.now(),
        errorMessage: `Workflow ${run.workflowId} not found in registry`,
      });
      failed++;

      events.push({
        type: "stage:failed",
        timestamp: deps.clock.now(),
        workflowRunId: stageRecord.workflowRunId,
        stageId: stageRecord.stageId,
        stageName: stageRecord.stageName,
        error: `Workflow ${run.workflowId} not found in registry`,
      });
      continue;
    }

    // 3c. Get stage definition
    const stageDef = workflow.getStage(stageRecord.stageId);
    if (!stageDef || !stageDef.checkCompletion) {
      const errorMsg = !stageDef
        ? `Stage ${stageRecord.stageId} not found in workflow ${run.workflowId}`
        : `Stage ${stageRecord.stageId} does not support checkCompletion`;

      await deps.persistence.updateStage(stageRecord.id, {
        status: "FAILED",
        completedAt: deps.clock.now(),
        errorMessage: errorMsg,
      });
      failed++;

      events.push({
        type: "stage:failed",
        timestamp: deps.clock.now(),
        workflowRunId: stageRecord.workflowRunId,
        stageId: stageRecord.stageId,
        stageName: stageRecord.stageName,
        error: errorMsg,
      });
      continue;
    }

    // 3d. Create storage shim
    const storage = createStorageShim(
      stageRecord.workflowRunId,
      run.workflowType,
      deps,
    );

    // 3e. Create log function
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

    // 3f. Build check context
    const checkContext = {
      workflowRunId: run.id,
      stageId: stageRecord.stageId,
      stageRecordId: stageRecord.id,
      config: stageRecord.config || {},
      log: logFn,
      onLog: logFn,
      storage,
    };

    try {
      // 3g. Call checkCompletion
      const checkResult = await stageDef.checkCompletion(
        stageRecord.suspendedState as any,
        checkContext,
      );

      if (checkResult.error) {
        // Error during check -- fail the stage and the run
        await deps.persistence.updateStage(stageRecord.id, {
          status: "FAILED",
          completedAt: deps.clock.now(),
          errorMessage: checkResult.error,
          nextPollAt: null,
        });

        await deps.persistence.updateRun(stageRecord.workflowRunId, {
          status: "FAILED",
          completedAt: deps.clock.now(),
        });

        failed++;

        events.push({
          type: "stage:failed",
          timestamp: deps.clock.now(),
          workflowRunId: stageRecord.workflowRunId,
          stageId: stageRecord.stageId,
          stageName: stageRecord.stageName,
          error: checkResult.error,
        });

        events.push({
          type: "workflow:failed",
          timestamp: deps.clock.now(),
          workflowRunId: stageRecord.workflowRunId,
          error: checkResult.error,
        });
      } else if (checkResult.ready) {
        // Ready -- complete the stage (output is optional)
        let outputRef: { _artifactKey: string } | undefined;
        if (checkResult.output !== undefined) {
          let validatedOutput = checkResult.output;
          try {
            validatedOutput = stageDef.outputSchema.parse(checkResult.output);
          } catch {
            // Fall back to raw output on validation failure
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

        await deps.persistence.updateStage(stageRecord.id, {
          status: "COMPLETED",
          completedAt: deps.clock.now(),
          duration,
          outputData: outputRef as any,
          nextPollAt: null,
          metrics: checkResult.metrics as any,
          embeddingInfo: checkResult.embeddings as any,
        });

        resumed++;
        resumedWorkflowRunIds.add(stageRecord.workflowRunId);

        events.push({
          type: "stage:completed",
          timestamp: deps.clock.now(),
          workflowRunId: stageRecord.workflowRunId,
          stageId: stageRecord.stageId,
          stageName: stageRecord.stageName,
          duration,
        });
      } else {
        // Not ready -- update nextPollAt for next check
        const pollInterval =
          checkResult.nextCheckIn ?? stageRecord.pollInterval ?? 60000;

        const nextPollAt = new Date(deps.clock.now().getTime() + pollInterval);

        await deps.persistence.updateStage(stageRecord.id, {
          nextPollAt,
        });
      }
    } catch (error) {
      // Unexpected error during checkCompletion
      const errorMessage =
        error instanceof Error ? error.message : String(error);

      await deps.persistence.updateStage(stageRecord.id, {
        status: "FAILED",
        completedAt: deps.clock.now(),
        errorMessage,
        nextPollAt: null,
      });

      await deps.persistence.updateRun(stageRecord.workflowRunId, {
        status: "FAILED",
        completedAt: deps.clock.now(),
      });

      failed++;

      events.push({
        type: "stage:failed",
        timestamp: deps.clock.now(),
        workflowRunId: stageRecord.workflowRunId,
        stageId: stageRecord.stageId,
        stageName: stageRecord.stageName,
        error: errorMessage,
      });

      events.push({
        type: "workflow:failed",
        timestamp: deps.clock.now(),
        workflowRunId: stageRecord.workflowRunId,
        error: errorMessage,
      });
    }
  }

  return {
    checked,
    resumed,
    failed,
    resumedWorkflowRunIds: [...resumedWorkflowRunIds],
    _events: events,
  };
}
