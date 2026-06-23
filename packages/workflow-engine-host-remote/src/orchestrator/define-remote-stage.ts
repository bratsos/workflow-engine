import type { Stage } from "@bratsos/workflow-engine";
import type { z } from "zod";
import type { OrchestratorTransport } from "../transport.js";

export interface RemoteStageOptions {
  pollIntervalMs?: number;
  maxWaitMs?: number;
}

type AnyStage = Stage<z.ZodTypeAny, z.ZodTypeAny, z.ZodTypeAny>;

const ZERO_METRICS = { startTime: 0, endTime: 0, duration: 0 };

export function defineRemoteStage(
  real: AnyStage,
  transport: OrchestratorTransport,
  opts: RemoteStageOptions = {},
): AnyStage {
  const pollInterval = opts.pollIntervalMs ?? 1_000;
  const maxWaitTime = opts.maxWaitMs ?? 3_600_000;

  return {
    ...real,
    mode: "async-batch",
    async execute(ctx) {
      const submitted = await transport.submit({
        workflowRunId: ctx.workflowRunId,
        stageId: ctx.stageId,
        stageName: ctx.stageName,
        stageNumber: ctx.stageNumber,
        input: ctx.input,
        config: ctx.config,
        resumeState: ctx.resumeState,
        workflowContext: ctx.workflowContext as Record<string, unknown>,
        pollInterval,
        maxWaitTime,
      });
      return {
        suspended: true as const,
        state: {
          batchId: submitted.taskId, // carries the remote taskId (schema requires batchId)
          submittedAt: new Date().toISOString(),
          pollInterval: submitted.pollConfig.pollInterval,
          maxWaitTime: submitted.pollConfig.maxWaitTime,
          metadata: { taskId: submitted.taskId },
        },
        pollConfig: submitted.pollConfig,
        metrics: ZERO_METRICS,
      };
    },
    async checkCompletion(suspendedState, ctx) {
      const taskId = (suspendedState as { batchId: string }).batchId;
      const poll = await transport.poll(taskId);

      if (poll.state === "pending" || poll.state === "assigned") {
        return { ready: false, nextCheckIn: poll.nextCheckIn ?? pollInterval };
      }
      if (poll.state === "failed") {
        return { ready: false, error: "remote activity failed (deadline or worker error)" };
      }
      // reported — replay buffered side-channels into ctx before returning
      for (const l of poll.logs) ctx.log(l.level as "INFO", l.message, l.meta);
      for (const a of poll.annotations) (ctx.annotate as (...args: unknown[]) => void)(...a);
      for (const p of poll.progress) ctx.log("INFO", `progress ${p.progress}%${p.message ? `: ${p.message}` : ""}`);

      const outcome = poll.outcome;
      if (!outcome) return { ready: false, error: "reported task missing outcome" };
      if (outcome.kind === "failed") return { ready: false, error: outcome.error };

      // strict trust gate — the engine's own resume-path validation is best-effort
      const parsed = real.outputSchema.safeParse(outcome.output);
      if (!parsed.success) {
        return { ready: false, error: `remote output failed schema validation: ${parsed.error.message}` };
      }
      return { ready: true, output: parsed.data };
    },
  };
}
