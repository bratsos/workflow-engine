import {
  StepResultNotSerializable,
  StepTimeoutError,
} from "../../core/steps.js";
import type { StepSignalCommand, StepSignalResult } from "../commands.js";
import type { KernelEvent } from "../events.js";
import { toOutboxEvents } from "../helpers/outbox-events.js";
import { fenceRunWrites, openRunWriter } from "../helpers/run-writes.js";
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

  // The ledger write can spill the payload to the blob store, outside any
  // transaction. Registered as a writer of the run (as `job.execute` is), the
  // sender holds off erasure until it has written. A run that has ended
  // admits no writer: its sender answers as it always did and writes nothing
  // (a late signal, such as a webhook retry, is routine). A run that is gone
  // is left to the fenced writes, which refuse.
  const writer = await openRunWriter(deps.persistence, command.workflowRunId);
  try {
    const ended =
      !writer.held &&
      Boolean(await deps.persistence.getRun(command.workflowRunId));
    const fenced = fenceRunWrites(deps, command.workflowRunId, writer);
    return await deliverSignal(
      command,
      { ...fenced, stepLedger: fenced.stepLedger ?? ledger },
      stage,
      ended,
    );
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
  } finally {
    await writer.close();
  }
}

async function deliverSignal(
  command: StepSignalCommand,
  deps: KernelDeps & { stepLedger: StepLedger },
  stage: WorkflowStageRecord,
  ended: boolean,
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

  // The answer of a run that has ended, without the wake the same call makes
  // on a live one. A stage that went while this read has nothing for the
  // writes to land on, and they would have failed.
  const answered = async (
    alreadyCompleted: boolean,
  ): Promise<HandlerResult<StepSignalResult>> => {
    const current = await deps.persistence.getStage(
      command.workflowRunId,
      command.stageId,
    );
    if (current?.id !== stage.id) {
      throw new Error(
        `Workflow stage ${command.workflowRunId}/${command.stageId} not found`,
      );
    }
    return {
      signalled: true,
      ok: true,
      alreadyCompleted,
      _events: [],
    };
  };

  const timedOut = (): HandlerResult<StepSignalResult> => ({
    ok: true,
    signalled: false,
    alreadyCompleted: true,
    timedOut: true,
    _events: [],
  });
  const finish = async (
    record: StepRecord,
    alreadyCompleted: boolean,
  ): Promise<HandlerResult<StepSignalResult>> => {
    if (record.waitState?.timedOut) return timedOut();
    return ended ? answered(alreadyCompleted) : wake(record, alreadyCompleted);
  };
  // Only a deadline fails a wait row. With an explicit `onTimeout` the
  // sender gets the same refusal as before the poller recorded it.
  const failed = (record: StepRecord): HandlerResult<StepSignalResult> => {
    if (
      record.waitState?.onTimeout !== undefined &&
      record.error === new StepTimeoutError(record.stepId).message
    ) {
      return timedOut();
    }
    throw new Error(
      `Durable signal step "${command.stepId}" has failed and cannot receive a signal`,
    );
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
    if (record.status === "failed") return failed(record);
    if (record.status === "completed") return finish(record, true);

    // From its deadline on, a wait with an explicit `onTimeout` can only
    // settle as timed out, the verdict the poller and the stage replay reach.
    // A "throw" wait is left for them to fail where they always have.
    const expired =
      record.status === "pending" &&
      record.waitState?.onTimeout !== undefined &&
      record.deadlineAt !== null &&
      record.deadlineAt <= deps.clock.now();
    if (expired && record.waitState?.onTimeout !== "return") return timedOut();
    if (ended) {
      // Without the write that settles it, the answer is the one it leads to.
      if (expired) return timedOut();
      payload();
      return answered(false);
    }
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
      if (winner?.status === "failed") return failed(winner);
      throw new Error(`Durable signal step "${command.stepId}" changed state`);
    }
    return finish(completed.record!, false);
  };

  const readPayload = () => jsonRoundTrip(command.payload, command.stepId);
  const existing = await deps.stepLedger.get(stage.id, command.stepId);
  if (existing) return completeExisting(existing, readPayload);

  const payload = readPayload();
  if (ended) return answered(false);
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
