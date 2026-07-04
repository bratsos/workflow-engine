/**
 * LocalExecutor — default ActivityExecutor implementation.
 *
 * Runs stage execute() in the current process.
 *
 * Logs are written live (fire-and-forget createLog) during execution, so
 * this executor returns logs: [] — the handler does not need to persist them.
 */

import { ZodError } from "zod";
import type { StageContext } from "../../core/stage.js";
import type { ProgressUpdate } from "../../core/types.js";
import type { CreateAnnotationInput } from "../../persistence/interface.js";
import type { KernelEvent } from "../events.js";
import {
  createAnnotationBuffer,
  createStorageShim,
  normalizeAnnotateArgs,
} from "../helpers/index.js";
import type {
  ActivityExecutor,
  ActivityRunInput,
  ActivityRunResult,
  ExecutorDeps,
} from "../ports.js";

export function createLocalExecutor(): ActivityExecutor {
  return {
    async run(
      input: ActivityRunInput,
      deps: ExecutorDeps,
    ): Promise<ActivityRunResult> {
      const {
        stageDef,
        workflowRunId,
        workflowType,
        stageId,
        stageNumber,
        stageRecordId,
        attempt,
        rawInput,
        config,
        resumeState,
        workflowContext,
      } = input;

      const progressEvents: KernelEvent[] = [];
      const annotationBuffer = createAnnotationBuffer();

      try {
        // Validate input
        const validatedInput = stageDef.inputSchema.parse(rawInput);

        // Parse config
        let stageConfig: unknown = (config as any)[stageId] || {};
        try {
          if (stageDef.configSchema) {
            stageConfig = stageDef.configSchema.parse(stageConfig);
          }
        } catch {
          // Fall back to raw config on parse failure
        }

        // Build log function — fire-and-forget, written live during execute
        const logFn = async (
          level: any,
          message: string,
          meta?: Record<string, unknown>,
        ) => {
          await deps.persistence
            .createLog({
              workflowRunId,
              workflowStageId: stageRecordId,
              level: level as any,
              message,
              metadata: meta,
            })
            .catch(() => {});
        };

        // Build annotate function — pushes to buffer
        const annotateFn = ((...args: unknown[]) => {
          const stageScopeFields = {
            workflowRunId,
            workflowStageRecordId: stageRecordId,
            attempt,
            scope: "stage" as const,
            scopeId: stageId,
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
        }) as StageContext<any, any, any>["annotate"];

        // Build context
        const context: StageContext<any, any, any> = {
          workflowRunId,
          stageId,
          stageNumber,
          stageName: stageDef.name,
          stageRecordId,
          input: validatedInput,
          config: stageConfig as any,
          resumeState: resumeState as any,
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
          annotate: annotateFn,
          storage: createStorageShim(workflowRunId, workflowType, deps as any),
          workflowContext,
        };

        // Execute the stage
        const result = await stageDef.execute(context);

        return {
          result,
          progress: progressEvents,
          annotations: annotationBuffer.flush(),
          logs: [],
        };
      } catch (e) {
        const error = e instanceof Error ? e.message : String(e);
        // Zod input/config validation errors are deterministic — retrying
        // the same rawInput will fail identically, so mark non-retryable
        // rather than let hosts burn retry attempts on a doomed job.
        const retryable = e instanceof ZodError ? false : undefined;
        return {
          error,
          errorName: e instanceof Error ? e.name : undefined,
          errorStack: e instanceof Error ? e.stack : undefined,
          retryable,
          progress: progressEvents,
          annotations: annotationBuffer.flush(),
          logs: [],
        };
      }
    },
  };
}
