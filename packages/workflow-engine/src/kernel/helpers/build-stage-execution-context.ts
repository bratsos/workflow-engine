import { forwardingProxy } from "../../ai/provider-diagnostics.js";
import type {
  AIHelper,
  LogContext,
  StageAIHelperOptions,
} from "../../ai/types.js";
import { AICallWriteTracker, trackedWrite } from "../../ai/write-tracker.js";
import type { StageContext } from "../../core/stage.js";
import { neverAbortingSignal } from "../../core/steps.js";
import type { ProgressUpdate } from "../../core/types.js";
import type { Workflow } from "../../core/workflow.js";
import type {
  AICallLogger,
  CreateAICallInput,
  CreateAnnotationInput,
} from "../../persistence/interface.js";
import { AIServicesNotConfiguredError } from "../errors.js";
import type { KernelEvent } from "../events.js";
import type { ActivityRunInput, ExecutorDeps } from "../ports.js";
import {
  createAnnotationBuffer,
  normalizeAnnotateArgs,
} from "./annotation-buffer.js";
import { writeBatchWarn } from "./batch-warn.js";
import { createStorageShim } from "./create-storage-shim.js";
import { toErrorMessage } from "./error-message.js";
import { createStepApi } from "./step-api.js";

export interface BuiltStageExecutionContext {
  context: StageContext<any, any, any>;
  progressEvents: KernelEvent[];
  annotationBuffer: ReturnType<typeof createAnnotationBuffer>;
}

/** Define lazy AI accessors shared by execute and checkCompletion contexts. */
export function defineLazyAIContext<T extends object>(
  target: T,
  params: {
    workflowRunId: string;
    stageId: string;
    stageRecordId?: string;
    tenantId?: string;
    labels?: Record<string, string>;
  },
  deps: ExecutorDeps,
): T & { readonly ai: AIHelper; readonly aiLogger: AICallLogger } {
  let helper: AIHelper | undefined;
  const topic = `workflow.${params.workflowRunId}.stage.${params.stageId}`;
  const stageRecordId = params.stageRecordId ?? params.stageId;

  // Rows keep the text policy and attribution of whatever built them. Every
  // row names this run, so erasing the run finds it; the stage fills only the
  // tenant and labels a row lacks, under the row's own. Every other member is
  // the configured logger's own, bound to it.
  const stamp = (call: CreateAICallInput): CreateAICallInput => ({
    ...call,
    workflowRunId: params.workflowRunId,
    tenantId: call.tenantId ?? params.tenantId,
    labels:
      params.labels || call.labels
        ? { ...params.labels, ...call.labels }
        : undefined,
  });
  const overriding = (logger: AICallLogger, own: Partial<AICallLogger>) =>
    forwardingProxy(logger, (key, value) =>
      Object.hasOwn(own, key) ? own[key as keyof AICallLogger] : value,
    );
  let scopedLogger: AICallLogger | undefined;
  const loggerForRun = (logger: AICallLogger): AICallLogger =>
    (scopedLogger ??= overriding(logger, {
      logCall: (call) => logger.logCall(stamp(call)),
      logBatchResults: (batchId, calls) =>
        logger.logBatchResults(batchId, calls.map(stamp)),
    }));
  // ctx.aiLogger stores direct writes as given, and its flush covers them
  // from the call until they settle.
  let stageLogger: AICallLogger | undefined;
  const directLogger = (logger: AICallLogger): AICallLogger => {
    const writes = new AICallWriteTracker();
    return overriding(logger, {
      logCall: (call) => trackedWrite(writes, () => logger.logCall(call)),
      logBatchResults: (batchId, calls) =>
        trackedWrite(writes, () => logger.logBatchResults(batchId, calls)),
      flush: (options) => writes.flush(options),
    });
  };

  const configured = () => {
    const services = deps.services;
    if (!services?.aiLogger || !services.ai) {
      throw new AIServicesNotConfiguredError();
    }
    return {
      ai: services.ai,
      aiLogger: loggerForRun(services.aiLogger),
    };
  };

  const logContext: LogContext = {
    workflowRunId: params.workflowRunId,
    stageRecordId,
    createLog: (data) => deps.persistence.createLog(data),
  };

  const options: StageAIHelperOptions = {
    attribution: {
      tenantId: params.tenantId,
      labels: params.labels,
      workflowRunId: params.workflowRunId,
    },
  };
  const getHelper = (): AIHelper => {
    if (!helper) {
      const services = configured();
      helper = services.ai(
        topic,
        services.aiLogger,
        logContext,
        undefined,
        options,
      );
    }
    return helper;
  };

  Object.defineProperties(target, {
    ai: {
      enumerable: true,
      configurable: true,
      get: getHelper,
    },
    aiLogger: {
      enumerable: true,
      configurable: true,
      get: () => (stageLogger ??= directLogger(configured().aiLogger)),
    },
  });

  return target as T & {
    readonly ai: AIHelper;
    readonly aiLogger: AICallLogger;
  };
}

/**
 * Builds the complete execute context used by both first execution and
 * durable replay. Keeping validation, logging, annotations, storage, and
 * step construction here makes replay semantically identical to execution.
 */
export function buildStageExecutionContext(
  input: ActivityRunInput,
  deps: ExecutorDeps,
): BuiltStageExecutionContext {
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
  const abortSignal = input.abortSignal ?? neverAbortingSignal();

  const progressEvents: KernelEvent[] = [];
  const annotationBuffer = createAnnotationBuffer();

  const logFn = (
    level: "DEBUG" | "INFO" | "WARN" | "ERROR",
    message: string,
    meta?: Record<string, unknown>,
  ): void => {
    void deps.persistence
      .createLog({
        workflowRunId,
        workflowStageId: stageRecordId,
        level,
        message,
        metadata: meta,
      })
      .catch(() => {});
  };

  const validatedInput = stageDef.inputSchema.parse(rawInput);
  let stageConfig: unknown = config[stageId] || {};
  try {
    if (stageDef.configSchema) {
      stageConfig = stageDef.configSchema.parse(stageConfig);
    }
  } catch (configError) {
    // Preserve the existing executor behavior: config validation is logged,
    // then the raw config is supplied to the stage.
    void logFn(
      "WARN",
      `Stage ${stageId} config failed schema validation; falling back to raw config`,
      { error: toErrorMessage(configError) },
    );
  }

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

  const context = {
    workflowRunId,
    stageId,
    stageNumber,
    stageName: stageDef.name,
    stageRecordId,
    input: validatedInput,
    config: stageConfig,
    resumeState: resumeState as any,
    step: createStepApi({
      stageRecordId,
      stepLedger: deps.stepLedger,
      clock: deps.clock,
      abortSignal,
      onLog: (level, message) => void logFn(level, message),
      onBatchWarn: (message) =>
        void writeBatchWarn(deps.persistence, workflowRunId, message),
      onAnnotate: (key, value, opts) => annotateFn(key, value, opts),
      ai: () => context.ai,
    }),
    abortSignal,
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
    storage: createStorageShim(workflowRunId, workflowType, deps),
    workflowContext,
  } as StageContext<any, any, any>;

  defineLazyAIContext(context, input, deps);

  return { context, progressEvents, annotationBuffer };
}

/** Resolve the same stage input used by job.execute for a replay. */
export function resolveStageInput(
  workflow: Workflow<any, any>,
  stageId: string,
  workflowRun: { input: unknown },
  workflowContext: Record<string, unknown>,
): unknown {
  const groupIndex = workflow.getExecutionGroupIndex(stageId);
  if (groupIndex <= 1) return workflowRun.input;

  const previousGroupOutput = resolvePreviousExecutionGroupOutput(
    workflow,
    groupIndex - 1,
    workflowContext,
  );
  if (previousGroupOutput === undefined) {
    throw new Error(
      `Stage ${stageId} (execution group ${groupIndex}) is missing the ` +
        `output of execution group ${groupIndex - 1} — cannot resolve input`,
    );
  }
  return previousGroupOutput;
}

function resolvePreviousExecutionGroupOutput(
  workflow: Workflow<any, any>,
  groupIndex: number,
  workflowContext: Record<string, unknown>,
): unknown {
  const stages = workflow.getStagesInExecutionGroup(groupIndex);
  if (stages.length === 0) return undefined;
  if (stages.length === 1) return workflowContext[stages[0].id];

  const merged: Record<string, unknown> = {};
  for (const stage of stages) {
    if (workflowContext[stage.id] !== undefined) {
      merged[stage.id] = workflowContext[stage.id];
    }
  }
  return merged;
}
