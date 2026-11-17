/**
 * Deliver committed outbox events at least once. Claims expire and do not
 * mark delivery: `publishedAt` is written only after the sink resolves.
 * Delivery can duplicate when an effect happens without its durable
 * acknowledgement, including on a crash, write error or ambiguous sink result.
 * Deduplicate by the outbox event ID. Run ID and sequence order events, but
 * SQL deletion of the newest rows can let the store reuse a sequence.
 *
 * Order is decided when the run head is claimed. A live predecessor blocks
 * successors then. A dead letter replayed after a successor was claimed can
 * arrive later. The engine's progress is independent of the sink.
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
  if (deps.persistence.outboxDeliveryDeferred) {
    return {
      deferred: true,
      published: 0,
      failed: 0,
      deadLettered: 0,
      eventSinkStatus: "healthy",
      _events: [],
    };
  }

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
  let stopAfterPage = false;
  let attempted = 0;
  let published = 0;
  let failed = 0;
  let deadLettered = 0;
  let firstError: string | undefined;

  const interrupted = (expiresAt?: number) => {
    if (expiresAt !== undefined && deps.clock.now().getTime() >= expiresAt) {
      const message = "outbox.flush claim expired before delivery";
      console.warn(message);
      firstError ??= message;
      return true;
    }
    if (command.signal?.aborted) {
      firstError ??= "outbox.flush cancelled";
      return true;
    }
    return false;
  };

  flush: while (attempted < limit && !interrupted()) {
    // Start the lease before awaiting the database, so there is one deadline
    // shared by the stored owner token and every pre-emit expiry check.
    const now = deps.clock.now();
    const expiresAt = now.getTime() + claimDurationMs;
    const claim = `${new Date(expiresAt).toISOString()}|${crypto.randomUUID()}`;
    const events = await deps.persistence.claimOutboxDelivery(
      limit - attempted,
      claim,
      now,
      [],
      command.signal,
    );
    if (interrupted(expiresAt) || !events.length) break;
    for (const event of events) {
      attempted++;
      if (interrupted(expiresAt)) break flush;
      const active = await deps.persistence.isOutboxDeliveryClaimActive(
        event.id,
        claim,
        deps.clock.now(),
      );
      if (interrupted(expiresAt)) break flush;
      if (!active) {
        stopAfterPage = true;
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
        stopAfterPage = true;
        const outcome = await deps.persistence.failOutboxDelivery(
          event.id,
          claim,
          maxRetries,
          deps.clock.now(),
        );
        firstError ??= toErrorMessage(error);
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
    // Finish the page but leave retries for the next flush. This avoids
    // repeatedly scanning failed heads to find independent work.
    if (stopAfterPage || deps.clock.now().getTime() >= expiresAt) break;
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
