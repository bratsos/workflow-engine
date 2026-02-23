/**
 * Handler: outbox.flush
 *
 * Reads unpublished outbox events and publishes them through EventSink.
 * Events are emitted in order (workflowRunId, sequence) and marked as
 * published after successful emission.
 *
 * On handler failure:
 * - Increments retryCount on the outbox event
 * - If retryCount >= maxRetries, moves event to DLQ
 * - Event is NOT marked as published (will retry on next flush)
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
  const events = await deps.persistence.getUnpublishedOutboxEvents(limit);

  // Determine maxRetries from EventSink (if it's a PluginRunner)
  const maxRetries = (deps.eventSink as Partial<PluginRunner>).maxRetries ?? 3;

  const publishedIds: string[] = [];

  for (const outboxEvent of events) {
    try {
      await deps.eventSink.emit(outboxEvent.payload as KernelEvent);
      publishedIds.push(outboxEvent.id);
    } catch {
      const newCount = await deps.persistence.incrementOutboxRetryCount(
        outboxEvent.id,
      );
      if (newCount >= maxRetries) {
        await deps.persistence.moveOutboxEventToDLQ(outboxEvent.id);
      }
      // Event stays unpublished — will retry on next flush (unless DLQ'd)
    }
  }

  if (publishedIds.length > 0) {
    await deps.persistence.markOutboxEventsPublished(publishedIds);
  }

  return { published: publishedIds.length, _events: [] };
}
