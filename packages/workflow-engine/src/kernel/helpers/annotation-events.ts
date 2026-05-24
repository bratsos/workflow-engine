/**
 * Build `annotation:created` events from `CreateAnnotationInput` rows
 * that have opted into outbox emission. Used by both stage-scope flush
 * paths (job-execute, stage-poll-suspended) and external attach (kernel
 * annotations helper) so the event shape is consistent everywhere.
 */

import type { CreateAnnotationInput } from "../../persistence/interface";
import type { AnnotationCreatedEvent } from "../events";

export function buildAnnotationEvents(
  inputs: ReadonlyArray<CreateAnnotationInput>,
  now: Date,
): AnnotationCreatedEvent[] {
  return inputs
    .filter((input) => input.emitEvent === true)
    .map((input) => ({
      type: "annotation:created" as const,
      timestamp: now,
      workflowRunId: input.workflowRunId,
      key: input.key,
      value: input.value,
      scope: input.scope,
      scopeId: input.scopeId ?? undefined,
      attempt: input.attempt,
      actorKind: input.actor?.kind,
      actorId: input.actor?.id,
      actorVersion: input.actor?.version,
    }));
}
