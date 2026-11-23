import type { EnginePruneCommand, EnginePruneResult } from "../commands";
import type { KernelDeps } from "../kernel";
import {
  AICallDeletionUnavailableError,
  DEFAULT_PURGE_LIMIT,
} from "./run-purge";

export async function handleEnginePrune(
  command: EnginePruneCommand,
  { persistence, services }: KernelDeps,
): Promise<EnginePruneResult> {
  const { aiCalls, aiCallText, outbox, idempotencyKeys } = command;
  const limit = command.limit ?? DEFAULT_PURGE_LIMIT;
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw new Error("engine.prune: limit must be a positive integer");
  }

  const logger = services?.aiLogger;
  if (aiCalls && !logger?.pruneCalls)
    throw new AICallDeletionUnavailableError("pruneCalls");
  if (aiCallText && !logger?.clearExpiredText)
    throw new AICallDeletionUnavailableError("clearExpiredText");
  if (
    (outbox && !persistence.pruneOutbox) ||
    (idempotencyKeys && !persistence.pruneIdempotencyKeys)
  ) {
    throw new Error(
      "Requested retention clause requires persistence prune support",
    );
  }

  return {
    aiCalls: aiCalls ? await logger!.pruneCalls!(aiCalls.olderThan, limit) : 0,
    aiCallText: aiCallText
      ? await logger!.clearExpiredText!(aiCallText.now, limit)
      : 0,
    outbox: outbox
      ? await persistence.pruneOutbox!(outbox.publishedOlderThan, limit)
      : 0,
    idempotencyKeys: idempotencyKeys
      ? await persistence.pruneIdempotencyKeys!(
          idempotencyKeys.olderThan,
          limit,
        )
      : 0,
  };
}
