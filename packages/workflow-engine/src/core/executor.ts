/**
 * Workflow Executor - Executes workflows with support for resume and suspension
 *
 * Key features:
 * - Sequential and parallel stage execution
 * - Automatic state persistence to R2 and database
 * - Resume from last completed stage
 * - Suspend/resume for long-running batch jobs
 * - Event emission for real-time updates
 *
 * Note: Stages should import createAIHelper directly from ~/lib/ai-helper
 * and create their own AI helper instances with appropriate topics.
 * The executor creates a helper for tracking aggregate stats per stage.
 */

import { EventEmitter } from "node:events";
import type {
  AICallLogger,
  LogLevel as PersistenceLogLevel,
  WorkflowPersistence,
} from "../persistence";
import { createLogger } from "../utils/logger";
import type { StageContext, StageStorage } from "./stage";
import type {
  LogLevel,
  ProgressUpdate,
  StageResult,
  SuspendedResult,
} from "./types";
import { isSuspendedResult } from "./types";
import type { StageNode, Workflow } from "./workflow";
import { workflowEventBus } from "./workflow-event-bus.server";
import { type WorkflowEventType } from "./workflow-events";

const logger = createLogger("Executor");

// ============================================================================
// Executor Events
// ============================================================================

export interface ExecutorEvents {
  "workflow:started": { workflowRunId: string; workflowName: string };
  "workflow:completed": { workflowRunId: string; output: unknown };
  "workflow:suspended": { workflowRunId: string; stageId: string };
  "workflow:cancelled": { workflowRunId: string; reason: string };
  "workflow:failed": { workflowRunId: string; error: string };

  "stage:started": { stageId: string; stageName: string; stageNumber: number };
  "stage:progress": ProgressUpdate;
  "stage:completed": { stageId: string; stageName: string; duration: number };
  "stage:suspended": { stageId: string; stageName: string; resumeAt: Date };
  "stage:failed": { stageId: string; stageName: string; error: string };

  log: { level: LogLevel; message: string; meta?: Record<string, unknown> };
}

// ============================================================================
// Executor Options
// ============================================================================

export interface WorkflowExecutorOptions {
  persistence?: WorkflowPersistence;
  /** Optional AI call logger. If not provided, AI tracking is disabled. */
  aiLogger?: AICallLogger;
}

// ============================================================================
// No-Op AI Logger (for workflows without AI tracking)
// ============================================================================

/**
 * A no-op implementation of AICallLogger for workflows that don't need AI tracking.
 * All methods do nothing but satisfy the interface.
 */
class NoOpAICallLogger implements AICallLogger {
  logCall(): void {
    // No-op
  }

  async logBatchResults(): Promise<void> {
    // No-op
  }

  async getStats(): Promise<{
    totalCalls: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    totalCost: number;
    perModel: Record<string, never>;
  }> {
    return {
      totalCalls: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCost: 0,
      perModel: {},
    };
  }

  async isRecorded(): Promise<boolean> {
    return false;
  }
}

// ============================================================================
// Workflow Executor
// ============================================================================

export class WorkflowExecutor extends EventEmitter {
  private cancelled = false;
  private persistence: WorkflowPersistence;
  private aiLogger: AICallLogger;

  constructor(
    private workflow: Workflow<any, any>,
    private workflowRunId: string,
    private workflowType: string,
    storageProviderOrOptions?: WorkflowExecutorOptions,
  ) {
    super();

    // Handle backward-compatible constructor signature
    let persistence: WorkflowPersistence | undefined;
    let aiLogger: AICallLogger | undefined;

    if (
      typeof storageProviderOrOptions === "object" &&
      storageProviderOrOptions !== null
    ) {
      persistence = storageProviderOrOptions.persistence;
      aiLogger = storageProviderOrOptions.aiLogger;
    }

    if (!persistence) {
      throw new Error(
        "WorkflowExecutor requires persistence to be provided via options. " +
          "Create an instance using PrismaWorkflowPersistence or InMemoryWorkflowPersistence.",
      );
    }

    this.persistence = persistence;
    // Use no-op logger if AI tracking is not needed
    this.aiLogger = aiLogger ?? new NoOpAICallLogger();
  }

  /**
   * Override emit to also forward events to the global event bus for SSE
   */
  emit(eventName: string | symbol, ...args: any[]): boolean {
    const eventType = String(eventName) as WorkflowEventType;
    if (args[0] && typeof args[0] === "object") {
      workflowEventBus.emitWorkflowEvent(
        this.workflowRunId,
        eventType,
        args[0],
      );
    }
    return super.emit(eventName, ...args);
  }

  /**
   * Check if the workflow has been interrupted (cancelled or suspended) externally
   * This checks the database status to detect external requests
   */
  private async checkExternalInterruption(): Promise<{
    type: "cancelled" | "suspended";
    reason?: string;
  } | null> {
    if (this.cancelled) {
      return { type: "cancelled", reason: "Cancelled by local request" };
    }

    try {
      const status = await this.persistence.getRunStatus(this.workflowRunId);

      if (status === "CANCELLED") {
        this.cancelled = true;
        return { type: "cancelled", reason: "Cancelled by external request" };
      }

      if (status === "SUSPENDED") {
        return { type: "suspended", reason: "Suspended by external request" };
      }

      return null;
    } catch (error) {
      logger.error("Error checking interruption status:", error);
      return null;
    }
  }

  /**
   * Execute the workflow
   *
   * @param input - Workflow input data
   * @param config - Configuration for each stage (keyed by stage ID)
   * @param options - Execution options (resume, etc.)
   * @returns Final output or 'suspended' if workflow is suspended
   */
  async execute<TInput, TOutput>(
    input: TInput,
    config: Record<string, unknown>,
    options: { resume?: boolean; fromStage?: string } = {},
  ): Promise<TOutput | "suspended"> {
    try {
      // Validate config before execution
      const configValidation = this.workflow.validateConfig(config);
      if (!configValidation.valid) {
        const errorMessages = configValidation.errors
          .map((e) => `  - ${e.stageId}: ${e.error}`)
          .join("\n");
        throw new Error(`Workflow config validation failed:\n${errorMessages}`);
      }

      // Update workflow run status
      await this.persistence.updateRun(this.workflowRunId, {
        status: "RUNNING",
        startedAt: new Date(),
      });

      this.emit("workflow:started", {
        workflowRunId: this.workflowRunId,
        workflowName: this.workflow.name,
      });

      this.log("INFO", `Starting workflow: ${this.workflow.name}`);

      // Determine starting point
      let startGroupNumber = 1; // Execution groups start at 1
      let currentOutput: any = input;

      // Initialize workflow context for accumulating stage outputs
      let workflowContext: Record<string, unknown> = {};

      if (options.resume) {
        const resumeData = await this.loadResumeState();
        if (resumeData) {
          startGroupNumber = resumeData.lastCompletedGroup + 1;
          currentOutput = resumeData.lastOutput;

          // Rebuild workflow context from completed stages
          workflowContext = await this.loadWorkflowContext();

          this.log("INFO", `Resuming from execution group ${startGroupNumber}`);
          this.log(
            "INFO",
            `Loaded ${Object.keys(workflowContext).length} previous stage outputs into context`,
          );
        }
      }

      // Handle fromStage option - rerun from a specific stage
      if (options.fromStage) {
        const fromStageData = await this.loadFromStageState(options.fromStage);
        startGroupNumber = fromStageData.executionGroup;
        currentOutput = fromStageData.input;
        workflowContext = fromStageData.workflowContext;

        this.log(
          "INFO",
          `Rerunning from stage "${options.fromStage}" (group ${startGroupNumber})`,
        );
        this.log(
          "INFO",
          `Loaded ${Object.keys(workflowContext).length} previous stage outputs into context`,
        );
      }

      // Execute stage groups
      const executionPlan = this.workflow.getExecutionPlan();

      for (let groupIdx = 0; groupIdx < executionPlan.length; groupIdx++) {
        const group = executionPlan[groupIdx];

        // Check for external interruption (cancel/pause) before each group
        const interruption = await this.checkExternalInterruption();

        if (interruption) {
          if (interruption.type === "cancelled") {
            this.log("WARN", "Workflow cancelled by external request");
            this.emit("workflow:cancelled", {
              workflowRunId: this.workflowRunId,
              reason: interruption.reason || "Cancelled by user",
            });

            // Ensure status is cancelled in DB (might be already, but to be safe/consistent)
            await this.persistence.updateRun(this.workflowRunId, {
              status: "CANCELLED",
              completedAt: new Date(),
            });

            return "cancelled" as any;
          } else if (interruption.type === "suspended") {
            this.log("WARN", "Workflow suspended by external request");

            // No specific event for "workflow level suspension by user" currently,
            // but we can reuse stage:suspended logic or just log.
            // Using stage:suspended with a fake "User Pause" stage ID for UI feedback might be hacky.
            // Ideally, we just return "suspended" and the UI sees the WorkflowRun status.

            // Ensure status is verified as suspended (it triggered this block, so it should be)
            return "suspended";
          }
        }

        // Skip groups that are already completed (when resuming)
        const groupNumber = group[0].executionGroup;
        if (groupNumber < startGroupNumber) {
          this.log("INFO", `Skipping already completed group ${groupNumber}`);
          continue;
        }

        if (group.length === 1) {
          // Sequential execution
          const node = group[0];
          const result = await this.executeStage(
            node,
            currentOutput,
            config[node.stage.id] || {},
            node.executionGroup,
            workflowContext,
          );

          if (result === "suspended") {
            return "suspended";
          }

          currentOutput = result.output;
          // Accumulate stage output in workflow context
          workflowContext[node.stage.id] = result.output;
        } else {
          // Parallel execution
          const results = await Promise.all(
            group.map((node) =>
              this.executeStage(
                node,
                currentOutput,
                config[node.stage.id] || {},
                node.executionGroup,
                workflowContext,
              ),
            ),
          );

          // Check if any stage is suspended
          const suspendedIdx = results.findIndex((r) => r === "suspended");
          if (suspendedIdx !== -1) {
            return "suspended";
          }

          // Merge parallel outputs into object (by index)
          currentOutput = results.reduce(
            (acc, result, idx) => {
              if (result !== "suspended") {
                acc[idx] = result.output;
                // Also accumulate in workflowContext by stage ID
                const stageId = group[idx].stage.id;
                workflowContext[stageId] = result.output;
              }
              return acc;
            },
            {} as Record<number, unknown>,
          );
        }
      }

      // Workflow completed
      const endTime = new Date();
      const run = await this.persistence.getRun(this.workflowRunId);
      const startTime = run?.startedAt;

      const duration = startTime
        ? endTime.getTime() - startTime.getTime()
        : undefined;

      // Calculate total cost and tokens
      const aggregatedStats = await this.getAggregatedStats();

      await this.persistence.updateRun(this.workflowRunId, {
        status: "COMPLETED",
        completedAt: endTime,
        duration,
        output: currentOutput as any,
        totalCost: aggregatedStats.totalCost,
        totalTokens: aggregatedStats.totalTokens,
      });

      this.emit("workflow:completed", {
        workflowRunId: this.workflowRunId,
        output: currentOutput,
      });

      this.log("INFO", `Workflow completed in ${duration}ms`);

      return currentOutput;
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);

      await this.persistence.updateRun(this.workflowRunId, {
        status: "FAILED",
        completedAt: new Date(),
      });

      this.emit("workflow:failed", {
        workflowRunId: this.workflowRunId,
        error: errorMessage,
      });

      this.log("ERROR", `Workflow failed: ${errorMessage}`);

      throw error;
    }
  }

  /**
   * Execute a single stage
   */
  private async executeStage(
    node: StageNode,
    input: any,
    config: any,
    executionGroup: number,
    workflowContext: Record<string, unknown>,
  ): Promise<StageResult<any> | "suspended"> {
    const { stage } = node;
    const startTime = Date.now();

    try {
      // Create or get stage record
      const stageRecord = await this.persistence.upsertStage({
        workflowRunId: this.workflowRunId,
        stageId: stage.id,
        create: {
          workflowRunId: this.workflowRunId,
          stageId: stage.id,
          stageName: stage.name,
          stageNumber: executionGroup,
          executionGroup,
          status: "RUNNING",
          startedAt: new Date(),
          config: config as any,
          inputData: input as any,
        },
        update: {
          status: "RUNNING",
          startedAt: new Date(),
        },
      });

      this.emit("stage:started", {
        stageId: stage.id,
        stageName: stage.name,
        stageNumber: executionGroup,
      });

      // Check if this stage was previously suspended and has state to resume from
      const isResuming = stageRecord.suspendedState !== null;
      if (isResuming) {
        this.log("INFO", `Resuming suspended stage: ${stage.name}`);
      } else {
        this.log("INFO", `Executing stage: ${stage.name}`);
      }

      // Validate input
      const inputStr = JSON.stringify(input);
      logger.debug(`Stage ${stage.name} input`, {
        stageId: stage.id,
        executionGroup,
        isResuming,
        input:
          inputStr.substring(0, 1000) + (inputStr.length > 1000 ? "..." : ""),
      });
      const validatedInput = stage.inputSchema.parse(input);

      // Create stage context
      const logFn = (
        level: LogLevel,
        message: string,
        meta?: Record<string, unknown>,
      ) => {
        this.log(level, message, meta);
        // Also save to database (fire and forget)
        this.persistence
          .createLog({
            workflowStageId: stageRecord.id,
            workflowRunId: this.workflowRunId,
            level: level as PersistenceLogLevel,
            message,
            metadata: meta,
          })
          .catch((err) => logger.error("Failed to persist log:", err));
      };

      const context: StageContext<any, any> = {
        workflowRunId: this.workflowRunId,
        stageId: stage.id,
        stageNumber: executionGroup,
        stageName: stage.name,
        input: validatedInput,
        config,
        onProgress: (update: ProgressUpdate) => {
          this.emit("stage:progress", update);
        },
        onLog: logFn,
        log: logFn,
        storage: this.createStorageShim(),
        workflowContext: workflowContext,
        // If resuming from suspension, pass the suspended state
        resumeState: isResuming
          ? (stageRecord.suspendedState as any)
          : undefined,
      };

      // Execute stage
      const result = await stage.execute(context);

      // Check if suspended
      if (isSuspendedResult(result)) {
        const { state, pollConfig, metrics } = result;

        // Trace log suspension details
        const stateStr = JSON.stringify(state);
        logger.debug(`Stage ${stage.name} suspended`, {
          stageId: stage.id,
          nextPollAt: pollConfig.nextPollAt.toISOString(),
          pollInterval: pollConfig.pollInterval,
          maxWaitTime: pollConfig.maxWaitTime,
          state:
            stateStr.substring(0, 500) + (stateStr.length > 500 ? "..." : ""),
        });

        // Update stage record
        await this.persistence.updateStage(stageRecord.id, {
          status: "SUSPENDED",
          suspendedState: state as any,
          nextPollAt: pollConfig.nextPollAt,
          pollInterval: pollConfig.pollInterval,
          maxWaitUntil: new Date(Date.now() + pollConfig.maxWaitTime),
          metrics: metrics as any,
        });

        // Update workflow run status
        await this.persistence.updateRun(this.workflowRunId, {
          status: "SUSPENDED",
        });

        this.emit("stage:suspended", {
          stageId: stage.id,
          stageName: stage.name,
          resumeAt: pollConfig.nextPollAt,
        });

        this.log(
          "INFO",
          `Stage suspended: ${stage.name}, next poll at ${pollConfig.nextPollAt.toISOString()}`,
        );

        return "suspended";
      }

      // Validate output
      const validatedOutput = stage.outputSchema.parse(result.output);

      // Save output to storage via persistence
      const outputKey = await this.persistence.saveStageOutput(
        this.workflowRunId,
        this.workflowType,
        stage.id,
        validatedOutput,
      );

      const endTime = Date.now();
      const duration = endTime - startTime;

      // Update stage record - store reference to artifact for backward compatibility
      await this.persistence.updateStage(stageRecord.id, {
        status: "COMPLETED",
        completedAt: new Date(),
        duration,
        outputData: { _artifactKey: outputKey },
        metrics: result.metrics as any,
        embeddingInfo: result.embeddings as any,
      });

      this.emit("stage:completed", {
        stageId: stage.id,
        stageName: stage.name,
        duration,
      });

      // Trace log stage output
      const outputStr = JSON.stringify(validatedOutput);
      logger.debug(`Stage ${stage.name} output`, {
        stageId: stage.id,
        duration,
        output:
          outputStr.substring(0, 1000) + (outputStr.length > 1000 ? "..." : ""),
        metrics: result.metrics,
      });

      this.log("INFO", `Stage completed: ${stage.name} in ${duration}ms`);

      return result;
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      const errorStack = error instanceof Error ? error.stack : undefined;

      // Trace log stage error with full details
      logger.error(`Stage ${stage.name} error`, {
        stageId: stage.id,
        error: errorMessage,
        stack: errorStack,
        duration: Date.now() - startTime,
      });

      await this.persistence.updateStageByRunAndStageId(
        this.workflowRunId,
        stage.id,
        {
          status: "FAILED",
          completedAt: new Date(),
          errorMessage,
        },
      );

      this.emit("stage:failed", {
        stageId: stage.id,
        stageName: stage.name,
        error: errorMessage,
      });

      this.log("ERROR", `Stage failed: ${stage.name} - ${errorMessage}`);

      throw error;
    }
  }

  /**
   * Load resume state from database
   */
  private async loadResumeState(): Promise<{
    lastCompletedGroup: number;
    lastOutput: any;
  } | null> {
    // First check if we have a SUSPENDED stage that's ready to resume
    const suspendedStage =
      await this.persistence.getFirstSuspendedStageReadyToResume(
        this.workflowRunId,
      );

    logger.debug(
      `loadResumeState - found suspended stage: ${suspendedStage?.stageId} ${suspendedStage?.status} ${suspendedStage?.nextPollAt} ${suspendedStage?.suspendedState ? "(has suspendedState)" : "(no suspendedState)"}`,
    );

    if (suspendedStage) {
      // Resume from the suspended stage using its stored input
      logger.debug(
        `Resuming from suspended stage ${suspendedStage.stageId}, group ${suspendedStage.executionGroup}`,
      );
      let lastOutput = suspendedStage.inputData;

      // Fallback: If inputData is missing, we need to get the proper input for this stage
      if (!lastOutput) {
        if (suspendedStage.executionGroup === 1) {
          // First group: use workflow run input
          logger.warn(
            `Suspended stage ${suspendedStage.stageId} has no inputData. Falling back to workflow run input.`,
          );
          const run = await this.persistence.getRun(this.workflowRunId);
          lastOutput = run?.input as any;
        } else {
          // Later groups: need to load output from the previous stage (the completed one before this)
          logger.warn(
            `Suspended stage ${suspendedStage.stageId} (group ${suspendedStage.executionGroup}) has no inputData. Loading previous stage output.`,
          );

          const previousCompleted =
            await this.persistence.getLastCompletedStageBefore(
              this.workflowRunId,
              suspendedStage.executionGroup,
            );

          if (previousCompleted) {
            const outputData = previousCompleted.outputData as any;

            if (outputData?._artifactKey) {
              lastOutput = await this.persistence.loadArtifact(
                this.workflowRunId,
                outputData._artifactKey,
              );
              logger.debug(
                `Loaded previous stage output from artifact: ${outputData._artifactKey}`,
              );
            } else if (outputData) {
              lastOutput = outputData;
              logger.debug(`Using previous stage outputData directly`);
            }
          }

          if (!lastOutput) {
            throw new Error(
              `Cannot resume suspended stage ${suspendedStage.stageId}: no inputData stored and no previous stage output found`,
            );
          }
        }
      }

      return {
        lastCompletedGroup: suspendedStage.executionGroup - 1,
        lastOutput,
      };
    }

    // Otherwise, find the last completed stage
    logger.debug(`No suspended stage found, looking for last completed stage`);

    // Also check if there's a failed stage - we want to resume from AFTER it
    const failedStage = await this.persistence.getFirstFailedStage(
      this.workflowRunId,
    );

    if (failedStage) {
      logger.debug(
        `Found failed stage: ${failedStage.stageId} in group ${failedStage.executionGroup}`,
      );

      // Find the last COMPLETED stage before the failed one
      const lastCompletedBeforeFailed =
        await this.persistence.getLastCompletedStageBefore(
          this.workflowRunId,
          failedStage.executionGroup,
        );

      if (lastCompletedBeforeFailed) {
        logger.debug(
          `Found last completed stage before failure: ${lastCompletedBeforeFailed.stageId}`,
        );

        // Load output from last completed stage
        const outputData = lastCompletedBeforeFailed.outputData as any;
        let output: any;

        // New: Check if output is stored as artifact
        if (outputData?._artifactKey) {
          output = await this.persistence.loadArtifact(
            this.workflowRunId,
            outputData._artifactKey,
          );
        }
        // Fallback: Use outputData directly (old format)
        else if (outputData) {
          output = outputData;
        } else {
          throw new Error(
            `No output data found for stage ${lastCompletedBeforeFailed.stageId}`,
          );
        }

        // Delete the failed stage so it can be re-executed
        await this.persistence.deleteStage(failedStage.id);

        logger.debug(
          `Deleted failed stage ${failedStage.stageId} for re-execution`,
        );

        return {
          lastCompletedGroup: lastCompletedBeforeFailed.executionGroup,
          lastOutput: output,
        };
      }
    }

    // No failed stage or no completed stages before it - look for any completed stages
    const stages = await this.persistence.getStagesByRun(this.workflowRunId, {
      status: "COMPLETED",
      orderBy: "desc",
    });

    if (stages.length === 0) {
      return null;
    }

    const lastStage = stages[0];
    logger.debug(`Found last completed stage: ${lastStage.stageId}`);

    // Load output - check artifact key (new), R2 key (legacy), or direct data (old)
    const outputData = lastStage.outputData as any;

    let output: any;
    // New: Check if output is stored as artifact
    if (outputData?._artifactKey) {
      output = await this.persistence.loadArtifact(
        this.workflowRunId,
        outputData._artifactKey,
      );
    }
    // Fallback: output stored directly in database (old format)
    else if (outputData) {
      output = outputData;
    } else {
      throw new Error(`No output data found for stage ${lastStage.stageId}`);
    }

    return {
      lastCompletedGroup: lastStage.executionGroup,
      lastOutput: output,
    };
  }

  /**
   * Load workflow context from all completed stages
   * This rebuilds the workflowContext object so resumed stages can access previous outputs
   */
  private async loadWorkflowContext(): Promise<Record<string, unknown>> {
    const completedStages = await this.persistence.getStagesByRun(
      this.workflowRunId,
      {
        status: "COMPLETED",
        orderBy: "asc",
      },
    );

    const workflowContext: Record<string, unknown> = {};

    for (const stage of completedStages) {
      // Load output - check artifact key (new), R2 key (legacy), or direct data (old)
      const outputData = stage.outputData as any;

      let output: any;
      // New: Check if output is stored as artifact
      if (outputData?._artifactKey) {
        output = await this.persistence.loadArtifact(
          this.workflowRunId,
          outputData._artifactKey,
        );
      }
      // Fallback: output stored directly in database (old format)
      else if (outputData) {
        output = outputData;
      } else {
        logger.warn(
          `No output data found for completed stage ${stage.stageId}`,
        );
        continue;
      }

      // Add to workflow context using stageId as key
      workflowContext[stage.stageId] = output;
      logger.debug(
        `Loaded output for stage ${stage.stageId} into workflowContext`,
      );
    }

    logger.debug(
      `Rebuilt workflowContext with ${Object.keys(workflowContext).length} stage outputs`,
    );

    return workflowContext;
  }

  /**
   * Load state for rerunning from a specific stage.
   * Requires that previous stages have already been executed and their outputs persisted.
   *
   * @param stageId - The stage ID to start execution from
   * @returns The execution group, input data, and workflow context
   */
  private async loadFromStageState(stageId: string): Promise<{
    executionGroup: number;
    input: any;
    workflowContext: Record<string, unknown>;
  }> {
    // Find the stage in the workflow definition
    const stage = this.workflow.getStage(stageId);
    if (!stage) {
      throw new Error(
        `Stage "${stageId}" not found in workflow "${this.workflow.id}"`,
      );
    }

    // Find the execution group for this stage
    const executionPlan = this.workflow.getExecutionPlan();
    let executionGroup = -1;

    for (const group of executionPlan) {
      const foundInGroup = group.find((node) => node.stage.id === stageId);
      if (foundInGroup) {
        executionGroup = foundInGroup.executionGroup;
        break;
      }
    }

    if (executionGroup === -1) {
      throw new Error(
        `Stage "${stageId}" not found in execution plan for workflow "${this.workflow.id}"`,
      );
    }

    logger.debug(
      `loadFromStageState: stage "${stageId}" is in execution group ${executionGroup}`,
    );

    // Load input for this stage
    let input: any;

    if (executionGroup === 1) {
      // First group: use the original workflow input
      const run = await this.persistence.getRun(this.workflowRunId);
      if (!run) {
        throw new Error(`WorkflowRun "${this.workflowRunId}" not found`);
      }
      input = run.input;
      logger.debug(`Using workflow input for first group stage`);
    } else {
      // Later groups: load output from the previous group's stage(s)
      const previousGroup = executionGroup - 1;

      // Find the last completed stage in the previous group
      const previousCompleted =
        await this.persistence.getLastCompletedStageBefore(
          this.workflowRunId,
          executionGroup,
        );

      if (!previousCompleted) {
        throw new Error(
          `Cannot rerun from stage "${stageId}": no completed stages found before execution group ${executionGroup}. ` +
            `You must run the workflow from the beginning first.`,
        );
      }

      // Load the output from the previous stage
      const outputData = previousCompleted.outputData as any;

      if (outputData?._artifactKey) {
        input = await this.persistence.loadArtifact(
          this.workflowRunId,
          outputData._artifactKey,
        );
        logger.debug(`Loaded input from artifact: ${outputData._artifactKey}`);
      } else if (outputData) {
        input = outputData;
        logger.debug(
          `Using outputData directly from stage ${previousCompleted.stageId}`,
        );
      } else {
        throw new Error(
          `Cannot rerun from stage "${stageId}": no output data found for previous stage "${previousCompleted.stageId}"`,
        );
      }
    }

    // Load workflow context from all completed stages before this group
    // But only include stages from groups BEFORE the target group
    const completedStages = await this.persistence.getStagesByRun(
      this.workflowRunId,
      {
        status: "COMPLETED",
        orderBy: "asc",
      },
    );

    const workflowContext: Record<string, unknown> = {};

    for (const completedStage of completedStages) {
      // Only include stages from groups before the target group
      if (completedStage.executionGroup >= executionGroup) {
        continue;
      }

      const outputData = completedStage.outputData as any;
      let output: any;

      if (outputData?._artifactKey) {
        output = await this.persistence.loadArtifact(
          this.workflowRunId,
          outputData._artifactKey,
        );
      } else if (outputData) {
        output = outputData;
      } else {
        logger.warn(
          `No output data found for completed stage ${completedStage.stageId}`,
        );
        continue;
      }

      workflowContext[completedStage.stageId] = output;
      logger.debug(
        `Loaded output for stage ${completedStage.stageId} into workflowContext`,
      );
    }

    // Delete any existing stage records for this stage and later stages
    // so they can be re-executed fresh
    const stagesToDelete = await this.persistence.getStagesByRun(
      this.workflowRunId,
      {},
    );

    for (const stageToDelete of stagesToDelete) {
      if (stageToDelete.executionGroup >= executionGroup) {
        await this.persistence.deleteStage(stageToDelete.id);
        logger.debug(
          `Deleted stage ${stageToDelete.stageId} (group ${stageToDelete.executionGroup}) for re-execution`,
        );
      }
    }

    return {
      executionGroup,
      input,
      workflowContext,
    };
  }

  /**
   * Create a minimal storage shim for context.storage (for API compatibility).
   * Stage implementations should not rely on this - it may be removed in future.
   */
  private createStorageShim(): StageStorage {
    const persistence = this.persistence;
    const workflowRunId = this.workflowRunId;
    const workflowType = this.workflowType;
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

  /**
   * Get aggregated statistics for the workflow run
   */
  private async getAggregatedStats(): Promise<{
    totalCost: number;
    totalTokens: number;
  }> {
    // Use the AI logger to get stats
    // Topic convention: "workflow.{workflowRunId}.*"
    const stats = await this.aiLogger.getStats(
      `workflow.${this.workflowRunId}`,
    );

    return {
      totalCost: stats.totalCost,
      totalTokens: stats.totalInputTokens + stats.totalOutputTokens,
    };
  }

  /**
   * Log a message with automatic database persistence
   */
  private log(
    level: LogLevel,
    message: string,
    meta?: Record<string, unknown>,
  ) {
    this.emit("log", { level, message, meta });

    // Also save to database (async, don't wait)
    this.persistence
      .createLog({
        workflowRunId: this.workflowRunId,
        level: level as PersistenceLogLevel,
        message,
        metadata: meta,
      })
      .catch((err) => logger.error("Failed to persist log:", err));
  }
}
