/**
 * Handler: job.execute
 *
 * Executes a single stage within a workflow run. This is the most complex
 * handler in the kernel -- it resolves input, builds the stage context,
 * runs the stage's execute() function, and handles completed / suspended /
 * failed outcomes.
 *
 * Extracted from StageExecutor.execute().
 */

import type { Workflow } from "../../core/workflow";
import type { StageContext } from "../../core/stage";
import type { ProgressUpdate } from "../../core/types";
import { isSuspendedResult } from "../../core/types";
import type { JobExecuteCommand, JobExecuteResult } from "../commands";
import type { KernelEvent } from "../events";
import type { KernelDeps, HandlerResult } from "../kernel";
import {
  createStorageShim,
  saveStageOutput,
  loadWorkflowContext,
} from "../helpers/index.js";

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

  if (groupIndex === 0) return workflowRun.input;

  const prevStageId = workflow.getPreviousStageId(stageId);
  if (prevStageId && workflowContext[prevStageId] !== undefined) {
    return workflowContext[prevStageId];
  }

  return workflowRun.input;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export async function handleJobExecute(
  command: JobExecuteCommand,
  deps: KernelDeps,
): Promise<HandlerResult<JobExecuteResult>> {
  const { workflowRunId, workflowId, stageId, config } = command;
  const events: KernelEvent[] = [];
  const startTime = deps.clock.now().getTime();

  // 1. Get workflow and stage definition
  const workflow = deps.registry.getWorkflow(workflowId);
  if (!workflow) throw new Error(`Workflow ${workflowId} not found in registry`);

  const stageDef = workflow.getStage(stageId);
  if (!stageDef) throw new Error(`Stage ${stageId} not found in workflow ${workflowId}`);

  // 2. Get workflow run
  const workflowRun = await deps.persistence.getRun(workflowRunId);
  if (!workflowRun) throw new Error(`WorkflowRun ${workflowRunId} not found`);

  // 3. Load workflow context
  const workflowContext = await loadWorkflowContext(workflowRunId, deps);

  // 4. Upsert stage record
  const stageRecord = await deps.persistence.upsertStage({
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
      config: config as any,
    },
    update: {
      status: "RUNNING",
      startedAt: deps.clock.now(),
    },
  });

  // 5. Emit stage:started
  events.push({
    type: "stage:started",
    timestamp: deps.clock.now(),
    workflowRunId,
    stageId,
    stageName: stageDef.name,
    stageNumber: stageRecord.stageNumber,
  });

  try {
    // 6. Resolve and validate input
    const rawInput = resolveStageInput(workflow, stageId, workflowRun, workflowContext);
    const validatedInput = stageDef.inputSchema.parse(rawInput);

    // 7. Parse config
    let stageConfig = (config as any)[stageId] || {};
    try {
      if (stageDef.configSchema) {
        stageConfig = stageDef.configSchema.parse(stageConfig);
      }
    } catch {
      // Fall back to raw config on parse failure
    }

    // 8. Build log function
    const logFn = async (
      level: any,
      message: string,
      meta?: Record<string, unknown>,
    ) => {
      await deps.persistence
        .createLog({
          workflowRunId,
          workflowStageId: stageRecord.id,
          level: level as any,
          message,
          metadata: meta,
        })
        .catch(() => {});
    };

    // 9. Build context
    const context: StageContext<any, any, any> = {
      workflowRunId,
      stageId,
      stageNumber: stageRecord.stageNumber,
      stageName: stageDef.name,
      stageRecordId: stageRecord.id,
      input: validatedInput,
      config: stageConfig,
      resumeState: stageRecord.suspendedState as any,
      onProgress: (update: ProgressUpdate) => {
        events.push({
          type: "stage:progress",
          timestamp: deps.clock.now(),
          workflowRunId,
          stageId,
          progress: update.progress,
          message: update.message,
          details: update.details,
        });
      },
      onLog: logFn,
      log: logFn,
      storage: createStorageShim(workflowRunId, workflowRun.workflowType, deps),
      workflowContext,
    };

    // 10. Execute
    const result = await stageDef.execute(context);

    // 11. Handle result
    if (isSuspendedResult(result)) {
      const { state, pollConfig, metrics } = result;
      const nextPollAt = new Date(
        pollConfig.nextPollAt?.getTime() ??
          deps.clock.now().getTime() + (pollConfig.pollInterval || 60000),
      );

      await deps.persistence.updateStage(stageRecord.id, {
        status: "SUSPENDED",
        suspendedState: state as any,
        nextPollAt,
        pollInterval: pollConfig.pollInterval,
        maxWaitUntil: pollConfig.maxWaitTime
          ? new Date(deps.clock.now().getTime() + pollConfig.maxWaitTime)
          : undefined,
        metrics: metrics as any,
      });

      events.push({
        type: "stage:suspended",
        timestamp: deps.clock.now(),
        workflowRunId,
        stageId,
        stageName: stageDef.name,
        nextPollAt,
      });

      return { outcome: "suspended" as const, nextPollAt, _events: events };
    } else {
      const duration = deps.clock.now().getTime() - startTime;

      // Save output
      const outputKey = await saveStageOutput(
        workflowRunId,
        workflowRun.workflowType,
        stageId,
        result.output,
        deps,
      );

      await deps.persistence.updateStage(stageRecord.id, {
        status: "COMPLETED",
        completedAt: deps.clock.now(),
        duration,
        outputData: { _artifactKey: outputKey } as any,
        metrics: result.metrics as any,
        embeddingInfo: result.embeddings as any,
      });

      events.push({
        type: "stage:completed",
        timestamp: deps.clock.now(),
        workflowRunId,
        stageId,
        stageName: stageDef.name,
        duration,
      });

      return { outcome: "completed" as const, output: result.output, _events: events };
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const duration = deps.clock.now().getTime() - startTime;

    await deps.persistence.updateStage(stageRecord.id, {
      status: "FAILED",
      completedAt: deps.clock.now(),
      duration,
      errorMessage,
    });

    await deps.persistence
      .createLog({
        workflowRunId,
        workflowStageId: stageRecord.id,
        level: "ERROR",
        message: errorMessage,
      })
      .catch(() => {});

    events.push({
      type: "stage:failed",
      timestamp: deps.clock.now(),
      workflowRunId,
      stageId,
      stageName: stageDef.name,
      error: errorMessage,
    });

    return { outcome: "failed" as const, error: errorMessage, _events: events };
  }
}
