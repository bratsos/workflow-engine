/**
 * Deliver committed outbox events at least once. Claims expire and do not
 * mark delivery: `publishedAt` is written only after the sink resolves.
 * A crash after emit, an emit still running at claim expiry, or a partial
 * plugin failure can cause duplicates. Consumers can deduplicate by the
 * outbox event ID in the delivery metadata. Run ID and sequence order events
 * but are not permanent identities: SQL deletion of the newest outbox rows
 * can allow the Prisma store to reuse a sequence.
 *
 * An earlier live event blocks later events of its run, including while it
 * is claimed or awaiting retry. Dead-lettered events do not block later
 * events; `plugin.replayDLQ` makes them eligible again. The engine's own
 * progress is independent of the sink.
 * Nothing in the engine deletes outbox rows; run.purge leaves them, and
 * an operator can remove them with SQL. For a purged run, a flush skips a
 * live claim until completion or expiry, skips published rows, and skips
 * dead letters until replay.
 *
 * A persistence write error rejects dispatch without a handler log. Host
 * maintenance logs the error and reports degraded delivery; live claims
 * remain recoverable after expiry unless the write already took effect.
 */

import type { OutboxFlushCommand, OutboxFlushResult } from "../commands";
import type { KernelEvent } from "../events";
import { toErrorMessage } from "../helpers/error-message.js";
import type { HandlerResult, KernelDeps } from "../kernel";
import type { PluginRunner } from "../plugins";

export async function handleOutboxFlush(
  command: OutboxFlushCommand,
  deps: KernelDeps,
): Promise<HandlerResult<OutboxFlushResult>> {
  const limit = command.maxEvents ?? 100;
  const claimDurationMs = command.claimDurationMs ?? 60_000;
  if (
    !Number.isSafeInteger(claimDurationMs) ||
    claimDurationMs < 1 ||
    claimDurationMs > 2_147_483_647
  ) {
    throw new RangeError(
      "outbox.flush claimDurationMs must be an integer from 1 to 2147483647",
    );
  }
  const maxRetries = (deps.eventSink as Partial<PluginRunner>).maxRetries ?? 3;
  const failedRuns = new Set<string>();
  let attempted = 0;
  let published = 0;
  let failed = 0;
  let deadLettered = 0;
  let firstError: string | undefined;

  while (attempted < limit) {
    const now = deps.clock.now();
    const expiresAt = now.getTime() + claimDurationMs;
    const claim = `${new Date(expiresAt).toISOString()}|${crypto.randomUUID()}`;
    const events = await deps.persistence.claimOutboxDelivery(
      limit - attempted,
      claim,
      now,
      [...failedRuns],
    );
    if (!events.length) break;
    for (const event of events) {
      attempted++;
      if (deps.clock.now().getTime() >= expiresAt) break;
      if (
        !(await deps.persistence.isOutboxDeliveryClaimActive(
          event.id,
          claim,
          deps.clock.now(),
        ))
      ) {
        failedRuns.add(event.workflowRunId);
        continue;
      }
      try {
        await deps.eventSink.emit(event.payload as KernelEvent, {
          eventId: event.id,
          workflowRunId: event.workflowRunId,
          sequence: event.sequence,
          attempt: event.retryCount + 1,
        });
      } catch (error) {
        firstError ??= toErrorMessage(error);
        failedRuns.add(event.workflowRunId);
        const outcome = await deps.persistence.failOutboxDelivery(
          event.id,
          claim,
          maxRetries,
          deps.clock.now(),
        );
        if (outcome === "dead-lettered") deadLettered++;
        if (outcome === "retry") failed++;
        continue;
      }
      if (
        await deps.persistence.completeOutboxDelivery(
          event.id,
          claim,
          deps.clock.now(),
        )
      )
        published++;
    }
    if (deps.clock.now().getTime() >= expiresAt) break;
  }

  return {
    published,
    failed,
    deadLettered,
    eventSinkStatus: firstError === undefined ? "healthy" : "degraded",
    ...(firstError !== undefined ? { eventSinkError: firstError } : {}),
    _events: [],
  };
}
