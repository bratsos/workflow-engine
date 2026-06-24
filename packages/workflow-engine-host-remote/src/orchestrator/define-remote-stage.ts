import type { Stage } from "@bratsos/workflow-engine";
import type { z } from "zod";
import type { ActivityReport } from "../protocol.js";
import { ActivityReportSchema } from "../protocol.js";
import type { OrchestratorTransport } from "../transport.js";

export interface RemoteStageOptions {
  pollIntervalMs?: number;
  maxWaitMs?: number;
  ownedKeyPrefixes?: string[];
  /**
   * Injectable clock for tests. Defaults to `Date.now`. The clock must be in
   * the same time domain as the broker's `deadlineAt` values — in production
   * both use the real wall clock; in tests both should use the same FakeClock.
   */
  _clock?: () => number;
  /**
   * The orchestrator's CURRENT stage-code version — the same value the broker
   * is configured with. When set, the durable-report fast-path will reject any
   * report written by a worker that ran under a DIFFERENT version (i.e. the
   * worker ran before a deploy changed stage code). The run falls through to
   * the re-register path, which will create a FAILED task due to the version
   * mismatch, failing the run with an actionable error.
   *
   * If unset, version-pinning is disabled and the durable-report path completes
   * as before (no version concern). This matches the broker's "pinning requires
   * both sides configured" semantics.
   */
  stageCodeVersion?: string;
}

type AnyStage = Stage<z.ZodTypeAny, z.ZodTypeAny, z.ZodTypeAny>;

const ZERO_METRICS = { startTime: 0, endTime: 0, duration: 0 };

/**
 * The claim-checked worker payload. Saved to BlobStore at suspend-time so that,
 * if the orchestrator restarts and its in-memory broker forgets the task, the
 * proxy can reconstruct the submit request and re-register the work.
 *
 * Fix 4: deadlineAt and stageCodeVersion are included so that recovery is
 * fully self-contained from the durable payload (preferred source:
 * suspendedState.metadata; fallback: payload.deadlineAt / payload.stageCodeVersion).
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
  /** Absolute deadline (ms since epoch) stashed for recovery self-sufficiency. */
  deadlineAt?: number;
  /** Stage code version stashed for version-pin self-sufficiency. */
  stageCodeVersion?: string;
}

function collectStrings(val: unknown): string[] {
  if (typeof val === "string") return [val];
  if (Array.isArray(val)) return val.flatMap(collectStrings);
  if (val !== null && typeof val === "object") {
    return Object.values(val as Record<string, unknown>).flatMap(
      collectStrings,
    );
  }
  return [];
}

function validateOutputKeyScope(
  output: unknown,
  grantPrefix: string,
  ownedKeyPrefixes: string[],
): string | null {
  for (const s of collectStrings(output)) {
    const isOwnedKey = ownedKeyPrefixes.some((p) => s.startsWith(p));
    if (isOwnedKey && !s.startsWith(grantPrefix)) {
      return `worker returned an object key outside its grant prefix (possible confused-deputy): ${s}`;
    }
  }
  return null;
}

export function defineRemoteStage(
  real: AnyStage,
  transport: OrchestratorTransport,
  opts: RemoteStageOptions = {},
): AnyStage {
  const pollInterval = opts.pollIntervalMs ?? 1_000;
  const maxWaitTime = opts.maxWaitMs ?? 3_600_000;
  const nowMs = opts._clock ?? Date.now.bind(Date);

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

      // Revision 5/6 + Fix 4: claim-check the full worker payload to BlobStore
      // AFTER submit so we can include the broker-confirmed deadlineAt and
      // stageCodeVersion, making recovery fully self-contained from the durable
      // payload (no reliance on suspendedState.metadata alone).
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
        deadlineAt: submitted.deadlineAt,
        stageCodeVersion: submitted.stageCodeVersion,
      };
      await ctx.storage.save(payloadKey, payload);

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
            artifactPrefix,
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
      const storedArtifactPrefix = meta?.artifactPrefix as string | undefined;
      const poll = await transport.poll(taskId);

      // Revision 3/4: the broker forgot this task (restart). First check for a
      // durable report written by the worker before it called broker.report() —
      // if found, the work is already done and we recover without re-running.
      // Only if no durable report exists do we re-register and let a worker
      // pick up the task again.
      if (poll.state === "unknown") {
        // B1: Deadline check runs FIRST — before any I/O. If deadline has
        // passed, fail immediately instead of re-registering forever.
        if (storedDeadlineAt !== undefined && nowMs() > storedDeadlineAt) {
          return { ready: false, error: "remote activity deadline exceeded" };
        }

        try {
          const payloadKey =
            (meta?.payloadKey as string | undefined) ??
            ctx.storage.getStageKey(ctx.stageId, "remote-payload.json");
          const payload = await ctx.storage.load<RemotePayload>(payloadKey);
          // Fix 1: a missing payload is unrecoverable — the run cannot resume.
          // Return a terminal error so the engine fails the run cleanly rather
          // than suspending indefinitely with no path forward.
          if (!payload)
            return {
              ready: false,
              error: "remote recovery payload missing — run cannot resume",
            };

          // Durable-report recovery: the worker writes
          // <artifactPrefix>/<taskId>/report.json to object storage BEFORE
          // calling broker.report(), so if the broker restarts after the worker
          // completed we can recover the outcome without re-running the work.
          const durableReportKey = `${payload.artifactPrefix}/${taskId}/report.json`;

          // B1: Validate durable report with ActivityReportSchema.safeParse.
          // Corrupt/forged blobs fall through to re-register (not complete, not fail).
          let durableReport: ActivityReport | undefined;
          try {
            const rawLoaded = await ctx.storage.load<unknown>(durableReportKey);
            if (rawLoaded !== undefined && rawLoaded !== null) {
              const schemaParsed = ActivityReportSchema.safeParse(rawLoaded);
              if (schemaParsed.success) {
                durableReport = schemaParsed.data;
              }
              // If parse fails: fall through to re-register (corrupt blob is treated as absent)
            }
          } catch {
            // Key absent or unreadable — fall through to re-register.
          }

          if (durableReport) {
            // B1-gate: version-pin check. If the orchestrator has a
            // stageCodeVersion configured AND the stashed version from
            // suspendedState.metadata differs (i.e. a deploy happened between
            // the worker writing the durable report and now), do NOT complete
            // from the stale report. Fall through to re-register so the broker
            // (configured with the new version) creates a FAILED task and the
            // run fails with the version error — the correct conservative
            // behavior. If opts.stageCodeVersion is unset, version-pinning is
            // not in use and the durable report completes as before.
            const versionGateBlocks =
              opts.stageCodeVersion !== undefined &&
              storedVersion !== undefined &&
              opts.stageCodeVersion !== storedVersion;

            if (!versionGateBlocks) {
              // Replay buffered side-channels from the durable report.
              for (const l of durableReport.logs)
                ctx.log(l.level as "INFO", l.message, l.meta);
              for (const a of durableReport.annotations)
                (ctx.annotate as (...args: unknown[]) => void)(...a);
              for (const p of durableReport.progress)
                ctx.log(
                  "INFO",
                  `progress ${p.progress}%${p.message ? `: ${p.message}` : ""}`,
                );

              const outcome = durableReport.outcome;
              if (outcome.kind === "failed")
                return { ready: false, error: outcome.error };

              // Strict trust gate — same as the normal "reported" path.
              const outputParsed = real.outputSchema.safeParse(outcome.output);
              if (outputParsed.success) {
                // B3: Validate output key scope in durable-report path.
                const grantPrefix = `${payload.artifactPrefix}/${taskId}/`;
                const scopeError = validateOutputKeyScope(
                  outputParsed.data,
                  grantPrefix,
                  opts.ownedKeyPrefixes ?? ["workflow-v2/", "remote-activity/"],
                );
                if (scopeError) return { ready: false, error: scopeError };

                const cm = outcome.customMetrics;
                return {
                  ready: true,
                  output: outputParsed.data,
                  metrics: cm
                    ? { startTime: 0, endTime: 0, duration: 0, ...cm }
                    : undefined,
                };
              }
              // B1: Output schema failure in durable-report path → fall through
              // to re-register (not a terminal error).
            }
            // versionGateBlocks === true: deploy detected — fall through to
            // re-register path below so the broker (configured with the new
            // version) creates a FAILED task and the run fails with a version
            // mismatch error — the correct conservative behavior.
          }

          // No valid durable report (absent, corrupt, or output schema failed) —
          // re-register the task so a worker picks it up.
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
            deadlineAt: storedDeadlineAt ?? payload.deadlineAt,
            // Revision 4: pin the version so a deploy that changed stage code
            // fails the run rather than resuming on incompatible code.
            pinnedVersion: storedVersion ?? payload.stageCodeVersion,
            artifactPrefix: payload.artifactPrefix,
          });
          return { ready: false, nextCheckIn: pollInterval };
        } catch (err) {
          // Fix 2: log transient errors so a stage stuck in recovery is
          // distinguishable from one normally waiting.
          ctx.log("WARN", "remote recovery failed, will retry", {
            taskId,
            error: err instanceof Error ? err.message : String(err),
          });
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

      // B3: Validate output key scope in the normal "reported" path.
      if (storedArtifactPrefix) {
        const grantPrefix = `${storedArtifactPrefix}/${taskId}/`;
        const scopeError = validateOutputKeyScope(
          parsed.data,
          grantPrefix,
          opts.ownedKeyPrefixes ?? ["workflow-v2/", "remote-activity/"],
        );
        if (scopeError) return { ready: false, error: scopeError };
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
