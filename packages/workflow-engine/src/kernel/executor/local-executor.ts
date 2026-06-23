/**
 * LocalExecutor — default ActivityExecutor implementation.
 *
 * Runs stage execute() in the current process. This is an exact extraction
 * of the Phase-2 body from handlers/job-execute.ts; behavior is byte-for-byte
 * identical to the pre-refactor handler.
 *
 * Logs are written live (fire-and-forget createLog) during execution, so
 * this executor returns logs: [] — the handler does not need to persist them.
 */

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

        // Parse config (same try/catch fallback as job-execute.ts:194-200)
        let stageConfig: unknown = (config as any)[stageId] || {};
        try {
          if (stageDef.configSchema) {
            stageConfig = stageDef.configSchema.parse(stageConfig);
          }
        } catch {
          // Fall back to raw config on parse failure
        }

        // Build log function — fire-and-forget, written live during execute
        // (identical to job-execute.ts:203-217)
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

        // Build annotate function — pushes to buffer, same normalizeAnnotateArgs
        // shaping as job-execute.ts:224-246
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

        // Build context (identical to job-execute.ts:249-274)
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
        return {
          error,
          progress: progressEvents,
          annotations: annotationBuffer.flush(),
          logs: [],
        };
      }
    },
  };
}
