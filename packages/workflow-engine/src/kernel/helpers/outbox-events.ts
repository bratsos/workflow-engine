/**
 * Build outbox event inputs from kernel events.
 *
 * Used by both job-execute (threads a caller-supplied `causationId` —
 * derived from the command's idempotency key when present — across every
 * outbox write in a single job.execute invocation) and stage-poll-suspended
 * (mints a fresh `causationId` per stage, since each stage's Phase-2
 * transaction is its own independent unit of causation). The default
 * parameter preserves both call sites' existing semantics exactly.
 */

import type { CreateOutboxEventInput } from "../../persistence/interface.js";
import type { KernelEvent } from "../events.js";

export function toOutboxEvents(
  workflowRunId: string,
  events: KernelEvent[],
  causationId: string = crypto.randomUUID(),
): CreateOutboxEventInput[] {
  return events.map((event) => ({
    workflowRunId,
    eventType: event.type,
    payload: event,
    causationId,
    occurredAt: event.timestamp,
  }));
}
