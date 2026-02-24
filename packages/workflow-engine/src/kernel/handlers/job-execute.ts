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
 *   Phase 2 (Execute):  run stageDef.execute() outside any database
 *                       transaction. Progress events are collected
 *                       in memory.
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

import type { StageContext } from "../../core/stage";
import type { ProgressUpdate } from "../../core/types";
import { isSuspendedResult } from "../../core/types";
import type { Workflow } from "../../core/workflow";
import type { CreateOutboxEventInput } from "../../persistence/interface";
import type { JobExecuteCommand, JobExecuteResult } from "../commands";
import type { KernelEvent } from "../events";
import {
  createStorageShim,
  loadWorkflowContext,
  saveStageOutput,
} from "../helpers/index.js";
import type { HandlerResult, KernelDeps } from "../kernel";

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
// Helper: build outbox event inputs from kernel events
// ---------------------------------------------------------------------------

function toOutboxEvents(
  workflowRunId: string,
  causationId: string,
  events: KernelEvent[],
): CreateOutboxEventInput[] {
  return events.map((event) => ({
    workflowRunId,
    eventType: event.type,
    payload: event,
    causationId,
    occurredAt: event.timestamp,
  }));
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

  const workflowContext = await loadWorkflowContext(workflowRunId, deps);

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
        config: config as any,
      },
      update: {
        status: "RUNNING",
        startedAt: deps.clock.now(),
      },
    });

    await tx.appendOutboxEvents(
      toOutboxEvents(workflowRunId, causationId, [
        {
          type: "stage:started",
          timestamp: deps.clock.now(),
          workflowRunId,
          stageId,
          stageName: stageDef.name,
          stageNumber: record.stageNumber,
        },
      ]),
    );

    return record;
  });

  // ── Phase 2: Execute (no transaction) ────────────────────────────
  // The stage's execute() function runs outside any database
  // transaction.  Progress events are collected in memory and
  // written to the outbox in Phase 3.

  const progressEvents: KernelEvent[] = [];

  try {
    // Resolve and validate input
    const rawInput = resolveStageInput(
      workflow,
      stageId,
      workflowRun,
      workflowContext,
    );
    const validatedInput = stageDef.inputSchema.parse(rawInput);

    // Parse config
    let stageConfig = (config as any)[stageId] || {};
    try {
      if (stageDef.configSchema) {
        stageConfig = stageDef.configSchema.parse(stageConfig);
      }
    } catch {
      // Fall back to raw config on parse failure
    }

    // Build log function (fire-and-forget, no transaction needed)
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

    // Build context
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
        progressEvents.push({
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

    // Execute the stage — this is the potentially long-running part
    const result = await stageDef.execute(context);

    // ── Phase 3a: Complete transaction (success) ─────────────────
    if (isSuspendedResult(result)) {
      const { state, pollConfig, metrics } = result;
      const nextPollAt = new Date(
        pollConfig.nextPollAt?.getTime() ??
          deps.clock.now().getTime() + (pollConfig.pollInterval || 60000),
      );

      await deps.persistence.withTransaction(async (tx) => {
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

        const suspendedEvent: KernelEvent = {
          type: "stage:suspended",
          timestamp: deps.clock.now(),
          workflowRunId,
          stageId,
          stageName: stageDef.name,
          nextPollAt,
        };

        await tx.appendOutboxEvents(
          toOutboxEvents(workflowRunId, causationId, [
            ...progressEvents,
            suspendedEvent,
          ]),
        );
      });

      return { outcome: "suspended" as const, nextPollAt, _events: [] };
    } else {
      const duration = deps.clock.now().getTime() - startTime;

      // Save output to blob store (not a DB operation)
      const outputKey = await saveStageOutput(
        workflowRunId,
        workflowRun.workflowType,
        stageId,
        result.output,
        deps,
      );

      await deps.persistence.withTransaction(async (tx) => {
        await tx.updateStage(stageRecord.id, {
          status: "COMPLETED",
          completedAt: deps.clock.now(),
          duration,
          outputData: { _artifactKey: outputKey } as any,
          metrics: result.metrics as any,
          embeddingInfo: result.embeddings as any,
        });

        const completedEvent: KernelEvent = {
          type: "stage:completed",
          timestamp: deps.clock.now(),
          workflowRunId,
          stageId,
          stageName: stageDef.name,
          duration,
        };

        await tx.appendOutboxEvents(
          toOutboxEvents(workflowRunId, causationId, [
            ...progressEvents,
            completedEvent,
          ]),
        );
      });

      return {
        outcome: "completed" as const,
        output: result.output,
        _events: [],
      };
    }
  } catch (error) {
    // ── Phase 3b: Complete transaction (failure) ─────────────────
    // The stage's execute() threw. Write FAILED status + outbox
    // event.  If Phase 3 itself fails, re-throw the original error
    // so the idempotency key is released and the job can be retried.
    const errorMessage = error instanceof Error ? error.message : String(error);
    const duration = deps.clock.now().getTime() - startTime;

    try {
      await deps.persistence.withTransaction(async (tx) => {
        await tx.updateStage(stageRecord.id, {
          status: "FAILED",
          completedAt: deps.clock.now(),
          duration,
          errorMessage,
        });

        const failedEvent: KernelEvent = {
          type: "stage:failed",
          timestamp: deps.clock.now(),
          workflowRunId,
          stageId,
          stageName: stageDef.name,
          error: errorMessage,
        };

        await tx.appendOutboxEvents(
          toOutboxEvents(workflowRunId, causationId, [
            ...progressEvents,
            failedEvent,
          ]),
        );
      });
    } catch {
      // Phase 3 itself failed. Stage stays RUNNING.
      // Re-throw the original error so the idempotency key is
      // released and lease.reapStale can retry the job.
      throw error;
    }

    await deps.persistence
      .createLog({
        workflowRunId,
        workflowStageId: stageRecord.id,
        level: "ERROR",
        message: errorMessage,
      })
      .catch(() => {});

    return { outcome: "failed" as const, error: errorMessage, _events: [] };
  }
}
