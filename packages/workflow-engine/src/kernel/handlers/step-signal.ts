import { StepResultNotSerializable } from "../../core/steps.js";
import type { StepSignalCommand, StepSignalResult } from "../commands.js";
import type { KernelEvent } from "../events.js";
import { toOutboxEvents } from "../helpers/outbox-events.js";
import type { HandlerResult, KernelDeps } from "../kernel.js";

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
  const wake = async (payload: unknown, alreadyCompleted: boolean) => {
    await deps.persistence.withTransaction(async (tx) => {
      const key = JSON.stringify([stage.id, command.stepId]);
      const claim = await tx.acquireIdempotencyKey(key, "step.signal.wake");
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
        payload,
      };
      await tx.updateStage(stage.id, { nextPollAt: deps.clock.now() });
      await tx.appendOutboxEvents(
        toOutboxEvents(command.workflowRunId, [event]),
      );
      await tx.completeIdempotencyKey(key, "step.signal.wake", {
        signalled: true,
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
    return wake(existing.result, true);
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
        return wake(winner.result, true);
      }
      if (winner?.status === "failed") {
        throw new Error(
          `Durable signal step "${command.stepId}" has failed and cannot receive a signal`,
        );
      }
      throw new Error(`Durable signal step "${command.stepId}" changed state`);
    }
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
        return wake(claimed.record.result, true);
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
          return wake(winner.result, true);
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
    }
  }

  return wake(payload, false);
}
