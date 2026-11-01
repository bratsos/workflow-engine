import { StepResultNotSerializable } from "../../core/steps.js";
import type { StepSignalCommand, StepSignalResult } from "../commands.js";
import type { KernelEvent } from "../events.js";
import { toOutboxEvents } from "../helpers/outbox-events.js";
import type { HandlerResult, KernelDeps } from "../kernel.js";
import type { StepRecord } from "../ports.js";

/** Idempotency type of a signal's wake. `run.purge` releases these keys. */
export const SIGNAL_WAKE = "step.signal.wake";
export const signalWakeKey = (stageRecordId: string, stepId: string) =>
  JSON.stringify([stageRecordId, stepId]);

function jsonRoundTrip(value: unknown, stepId: string): unknown {
  try {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new Error("undefined payload");
    return JSON.parse(encoded);
  } catch {
    throw new StepResultNotSerializable(stepId);
  }
}

export async function handleStepSignal(
  command: StepSignalCommand,
  deps: KernelDeps,
): Promise<HandlerResult<StepSignalResult>> {
  if (!deps.stepLedger) {
    throw new Error(
      "step.signal requires a configured StepLedger. Pass stepLedger to createKernel before signalling a stage.",
    );
  }

  const stage = await deps.persistence.getStage(
    command.workflowRunId,
    command.stageId,
  );
  if (!stage) {
    throw new Error(
      `Workflow stage ${command.workflowRunId}/${command.stageId} not found`,
    );
  }

  // The ledger is external to the stage transaction. A completed ledger row
  // must still retry its wake; this key commits with the wake and outbox event.
  // It records which row woke the stage: a ledger reset drops that row, so the
  // next signal completes a new one and that delivery must wake the stage too.
  const wake = async (record: StepRecord, alreadyCompleted: boolean) => {
    const delivery = record.updatedAt.getTime();
    await deps.persistence.withTransaction(async (tx) => {
      const key = signalWakeKey(stage.id, command.stepId);
      let claim = await tx.acquireIdempotencyKey(key, SIGNAL_WAKE);
      if (
        claim.status === "replay" &&
        (claim.result as { delivery?: number }).delivery !== delivery
      ) {
        await tx.releaseIdempotencyKey(key, SIGNAL_WAKE);
        claim = await tx.acquireIdempotencyKey(key, SIGNAL_WAKE);
      }
      if (claim.status === "replay") return;
      if (claim.status === "in_progress") {
        throw new Error(
          `Durable signal step "${command.stepId}" wake is in progress`,
        );
      }
      const event: KernelEvent = {
        type: "step:signalled",
        timestamp: deps.clock.now(),
        workflowRunId: command.workflowRunId,
        stageId: command.stageId,
        stepId: command.stepId,
        payload: record.result,
      };
      await tx.updateStage(stage.id, { nextPollAt: deps.clock.now() });
      await tx.appendOutboxEvents(
        toOutboxEvents(command.workflowRunId, [event]),
      );
      await tx.completeIdempotencyKey(key, SIGNAL_WAKE, {
        signalled: true,
        delivery,
      });
    });
    return {
      signalled: true as const,
      ok: true as const,
      alreadyCompleted,
      _events: [],
    };
  };

  const existing = await deps.stepLedger.get(stage.id, command.stepId);
  if (existing?.kind !== undefined && existing.kind !== "signal") {
    throw new Error(
      `Durable step "${command.stepId}" was previously used as ${existing.kind} and cannot receive a signal`,
    );
  }
  if (existing?.status === "failed") {
    throw new Error(
      `Durable signal step "${command.stepId}" has failed and cannot receive a signal`,
    );
  }
  if (existing?.status === "completed") {
    return wake(existing, true);
  }

  const payload = jsonRoundTrip(command.payload, command.stepId);
  if (existing) {
    const completed = await deps.stepLedger.compareAndSet(
      stage.id,
      command.stepId,
      { status: existing.status, attempt: existing.attempt },
      {
        status: "completed",
        result: payload,
        error: null,
        leaseExpiresAt: null,
      },
    );
    if (!completed.applied) {
      const winner = await deps.stepLedger.get(stage.id, command.stepId);
      if (winner?.status === "completed") {
        return wake(winner, true);
      }
      if (winner?.status === "failed") {
        throw new Error(
          `Durable signal step "${command.stepId}" has failed and cannot receive a signal`,
        );
      }
      throw new Error(`Durable signal step "${command.stepId}" changed state`);
    }
    return wake(completed.record!, false);
  } else {
    const claimed = await deps.stepLedger.claim({
      stageRecordId: stage.id,
      stepId: command.stepId,
      // External signals arrive before the stage knows their replay position.
      // seq=0 is treated as an unknown/wildcard position by StepApi.
      seq: 0,
      kind: "signal",
      status: "completed",
      attempt: 1,
      leaseExpiresAt: null,
      deadlineAt: null,
      result: payload,
    });
    if (!claimed.created) {
      if (claimed.record.kind !== "signal") {
        throw new Error(
          `Durable step "${command.stepId}" was previously used as ${claimed.record.kind} and cannot receive a signal`,
        );
      }
      if (claimed.record.status === "failed") {
        throw new Error(
          `Durable signal step "${command.stepId}" has failed and cannot receive a signal`,
        );
      }
      if (claimed.record.status === "completed") {
        return wake(claimed.record, true);
      }
      const completed = await deps.stepLedger.compareAndSet(
        stage.id,
        command.stepId,
        { status: claimed.record.status, attempt: claimed.record.attempt },
        {
          status: "completed",
          result: payload,
          error: null,
          leaseExpiresAt: null,
        },
      );
      if (!completed.applied) {
        const winner = await deps.stepLedger.get(stage.id, command.stepId);
        if (winner?.status === "completed") {
          return wake(winner, true);
        }
        if (winner?.status === "failed") {
          throw new Error(
            `Durable signal step "${command.stepId}" has failed and cannot receive a signal`,
          );
        }
        throw new Error(
          `Durable signal step "${command.stepId}" changed state`,
        );
      }
      return wake(completed.record!, false);
    }
    return wake(claimed.record, false);
  }
}
