/**
 * Handler: outbox.flush
 *
 * Claims unpublished outbox events and publishes them through EventSink.
 * Events are claimed (their `publishedAt` stamped) atomically before they
 * are emitted, in (workflowRunId, sequence) order, so two hosts flushing
 * the same outbox concurrently — a cron tick and a request-kicked tick, or
 * two workers — never both deliver the same event.
 *
 * On handler failure:
 * - The event is released (its `publishedAt` cleared) so the next flush
 *   retries it, together with the later events of the same run
 * - Increments retryCount on the outbox event
 * - If retryCount >= maxRetries, moves event to DLQ
 *
 * A process that dies between the claim and the emit leaves the event
 * stamped as published: the claim is what makes delivery once-only.
 *
 * This handler returns _events: [] — it does NOT produce new outbox events.
 */

import type { OutboxFlushCommand, OutboxFlushResult } from "../commands";
import type { KernelEvent } from "../events";
import type { HandlerResult, KernelDeps } from "../kernel";
import type { PluginRunner } from "../plugins";

export async function handleOutboxFlush(
  command: OutboxFlushCommand,
  deps: KernelDeps,
): Promise<HandlerResult<OutboxFlushResult>> {
  const limit = command.maxEvents ?? 100;
  const events = await deps.persistence.claimUnpublishedOutboxEvents(limit);

  // Determine maxRetries from EventSink (if it's a PluginRunner)
  const maxRetries = (deps.eventSink as Partial<PluginRunner>).maxRetries ?? 3;

  let published = 0;
  const releaseIds: string[] = [];
  // Events are claimed ordered by (workflowRunId, sequence). Once a run's
  // event N fails to publish, later events for that same run must not
  // be published ahead of it — that would redeliver out of order on the
  // next flush. Release (not fail) the rest of that run's events this
  // pass; other runs are unaffected.
  const failedRunIds = new Set<string>();

  for (const outboxEvent of events) {
    if (failedRunIds.has(outboxEvent.workflowRunId)) {
      releaseIds.push(outboxEvent.id);
      continue;
    }

    try {
      await deps.eventSink.emit(outboxEvent.payload as KernelEvent);
      published++;
    } catch {
      failedRunIds.add(outboxEvent.workflowRunId);
      releaseIds.push(outboxEvent.id);
      const newCount = await deps.persistence.incrementOutboxRetryCount(
        outboxEvent.id,
      );
      if (newCount >= maxRetries) {
        await deps.persistence.moveOutboxEventToDLQ(outboxEvent.id);
      }
      // Released below — will retry on next flush (unless DLQ'd)
    }
  }

  if (releaseIds.length > 0) {
    await deps.persistence.releaseOutboxEvents(releaseIds);
  }

  return { published, _events: [] };
}
