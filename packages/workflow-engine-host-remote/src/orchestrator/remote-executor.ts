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

import type {
  ActivityExecutor,
  ActivityRunInput,
  ActivityRunResult,
  BufferedLog,
  CreateAnnotationInput,
  ExecutorDeps,
  KernelEvent,
} from "@bratsos/workflow-engine/kernel";
import type { BufferedProgress } from "../protocol.js";
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

type NormalizedAnnotation = {
  key: string;
  value: unknown;
  actor?: CreateAnnotationInput["actor"];
  payload?: unknown;
  idempotencyKey?: string | null;
  emitEvent?: boolean;
};

/**
 * Inline normalization of raw ctx.annotate() arg-tuples from the worker.
 * Handles the two forms used in practice:
 *   - [key: string, value, opts?]
 *   - [{ attributes, actor?, payload?, idempotencyKey?, emitEvent? }]  (batch)
 */
function normalizeAnnotateTuple(argTuple: unknown[]): NormalizedAnnotation[] {
  const first = argTuple[0];
  // string or TypedKey ({key: string, no attributes}) form
  if (typeof first === "string") {
    const opts = argTuple[2] as Record<string, unknown> | undefined;
    return [
      {
        key: first,
        value: argTuple[1],
        actor: opts?.actor as CreateAnnotationInput["actor"],
        payload: opts?.payload,
        idempotencyKey: opts?.idempotencyKey as string | null | undefined,
        emitEvent: opts?.emitEvent as boolean | undefined,
      },
    ];
  }
  if (
    first !== null &&
    typeof first === "object" &&
    "key" in first &&
    !("attributes" in first)
  ) {
    const opts = argTuple[2] as Record<string, unknown> | undefined;
    return [
      {
        key: (first as { key: string }).key,
        value: argTuple[1],
        actor: opts?.actor as CreateAnnotationInput["actor"],
        payload: opts?.payload,
        idempotencyKey: opts?.idempotencyKey as string | null | undefined,
        emitEvent: opts?.emitEvent as boolean | undefined,
      },
    ];
  }
  // batch form: { attributes, actor?, payload?, idempotencyKey?, emitEvent? }
  const batch = first as
    | {
        attributes?: Record<string, unknown>;
        actor?: CreateAnnotationInput["actor"];
        payload?: unknown;
        idempotencyKey?: string | null;
        emitEvent?: boolean;
      }
    | null
    | undefined;
  const attributes = batch?.attributes ?? {};
  return Object.entries(attributes).map(([key, value]) => ({
    key,
    value,
    actor: batch?.actor,
    payload: batch?.payload,
    idempotencyKey: batch?.idempotencyKey,
    emitEvent: batch?.emitEvent,
  }));
}

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
        const error = e instanceof Error ? e.message : String(e);
        return { error, progress: [], annotations: [], logs: [] };
      }

      // Fix 5: use stageRecordId as a stable taskId so a re-dispatch after a
      // broker restart is idempotent (not a duplicate task).
      const stableTaskId = stageRecordId;

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

      // Submit to broker
      const submitted = await transport.submit(submitArgs);

      const { taskId } = submitted;

      // Block until the worker reports (or deadline/failure)
      const MAX_ITERS = 10_000;
      let poll = await transport.poll(taskId);
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
        const normalized = normalizeAnnotateTuple(argTuple);
        for (const {
          key,
          value,
          actor,
          payload,
          idempotencyKey,
          emitEvent,
        } of normalized) {
          if (value === undefined || value === null) continue;
          annotations.push({
            ...stageScopeFields,
            actor,
            key,
            value,
            payload,
            idempotencyKey,
            emitEvent,
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
