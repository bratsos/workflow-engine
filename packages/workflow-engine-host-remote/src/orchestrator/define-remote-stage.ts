import type { Stage } from "@bratsos/workflow-engine";
import type { z } from "zod";
import type { OrchestratorTransport } from "../transport.js";

export interface RemoteStageOptions {
  pollIntervalMs?: number;
  maxWaitMs?: number;
}

type AnyStage = Stage<z.ZodTypeAny, z.ZodTypeAny, z.ZodTypeAny>;

const ZERO_METRICS = { startTime: 0, endTime: 0, duration: 0 };

/**
 * The claim-checked worker payload. Saved to BlobStore at suspend-time so that,
 * if the orchestrator restarts and its in-memory broker forgets the task, the
 * proxy can reconstruct the submit request and re-register the work.
 */
interface RemotePayload {
  stageName: string;
  stageNumber: number;
  input: unknown;
  config: unknown;
  resumeState: unknown;
  workflowContext: Record<string, unknown>;
  pollInterval: number;
  maxWaitTime: number;
  artifactPrefix: string;
}

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
      // Revision 7: use the stage record id as a stable taskId so a re-register
      // after restart is idempotent. In the real engine flow this is always
      // set; in unit tests it may be undefined, in which case the broker
      // generates an id (and recovery still works via the stashed taskId).
      const taskId = ctx.stageRecordId;
      const payloadKey = ctx.storage.getStageKey(
        ctx.stageId,
        "remote-payload.json",
      );
      // Revision 5: align the broker's artifact namespace with the engine's own
      // stage storage key so reruns reuse the same prefix.
      const artifactPrefix = ctx.storage.getStageKey(ctx.stageId, "remote");

      // Revision 5/6: claim-check the full worker payload to BlobStore under a
      // deterministic key BEFORE submitting, so the recovery path can reload it.
      const payload: RemotePayload = {
        stageName: ctx.stageName,
        stageNumber: ctx.stageNumber,
        input: ctx.input,
        config: ctx.config,
        resumeState: ctx.resumeState,
        workflowContext: ctx.workflowContext as Record<string, unknown>,
        pollInterval,
        maxWaitTime,
        artifactPrefix,
      };
      await ctx.storage.save(payloadKey, payload);

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
        taskId,
        artifactPrefix,
      });

      return {
        suspended: true as const,
        state: {
          // carries the remote taskId (schema requires batchId)
          batchId: submitted.taskId,
          submittedAt: new Date().toISOString(),
          pollInterval: submitted.pollConfig.pollInterval,
          maxWaitTime: submitted.pollConfig.maxWaitTime,
          // Revision 1/4/7: everything the recovery path needs survives in
          // suspendedState.metadata (round-tripped through persistence).
          metadata: {
            taskId: submitted.taskId,
            payloadKey,
            deadlineAt: submitted.deadlineAt,
            stageCodeVersion: submitted.stageCodeVersion,
          },
        },
        pollConfig: submitted.pollConfig,
        metrics: ZERO_METRICS,
      };
    },
    async checkCompletion(suspendedState, ctx) {
      const taskId = (suspendedState as { batchId: string }).batchId;
      const meta = (suspendedState as { metadata?: Record<string, unknown> })
        .metadata;
      const storedDeadlineAt = meta?.deadlineAt as number | undefined;
      const storedVersion = meta?.stageCodeVersion as string | undefined;
      const poll = await transport.poll(taskId);

      // Revision 3/4: the broker forgot this task (restart). Recover by
      // reloading the claim-checked payload and re-registering idempotently.
      if (poll.state === "unknown") {
        try {
          const payloadKey =
            (meta?.payloadKey as string | undefined) ??
            ctx.storage.getStageKey(ctx.stageId, "remote-payload.json");
          const payload = await ctx.storage.load<RemotePayload>(payloadKey);
          await transport.submit({
            workflowRunId: ctx.workflowRunId,
            stageId: ctx.stageId,
            stageName: payload.stageName,
            stageNumber: payload.stageNumber,
            input: payload.input,
            config: payload.config,
            resumeState: payload.resumeState,
            workflowContext: payload.workflowContext,
            pollInterval: payload.pollInterval,
            maxWaitTime: payload.maxWaitTime,
            taskId,
            // Revision 1: re-register with the ORIGINAL absolute deadline so the
            // deadline is never reset across restarts.
            deadlineAt: storedDeadlineAt,
            // Revision 4: pin the version so a deploy that changed stage code
            // fails the run rather than resuming on incompatible code.
            pinnedVersion: storedVersion,
            artifactPrefix: payload.artifactPrefix,
          });
          return { ready: false, nextCheckIn: pollInterval };
        } catch {
          // Revision 3: transient errors (e.g. BlobStore blip) must keep the
          // stage SUSPENDED for a later retry — never throw, never fail.
          return { ready: false, nextCheckIn: pollInterval };
        }
      }

      if (poll.state === "pending" || poll.state === "assigned") {
        return { ready: false, nextCheckIn: poll.nextCheckIn ?? pollInterval };
      }
      if (poll.state === "failed") {
        // Surface the broker's specific failure reason when available — this
        // carries the deadline-exceeded (Revision 1/3) and version-changed
        // (Revision 4) messages so the run fails with an actionable cause.
        return {
          ready: false,
          error:
            poll.error ?? "remote activity failed (deadline or worker error)",
        };
      }
      // reported — replay buffered side-channels into ctx before returning
      for (const l of poll.logs) ctx.log(l.level as "INFO", l.message, l.meta);
      for (const a of poll.annotations)
        (ctx.annotate as (...args: unknown[]) => void)(...a);
      for (const p of poll.progress)
        ctx.log(
          "INFO",
          `progress ${p.progress}%${p.message ? `: ${p.message}` : ""}`,
        );

      const outcome = poll.outcome;
      if (!outcome)
        return { ready: false, error: "reported task missing outcome" };
      if (outcome.kind === "failed")
        return { ready: false, error: outcome.error };

      // strict trust gate — the engine's own resume-path validation is best-effort
      const parsed = real.outputSchema.safeParse(outcome.output);
      if (!parsed.success) {
        return {
          ready: false,
          error: `remote output failed schema validation: ${parsed.error.message}`,
        };
      }
      const cm = outcome.customMetrics;
      return {
        ready: true,
        output: parsed.data,
        metrics: cm
          ? { startTime: 0, endTime: 0, duration: 0, ...cm }
          : undefined,
      };
    },
  };
}
