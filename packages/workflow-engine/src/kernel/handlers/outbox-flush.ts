/**
 * Handler: outbox.flush
 *
 * Claims unpublished outbox events and publishes them through EventSink.
 * Events are claimed (their `publishedAt` stamped) atomically before they
 * are emitted, in (workflowRunId, sequence) order, so two hosts flushing
 * the same outbox concurrently — a cron tick and a request-kicked tick, or
 * two workers — never both deliver the same event.
 *
 * What that guarantees, exactly:
 * - No phantom events: the events are written in the transaction of the
 *   state change they describe, so a rolled-back transaction writes none.
 * - One delivery attempt (one `emit`) per claim.
 * - A sink failure is retried: the event is released (its `publishedAt`
 *   cleared) so the next flush tries again, together with the later events
 *   of the same run, up to the retry budget (`maxRetries`, default 3
 *   failed attempts); then the event moves to the DLQ and waits for
 *   `plugin.replayDLQ`. A retry emits the whole event again, so a plugin
 *   that ran before the failing one sees it again.
 * - An event is lost only if the process dies between the claim and the
 *   emit: it is left stamped as published and no later flush delivers it.
 *   Delivery is at-most-once per claim, retried only after a sink failure:
 *   NOT at-least-once. Closing that window needs a claim state of its own
 *   (a schema change), not a change here.
 * - The engine's own progress never depends on the sink: the poller, not
 *   the sink, advances runs.
 * - A consumer that needs every event reads the `outbox_events` table (or
 *   the console, which reads the same rows): the row stays whatever became
 *   of the delivery: nothing in the engine deletes outbox rows (`run.purge`
 *   does not touch `outbox_events`, which has no foreign key to the run), so
 *   they are removed with SQL.
 *
 * On handler failure:
 * - The event is released (its `publishedAt` cleared) so the next flush
 *   retries it, together with the later events of the same run
 * - Increments retryCount on the outbox event
 * - If retryCount >= maxRetries, moves event to DLQ
 *
 * The result names the sink's state: `eventSinkStatus: "degraded"` when at
 * least one event could not be published this pass, plus how many will be
 * retried by the next flush (`failed`) and how many exhausted their retry
 * budget (`deadLettered`). Those two populations are disjoint: a released
 * event that was also dead-lettered will not retry on its own, so it is
 * reported only as `deadLettered`. A degraded sink never stalls a run —
 * the poller, not the sink, is what advances one — so hosts surface the
 * state instead of throwing (see `createEventSinkMonitor` in
 * `helpers/host-support.ts`).
 *
 * This handler returns _events: [] — it does NOT produce new outbox events.
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
  const events = await deps.persistence.claimUnpublishedOutboxEvents(limit);

  // Determine maxRetries from EventSink (if it's a PluginRunner)
  const maxRetries = (deps.eventSink as Partial<PluginRunner>).maxRetries ?? 3;

  let published = 0;
  let deadLettered = 0;
  let firstError: string | undefined;
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
    } catch (error) {
      firstError ??= toErrorMessage(error);
      failedRunIds.add(outboxEvent.workflowRunId);
      releaseIds.push(outboxEvent.id);
      const newCount = await deps.persistence.incrementOutboxRetryCount(
        outboxEvent.id,
      );
      if (newCount >= maxRetries) {
        // One write sets `dlqAt` AND drops the claim stamp, so no crash
        // before the release below can leave a stamped dead letter (which
        // a replay would turn into an event that reads as published).
        await deps.persistence.moveOutboxEventToDLQ(outboxEvent.id);
        deadLettered++;
      }
      // Released below — will retry on next flush (unless DLQ'd)
    }
  }

  if (releaseIds.length > 0) {
    await deps.persistence.releaseOutboxEvents(releaseIds);
  }

  return {
    published,
    // Every released id minus the ones that were also dead-lettered. A
    // dead letter is released so a replay can still find it in sequence,
    // but it does not retry on its own and `deadLettered` already counts
    // it — leaving it in here reported one event twice and contradicted
    // what `failed` documents. The remainder is homogeneous: events whose
    // emit threw, plus the later events of those same runs held back to
    // keep per-run order. Both come round again on the next flush.
    failed: releaseIds.length - deadLettered,
    deadLettered,
    eventSinkStatus: firstError === undefined ? "healthy" : "degraded",
    ...(firstError !== undefined ? { eventSinkError: firstError } : {}),
    _events: [],
  };
}
