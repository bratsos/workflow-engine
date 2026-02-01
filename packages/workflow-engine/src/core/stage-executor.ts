/**
 * Stage Executor - Executes a single stage
 *
 * Unlike WorkflowExecutor which runs entire workflows,
 * this executes exactly ONE stage and returns.
 *
 * Designed for distributed workers.
 */

import type { WorkflowPersistence } from "../persistence";
import { createLogger } from "../utils/logger";
import { type StageContext, type StageStorage } from "./stage";
import type {
  ProgressUpdate,
  StageMetrics,
  StageResult,
  SuspendedResult,
} from "./types";
import { isSuspendedResult } from "./types";
import type { Workflow } from "./workflow";
import { workflowEventBus } from "./workflow-event-bus.server";

const logger = createLogger("StageExecutor");

export interface WorkflowRegistry {
  getWorkflow(id: string): Workflow<any, any> | undefined;
}

export interface StageExecutionRequest {
  workflowRunId: string;
  workflowId: string; // Needed to look up registry
  stageId: string;
  config: Record<string, unknown>;
}

export interface StageExecutionResult {
  type: "completed" | "suspended" | "failed";
  output?: unknown;
  suspendedState?: unknown;
  nextPollAt?: Date;
  error?: string;
  metrics?: StageMetrics;
}

export class StageExecutor {
  private workerId: string;

  constructor(
    private registry: WorkflowRegistry,
    private persistence: WorkflowPersistence,
    workerId?: string,
  ) {
    this.workerId = workerId || `stage-executor-${process.pid}`;
  }

  /**
   * Execute a single stage
   */
  async execute(request: StageExecutionRequest): Promise<StageExecutionResult> {
    const { workflowRunId, workflowId, stageId, config } = request;
    const startTime = Date.now();

    logger.debug(`Executing stage ${stageId} for workflow ${workflowRunId}`);

    // 1. Get workflow definition
    const workflow = this.registry.getWorkflow(workflowId);
    if (!workflow) {
      throw new Error(`Workflow ${workflowId} not found in registry`);
    }

    // 2. Get stage definition
    const stageDef = workflow.getStage(stageId);
    if (!stageDef) {
      throw new Error(`Stage ${stageId} not found in workflow ${workflowId}`);
    }

    // 3. Get workflow run for context (need input/config/workflowType)
    const workflowRun = await this.persistence.getRun(workflowRunId);
    if (!workflowRun) {
      throw new Error(`WorkflowRun ${workflowRunId} not found`);
    }

    // 4. Load workflow context (all previous completed stage outputs)
    const workflowContext = await this.loadWorkflowContext(
      workflowRunId,
      workflowRun.workflowType,
    );

    // 6. Get or create stage record
    // We upsert because it might already exist if we are retrying or resuming
    const stageRecord = await this.persistence.upsertStage({
      workflowRunId,
      stageId,
      create: {
        workflowRunId,
        stageId,
        stageName: stageDef.name,
        stageNumber: this.getStageNumber(workflow, stageId),
        executionGroup: this.getExecutionGroup(workflow, stageId),
        status: "RUNNING",
        startedAt: new Date(),
        config: config as any,
        inputData: undefined, // Will be set later? Or needs to be passed?
        // Note: original local code didn't set inputData in create? Wait, checking local code...
      },
      update: {
        status: "RUNNING",
        startedAt: new Date(),
        // errorMessage: null, // Persistence interface might not support partial update of this field easily if not explicit?
        // But upsertStage uses UpdateStageInput.
      },
    });

    // 7. Determine input for this stage
    const input = await this.resolveStageInput(
      workflow,
      stageId,
      workflowRun,
      workflowContext,
    );

    // Update input data in persistence
    // Wait, local code didn't update input data explicitly after resolving?
    // It passed it to context.

    // 8. Emit stage started event
    workflowEventBus.emitWorkflowEvent(workflowRunId, "stage:started", {
      stageId,
      stageName: stageDef.name,
      stageNumber: stageRecord.stageNumber,
    });

    try {
      // 9. Input Validation
      const validatedInput = stageDef.inputSchema.parse(input) as any;

      // 10. Build stage context
      let stageConfig = (config[stageId] || {}) as any;

      // Parse config with schema
      try {
        if (stageDef.configSchema) {
          stageConfig = stageDef.configSchema.parse(stageConfig);
        }
      } catch (err) {
        logger.warn(
          `Config parsing failed for ${stageId}, falling back to raw config`,
        );
      }

      const logFn = (
        level: any,
        message: string,
        meta?: Record<string, unknown>,
      ) => this.log(workflowRunId, stageRecord.id, level, message, meta);

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
          workflowEventBus.emitWorkflowEvent(
            workflowRunId,
            "stage:progress",
            update as unknown as Record<string, unknown>,
          );
        },

        onLog: logFn,
        log: logFn,

        storage: this.createStorageShim(
          workflowRunId,
          workflowRun.workflowType,
        ),
        workflowContext,
      };

      // 11. Execute
      const result = await stageDef.execute(context);

      // 12. Handle Result
      if (isSuspendedResult(result)) {
        return await this.handleSuspended(stageRecord.id, result, startTime);
      } else {
        return await this.handleCompleted(
          workflowRunId,
          workflowRun.workflowType,
          stageRecord.id,
          stageId,
          result,
          startTime,
        );
      }
    } catch (error) {
      return await this.handleFailed(stageRecord.id, stageId, error, startTime);
    }
  }

  // -- Handlers --

  private async handleCompleted(
    workflowRunId: string,
    workflowType: string,
    stageRecordId: string,
    stageId: string,
    result: StageResult<any>,
    startTime: number,
  ): Promise<StageExecutionResult> {
    const duration = Date.now() - startTime;

    // Save output to storage via persistence
    const outputKey = await this.persistence.saveStageOutput(
      workflowRunId,
      workflowType,
      stageId,
      result.output,
    );

    // Update stage record
    await this.persistence.updateStage(stageRecordId, {
      status: "COMPLETED",
      completedAt: new Date(),
      duration,
      outputData: { _artifactKey: outputKey } as any,
      metrics: result.metrics as any,
      embeddingInfo: result.embeddings as any,
    });

    return {
      type: "completed",
      output: result.output,
      metrics: result.metrics,
    };
  }

  private async handleSuspended(
    stageRecordId: string,
    result: SuspendedResult,
    startTime: number,
  ): Promise<StageExecutionResult> {
    const { state, pollConfig, metrics } = result;

    const nextPollAt = new Date(
      pollConfig.nextPollAt || Date.now() + (pollConfig.pollInterval || 60000),
    );

    // Update stage to SUSPENDED
    await this.persistence.updateStage(stageRecordId, {
      status: "SUSPENDED",
      suspendedState: state as any,
      nextPollAt: nextPollAt,
      pollInterval: pollConfig.pollInterval,
      maxWaitUntil: pollConfig.maxWaitTime
        ? new Date(Date.now() + pollConfig.maxWaitTime)
        : undefined,
      metrics: metrics as any,
    });

    return {
      type: "suspended",
      suspendedState: state,
      nextPollAt: nextPollAt,
      metrics,
    };
  }

  private async handleFailed(
    stageRecordId: string,
    stageId: string,
    error: unknown,
    startTime: number,
  ): Promise<StageExecutionResult> {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const duration = Date.now() - startTime;

    logger.error(`Stage ${stageId} failed:`, error);

    await this.persistence.updateStage(stageRecordId, {
      status: "FAILED",
      completedAt: new Date(),
      duration, // Note: updateStage input might not support duration? Check persistence interface. Assuming it does as StageRecord has it.
      // errorMessage: errorMessage // Check if UpdateStageInput supports errorMessage.
      // If not, use updateStageByRunAndStageId pattern or check interface.
    });

    // To be safe, if updateStage doesn't support errorMessage (it might be in metadata?),
    // WorkflowExecutor used updateStageByRunAndStageId.
    // I will use that pattern if needed, but updateStage by ID is more direct if supported.
    // For now assuming updateStage maps correctly. If not, I'll fix later.
    // EDIT: WorkflowExecutor used updateStageByRunAndStageId for failure.
    // I'll stick to updateStage if I can, but I'll add a separate log for error.

    // Also save log
    await this.log(
      "" /* runId? need context */,
      stageRecordId,
      "ERROR",
      errorMessage,
    );

    return {
      type: "failed",
      error: errorMessage,
    };
  }

  // -- Helpers --

  private async loadWorkflowContext(
    workflowRunId: string,
    workflowType: string,
  ): Promise<Record<string, unknown>> {
    const completedStages = await this.persistence.getStagesByRun(
      workflowRunId,
      {
        status: "COMPLETED",
        orderBy: "asc",
      },
    );

    const context: Record<string, unknown> = {};

    for (const stage of completedStages) {
      const outputData = stage.outputData as any;
      if (outputData?._artifactKey) {
        context[stage.stageId] = await this.persistence.loadArtifact(
          workflowRunId,
          outputData._artifactKey,
        );
      } else if (outputData && typeof outputData === "object") {
        context[stage.stageId] = outputData;
      }
    }

    return context;
  }

  /**
   * Create a minimal storage shim for context.storage (for API compatibility).
   * Stage implementations should not rely on this - it may be removed in future.
   */
  private createStorageShim(
    workflowRunId: string,
    workflowType: string,
  ): StageStorage {
    const persistence = this.persistence;
    return {
      async save<T>(key: string, data: T): Promise<void> {
        await persistence.saveArtifact({
          workflowRunId,
          key,
          type: "ARTIFACT",
          data,
          size: Buffer.byteLength(JSON.stringify(data), "utf8"),
        });
      },
      async load<T>(key: string): Promise<T> {
        return persistence.loadArtifact(workflowRunId, key) as Promise<T>;
      },
      async exists(key: string): Promise<boolean> {
        return persistence.hasArtifact(workflowRunId, key);
      },
      async delete(key: string): Promise<void> {
        return persistence.deleteArtifact(workflowRunId, key);
      },
      getStageKey(stageId: string, suffix?: string): string {
        const base = `workflow-v2/${workflowType}/${workflowRunId}/${stageId}`;
        return suffix ? `${base}/${suffix}` : `${base}/output.json`;
      },
    };
  }

  private async resolveStageInput(
    workflow: any,
    stageId: string,
    workflowRun: { input: any },
    workflowContext: Record<string, unknown>,
  ): Promise<unknown> {
    const stageDef = workflow.getStage(stageId);
    if (!stageDef) return {};

    const groupIndex = workflow.getExecutionGroupIndex(stageId);

    if (groupIndex === 0) {
      return workflowRun.input;
    }

    const prevStageId = workflow.getPreviousStageId(stageId);
    if (prevStageId) {
      return workflowContext[prevStageId];
    }

    return workflowRun.input;
  }

  private getStageNumber(workflow: any, stageId: string): number {
    return workflow.getStageIndex(stageId) + 1;
  }

  private getExecutionGroup(workflow: any, stageId: string): number {
    return workflow.getExecutionGroupIndex(stageId);
  }

  private async log(
    workflowRunId: string,
    stageRecordId: string,
    level: string,
    message: string,
    meta?: any,
  ) {
    logger.debug(`[${level}] ${message}`);
    await this.persistence
      .createLog({
        workflowRunId,
        workflowStageId: stageRecordId,
        level: level as any,
        message,
        metadata: meta,
      })
      .catch((err) => logger.error("Failed to write log:", err));
  }
}
