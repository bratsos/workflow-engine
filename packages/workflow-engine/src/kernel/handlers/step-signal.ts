import { StepResultNotSerializable } from "../../core/steps.js";
import type { StepSignalCommand, StepSignalResult } from "../commands.js";
import type { KernelEvent } from "../events.js";
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
    return {
      signalled: true,
      ok: true,
      alreadyCompleted: true,
      _events: [],
    };
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
        return {
          signalled: true,
          ok: true,
          alreadyCompleted: true,
          _events: [],
        };
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
        return {
          signalled: true,
          ok: true,
          alreadyCompleted: true,
          _events: [],
        };
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
          return {
            signalled: true,
            ok: true,
            alreadyCompleted: true,
            _events: [],
          };
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

  await deps.persistence.updateStage(stage.id, {
    nextPollAt: deps.clock.now(),
  });

  const event: KernelEvent = {
    type: "step:signalled",
    timestamp: deps.clock.now(),
    workflowRunId: command.workflowRunId,
    stageId: command.stageId,
    stepId: command.stepId,
    payload,
  };
  return {
    signalled: true,
    ok: true,
    alreadyCompleted: false,
    _events: [event],
  };
}
