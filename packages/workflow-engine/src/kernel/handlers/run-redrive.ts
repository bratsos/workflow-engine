/**
 * Handler: run.redrive
 *
 * The three verbs operators actually want, which Conductor factors as
 * `retry` / `restart` / `rerun`, on one command:
 *
 *  - `{ kind: "lastFailure" }` - resume at the first stage that is not
 *    COMPLETED, leaving completed stages untouched.
 *  - `{ kind: "start" }`       - re-run the whole pipeline from group 1.
 *  - `{ kind: "stage", ... }`  - resume at a chosen stage.
 *
 * Three things separate it from the `run.rerunFrom` it replaces.
 *
 * First, the superseded attempt is preserved. `run.rerunFrom` deleted the
 * failed stage row and every row after it, which destroyed the evidence of
 * the failure being retried. Here each superseded stage record is archived
 * as a stage-scoped annotation before it is touched, carrying its status,
 * error, timings, metrics and output pointer. Annotations already survive
 * stage deletion (`onDelete: SetNull` on the stage relation), already
 * carry `attempt`, and are already queryable through
 * `kernel.annotations.list` - so the failed attempt lands on the surface
 * built for exactly this rather than in a new table.
 *
 * Second, resuming keeps the progress the resumed stage made. For
 * `lastFailure` and `stage` the records of the target execution group are
 * not deleted and recreated: each is reopened in place - back to PENDING,
 * `attempt` bumped, the outcome of the old attempt cleared - so its step
 * ledger, keyed by that record's id, survives. Every `completed` step row
 * stays as it is (a stage that completed 9 of 10 steps re-runs the tenth,
 * and the external keys the nine were given still name their effects) and
 * every row naming an external effect is re-opened rather than dropped,
 * the way the engine's own job retry already treats an exhausted stage.
 * Stages in later groups are still removed. `start` keeps the full
 * replacement: every record goes, and every ledger with it.
 *
 * Third, with definition versioning in place a redrive may move the run
 * onto a different definition version - DBOS's fork-onto-a-new-
 * application-version, which is the answer to "we shipped a bug, patch it
 * and re-run". Step Functions' framing is followed for the rest: the same
 * run id, an incremented redrive count, no branching into a new
 * execution.
 */

import type { EngineBatchRef } from "../../ai/batch/model.js";
import type {
  CreateAnnotationInput,
  WorkflowStageRecord,
} from "../../persistence/interface";
import type {
  RunCancelBatchOutcome,
  RunRedriveCommand,
  RunRedriveFrom,
  RunRedriveResult,
} from "../commands";
import type { KernelEvent } from "../events";
import {
  hasCancelFence,
  isEngineOwned,
  isSubmitStepRow,
  owedRefsOf,
  parseStoredSubmit,
  settleOwedOnRow,
} from "../helpers/batch-submit-record.js";
import { writeBatchWarn } from "../helpers/batch-warn.js";
import {
  answeredOf,
  cancelBatchesNow,
  heldStepOutcomes,
  refsOfSuspendedState,
} from "../helpers/cancel-run-batches.js";
import {
  assertServesRun,
  recordDefinitionVersion,
} from "../helpers/definition-pinning.js";
import {
  applyStepLedgerReset,
  namesExternalEffect,
  outputKeys,
  planStepLedgerReset,
  prepareExecutionGroup,
  type StepLedgerResetPlan,
} from "../helpers/index.js";
import { isTransactionReadBound } from "../helpers/transaction-reads.js";
import type { HandlerResult, KernelDeps } from "../kernel";
import type { StepRecord } from "../ports";
import { SIGNAL_WAKE, signalWakeKey } from "./step-signal.js";

/**
 * A durable step row a redrive is about to drop that named an external
 * effect. The external key is the actionable part: it is what an operator
 * searches the provider with.
 */
interface AbandonedStep {
  stepId: string;
  status: StepRecord["status"];
  externalKey: string | null;
}

/** Why a redrive dropped rows naming an external effect. */
type AbandonReason = "deleted" | "fallback";

function toAbandoned(rows: readonly StepRecord[]): AbandonedStep[] {
  return rows.filter(namesExternalEffect).map((row) => ({
    stepId: row.stepId,
    status: row.status,
    externalKey: row.externalKey ?? null,
  }));
}

/** A batch a redrive cancels, as its log lines name it. */
function describeCancel(o: {
  stage: { stageId: string };
  row?: StepRecord;
  ref: EngineBatchRef;
}): string {
  return `"${o.ref.id}" (${o.ref.provider}, stage "${o.stage.stageId}"${o.row ? `, step "${o.row.stepId}"` : ""}${o.row?.externalKey ? `, external key ${o.row.externalKey}` : ""})`;
}

/** Annotation key under which a superseded stage attempt is archived. */
export const SUPERSEDED_ATTEMPT_KEY = "run.supersededAttempt";

/** Run states a redrive may start from. */
const REDRIVABLE = new Set(["COMPLETED", "FAILED", "CANCELLED"]);

/**
 * Resolves which stage the run resumes from. Returns the stage id; the
 * caller maps it to an execution group against the resolved definition.
 */
function resolveFromStageId(
  from: RunRedriveFrom,
  workflow: { getStagesInExecutionGroup(i: number): Array<{ id: string }> },
  existingStages: readonly WorkflowStageRecord[],
  workflowRunId: string,
): string {
  if (from.kind === "stage") return from.stageId;

  if (from.kind === "start") {
    const first = workflow.getStagesInExecutionGroup(1)[0];
    if (!first) {
      throw new Error(
        `Cannot restart run ${workflowRunId}: the workflow has no stages in execution group 1.`,
      );
    }
    return first.id;
  }

  // "lastFailure": the earliest stage record that did not complete.
  // `getStagesByRun` already orders by executionGroup then stageNumber.
  const firstIncomplete = existingStages.find((s) => s.status !== "COMPLETED");
  if (firstIncomplete) return firstIncomplete.stageId;

  const last = existingStages[existingStages.length - 1];
  if (!last) {
    throw new Error(
      `Cannot retry run ${workflowRunId}: it has no stage records to resume from. Use from: { kind: "start" } to run it from the beginning.`,
    );
  }
  // Every stage completed (a COMPLETED run being "retried"): re-run the
  // last one, which is what Conductor's retry does with a finished
  // workflow rather than refusing.
  return last.stageId;
}

/** Which run states a caller accepts, and how it refuses the others. */
export interface RedriveSourceStates {
  states: ReadonlySet<string>;
  refuse(status: string): string;
}

const REDRIVE_SOURCES: RedriveSourceStates = {
  states: REDRIVABLE,
  refuse: (status) =>
    `Cannot redrive a run in ${status} state. Must be COMPLETED, FAILED or CANCELLED.`,
};

export async function handleRunRedrive(
  command: RunRedriveCommand,
  deps: KernelDeps,
  sources: RedriveSourceStates = REDRIVE_SOURCES,
): Promise<HandlerResult<RunRedriveResult>> {
  const { workflowRunId } = command;
  const from: RunRedriveFrom = command.from ?? { kind: "lastFailure" };
  const events: KernelEvent[] = [];

  const run = await deps.persistence.getRun(workflowRunId);
  if (!run) throw new Error(`WorkflowRun ${workflowRunId} not found`);

  if (!sources.states.has(run.status)) {
    throw new Error(sources.refuse(run.status));
  }

  const workflow = deps.registry.getWorkflow(run.workflowId);
  if (!workflow) {
    throw new Error(`Workflow ${run.workflowId} not found in registry`);
  }

  // ── Which definition does the redriven run resolve against? ────────
  let definitionVersion = run.definitionVersion;
  if (command.definitionVersion === "latest") {
    // Re-pin to what this process serves, registering the snapshot if it
    // has not been seen before.
    definitionVersion = await recordDefinitionVersion(workflow, deps);
  } else if (command.definitionVersion !== undefined) {
    const stored = await deps.persistence.getDefinition(
      run.workflowId,
      command.definitionVersion,
    );
    if (!stored) {
      throw new Error(
        `Cannot redrive run ${workflowRunId} onto definition version "${command.definitionVersion}" of workflow "${run.workflowId}": no run has ever been created at that version, so its structure is not recorded.`,
      );
    }
    definitionVersion = command.definitionVersion;
  }

  // The stage graph the redrive is planned against must be the one the
  // run will actually execute under. Re-pinning to "latest" makes this
  // build authoritative by definition; otherwise this build has to
  // present the pinned version, or the redrive would plan against a
  // different shape than the host that eventually runs it.
  assertServesRun({ ...run, definitionVersion }, workflow);

  const existingStages = await deps.persistence.getStagesByRun(workflowRunId);
  const fromStageId = resolveFromStageId(
    from,
    workflow,
    existingStages,
    workflowRunId,
  );

  if (!workflow.getStage(fromStageId)) {
    throw new Error(
      `Stage ${fromStageId} not found in workflow ${run.workflowId}`,
    );
  }
  const targetGroup = workflow.getExecutionGroupIndex(fromStageId);

  if (targetGroup > 1) {
    const priorStages = existingStages.filter(
      (s) => s.executionGroup < targetGroup,
    );
    if (priorStages.length === 0) {
      throw new Error(
        `Cannot redrive from stage ${fromStageId}: previous stages have not been executed`,
      );
    }
  }

  const stagesToSupersede = existingStages.filter(
    (s) => s.executionGroup >= targetGroup,
  );
  const supersededStageIds = stagesToSupersede.map((s) => s.stageId);

  // ── Reopen or replace ──────────────────────────────────────────────
  // Resuming keeps the target group's records and the progress in their
  // ledgers; restarting from the beginning replaces everything. Records
  // in groups after the target go either way: nothing in them is progress
  // the resumed group can use, and `run.transition` recreates them.
  const reopen = from.kind !== "start";
  const stagesToReopen = reopen
    ? stagesToSupersede.filter((s) => s.executionGroup === targetGroup)
    : [];
  const stagesToDelete = stagesToSupersede.filter(
    (s) => !stagesToReopen.includes(s),
  );

  // ── What the redrive abandons ──────────────────────────────────────
  // A ledger row is keyed by its stage record's id, so the rows of a
  // deleted record cannot be kept and `_postCommit` clears them. A
  // reopened record keeps its rows through the same reset an exhausted
  // stage gets before a fresh attempt - unless the ledger cannot clear
  // selectively, in which case the rows go too. Either way a dropped row
  // naming an external effect may still hold the handle of a batch a
  // provider is processing and billing, and dropping it silently leaves
  // that effect with no record anywhere. So what is about to be dropped
  // is decided now, before anything is touched, and written down in the
  // same shape `job.execute` uses when a ledger cannot clear selectively:
  // step id, status and external key. Both a log and an annotation, since
  // logs rotate and the annotation stays on the run.
  const abandonedByStage = new Map<string, AbandonedStep[]>();
  const abandonReasons = new Set<AbandonReason>();
  const ledgerResets = new Map<string, StepLedgerResetPlan>();
  // Wake keys name a stage record id; a deleted record's are released with
  // its ledger, since no later signal or purge can find them.
  const deletedSignalSteps = new Map<string, string[]>();
  // Batches whose cancel is owed (`cancelOwed`, always safe to send: the step
  // lost them and never adopts them) or was asked for on a record this
  // redrive deletes. Read here because a deleted record takes its rows with
  // it; named on the run in this transaction, sent after the commit, and
  // reported in `batches`.
  //
  // On a CANCELLED run the cancel was asked for every batch of a stage that
  // had not completed: a sweep may still be running, and an intent it records
  // after these reads is deleted unread. So every batch such a sweep would
  // cancel on a deleted record (the engine-owned refs of its submit rows, its
  // legacy `suspendedState` refs) is sent here too, unless it is recorded as
  // cancelled. Nothing can adopt them: their key names a deleted record.
  const cancelAsked = run.status === "CANCELLED";
  const owedCancels: Array<{
    stage: (typeof existingStages)[number];
    /** Absent for a legacy stage's `suspendedState` batch. */
    row?: StepRecord;
    ref: EngineBatchRef;
    gone: boolean;
  }> = [];
  const addCancel = (entry: (typeof owedCancels)[number]) => {
    if (entry.ref.id.startsWith("batch-empty-")) return;
    if (
      owedCancels.some(
        (o) =>
          o.stage === entry.stage &&
          o.row === entry.row &&
          o.ref.id === entry.ref.id,
      )
    ) {
      return;
    }
    owedCancels.push(entry);
  };
  if (deps.stepLedger) {
    const ledger = deps.stepLedger;
    for (const stage of stagesToSupersede) {
      const rows = await ledger.list(stage.id).catch((error) => {
        if (isTransactionReadBound(ledger)) throw error;
        return [] as StepRecord[];
      });
      deletedSignalSteps.set(
        stage.id,
        rows.filter((row) => row.kind === "signal").map((row) => row.stepId),
      );
      let dropped: readonly StepRecord[] = rows;
      let reason: AbandonReason = "deleted";
      if (stagesToReopen.includes(stage)) {
        const plan = planStepLedgerReset(rows, ledger, "resume");
        ledgerResets.set(stage.id, plan);
        dropped = plan.dropped;
        reason = "fallback";
      }
      for (const row of rows) {
        if (!isSubmitStepRow(row)) continue;
        const gone = dropped.includes(row);
        // A kept row a sweep holds is reported `held` after the reset.
        if (!gone && row.status === "running" && hasCancelFence(row)) continue;
        const record = parseStoredSubmit(row.result);
        const done = record?.cancelledBatchIds ?? [];
        const refs: EngineBatchRef[] = [...owedRefsOf(row.result)];
        // A cancel was asked for on a row this redrive deletes: the batches
        // a sweep held, or the ones it recorded it may have sent to.
        if (gone && record?.cancelFence) refs.push(...record.refs);
        else if (gone && record?.cancelIntent) {
          const ids = record.cancelIntent.batchIds;
          refs.push(...record.refs.filter((ref) => ids.includes(ref.id)));
        }
        if (
          gone &&
          cancelAsked &&
          stage.status !== "COMPLETED" &&
          record &&
          isEngineOwned(row, record)
        ) {
          refs.push(...record.refs);
        }
        for (const ref of refs) {
          if (done.includes(ref.id)) continue;
          addCancel({ stage, row, ref, gone });
        }
      }
      const abandoned = toAbandoned(dropped);
      if (abandoned.length > 0) {
        abandonedByStage.set(stage.id, abandoned);
        abandonReasons.add(reason);
      }
    }
  }
  if (cancelAsked) {
    for (const stage of stagesToDelete) {
      if (stage.status === "COMPLETED") continue;
      for (const ref of refsOfSuspendedState(stage.suspendedState)) {
        addCancel({ stage, ref, gone: true });
      }
    }
  }

  // ── Preserve the attempt being superseded ──────────────────────────
  // Written before the stage rows are touched, in the same transaction,
  // so a rollback takes the archive with it.
  if (stagesToSupersede.length > 0) {
    const archive: CreateAnnotationInput[] = stagesToSupersede.map((stage) => ({
      workflowRunId,
      workflowStageRecordId: stage.id,
      attempt: stage.attempt,
      scope: "stage",
      scopeId: stage.stageId,
      actor: { kind: "engine", id: "run.redrive" },
      key: SUPERSEDED_ATTEMPT_KEY,
      value: stage.status,
      payload: {
        redriveCount: run.redriveCount + 1,
        stageRecordId: stage.id,
        stageNumber: stage.stageNumber,
        executionGroup: stage.executionGroup,
        attempt: stage.attempt,
        status: stage.status,
        errorMessage: stage.errorMessage,
        startedAt: stage.startedAt?.toISOString() ?? null,
        completedAt: stage.completedAt?.toISOString() ?? null,
        duration: stage.duration,
        metrics: stage.metrics,
        // The blob key, not the blob: the new attempt writes to the same
        // key, so this records that an output existed and where, not a
        // copy of it.
        outputData: stage.outputData,
        definitionVersion: run.definitionVersion,
        // Whether the record was reopened for the new attempt (its ledger
        // kept) or deleted (its ledger cleared).
        reopened: stagesToReopen.includes(stage),
        // Only present when the redrive drops a durable step row that
        // named an external effect. Absent is the normal case.
        ...(abandonedByStage.has(stage.id)
          ? { abandonedSteps: abandonedByStage.get(stage.id) }
          : {}),
      },
      idempotencyKey: `${SUPERSEDED_ATTEMPT_KEY}:${stage.id}:${stage.attempt}`,
    }));
    await deps.persistence.appendAnnotations(archive);
  }

  if (abandonedByStage.size > 0) {
    const steps = [...abandonedByStage.values()].flat();
    const reasons: string[] = [];
    if (abandonReasons.has("deleted")) {
      reasons.push(
        "their ledger rows are keyed by stage records this redrive deletes and cannot be kept",
      );
    }
    if (abandonReasons.has("fallback")) {
      reasons.push("this StepLedger cannot clear selectively");
    }
    await writeBatchWarn(
      deps.persistence,
      workflowRunId,
      `Redriving this run abandoned ${steps.length} durable step row(s) that named an ` +
        `external effect; ${reasons.join("; ")}. Any effect still in flight must be found ` +
        `by its external key.`,
      { steps },
    );
  }

  // The cancels are sent after the commit, which has deleted every record of
  // the ones marked deleted: a process that stops in between leaves those
  // batches running with nothing else naming them. So they are named here, on
  // the run, in the same transaction, and each outcome follows in its own line.
  if (owedCancels.length > 0) {
    const named = owedCancels.map(describeCancel);
    const gone = owedCancels.some((o) => o.gone);
    const kept = owedCancels.some((o) => !o.gone);
    await writeBatchWarn(
      deps.persistence,
      workflowRunId,
      `Redriving this run sends a cancel to provider batch(es) ${named.join("; ")}. A line naming each batch follows with the outcome of its cancel. If none follows for a batch, the redrive stopped before the provider answered: ${[
        ...(gone
          ? [
              "a batch of a record this redrive deletes has nothing else to cancel it, so cancel it at the provider",
            ]
          : []),
        ...(kept
          ? [
              "a batch owed on a step this redrive keeps stays owed there, and the step's next execution sends its cancel again",
            ]
          : []),
      ].join("; ")}.`,
      {
        batches: owedCancels.map((o) => ({
          stageId: o.stage.stageId,
          ...(o.row ? { stepId: o.row.stepId } : {}),
          ...(o.row?.externalKey ? { externalKey: o.row.externalKey } : {}),
          ref: o.ref,
          deleted: o.gone,
        })),
      },
    );
  }

  // Blob deletion is deferred to _postCommit: blob deletes are not part of
  // the database transaction and could not be rolled back with it. Only a
  // deleted record's blobs go: a reopened record's kept steps may hold
  // references into its own storage, and the output and artifacts of its
  // earlier attempts stay, under their own keys, for the archive's pointer.
  //
  // Keys an outputData points at are kept: a deleted record's, so a caller
  // whose own transaction rolls this redrive back finds its restored
  // pointers intact, and a current record's, so a new attempt that
  // completed before the cleanup (a caller-owned job.execute) keeps its
  // output. Kept keys go with run.purge. Listing waits for the commit: an unbound blob store read
  // inside the transaction can wait on the transaction's own lock.
  const deletedOutputKeys = stagesToDelete.flatMap(outputKeys);
  const blobPrefixesToDelete = stagesToDelete.map(
    (stage) =>
      `workflow-v2/${run.workflowType}/${workflowRunId}/${stage.stageId}/`,
  );

  for (const stage of stagesToDelete) {
    // In this transaction: nothing can name a deleted record afterwards.
    for (const stepId of deletedSignalSteps.get(stage.id) ?? []) {
      await deps.persistence.releaseIdempotencyKey(
        signalWakeKey(stage.id, stepId),
        SIGNAL_WAKE,
      );
    }
    await deps.persistence.deleteStage(stage.id);
  }

  // A reopened record goes back to what a record that has never run looks
  // like - PENDING, no outcome - on its next attempt, fenced on the
  // version this handler read so a concurrent write to the row is not
  // silently overwritten. `startedAt` is left for `job.execute` to stamp.
  for (const stage of stagesToReopen) {
    await deps.persistence.updateStage(stage.id, {
      status: "PENDING",
      attempt: stage.attempt + 1,
      errorMessage: null,
      completedAt: null,
      duration: null,
      outputData: null,
      suspendedState: null,
      resumeData: null,
      nextPollAt: null,
      metrics: null,
      embeddingInfo: null,
      expectedVersion: stage.version,
    });
  }

  await deps.persistence.updateRun(workflowRunId, {
    status: "RUNNING",
    startedAt: deps.clock.now(),
    completedAt: null,
    duration: null,
    output: null,
    totalCost: 0,
    totalTokens: 0,
    redriveCount: run.redriveCount + 1,
    ...(definitionVersion !== run.definitionVersion
      ? { definitionVersion }
      : {}),
    // The status checked above must still hold when the run reopens.
    expectedVersion: run.version,
  });

  // Restarting replaced every record, so the group is created outright and
  // enqueued unconditionally. Resuming reopened the group's records in
  // place (they are PENDING now), so the group is upserted - which also
  // creates a record for a stage the target definition version added -
  // and every PENDING record is enqueued.
  const enqueue = await prepareExecutionGroup(
    { ...run, definitionVersion },
    workflow,
    deps,
    reopen
      ? {
          groupIndex: targetGroup,
          attemptMode: "max+1",
          createMode: "upsert",
          attemptSourceStages: stagesToReopen,
        }
      : {
          groupIndex: targetGroup,
          attemptMode: "max+1",
          createMode: "create",
          filterPending: false,
          attemptSourceStages: stagesToSupersede,
        },
  );

  events.push({
    type: "workflow:started",
    timestamp: deps.clock.now(),
    workflowRunId,
  });

  return {
    workflowRunId,
    fromStageId,
    supersededStages: supersededStageIds,
    redriveCount: run.redriveCount + 1,
    definitionVersion,
    _events: events,
    _postCommit: async (postDeps) => {
      await postDeps.jobTransport.deleteByRunAndStages(
        workflowRunId,
        supersededStageIds,
      );

      // A deleted record's ledger is cleared, not archived: its rows are
      // keyed by a stage record id nothing will ever look up again, and
      // stages in groups after the target are never recreated. What
      // survives is the annotation archive above, which is the queryable
      // record of the superseded attempt. A reopened record's ledger gets
      // the reset planned above: completed rows and rows naming an
      // external effect stay, the rest go.
      for (const stage of stagesToDelete) {
        await postDeps.stepLedger?.clear(stage.id);
      }
      // A submit step a run.cancel sweep holds is left to it (see
      // `applyStepLedgerReset`); the redriven step waits for it, and the
      // caller is told until when.
      const held: RunCancelBatchOutcome[] = [];
      if (postDeps.stepLedger) {
        const ledger = postDeps.stepLedger;
        for (const [stageRecordId, plan] of ledgerResets) {
          await applyStepLedgerReset(ledger, stageRecordId, plan);
          const stageId = stagesToReopen.find(
            (s) => s.id === stageRecordId,
          )!.stageId;
          for (const row of plan.reopen) {
            if (row.status !== "running" || !hasCancelFence(row)) continue;
            const current = await ledger
              .get(stageRecordId, row.stepId)
              .catch(() => null);
            if (!current) continue;
            held.push(
              ...heldStepOutcomes(
                stageId,
                current,
                postDeps.clock.now(),
                (until) =>
                  `a run.cancel sweep holds this step until ${until} (it may have stopped while holding it); the redriven step waits until the sweep gives it back or the hold ends, then completes any cancel the sweep recorded and goes on`,
              ),
            );
          }
        }
      }

      for (const prefix of blobPrefixesToDelete) {
        const keys = await postDeps.blobStore
          .list(prefix)
          .catch(() => [] as string[]);
        if (keys.length === 0) continue;
        // Read after listing: a pointer committed before this read keeps
        // the listed key it names. Unreadable, nothing here is deleted.
        const current = await postDeps.persistence
          .getStagesByRun(workflowRunId)
          .catch(() => null);
        if (!current) continue;
        const kept = new Set([
          ...deletedOutputKeys,
          ...current.flatMap(outputKeys),
        ]);
        for (const key of keys) {
          if (kept.has(key)) continue;
          await postDeps.blobStore.delete(key).catch(() => {});
        }
      }

      await enqueue(postDeps);

      // The cancels collected above, after the run is enqueued (they do not
      // hold it up), with no gate: nothing can adopt these batches.
      const verdicts = await cancelBatchesNow(
        postDeps,
        owedCancels.map((o) => o.ref),
      );
      const cancels: RunCancelBatchOutcome[] = [];
      for (const [i, o] of owedCancels.entries()) {
        const verdict = verdicts[i]!;
        const answered =
          verdict.status === "cancelled" ||
          verdict.status === "already-terminal";
        const outcome: RunCancelBatchOutcome = {
          stageId: o.stage.stageId,
          ...(o.row ? { stepId: o.row.stepId } : {}),
          ...(o.row?.externalKey ? { externalKey: o.row.externalKey } : {}),
          ref: o.ref,
          ...verdict,
          ...(!answered
            ? {
                error: `${verdict.error ? `${verdict.error}; ` : ""}${o.gone ? "this redrive deleted the record that named it, so nothing else will cancel this batch" : "the cancel stays owed on the step, and the step's next execution sends it again"}`,
              }
            : {}),
        };
        cancels.push(outcome);
        if (answered) {
          await postDeps.persistence
            .createLog({
              workflowRunId,
              level: "INFO",
              message: `Redriving this run: provider batch ${describeCancel(o)} ${verdict.status === "cancelled" ? "was cancelled" : "had already ended"}.`,
              metadata: { ...outcome },
            })
            .catch(() => {});
        } else {
          await writeBatchWarn(
            postDeps.persistence,
            workflowRunId,
            `Redriving this run: provider batch ${describeCancel(o)} was not cancelled (${verdict.status}: ${outcome.error}). It may still be running and billed; cancel it at the provider.`,
            { ...outcome },
          );
        }
      }
      if (postDeps.stepLedger) {
        const kept = new Map<StepRecord, EngineBatchRef[]>();
        for (const o of owedCancels) {
          if (!o.gone && o.row) {
            kept.set(o.row, [...(kept.get(o.row) ?? []), o.ref]);
          }
        }
        for (const [row, refs] of kept) {
          const verdictOf = (ref: EngineBatchRef) =>
            verdicts[
              owedCancels.findIndex((o) => o.row === row && o.ref === ref)
            ];
          await settleOwedOnRow(
            postDeps.stepLedger,
            row.stageRecordId,
            row.stepId,
            answeredOf(refs, verdictOf),
            postDeps.clock.now(),
          ).catch(() => {});
        }
      }

      return [...held, ...cancels];
    },
  };
}
