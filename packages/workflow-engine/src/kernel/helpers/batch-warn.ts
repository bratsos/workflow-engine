/**
 * WARNs that name a provider batch which may still be running and billed.
 *
 * Such a WARN is often the only record of the batch, so it is written on the
 * run, never on a stage record (a `run.redrive` that deletes the record would
 * take a stage-scoped log with it), and a write that fails is tried once more
 * and then reported through the engine logger rather than dropped.
 */

import { createLogger, isTraceTextEnabled } from "../../utils/logger.js";
import type { KernelDeps } from "../kernel.js";
import { toErrorMessage } from "./error-message.js";

const logger = createLogger("workflow-engine");

export async function writeBatchWarn(
  persistence: KernelDeps["persistence"],
  workflowRunId: string,
  message: string,
  metadata?: unknown,
): Promise<void> {
  let failure: unknown;
  for (let tries = 0; tries < 2; tries++) {
    try {
      await persistence.createLog({
        workflowRunId,
        level: "WARN",
        message,
        ...(metadata !== undefined ? { metadata } : {}),
      });
      return;
    } catch (error) {
      failure = error;
    }
  }
  const diagnostic = "a WARN naming a provider batch could not be written";
  const includeText = isTraceTextEnabled();
  const detail = includeText ? toErrorMessage(failure) : undefined;
  logger.error(
    diagnostic,
    { workflowRunId, ...(includeText && { error: detail, warning: message }) },
    () => [
      `run ${workflowRunId}: ${diagnostic} (${detail ?? "error details omitted"})${includeText ? `: ${message}` : ""}`,
    ],
  );
}
