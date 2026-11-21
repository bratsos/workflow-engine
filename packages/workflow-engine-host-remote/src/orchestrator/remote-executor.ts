/**
 * RemoteExecutor — ActivityExecutor port implementation.
 *
 * Blocking model: submit → poll until reported → map to ActivityRunResult.
 * Correct for short remote stages and in-process demos. Long stages (minutes+)
 * should use the Phase-1 proxy stage path (defineRemoteStage) which suspends.
 *
 * Lease-hold caveat: the kernel holds the job lease while this executor blocks.
 * For real deployments with long-running stages that caveat is material — the
 * Phase-1 proxy-stage pattern is the right tool there.
 */

import {
  type ActivityExecutor,
  type ActivityRunInput,
  type ActivityRunResult,
  type BufferedLog,
  type CreateAnnotationInput,
  type ExecutorDeps,
  type KernelEvent,
  normalizeAnnotateArgs,
  toErrorMessage,
} from "@bratsos/workflow-engine/kernel";
import {
  ActivityReportSchema,
  type BufferedProgress,
  type PollResponse,
} from "../protocol.js";
import type { OrchestratorTransport } from "../transport.js";

export interface RemoteExecutorOptions {
  /** How long the remote activity may run before deadline (ms). Default: 3_600_000 (1h). */
  maxWaitMs?: number;
  /** pollInterval passed to broker.submit — worker poll hint (ms). Default: 1_000. */
  pollIntervalMs?: number;
  /** How often we call transport.poll while waiting (ms). Default: 5. */
  pollEveryMs?: number;
}

const ZERO_METRICS = { startTime: 0, endTime: 0, duration: 0 };

export function createRemoteExecutor(
  transport: OrchestratorTransport,
  opts: RemoteExecutorOptions = {},
): ActivityExecutor {
  const pollIntervalMs = opts.pollIntervalMs ?? 1_000;
  const maxWaitMs = opts.maxWaitMs ?? 3_600_000;
  const pollEveryMs = opts.pollEveryMs ?? 5;

  return {
    async run(
      input: ActivityRunInput,
      deps: ExecutorDeps,
    ): Promise<ActivityRunResult> {
      const {
        stageDef,
        workflowRunId,
        stageId,
        stageName,
        stageNumber,
        stageRecordId,
        attempt,
        config,
        resumeState,
        workflowContext,
      } = input;

      // Parse stageConfig: the handler passes the WHOLE config map — index [stageId] ourselves
      const stageConfig: unknown =
        (config as Record<string, unknown>)[stageId] ?? {};
      let parsedConfig: unknown = stageConfig;
      try {
        if (stageDef.configSchema) {
          parsedConfig = stageDef.configSchema.parse(stageConfig);
        }
      } catch {
        // Fall back to raw stageConfig on parse failure
      }

      // Validate input
      let validatedInput: unknown;
      try {
        validatedInput = stageDef.inputSchema.parse(input.rawInput);
      } catch (e) {
        return {
          error: toErrorMessage(e),
          progress: [],
          annotations: [],
          logs: [],
        };
      }

      // Fix 5: a stable taskId per stage record and attempt, so a re-dispatch
      // of the same attempt (a broker restart, a lost acknowledgement) is
      // idempotent, while a retry the kernel granted is a new task instead of
      // the previous attempt's report played back. Attempt 1 keeps the bare
      // record id, as before.
      const stableTaskId =
        attempt > 1 ? `${stageRecordId}-attempt-${attempt}` : stageRecordId;

      // Submit args captured for potential re-submit on "unknown" state.
      const submitArgs = {
        workflowRunId,
        stageId,
        stageName,
        stageNumber,
        input: validatedInput,
        config: parsedConfig,
        resumeState,
        workflowContext,
        pollInterval: pollIntervalMs,
        maxWaitTime: maxWaitMs,
        taskId: stableTaskId,
      };

      // The worker stores its report under the broker's default prefix
      // before it reports. A task the broker no longer knows that already
      // reported (a broker restart after a lost acknowledgement or a lost
      // process) is answered from that report rather than run again.
      const reportKey = `remote-activity/${workflowRunId}/${stageId}/${stableTaskId}/report.json`;
      const durableReport = async (): Promise<PollResponse | undefined> => {
        const raw = await deps.blobStore.get(reportKey).catch(() => undefined);
        const parsed = ActivityReportSchema.safeParse(raw);
        if (!parsed.success || parsed.data.taskId !== stableTaskId) return;
        const { outcome, logs, annotations, progress } = parsed.data;
        return { state: "reported", outcome, logs, annotations, progress };
      };

      // Submit to broker, unless this task already reported.
      let poll = await durableReport();
      const taskId = poll
        ? stableTaskId
        : (await transport.submit(submitArgs)).taskId;

      // Block until the worker reports (or deadline/failure)
      const MAX_ITERS = 10_000;
      poll ??= await transport.poll(taskId);
      let iters = 0;
      let resubmits = 0;

      while (
        poll.state !== "reported" &&
        poll.state !== "failed" &&
        iters < MAX_ITERS
      ) {
        // Fix 5: broker forgot the task (e.g. broker restart). Re-submit the
        // same task (idempotent due to stable taskId) and keep polling.
        if (poll.state === "unknown") {
          const reported = await durableReport();
          if (reported) {
            poll = reported;
            break;
          }
          if (resubmits < MAX_ITERS) {
            await transport.submit(submitArgs);
            resubmits++;
          }
        } else {
          await new Promise<void>((resolve) =>
            setTimeout(resolve, pollEveryMs),
          );
        }
        poll = await transport.poll(taskId);
        iters++;
      }

      // Map poll result to ActivityRunResult
      const logs: BufferedLog[] = poll.logs;

      if (poll.state === "failed") {
        return {
          error: "remote activity failed (deadline or worker error)",
          progress: [],
          annotations: [],
          logs,
        };
      }

      if (!poll.outcome) {
        return {
          error: "reported task missing outcome",
          progress: [],
          annotations: [],
          logs,
        };
      }

      const outcome = poll.outcome;

      if (outcome.kind === "failed") {
        return {
          error: outcome.error,
          progress: [],
          annotations: [],
          logs,
        };
      }

      // outcome.kind === "completed" — strict trust gate
      // SyncStageDefinitionLike.outputSchema is typed as { parse(v:unknown):unknown } | null | undefined
      // Cast to the full Zod shape so we can call safeParse.
      const outputSchema = stageDef.outputSchema as
        | {
            safeParse(
              v: unknown,
            ):
              | { success: true; data: unknown }
              | { success: false; error: { message: string } };
          }
        | null
        | undefined;
      if (!outputSchema) {
        return {
          error:
            "remote output failed schema validation: no outputSchema defined",
          progress: [],
          annotations: [],
          logs,
        };
      }
      const parsed = outputSchema.safeParse(outcome.output);
      if (!parsed.success) {
        return {
          error: `remote output failed schema validation: ${parsed.error.message}`,
          progress: [],
          annotations: [],
          logs,
        };
      }

      // Map progress items → KernelEvent[] (stage:progress)
      const progress: KernelEvent[] = (poll.progress as BufferedProgress[]).map(
        (p) => ({
          type: "stage:progress" as const,
          timestamp: deps.clock.now(),
          workflowRunId,
          stageId,
          progress: p.progress,
          message: p.message ?? "",
          details: p.details as Record<string, unknown> | undefined,
        }),
      );

      // Normalize raw annotation arg-tuples → CreateAnnotationInput[]
      const stageScopeFields = {
        workflowRunId,
        workflowStageRecordId: stageRecordId,
        attempt,
        scope: "stage" as const,
        scopeId: stageId,
      };
      const annotations: CreateAnnotationInput[] = [];
      for (const argTuple of poll.annotations) {
        for (const { key, value, opts } of normalizeAnnotateArgs(argTuple)) {
          if (value === undefined || value === null) continue;
          annotations.push({
            ...stageScopeFields,
            actor: opts?.actor,
            key,
            value,
            payload: opts?.payload,
            idempotencyKey: opts?.idempotencyKey,
            emitEvent: opts?.emitEvent,
          });
        }
      }

      return {
        result: {
          output: parsed.data,
          metrics: {
            ...ZERO_METRICS,
            ...(outcome.customMetrics ?? {}),
          },
        },
        progress,
        annotations,
        logs,
      };
    },
  };
}
