/**
 * Workflow Runtime - Unified API for workflow execution
 *
 * The main entry point for the workflow engine. Handles everything:
 * - Creating new workflow runs (with validation)
 * - Polling for pending workflows → enqueuing first stage
 * - Processing jobs from the queue (executing stages)
 * - Polling for suspended stages → resuming execution
 * - Transitioning workflows between stages
 */

import os from "node:os";
import type {
  WorkflowPersistence,
  JobQueue,
  WorkflowRunRecord,
  AICallLogger,
} from "../persistence";
import type { WorkflowRegistry } from "../core/stage-executor";
import { StageExecutor } from "../core/stage-executor";
import { WorkflowExecutor } from "../core/executor";
import type { StageStorage } from "../core/stage";
import { workflowEventBus } from "../core/workflow-event-bus.server";
import { createLogger } from "../utils/logger";

import {
  createAIHelper as baseCreateAIHelper,
  type AIHelper,
  type LogContext,
} from "../ai/ai-helper";

const logger = createLogger("Runtime");

// ============================================================================
// Types
// ============================================================================

export interface WorkflowRuntimeConfig {
  /** Persistence implementation */
  persistence: WorkflowPersistence;
  /** Job queue implementation */
  jobQueue: JobQueue;
  /** Workflow registry */
  registry: WorkflowRegistry;
  /** AI call logger for createAIHelper */
  aiCallLogger?: AICallLogger;
  /** Interval between poll cycles in milliseconds (default: 10000) */
  pollIntervalMs?: number;
  /** Interval between job dequeue attempts in milliseconds (default: 1000) */
  jobPollIntervalMs?: number;
  /** Worker ID (default: auto-generated) */
  workerId?: string;
  /** Stale job threshold in milliseconds (default: 60000) */
  staleJobThresholdMs?: number;
  /** Function to determine workflow priority */
  getWorkflowPriority?: (workflowId: string) => number;
}

export interface CreateRunOptions {
  workflowId: string;
  input: Record<string, unknown>;
  config?: Record<string, unknown>;
  priority?: number;
  /** Domain-specific metadata */
  metadata?: Record<string, unknown>;
}

export interface CreateRunResult {
  workflowRunId: string;
}

// ============================================================================
// WorkflowRuntime Class
// ============================================================================

export class WorkflowRuntime {
  private isPolling = false;
  private isProcessingJobs = false;
  private isRunning = false;
  private pollIntervalMs: number;
  private jobPollIntervalMs: number;
  private staleJobThresholdMs: number;
  private workerId: string;
  private persistence: WorkflowPersistence;
  private jobQueue: JobQueue;
  private registry: WorkflowRegistry;
  private aiCallLogger?: AICallLogger;
  private getWorkflowPriority?: (workflowId: string) => number;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private stageExecutor: StageExecutor;
  private jobsProcessed = 0;

  constructor(config: WorkflowRuntimeConfig) {
    this.pollIntervalMs = config.pollIntervalMs ?? 10000; // 10s default
    this.jobPollIntervalMs = config.jobPollIntervalMs ?? 1000; // 1s default
    this.staleJobThresholdMs = config.staleJobThresholdMs ?? 60000; // 60s default
    this.workerId = config.workerId ?? `worker-${process.pid}-${os.hostname()}`;
    this.persistence = config.persistence;
    this.jobQueue = config.jobQueue;
    this.registry = config.registry;
    this.aiCallLogger = config.aiCallLogger;
    this.getWorkflowPriority = config.getWorkflowPriority;
    this.stageExecutor = new StageExecutor(
      this.registry,
      this.persistence,
      this.workerId,
    );
  }

  // ==========================================================================
  // AI Helper Factory
  // ==========================================================================

  /**
   * Create an AI helper bound to this runtime's logger
   * @param topic - Topic for logging (e.g., "workflow.abc123.stage.extraction")
   * @param logContext - Optional log context for persistence logging in batch operations
   */
  createAIHelper(topic: string, logContext?: LogContext): AIHelper {
    if (!this.aiCallLogger) {
      throw new Error(
        "[Runtime] AICallLogger not configured. Pass aiCallLogger in config.",
      );
    }
    return baseCreateAIHelper(topic, this.aiCallLogger, logContext);
  }

  /**
   * Create a LogContext for a workflow stage (for use with createAIHelper)
   * This enables batch operations to log to the workflow persistence.
   */
  createLogContext(workflowRunId: string, stageRecordId: string): LogContext {
    const persistence = this.persistence;
    return {
      workflowRunId,
      stageRecordId,
      createLog: (data) => persistence.createLog(data),
    };
  }

  // ==========================================================================
  // Lifecycle
  // ==========================================================================

  /**
   * Start the runtime as a full worker (processes jobs + polls)
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      logger.debug("Already running");
      return;
    }

    logger.info(`Starting worker ${this.workerId}`);
    logger.debug(
      `Poll interval: ${this.pollIntervalMs}ms, Job poll: ${this.jobPollIntervalMs}ms`,
    );

    this.isRunning = true;

    // Start orchestration polling
    this.pollTimer = setInterval(() => this.poll(), this.pollIntervalMs);
    this.poll(); // Immediate first poll

    // Start job processing loop
    this.processJobs();

    // Graceful shutdown
    process.on("SIGTERM", () => this.stop());
    process.on("SIGINT", () => this.stop());
  }

  /**
   * Stop the runtime
   */
  stop(): void {
    logger.info(`Stopping worker ${this.workerId}...`);
    this.isRunning = false;

    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }

    logger.info(`Stopped. Processed ${this.jobsProcessed} jobs.`);
  }

  // ==========================================================================
  // Create Run - The main API for starting workflows
  // ==========================================================================

  /**
   * Create a new workflow run with validation.
   * The runtime will pick it up on the next poll cycle and start execution.
   */
  async createRun(options: CreateRunOptions): Promise<CreateRunResult> {
    const { workflowId, input, config = {}, priority, metadata } = options;

    // 1. Get workflow definition from registry
    const workflow = this.registry.getWorkflow(workflowId);
    if (!workflow) {
      throw new Error(`Workflow ${workflowId} not found in registry`);
    }

    // 2. Validate input
    try {
      workflow.inputSchema.parse(input);
    } catch (error) {
      throw new Error(`Invalid workflow input: ${error}`);
    }

    // 3. Get default config and merge with provided
    const defaultConfig = workflow.getDefaultConfig?.() ?? {};
    const mergedConfig = { ...defaultConfig, ...config };

    // 4. Validate config
    const configValidation = workflow.validateConfig(mergedConfig);
    if (!configValidation.valid) {
      const errors = configValidation.errors
        .map((e) => `${e.stageId}: ${e.error}`)
        .join(", ");
      throw new Error(`Invalid workflow config: ${errors}`);
    }

    // 5. Calculate priority
    const effectivePriority =
      priority ?? this.getWorkflowPriority?.(workflowId) ?? 5;

    // 6. Create WorkflowRun record (status: PENDING)
    const workflowRun = await this.persistence.createRun({
      workflowId,
      workflowName: workflow.name,
      workflowType: workflowId,
      input,
      config: mergedConfig,
      priority: effectivePriority,
      metadata,
    });

    logger.debug(`Created WorkflowRun ${workflowRun.id} for ${workflowId}`);

    return {
      workflowRunId: workflowRun.id,
    };
  }

  // ==========================================================================
  // Job Processing Loop
  // ==========================================================================

  /**
   * Process jobs from the queue
   */
  private async processJobs(): Promise<void> {
    // Clean up stale jobs on startup
    await this.jobQueue.releaseStaleJobs(this.staleJobThresholdMs);
    let lastStaleCheck = Date.now();
    let lastLogTime = Date.now();

    while (this.isRunning) {
      try {
        const now = Date.now();

        // Periodic stale job cleanup
        if (now - lastStaleCheck > this.staleJobThresholdMs) {
          await this.jobQueue.releaseStaleJobs(this.staleJobThresholdMs);
          lastStaleCheck = now;
        }

        // Periodic logging
        if (now - lastLogTime > 10000) {
          logger.debug(
            `Worker ${this.workerId}: processed ${this.jobsProcessed} jobs`,
          );
          lastLogTime = now;
        }

        // Dequeue next job
        const job = await this.jobQueue.dequeue();
        if (!job) {
          await new Promise((r) => setTimeout(r, this.jobPollIntervalMs));
          continue;
        }

        const { jobId, workflowRunId, stageId, payload } = job;
        const config =
          (payload as { config?: Record<string, unknown> }).config || {};

        logger.debug(
          `Processing stage ${stageId} for workflow ${workflowRunId}`,
        );

        // Get workflow ID
        const workflowId = await this.getWorkflowId(workflowRunId);
        if (!workflowId) {
          await this.jobQueue.fail(jobId, "WorkflowRun not found", false);
          continue;
        }

        // Execute stage
        const result = await this.stageExecutor.execute({
          workflowRunId,
          stageId,
          workflowId,
          config,
        });

        this.jobsProcessed++;

        // Handle result
        if (result.type === "completed") {
          logger.debug(`Job completed`, {
            jobId,
            workflowRunId,
            stageId,
          });
          await this.jobQueue.complete(jobId);
          await this.transitionWorkflow(workflowRunId);
        } else if (result.type === "suspended") {
          const nextPollAt = result.nextPollAt || new Date(Date.now() + 60000);
          logger.debug(`Job suspended`, {
            jobId,
            workflowRunId,
            stageId,
            nextPollAt: nextPollAt.toISOString(),
          });
          await this.jobQueue.suspend(jobId, nextPollAt);
        } else if (result.type === "failed") {
          const canRetry = job.attempt < 3;
          logger.debug(`Job failed`, {
            jobId,
            workflowRunId,
            stageId,
            error: result.error,
            attempt: job.attempt,
            canRetry,
          });
          await this.jobQueue.fail(
            jobId,
            result.error || "Unknown error",
            canRetry,
          );
          if (!canRetry) {
            await this.persistence.updateRun(workflowRunId, {
              status: "FAILED",
            });
          }
        }
      } catch (error) {
        logger.error("Error in job loop:", error);
        await new Promise((r) => setTimeout(r, 5000));
      }
    }
  }

  private async getWorkflowId(runId: string): Promise<string | null> {
    const run = await this.persistence.getRun(runId);
    return run?.workflowId ?? null;
  }

  // ==========================================================================
  // Polling - Orchestration
  // ==========================================================================

  /**
   * Poll for pending workflows and suspended stages
   */
  private async poll(): Promise<void> {
    if (this.isPolling) return;
    this.isPolling = true;

    try {
      await this.pollPendingWorkflows();
      await this.pollSuspendedStages();
    } finally {
      this.isPolling = false;
    }
  }

  /**
   * Poll for pending workflows and enqueue their first stage.
   * Uses claimNextPendingRun() for zero-contention claiming with FOR UPDATE SKIP LOCKED.
   */
  private async pollPendingWorkflows(): Promise<void> {
    // Keep claiming workflows until none are left
    // Each worker gets a different workflow - no race conditions
    let claimedCount = 0;

    while (true) {
      // Atomically find and claim the next pending workflow
      // Uses FOR UPDATE SKIP LOCKED - workers never contend for the same row
      const run = await this.persistence.claimNextPendingRun();
      if (!run) {
        // No more pending workflows available
        break;
      }

      claimedCount++;
      logger.debug(`Claimed workflow ${run.id}`);

      try {
        const workflow = this.registry.getWorkflow(run.workflowId);
        if (!workflow) {
          await this.persistence.updateRun(run.id, { status: "FAILED" });
          continue;
        }

        const firstStages = workflow.getStagesInExecutionGroup(1);
        if (firstStages.length === 0) {
          await this.persistence.updateRun(run.id, { status: "FAILED" });
          continue;
        }

        await this.enqueueExecutionGroup(run, workflow, 1);
        // Note: status already set to RUNNING by claimNextPendingRun
        logger.debug(`Started workflow ${run.id}`);
      } catch (error) {
        logger.error(`Error starting workflow ${run.id}:`, error);
        await this.persistence.updateRun(run.id, { status: "FAILED" });
      }
    }

    if (claimedCount > 0) {
      logger.debug(`Processed ${claimedCount} pending workflow(s)`);
    }
  }

  /**
   * Poll suspended stages and resume if ready (public for manual triggering)
   */
  async pollSuspendedStages(): Promise<void> {
    const suspendedStages = await this.persistence.getSuspendedStages(
      new Date(),
    );
    if (suspendedStages.length === 0) return;

    logger.debug(`Found ${suspendedStages.length} suspended stages`);

    for (const stageRecord of suspendedStages) {
      try {
        const workflowRun = await this.persistence.getRun(
          stageRecord.workflowRunId,
        );
        if (!workflowRun) continue;
        await this.checkAndResume({ ...stageRecord, workflowRun });
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        logger.error(`Error checking stage ${stageRecord.stageId}:`, error);

        // Check if this is a transient error that should be retried
        const isTransientError =
          errorMessage.includes("fetch failed") ||
          errorMessage.includes("ECONNREFUSED") ||
          errorMessage.includes("ETIMEDOUT") ||
          errorMessage.includes("network") ||
          errorMessage.includes("ENOTFOUND") ||
          errorMessage.includes("socket hang up");

        if (isTransientError) {
          // Reschedule the check instead of failing the workflow
          logger.debug(
            `Transient error for stage ${stageRecord.stageId}, will retry on next poll`,
          );
          const nextPollAt = new Date(Date.now() + this.pollIntervalMs);
          await this.persistence
            .updateStage(stageRecord.id, { nextPollAt })
            .catch((err) => logger.error("Failed to update stage:", err));
        } else {
          // Permanent error - mark as failed
          await this.markStageFailed(
            stageRecord.id,
            `Runtime error: ${errorMessage}`,
          ).catch((err) => logger.error("Failed to mark stage failed:", err));
          await this.persistence
            .updateRun(stageRecord.workflowRunId, { status: "FAILED" })
            .catch((err) => logger.error("Failed to update run:", err));
        }
      }
    }
  }

  /**
   * Transition a workflow to its next state (public for external calls)
   */
  async transitionWorkflow(workflowRunId: string): Promise<void> {
    const workflowRun = await this.persistence.getRun(workflowRunId);
    if (!workflowRun) return;

    if (["FAILED", "CANCELLED", "COMPLETED"].includes(workflowRun.status))
      return;

    const workflow = this.registry.getWorkflow(workflowRun.workflowId);
    if (!workflow) return;

    const stages = await this.persistence.getStagesByRun(workflowRunId);

    if (stages.length === 0) {
      await this.enqueueExecutionGroup(workflowRun, workflow, 1);
      return;
    }

    const activeStage = stages.find((s) =>
      ["RUNNING", "PENDING", "SUSPENDED"].includes(s.status),
    );
    if (activeStage) return;

    const maxGroup = Math.max(...stages.map((s) => s.executionGroup));
    const nextStages = workflow.getStagesInExecutionGroup(maxGroup + 1);

    if (nextStages.length > 0) {
      await this.enqueueExecutionGroup(workflowRun, workflow, maxGroup + 1);
    } else {
      await this.completeWorkflow(workflowRun);
    }
  }

  // ==========================================================================
  // Private helpers
  // ==========================================================================

  private async checkAndResume(stageRecord: any): Promise<void> {
    const { workflowRun } = stageRecord;

    const workflow = this.registry.getWorkflow(workflowRun.workflowId);
    if (!workflow) {
      await this.markStageFailed(
        stageRecord.id,
        "Workflow definition not found",
      );
      return;
    }

    const stageDef = workflow.getStage(stageRecord.stageId);
    if (!stageDef || !stageDef.checkCompletion) {
      await this.markStageFailed(
        stageRecord.id,
        "Stage does not support batch completion",
      );
      return;
    }

    const storage = this.createStorageShim(
      workflowRun.id,
      workflowRun.workflowType,
    );

    const logFn = async (
      level: "DEBUG" | "INFO" | "WARN" | "ERROR",
      message: string,
    ) => {
      await this.persistence
        .createLog({
          workflowRunId: workflowRun.id,
          workflowStageId: stageRecord.id,
          level,
          message: `[Runtime] ${message}`,
        })
        .catch((err) => logger.error("Failed to create log:", err));
    };

    const completionResult = await stageDef.checkCompletion(
      stageRecord.suspendedState,
      {
        workflowRunId: workflowRun.id,
        stageId: stageRecord.stageId,
        stageRecordId: stageRecord.id, // For LogContext in AIHelper
        config: stageRecord.config || {},
        log: logFn,
        onLog: logFn,
        storage,
      },
    );

    logger.debug("Stage completion result", completionResult);

    if (completionResult.ready) {
      if (completionResult.output !== undefined) {
        const validatedOutput = stageDef.outputSchema.parse(
          completionResult.output,
        );
        const outputKey = await this.persistence.saveStageOutput(
          workflowRun.id,
          workflowRun.workflowType,
          stageRecord.stageId,
          validatedOutput,
        );

        await this.persistence.updateStage(stageRecord.id, {
          status: "COMPLETED",
          completedAt: new Date(),
          duration: Date.now() - new Date(stageRecord.startedAt).getTime(),
          outputData: { _artifactKey: outputKey } as any,
          metrics: completionResult.metrics as any,
          embeddingInfo: completionResult.embeddings as any,
        });
      } else {
        await this.persistence.updateStage(stageRecord.id, {
          nextPollAt: null,
        });
      }
      await this.resumeWorkflow(workflowRun, workflow);
    } else if (completionResult.error) {
      await this.markStageFailed(stageRecord.id, completionResult.error);
      await this.persistence.updateRun(workflowRun.id, { status: "FAILED" });
      workflowEventBus.emitWorkflowEvent(workflowRun.id, "workflow:failed", {
        workflowRunId: workflowRun.id,
        error: completionResult.error,
      });
    } else {
      const nextPollAt = new Date(
        Date.now() + (completionResult.nextCheckIn || this.pollIntervalMs),
      );
      await this.persistence.updateStage(stageRecord.id, { nextPollAt });
    }
  }

  private async resumeWorkflow(workflowRun: any, workflow: any): Promise<void> {
    try {
      await this.persistence.updateRun(workflowRun.id, { status: "RUNNING" });
      const executor = new WorkflowExecutor(
        workflow,
        workflowRun.id,
        workflowRun.workflowType,
        {
          persistence: this.persistence,
          aiLogger: this.aiCallLogger,
        },
      );
      await executor.execute(workflowRun.input, workflowRun.config || {}, {
        resume: true,
      });
    } catch (error) {
      await this.persistence.updateRun(workflowRun.id, { status: "FAILED" });
      workflowEventBus.emitWorkflowEvent(workflowRun.id, "workflow:failed", {
        workflowRunId: workflowRun.id,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Create a minimal storage shim for context.storage (for API compatibility).
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

  private async markStageFailed(
    stageId: string,
    errorMessage: string,
  ): Promise<void> {
    await this.persistence.updateStage(stageId, {
      status: "FAILED",
      completedAt: new Date(),
      errorMessage,
    });
  }

  private async enqueueExecutionGroup(
    workflowRun: any,
    workflow: any,
    groupIndex: number,
  ) {
    const stages = workflow.getStagesInExecutionGroup(groupIndex);
    if (stages.length === 0) return;

    for (const stage of stages) {
      await this.persistence.createStage({
        workflowRunId: workflowRun.id,
        stageId: stage.id,
        stageName: stage.name,
        stageNumber: workflow.getStageIndex(stage.id) + 1,
        executionGroup: groupIndex,
        status: "PENDING",
        config: (workflowRun.config as any)?.[stage.id] || {},
      });
    }

    await this.jobQueue.enqueueParallel(
      stages.map((stage: any) => ({
        workflowRunId: workflowRun.id,
        stageId: stage.id,
        priority: workflowRun.priority,
        payload: { config: workflowRun.config || {} },
      })),
    );
  }

  private async completeWorkflow(workflowRun: any) {
    const stages = await this.persistence.getStagesByRun(workflowRun.id);

    let totalCost = 0,
      totalTokens = 0;
    for (const stage of stages) {
      const metrics = stage.metrics as any;
      if (metrics) {
        totalCost += metrics.cost || 0;
        totalTokens += (metrics.inputTokens || 0) + (metrics.outputTokens || 0);
      }
    }

    await this.persistence.updateRun(workflowRun.id, {
      status: "COMPLETED",
      completedAt: new Date(),
      duration: Date.now() - new Date(workflowRun.createdAt).getTime(),
      totalCost,
      totalTokens,
    });

    workflowEventBus.emitWorkflowEvent(workflowRun.id, "workflow:completed", {
      workflowRunId: workflowRun.id,
      output: workflowRun.output || {},
      duration: Date.now() - new Date(workflowRun.createdAt).getTime(),
      totalCost,
      totalTokens,
    });

    logger.debug(`Workflow ${workflowRun.id} completed`);
  }
}

/**
 * Factory function to create a WorkflowRuntime instance
 */
export function createWorkflowRuntime(
  config: WorkflowRuntimeConfig,
): WorkflowRuntime {
  return new WorkflowRuntime(config);
}
