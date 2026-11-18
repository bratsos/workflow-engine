/**
 * Deliver committed outbox events at least once. Claims expire and do not
 * mark delivery: `publishedAt` is written only after the sink resolves.
 * Delivery can duplicate when an effect happens without its durable
 * acknowledgement, including on a crash, write error or ambiguous sink result.
 * Deduplicate by the outbox event ID. Run ID and sequence order events, but
 * SQL deletion of the newest rows can let the store reuse a sequence.
 *
 * Order is decided at claim time. A replayed dead letter follows successors
 * already claimed or published. Unclaimed successors wait behind it after
 * replay. The engine's progress is independent of the sink.
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
import type { OutboxRecord } from "../ports";

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
  const persistence = deps.persistence;
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

  while (attempted < limit && !interrupted()) {
    // Start the lease before awaiting the database, so there is one deadline
    // shared by the stored owner token and every pre-emit expiry check.
    const now = deps.clock.now();
    const expiresAt = now.getTime() + claimDurationMs;
    const claim = `${new Date(expiresAt).toISOString()}|${crypto.randomUUID()}`;
    // The claim statement returns only rows it now owns. A row revoked after
    // it (an operator's DLQ move, a purge) can still reach the sink once; its
    // acknowledgement, fenced on this claim, then changes nothing, and the
    // flush ends after this page.
    const events = await persistence.claimOutboxDelivery(
      limit - attempted,
      claim,
      now,
      [],
      command.signal,
    );
    if (interrupted(expiresAt) || !events.length) break;
    attempted += events.length;

    // Acknowledge accepted events together: one write carries every event
    // accepted while the previous write was in flight, and the first waits
    // one turn so runs whose sinks settle together share it. A run's next
    // event does not wait for the acknowledgement of the one before it; a
    // crash in between redelivers both, in order.
    let accepted: string[] = [];
    let writing: Promise<void> | undefined;
    let writeError: { error: unknown } | undefined;
    const write = async () => {
      // Before any adapter call: `writing` is set when this body runs.
      await undefined;
      while (accepted.length) {
        const batch = accepted;
        accepted = [];
        try {
          const count = persistence.completeOutboxDeliveries
            ? await persistence.completeOutboxDeliveries(
                batch,
                claim,
                deps.clock.now(),
              )
            : (
                await Promise.all(
                  batch.map((id) =>
                    persistence.completeOutboxDelivery(
                      id,
                      claim,
                      deps.clock.now(),
                    ),
                  ),
                )
              ).filter(Boolean).length;
          published += count;
          if (count < batch.length) stopAfterPage = true;
        } catch (error) {
          writeError ??= { error };
        }
      }
      writing = undefined;
    };
    const acknowledge = (id: string) => {
      accepted.push(id);
      writing ??= write();
    };

    // Runs are delivered concurrently, a run's events one after another.
    const runs = new Map<string, OutboxRecord[]>();
    for (const event of events) {
      const run = runs.get(event.workflowRunId);
      if (run) run.push(event);
      else runs.set(event.workflowRunId, [event]);
    }
    const results = await Promise.allSettled(
      [...runs.values()].map(async (run) => {
        for (const event of run) {
          if (writeError || interrupted(expiresAt)) return;
          try {
            await deps.eventSink.emit(event.payload as KernelEvent, {
              eventId: event.id,
              workflowRunId: event.workflowRunId,
              sequence: event.sequence,
              attempt: event.retryCount + 1,
            });
          } catch (error) {
            stopAfterPage = true;
            firstError ??= toErrorMessage(error);
            let outcome: Awaited<
              ReturnType<typeof persistence.failOutboxDelivery>
            >;
            try {
              outcome = await persistence.failOutboxDelivery(
                event.id,
                claim,
                maxRetries,
                deps.clock.now(),
              );
            } catch (writeFailure) {
              // A write error stops the whole page, as an acknowledgement's does.
              writeError ??= { error: writeFailure };
              return;
            }
            if (outcome === "dead-lettered") deadLettered++;
            if (outcome === "retry") failed++;
            return;
          }
          acknowledge(event.id);
        }
      }),
    );
    while (writing) await writing;
    for (const result of results) {
      if (result.status === "rejected") throw result.reason;
    }
    if (writeError) throw writeError.error;
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
