import {
  StepResultNotSerializable,
  StepTimeoutError,
} from "../../core/steps.js";
import type { StepSignalCommand, StepSignalResult } from "../commands.js";
import type { KernelEvent } from "../events.js";
import { toOutboxEvents } from "../helpers/outbox-events.js";
import { waitTimeoutPatch } from "../helpers/step-api.js";
import type { HandlerResult, KernelDeps } from "../kernel.js";
import type { StepLedger, StepRecord, WorkflowStageRecord } from "../ports.js";

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
  const ledger = deps.stepLedger;
  if (!ledger) {
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

  try {
    return await deliverSignal(command, { ...deps, stepLedger: ledger }, stage);
  } catch (error) {
    // The record went (purge, restart) after the read above: whatever this
    // delivery wrote under it has no row left to name it, and whoever
    // deleted the record may have cleaned up before the write landed.
    const current = await deps.persistence
      .getStage(command.workflowRunId, command.stageId)
      .catch(() => stage);
    if (current?.id !== stage.id) {
      await ledger.clear(stage.id).catch(() => {});
      await deps.persistence
        .releaseIdempotencyKey(
          signalWakeKey(stage.id, command.stepId),
          SIGNAL_WAKE,
        )
        .catch(() => {});
    }
    throw error;
  }
}

async function deliverSignal(
  command: StepSignalCommand,
  deps: KernelDeps & { stepLedger: StepLedger },
  stage: WorkflowStageRecord,
): Promise<HandlerResult<StepSignalResult>> {
  // The ledger is external to the stage transaction. A completed ledger row
  // must still retry its wake; this key commits with the wake and outbox event.
  // It records which row woke the stage: a ledger reset drops that row, so the
  // next signal completes a new one and that delivery must wake the stage too.
  // A row is told apart by its completion time and, for a replacement written
  // in the same tick, by its creation time, position and attempt. A claim
  // stored before `row` existed carries `delivery` alone and stays valid.
  const wake = async (record: StepRecord, alreadyCompleted: boolean) => {
    const delivery = record.updatedAt.getTime();
    const row = [record.createdAt.getTime(), record.seq, record.attempt];
    await deps.persistence.withTransaction(async (tx) => {
      const key = signalWakeKey(stage.id, command.stepId);
      let claim = await tx.acquireIdempotencyKey(key, SIGNAL_WAKE);
      if (claim.status === "replay") {
        const woken = claim.result as { delivery?: number; row?: number[] };
        if (
          woken.delivery !== delivery ||
          (woken.row && woken.row.join() !== row.join())
        ) {
          await tx.releaseIdempotencyKey(key, SIGNAL_WAKE);
          claim = await tx.acquireIdempotencyKey(key, SIGNAL_WAKE);
        }
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
      await tx.completeIdempotencyKey(
        key,
        SIGNAL_WAKE,
        { signalled: true, delivery, row },
        command.workflowRunId,
      );
    });
    return {
      signalled: true as const,
      ok: true as const,
      alreadyCompleted,
      _events: [],
    };
  };

  const finish = async (
    record: StepRecord,
    alreadyCompleted: boolean,
  ): Promise<HandlerResult<StepSignalResult>> => {
    if (record.waitState?.timedOut) {
      return {
        ok: true,
        signalled: false,
        alreadyCompleted: true,
        timedOut: true,
        _events: [],
      };
    }
    return wake(record, alreadyCompleted);
  };

  const completeExisting = async (
    record: StepRecord,
    payload: () => unknown,
  ) => {
    if (record.kind !== "signal") {
      throw new Error(
        `Durable step "${command.stepId}" was previously used as ${record.kind} and cannot receive a signal`,
      );
    }
    if (record.status === "failed") {
      throw new Error(
        `Durable signal step "${command.stepId}" has failed and cannot receive a signal`,
      );
    }
    if (record.status === "completed") return finish(record, true);

    // At the deadline the signal and poller still race for the pending
    // row. After that tick an opted-in wait can only settle as timed out.
    const expired =
      record.status === "pending" &&
      record.waitState?.onTimeout === "return" &&
      record.deadlineAt !== null &&
      record.deadlineAt < deps.clock.now();
    const completed = await deps.stepLedger.compareAndSet(
      stage.id,
      command.stepId,
      { status: record.status, attempt: record.attempt },
      expired
        ? waitTimeoutPatch(record, new StepTimeoutError(record.stepId))
        : {
            status: "completed",
            result: payload(),
            error: null,
            leaseExpiresAt: null,
          },
    );
    if (!completed.applied) {
      const winner = await deps.stepLedger.get(stage.id, command.stepId);
      if (winner?.status === "completed") {
        return finish(winner, true);
      }
      if (winner?.status === "failed") {
        throw new Error(
          `Durable signal step "${command.stepId}" has failed and cannot receive a signal`,
        );
      }
      throw new Error(`Durable signal step "${command.stepId}" changed state`);
    }
    return finish(completed.record!, false);
  };

  const readPayload = () => jsonRoundTrip(command.payload, command.stepId);
  const existing = await deps.stepLedger.get(stage.id, command.stepId);
  if (existing) return completeExisting(existing, readPayload);

  const payload = readPayload();
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
    return completeExisting(claimed.record, () => payload);
  }
  return wake(claimed.record, false);
}
