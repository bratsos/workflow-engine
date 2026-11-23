/**
 * Cancelling the provider batches a run created, once its run is CANCELLED.
 *
 * A batch is billed from the moment the provider accepts it, so a run that is
 * cancelled while its `ctx.step.ai.map` waits on one must stop it, not only
 * mark the run. The sweep never throws: the run is already CANCELLED, and a
 * provider that cannot cancel must not undo that.
 *
 * WHEN IT RUNS. `run.cancel` runs it after its commit (`_postCommit`), and a
 * repeated `run.cancel` on a CANCELLED run runs it again. It also runs wherever
 * a handler that executed a stage body finds the run CANCELLED afterwards,
 * because a body in another process can create a batch after the sweep read the
 * ledger (its abort signal had not fired yet): the four `ghost` exits of
 * `job.execute` that follow a body, a `stage.pollSuspended` replay or legacy
 * `checkCompletion` whose stage row the cancel moved while it ran, and both CANCELLED branches of
 * `handleClaimOutcome`, which every `stage.pollSuspended` replay ends in. The
 * handle such a body recorded is then in the ledger and is found here.
 *
 * WHICH CANCEL IT BELONGS TO. The sweep is tied to the run generation it was
 * started for: `redriveCount` of the run, with the run CANCELLED. A sweep held
 * up past a `run.redrive` (a slow provider, a slow job update) must not cancel
 * the batch of a run that is RUNNING again, so it checks the generation before
 * it reads anything, after it has taken hold of the ledger rows, and before
 * each provider call, and gives up silently when the run has moved on.
 *
 * Where the batches are:
 * - Durable steps. `ctx.step.ai.map` stores its submit as the step-ledger row
 *   `${id}:submit` (see `batch-submit-record.ts`). A record is cancelled only
 *   when the engine can prove it wrote it: its `externalKey` equals the row's.
 *   An ordinary step that memoised a handle of its own, and a record written
 *   before the field existed, is reported as `unverified` and left alone. A
 *   submit step that holds no handle (executing, or failed before it recorded
 *   one) is reported as `unrecorded` with its external key: a batch may exist
 *   that the engine cannot name.
 * - Legacy async-batch stages keep their handle in `suspendedState`. The
 *   documented place for the refs is `suspendedState.metadata.batchRefs`
 *   (`handle.refs`); the stage declares them there for the engine, and they are
 *   cancelled too. A stage that keeps its handle anywhere else owns its provider
 *   cancel (`AIBatch.cancel`). They have no ledger row to hold, so the
 *   generation checks are their fence, and what keeps them safe is that
 *   `run.redrive` clears `suspendedState` and restarts the stage, which submits
 *   a new batch and never resumes the old handle: a stale cancel can only hit
 *   the dead batch of the cancelled attempt, never the new one, because refs
 *   read between two generation checks all belong to one generation.
 * - The same batch can be listed by several owners (a row and a stage's
 *   `suspendedState`, or two rows). It is cancelled once and reported for each
 *   owner, and every owning row is finalised.
 *
 * How a ref gets a transport: `KernelServices.batchModels`, else the built-in
 * transport named by the ref's `provider` and `modelId`, with credentials from
 * the environment. The process that cancels need not be the one that ran the
 * stage. When no transport can be built the batch is `unavailable`.
 *
 * Every batch ends up with one outcome (see `RunCancelBatchStatus`), and each
 * one that may still be running gets a WARN log on the run. Repeating the
 * command is the recovery: the sweep re-reads every batch, so one that is
 * already cancelling, cancelled or ended is reported as such and not re-sent.
 *
 * LATENCY. The provider calls are bounded twice: each batch gets
 * `batchMs` (default 30 s) for resolving its transport, reading the batch and
 * cancelling it, and the whole sweep gets `sweepMs` (default 60 s). A batch the
 * sweep did not reach, or whose call outlived its budget, is reported as
 * `failed` with the reason. The calls run four at a time, so the provider time
 * of one sweep is at most `sweepMs`; `run.cancel` adds only its database reads
 * and writes to that.
 *
 * HOLDING THE ROWS. Before the first provider call the sweep takes hold of every
 * submit row it will act on, as a takeover: one compare-and-set from the row's
 * status and attempt to `running`, `attempt + 1`, a lease that starts when the
 * row is taken (not when the scan began) and a `cancelFence`. The attempt is
 * what makes the hold belong to one sweep: two sweeps that read the same row
 * (an expired fence included) cannot both take it, and every later write of
 * the sweep is pinned to `(running, its attempt)`, so a sweep whose hold was
 * taken over writes nothing more and reports the batch `failed`. A replay of
 * the step meets an executing step and waits, and the ledger reset
 * (`run.redrive`) leaves the row alone. Attempt-relative markers on the row
 * (the tombstone, the step's failure record) move with the attempt.
 *
 * INTENT BEFORE EFFECT. Before the provider call for a batch, the sweep adds
 * its id to the row's `cancelIntent` (with the status the row was held from).
 * Only after that write applied, the run generation was checked again, the
 * call fits inside the hold and the batch budget is not spent, is the request
 * sent. A write that did not apply sends nothing. When the sweep releases a row
 * it removes from the intent each batch whose cancel it confirmed (`cancelled`)
 * or found ended (`already-terminal`); a batch whose answer was an error or
 * never came stays in it, and the row is re-opened (`running`, no lease), so
 * no replay continues on a batch a cancel may have reached.
 *
 * A SWEEP THAT DIED. A process that dies between taking hold of a row and its
 * last write (a serverless limit is shorter than the sweep budget), or whose
 * final write fails, leaves the row `running` with its fence, and with an intent
 * for every batch a request may have left for. Whoever meets it completes the
 * cancel, never as an ordinary reclaim:
 * - the next sweep takes the row over (`attempt + 1` again, keeping the status
 *   it was first held from), repeats the cancel (idempotent: the transports
 *   read the batch first, so a cancel that landed is reported `cancelled`, a
 *   batch that ended `already-terminal`) and releases the row as an
 *   uninterrupted sweep would;
 * - the ledger reset leaves the row as it is;
 * - the submit step (`step-ai.ts`) sends the cancel again for every batch in the
 *   intent before it does anything. Batches confirmed cancelled are recorded and,
 *   when that is all of them, tombstoned and replaced; batches that had ended are
 *   collected. When the cancel cannot be completed (the transport throws, has no
 *   cancel call or answers `unsupported`) the step fails retryably with a WARN
 *   and keeps the fence and the intent; its next attempt tries again. A row with
 *   a fence and no intent sent nothing, and the step continues on its batches.
 *
 * AFTER A BATCH IS CANCELLED. `run.redrive` keeps a stage's completed steps, so
 * without the following it would replay the stored submit and wait on a dead
 * batch. For each submit row the sweep records the ids it cancelled in
 * `cancelledBatchIds` (a search for the step's external key never returns one,
 * even while a provider that cancels asynchronously still lists it as running),
 * re-opens a completed row (`running`, no lease), and decides by what it
 * confirmed:
 * - every batch of the row cancelled (or found already cancelled): the record
 *   gets the `engineCancelled` tombstone. The next execution of the submit
 *   creates a new batch on every transport, never adopting or waiting on the
 *   old one, and its poll and collect steps are numbered by generation so rows
 *   the old batch left behind are not replayed. See `batch-submit-record.ts`.
 * - only some batches cancelled: no tombstone, so the submit runs with
 *   `isReclaim: true` and adopts per batch: transports that can adopt keep the
 *   live ones and replace the cancelled ones, and a transport that cannot adopt
 *   refuses, as for a crashed submit.
 * - none cancelled and none left in the intent (`unavailable`, `unsupported`,
 *   a call that was never sent, or a batch that ended on its own): the row is
 *   restored as it was, so a redrive waits on the live batch or collects the
 *   finished one. A batch whose request was sent and whose answer is unknown
 *   stays in the intent (above), and the step completes the cancel first.
 */

import {
  type EngineBatchModel,
  type EngineBatchRef,
  EngineBatchRefSchema,
} from "../../ai/batch/model.js";
import { resolveBatchModelForRef } from "../../ai/batch/resolve-ref.js";
import {
  knownProviderBatchStatus,
  providerError,
} from "../../ai/provider-diagnostics.js";
import type {
  RunCancelBatchOutcome,
  RunCancelBatchStatus,
} from "../commands.js";
import type { KernelDeps } from "../kernel.js";
import type { StepRecord, StepRecordPatch } from "../ports.js";
import { listStepRows } from "../spill.js";
import {
  isEngineOwned,
  isFencedBySweep,
  isSubmitStepRow,
  markerBases,
  owedRefsOf,
  parseStoredSubmit,
  rebaseMarkers,
  type StoredSubmit,
  settleOwed,
  settleOwedOnRow,
} from "./batch-submit-record.js";
import { writeBatchWarn } from "./batch-warn.js";
import { toErrorMessage } from "./error-message.js";

/** Concurrent provider conversations per sweep. */
const CONCURRENCY = 4;
/** Default budget of one batch: resolve its transport, read it, cancel it. */
const DEFAULT_BATCH_MS = 30_000;
/** Default budget of the whole sweep. */
const DEFAULT_SWEEP_MS = 60_000;

/** The refs a legacy stage persisted in `suspendedState.metadata.batchRefs`. */
export function refsOfSuspendedState(state: unknown): EngineBatchRef[] {
  const refs = (state as { metadata?: { batchRefs?: unknown } } | null)
    ?.metadata?.batchRefs;
  if (!Array.isArray(refs)) return [];
  return refs.flatMap((raw) => {
    const parsed = EngineBatchRefSchema.safeParse(raw);
    return parsed.success ? [parsed.data] : [];
  });
}

/**
 * Who lists a batch: a stage's `suspendedState` (no row), a submit row the
 * sweep holds (`row`), or a submit row that owes the batch a cancel
 * (`owedOn`, the row as the scan read it: `cancelOwed`). An owed batch was
 * lost by an execution of its step and is never adopted or waited on, so its
 * cancel is sent whatever the run has become since.
 */
interface Owner {
  stageId: string;
  stageRecordId: string;
  row?: StepRecord;
  owedOn?: StepRecord;
}

interface Target {
  ref: EngineBatchRef;
  owners: Owner[];
}

/** A submit row the sweep holds. */
interface HeldRow {
  /** The row as the scan read it. */
  row: StepRecord;
  record: StoredSubmit;
  stageId: string;
  /** The status the row was held from: what a write-back restores. */
  baseStatus: StepRecord["status"];
  /** The attempt the row's markers count from while it is held. */
  fromAttempt: number;
  /** The attempt the hold took the row at: every later write is pinned to it. */
  attempt: number;
  /** When the hold's lease expires. */
  until: Date;
  /** The row's `result` as this sweep last wrote it. */
  result: Record<string, unknown>;
  /** Batch ids a cancel request may have left this process for. */
  sent: Set<string>;
  /** This sweep's writes to the row, one after the other. */
  chain: Promise<unknown>;
  /** A pinned write did not apply: the row is no longer this sweep's. */
  lost: boolean;
  /**
   * ...because the row is gone: a redrive deleted its stage record. The
   * batches' external key named that record, so no execution can find them
   * again; their cancels are sent without a record (`sendForGoneRows`).
   */
  gone?: boolean;
  /** Batches the row owed a cancel when the scan read it (`cancelOwed`). */
  owed: EngineBatchRef[];
}

const ROW_GONE = "the step's row is gone";

const refKey = (ref: EngineBatchRef) =>
  [ref.provider, ref.modelId, ref.id].join("\u0000");

const union = (...lists: Array<readonly string[] | undefined>) => [
  ...new Set(lists.flatMap((list) => list ?? [])),
];

async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]!);
      }
    }),
  );
  return out;
}

/**
 * Run `work` with a signal that aborts, and a result that rejects, once `ms`
 * has passed. The rejection does not depend on `work` honouring the signal: a
 * transport that ignores it cannot hold the sweep up.
 */
async function withinBudget<T>(
  ms: number,
  work: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error(`did not finish within ${ms} ms`);
      controller.abort(error);
      reject(error);
    }, ms);
  });
  try {
    return await Promise.race([work(controller.signal), expired]);
  } finally {
    clearTimeout(timer);
  }
}

/** The AI SDK throws this when it finds no API key; the batch is then unreachable from here. */
function isMissingCredentials(error: unknown): boolean {
  return error instanceof Error && error.name === "AI_LoadAPIKeyError";
}

export type Verdict = Pick<
  RunCancelBatchOutcome,
  "status" | "providerStatus" | "error"
>;

export interface CancelRunBatchesOptions {
  /**
   * The `redriveCount` of the cancelled run this sweep belongs to. Read from
   * the run when absent. A sweep whose run has been redriven since does nothing.
   */
  generation?: number;
}

const stillRunning: Record<
  Exclude<RunCancelBatchStatus, "cancelled" | "already-terminal">,
  string
> = {
  unsupported:
    "its transport has no cancel call, so it keeps running and billing",
  unavailable: "no transport for it could be built in this process",
  failed: "the provider call failed",
  unrecorded:
    "its submit step holds no batch handle, so a batch may exist that the engine cannot name",
  unverified:
    "the engine cannot prove it created it (the step record carries no ownership marker), so it was left alone",
  held: "another run.cancel sweep holds its submit step",
};

/**
 * Send a cancel for each of `refs` now, each within the per-batch budget,
 * with no record and no check of the run: for batches nothing else can reach
 * (their row is gone) or that are owed a cancel. Never rejects.
 */
export async function cancelBatchesNow(
  deps: Pick<KernelDeps, "services">,
  refs: readonly EngineBatchRef[],
): Promise<Verdict[]> {
  const batchMs =
    deps.services?.batchCancelTimeouts?.batchMs ?? DEFAULT_BATCH_MS;
  const resolve = deps.services?.batchModels ?? resolveBatchModelForRef;
  return mapLimit(refs, CONCURRENCY, async (ref) => {
    try {
      return await withinBudget(batchMs, async (signal): Promise<Verdict> => {
        let model: EngineBatchModel | undefined;
        try {
          model = await resolve(ref);
        } catch (error) {
          return {
            status: "unavailable",
            error: providerError(
              error,
              "The batch transport could not be resolved",
            ).message,
          };
        }
        if (!model) {
          return {
            status: "unavailable",
            error: `No batch transport resolves provider "${ref.provider}" in this process.`,
          };
        }
        if (!model.cancel) return { status: "unsupported" };
        try {
          const result = await model.cancel(ref, { abortSignal: signal });
          const providerStatus = knownProviderBatchStatus(result.rawStatus);
          return {
            status: result.outcome,
            ...(providerStatus !== undefined ? { providerStatus } : {}),
          };
        } catch (error) {
          return {
            status: isMissingCredentials(error) ? "unavailable" : "failed",
            error: providerError(error, "Provider batch cancellation failed")
              .message,
          };
        }
      });
    } catch (error) {
      return {
        status: "failed",
        error: `The provider call ${toErrorMessage(error)}.`,
      };
    }
  });
}

/** What the provider answered, for `settleOwed`. */
export function answeredOf(
  refs: readonly EngineBatchRef[],
  verdictOf: (ref: EngineBatchRef) => Verdict | null | undefined,
): Map<string, "cancelled" | "ended"> {
  const answered = new Map<string, "cancelled" | "ended">();
  for (const ref of refs) {
    const status = verdictOf(ref)?.status;
    if (status === "cancelled") answered.set(ref.id, "cancelled");
    else if (status === "already-terminal") answered.set(ref.id, "ended");
  }
  return answered;
}

/** The advice a WARN about a batch that may still be running ends with. */
export function batchAdvice(
  runStillCancelled: boolean,
  heldUntil?: string,
): string {
  if (heldUntil !== undefined) {
    return runStillCancelled
      ? `repeat run.cancel after ${heldUntil}, or cancel it at the provider`
      : "cancel it at the provider";
  }
  return runStillCancelled
    ? "cancel it at the provider, or repeat run.cancel to retry"
    : "cancel it at the provider";
}

/**
 * What to report for a submit row a `run.cancel` sweep holds (`row` carries a
 * live fence: `isFencedBySweep`): one `held` outcome per batch the row lists
 * that is not recorded cancelled, or one for the step when it lists none.
 * Empty for a row that is not held.
 */
export function heldStepOutcomes(
  stageId: string,
  row: StepRecord,
  now: Date,
  error = (until: string) =>
    `held until ${until} (that sweep may have stopped while holding it); after then the next run.cancel takes the step over and finishes the cancel`,
): RunCancelBatchOutcome[] {
  if (!isFencedBySweep(row, now)) return [];
  const record = parseStoredSubmit(row.result);
  const heldUntil = row.leaseExpiresAt!.toISOString();
  const base = {
    stageId,
    stepId: row.stepId,
    ...(row.externalKey ? { externalKey: row.externalKey } : {}),
    status: "held" as const,
    heldUntil,
    error: error(heldUntil),
  };
  const cancelled = record?.cancelledBatchIds ?? [];
  const refs = [...(record?.refs ?? []), ...owedRefsOf(row.result)].filter(
    (ref) => !cancelled.includes(ref.id),
  );
  if (refs.length > 0) return refs.map((ref) => ({ ...base, ref }));
  return record?.refs.length ? [] : [base];
}

/**
 * Cancel every provider batch the run created. Resolves with one outcome per
 * batch and never rejects.
 */
export async function cancelRunBatches(
  workflowRunId: string,
  deps: KernelDeps,
  options: CancelRunBatchesOptions = {},
): Promise<RunCancelBatchOutcome[]> {
  // On the run, never on a stage record a redrive may delete, and never lost
  // silently: such a WARN can be the only record of a running batch.
  const warn = (message: string, metadata?: unknown): Promise<void> =>
    writeBatchWarn(deps.persistence, workflowRunId, message, metadata);
  const runStillCancelled = async () =>
    (await deps.persistence.getRun(workflowRunId).catch(() => null))?.status ===
    "CANCELLED";

  const held: HeldRow[] = [];
  /** Every row this sweep took hold of, as the scan read it. */
  const heldRows = new Set<StepRecord>();
  /** Held rows found gone when written. */
  const goneRows: HeldRow[] = [];
  const ledger = deps.stepLedger;

  /** Verdicts by batch, filled as the provider calls finish. */
  const verdicts = new Map<string, Verdict | null>();

  /**
   * Write a held row, pinned to (`running`, the hold's attempt), after every
   * earlier write of this sweep to it. Resolves `true` when the write applied.
   * Not applied means the row was taken over (a hold whose lease expired is
   * taken at a higher attempt): it is no longer this sweep's, and nothing else
   * is written to it. A write that throws may or may not have applied; it is
   * reported as not applied and the row is kept.
   */
  const writeHeld = (
    h: HeldRow,
    patch: (current: Record<string, unknown>) => StepRecordPatch,
  ): Promise<boolean> => {
    const next = h.chain.then(async () => {
      if (h.lost || !ledger) return false;
      const change = patch(h.result);
      try {
        const outcome = await ledger.compareAndSet(
          h.row.stageRecordId,
          h.row.stepId,
          { status: "running", attempt: h.attempt },
          change,
        );
        if (!outcome.applied) {
          h.lost = true;
          h.gone = outcome.record === null;
          return false;
        }
      } catch {
        return false;
      }
      h.result = change.result as Record<string, unknown>;
      return true;
    });
    h.chain = next;
    return next;
  };

  /**
   * Give a held row back, recording what is known about each of its batches:
   * - cancelled (the provider has it cancelling or cancelled): added to
   *   `cancelledBatchIds`; when that is every batch of the row, the tombstone;
   * - ended on its own first (\`already-terminal\`): nothing to record;
   * - a cancel request may have left and its outcome is unknown (failed, timed
   *   out, cut off): kept in `cancelIntent`, as is an intent the row already
   *   carried for a batch this sweep did not send to;
   * - no request left (not reached, run moved on, no transport): nothing.
   * A completed row with a batch cancelled or a cancel pending is re-opened
   * (`running`, no lease): it must never answer a replay with a batch a cancel
   * may have reached. Otherwise the row goes back to the status it was held
   * from. Resolves whether the write applied.
   */
  const writeBack = (h: HeldRow): Promise<boolean> =>
    writeHeld(h, (current) => {
      const {
        cancelFence: _fence,
        cancelIntent: _written,
        ...held
      } = rebaseMarkers(current, [h.fromAttempt], h.attempt);
      const verdictOf = (ref: EngineBatchRef) => verdicts.get(refKey(ref));
      const ids = h.record.refs.map((ref) => ref.id);
      // Owed cancels the provider answered leave `cancelOwed`; the rest stay.
      const settled = settleOwed(held, answeredOf(h.owed, verdictOf)) ?? held;
      const cancelled = union(
        settled.cancelledBatchIds as string[] | undefined,
        h.record.refs
          .filter((ref) => verdictOf(ref)?.status === "cancelled")
          .map((ref) => ref.id),
      );
      const ended = h.record.refs
        .filter((ref) => verdictOf(ref)?.status === "already-terminal")
        .map((ref) => ref.id);
      // The intent the row carried before the hold, and the batches a request
      // left for: one this sweep recorded and then did not send (the run was
      // redriven, the budget ran out) reached no provider.
      const intent = union(h.record.cancelIntent?.batchIds, [...h.sent]).filter(
        (id) =>
          ids.includes(id) && !cancelled.includes(id) && !ended.includes(id),
      );
      const anyCancelled = ids.some((id) => cancelled.includes(id));
      const all = ids.every((id) => cancelled.includes(id));
      const base = held as unknown as StoredSubmit;
      const status =
        h.baseStatus === "completed" && (anyCancelled || intent.length > 0)
          ? "running"
          : h.baseStatus;
      const result: Record<string, unknown> = {
        ...settled,
        ...(cancelled.length > 0 ? { cancelledBatchIds: cancelled } : {}),
        ...(intent.length > 0
          ? { cancelIntent: { batchIds: intent, from: h.baseStatus } }
          : {}),
        ...(all && base.engineCancelled === undefined
          ? {
              engineCancelled: {
                attempt: h.attempt,
                generation: (base.generation ?? 0) + 1,
              },
            }
          : {}),
      };
      return { status, leaseExpiresAt: null, result };
    });

  /** Rows whose write-back did not apply, with the reason. */
  const notWrittenBack = new Map<StepRecord, string>();
  const writeBackAll = async () => {
    for (const h of held) {
      const written = await writeBack(h);
      if (h.gone) goneRows.push(h);
      if (!written) {
        notWrittenBack.set(
          h.row,
          h.gone
            ? ROW_GONE
            : h.lost
              ? "another execution took the step over"
              : "the ledger write failed",
        );
      }
    }
    held.length = 0;
  };

  try {
    // ── Which cancel is this? ───────────────────────────────────────────
    const first = await deps.persistence.getRun(workflowRunId);
    if (!first || first.status !== "CANCELLED") return [];
    const generation = options.generation ?? first.redriveCount;
    if (first.redriveCount !== generation) return [];

    const stillThisCancel = async () => {
      const run = await deps.persistence.getRun(workflowRunId);
      return run?.status === "CANCELLED" && run.redriveCount === generation;
    };

    // ── Find the batches ────────────────────────────────────────────────
    const targets = new Map<string, Target>();
    const special: RunCancelBatchOutcome[] = [];
    const specialWarnings: Array<{
      outcome: RunCancelBatchOutcome;
      stageRecordId: string;
    }> = [];
    const addTarget = (ref: EngineBatchRef, owner: Owner) => {
      // `batch-empty-*` is the id the helper invents for a zero-request
      // submit: there is no provider batch behind it.
      if (ref.id.startsWith("batch-empty-")) return;
      const key = refKey(ref);
      const target = targets.get(key);
      if (target) target.owners.push(owner);
      else targets.set(key, { ref, owners: [owner] });
    };
    const note = (outcome: RunCancelBatchOutcome, stageRecordId: string) => {
      special.push(outcome);
      specialWarnings.push({ outcome, stageRecordId });
    };

    const now = deps.clock.now();
    const rowsToHold: Array<{
      row: StepRecord;
      stageId: string;
      baseStatus: StepRecord["status"];
      fromAttempt: number;
    }> = [];
    for (const stage of await deps.persistence.getStagesByRun(workflowRunId)) {
      for (const ref of refsOfSuspendedState(stage.suspendedState)) {
        addTarget(ref, { stageId: stage.stageId, stageRecordId: stage.id });
      }
      if (!ledger) continue;
      let rows: StepRecord[];
      try {
        // Only the submit rows: another row's unreadable spilled result
        // must not hide a batch.
        const listed = await listStepRows(ledger, stage.id, isSubmitStepRow);
        rows = listed.rows;
        for (const lost of listed.unreadable) {
          await warn(
            `Run cancelled, but the stored submit record of step "${lost.stepId}" in stage "${stage.stageId}" could not be read from blob "${lost.key}" (${toErrorMessage(lost.error)}), so its provider batches were not cancelled. ${(await runStillCancelled()) ? "Repeat run.cancel to retry." : "Look them up at the provider and cancel them there."}`,
            {
              stageId: stage.stageId,
              stepId: lost.stepId,
              key: lost.key,
              error: toErrorMessage(lost.error),
            },
          );
        }
      } catch (error) {
        await warn(
          `Run cancelled, but the durable steps of stage "${stage.stageId}" could not be read (${toErrorMessage(error)}), so its provider batches were not cancelled. ${(await runStillCancelled()) ? "Repeat run.cancel to retry." : "Look them up at the provider and cancel them there."}`,
          { stageId: stage.stageId, error: toErrorMessage(error) },
        );
        continue;
      }
      for (const row of rows) {
        if (!isSubmitStepRow(row)) continue;
        const record = parseStoredSubmit(row.result);
        const base = {
          stageId: stage.stageId,
          stepId: row.stepId,
          ...(row.externalKey ? { externalKey: row.externalKey } : {}),
        };
        if (isFencedBySweep(row, now)) {
          for (const outcome of heldStepOutcomes(stage.stageId, row, now)) {
            note(outcome, stage.id);
          }
          continue;
        }
        // Owed a cancel whatever else the row is (its holder, if any, never
        // adopts or waits on these).
        for (const ref of owedRefsOf(row.result)) {
          addTarget(ref, {
            stageId: stage.stageId,
            stageRecordId: stage.id,
            owedOn: row,
          });
        }
        const executing =
          row.status === "running" &&
          row.leaseExpiresAt !== null &&
          row.leaseExpiresAt.getTime() > now.getTime();
        if (
          executing ||
          (!record && ["running", "failed"].includes(row.status))
        ) {
          note({ ...base, status: "unrecorded" }, stage.id);
          continue;
        }
        if (!record) continue;
        if (!isEngineOwned(row, record)) {
          for (const ref of record.refs) {
            note({ ...base, ref, status: "unverified" }, stage.id);
          }
          continue;
        }
        for (const ref of record.refs) {
          addTarget(ref, {
            stageId: stage.stageId,
            stageRecordId: stage.id,
            row,
          });
        }
        // A fence here (a live one was skipped above) is a sweep that died
        // holding the row, or one a submit step kept when it could not
        // complete the cancel: either way the row is what it is only because
        // of the hold, and the fence says what it was held from. A pending
        // intent says the same for a row that was given back.
        const dead = record.cancelFence;
        rowsToHold.push({
          row,
          stageId: stage.stageId,
          baseStatus: dead?.heldFrom ?? record.cancelIntent?.from ?? row.status,
          fromAttempt: dead?.fromAttempt ?? row.attempt,
        });
      }
    }
    if (targets.size === 0 && special.length === 0) return [];

    // ── Take hold of the rows, then confirm this is still the cancel ────
    const timeouts = deps.services?.batchCancelTimeouts;
    const batchMs = timeouts?.batchMs ?? DEFAULT_BATCH_MS;
    const sweepMs = timeouts?.sweepMs ?? DEFAULT_SWEEP_MS;
    if (!(await stillThisCancel())) return [];
    const lostRows = new Set<StepRecord>();
    for (const { row, stageId, baseStatus, fromAttempt } of rowsToHold) {
      const record = parseStoredSubmit(row.result)!;
      // Taken now, not when the scan began: a slow scan must not start the
      // provider calls under a lease that is already running out.
      const until = new Date(deps.clock.now().getTime() + sweepMs + batchMs);
      // The markers of a row with a left-over fence count from either attempt
      // (`markerBases`); from here on they count from `fromAttempt`.
      const { cancelFence: _old, ...unfenced } = rebaseMarkers(
        (row.result ?? {}) as Record<string, unknown>,
        markerBases(row, record),
        fromAttempt,
      );
      const result = {
        ...unfenced,
        cancelFence: {
          runGeneration: generation,
          until: until.toISOString(),
          heldFrom: baseStatus,
          fromAttempt,
        },
      };
      // A takeover: `attempt + 1`, so two sweeps that read the same row (one
      // whose fence has expired included) cannot both hold it, and a sweep
      // whose hold was taken over can no longer write it.
      const outcome = await ledger!
        .compareAndSet(
          row.stageRecordId,
          row.stepId,
          { status: row.status, attempt: row.attempt },
          {
            status: "running",
            attempt: row.attempt + 1,
            leaseExpiresAt: until,
            result,
          },
        )
        .catch(() => ({ applied: false }));
      if (outcome.applied) {
        held.push({
          row,
          record,
          stageId,
          baseStatus,
          fromAttempt,
          attempt: row.attempt + 1,
          until,
          result,
          sent: new Set(),
          chain: Promise.resolve(),
          lost: false,
          owed: owedRefsOf(row.result),
        });
        heldRows.add(row);
      } else lostRows.add(row);
    }
    // A row that changed under the sweep is not its to act on. Read again:
    // another sweep that took it first is reported as holding it.
    for (const row of lostRows) {
      for (const [key, target] of targets) {
        target.owners = target.owners.filter(
          (o) => o.row !== row && o.owedOn !== row,
        );
        if (target.owners.length === 0) targets.delete(key);
      }
      const stageId = rowsToHold.find((r) => r.row === row)!.stageId;
      const current = await ledger!
        .get(row.stageRecordId, row.stepId)
        .catch(() => null);
      if (current && !isFencedBySweep(current, deps.clock.now())) {
        for (const ref of owedRefsOf(current.result)) {
          addTarget(ref, {
            stageId,
            stageRecordId: row.stageRecordId,
            owedOn: current,
          });
        }
      }
      const heldBy =
        current && isFencedBySweep(current, deps.clock.now())
          ? heldStepOutcomes(stageId, current, deps.clock.now())
          : undefined;
      const changed = {
        stageId,
        stepId: row.stepId,
        ...(row.externalKey ? { externalKey: row.externalKey } : {}),
        status: "failed" as const,
        error: "The step changed while the cancel sweep took hold of it.",
      };
      const refs = parseStoredSubmit(row.result)?.refs ?? [];
      const outcomes =
        heldBy ??
        (refs.length > 0
          ? refs.map((ref) => ({ ...changed, ref }))
          : [changed]);
      for (const outcome of outcomes) note(outcome, row.stageRecordId);
    }
    // A redrive between the first check and the holds: the rows go back
    // untouched and nothing is sent to a provider, except owed cancels and
    // the batches of rows the redrive deleted (below).
    const redriven = !(await stillThisCancel());

    // ── Cancel them, within the budgets ─────────────────────────────────
    const sweepEndsAt = Date.now() + sweepMs;
    const resolve = deps.services?.batchModels ?? resolveBatchModelForRef;
    const models = new Map<string, Promise<EngineBatchModel | undefined>>();
    const modelFor = (ref: EngineBatchRef) => {
      const key = `${ref.provider}\u0000${ref.modelId}`;
      let model = models.get(key);
      if (!model) {
        model = Promise.resolve().then(() => resolve(ref));
        models.set(key, model);
      }
      return model;
    };
    const heldOf = (row: StepRecord) => held.find((h) => h.row === row)!;

    /**
     * One batch. Nothing leaves the process until every row that lists the
     * batch says, durably, that a cancel may be sent (`cancelIntent`), and
     * after the last wait before the request it is checked again that the run
     * is still the cancelled generation (a read) and that the sweep still
     * holds every such row (its lease outlasts the call: nobody takes a live
     * hold over) and that the budget has not run out (once it has, the
     * verdict is already `failed` and the rows may already be written back).
     */
    const cancelOne = async (target: Target): Promise<Verdict | null> => {
      const { ref } = target;
      // Owed by a step that lost it: no record is needed and no run state
      // makes it live again.
      const owedOnly = target.owners.every((o) => o.owedOn);
      const startedAt = Date.now();
      const left = sweepEndsAt - startedAt;
      if (left <= 0) {
        return {
          status: "failed",
          error: `Not reached: run.cancel stopped cancelling provider batches after ${sweepMs} ms.`,
        };
      }
      const budget = Math.min(batchMs, left);
      const rows = target.owners.flatMap((o) => (o.row ? [heldOf(o.row)] : []));
      try {
        return await withinBudget(
          budget,
          async (signal): Promise<Verdict | null> => {
            // The run was redriven since the sweep took hold: this batch may now
            // be the live batch of a RUNNING run. Not sent, not reported.
            if (!owedOnly && !(await stillThisCancel())) return null;
            let model: EngineBatchModel | undefined;
            try {
              model = await modelFor(ref);
            } catch (error) {
              return {
                status: "unavailable",
                error: providerError(
                  error,
                  "The batch transport could not be resolved",
                ).message,
              };
            }
            if (!model) {
              return {
                status: "unavailable",
                error: `No batch transport resolves provider "${ref.provider}" in this process.`,
              };
            }
            if (!model.cancel) return { status: "unsupported" };
            for (const h of rows) {
              if (signal.aborted) return null;
              const recorded = await writeHeld(h, (current) => ({
                result: {
                  ...current,
                  cancelIntent: {
                    batchIds: union(
                      (current.cancelIntent as StoredSubmit["cancelIntent"])
                        ?.batchIds,
                      [ref.id],
                    ),
                    from: h.baseStatus,
                  },
                },
              }));
              if (!recorded) {
                return {
                  status: "failed",
                  error: `Not sent: the cancel could not be recorded on step "${h.row.stepId}" first (${h.gone ? ROW_GONE : h.lost ? "another execution took the step over" : "the ledger write failed"})`,
                };
              }
            }
            if (!owedOnly && !(await stillThisCancel())) return null;
            const callEndsAt =
              deps.clock.now().getTime() + budget - (Date.now() - startedAt);
            if (signal.aborted) return null;
            if (rows.some((h) => h.lost || callEndsAt >= h.until.getTime())) {
              return {
                status: "failed",
                error:
                  "Not sent: the cancel sweep's hold on the step would end before the provider call.",
              };
            }
            for (const h of rows) h.sent.add(ref.id);
            try {
              const result = await model.cancel(ref, { abortSignal: signal });
              const providerStatus = knownProviderBatchStatus(result.rawStatus);
              return {
                status: result.outcome,
                ...(providerStatus !== undefined ? { providerStatus } : {}),
              };
            } catch (error) {
              return {
                status: isMissingCredentials(error) ? "unavailable" : "failed",
                error: providerError(
                  error,
                  "Provider batch cancellation failed",
                ).message,
              };
            }
          },
        );
      } catch (error) {
        return {
          status: "failed",
          error: `The provider call ${toErrorMessage(error)}.`,
        };
      }
    };

    const list = [...targets.entries()].filter(
      ([, target]) => !redriven || target.owners.every((o) => o.owedOn),
    );
    const results = await mapLimit(list, CONCURRENCY, async ([, target]) =>
      cancelOne(target),
    );
    for (const [i, [key]] of list.entries()) verdicts.set(key, results[i]!);

    // ── Give the rows back, recording what is known ─────────────────────
    await writeBackAll();

    // A row found gone was deleted with its stage record by a run.redrive:
    // its batches' external key named that record, so nothing can find or
    // adopt them again, and the run.cancel asked for them to be cancelled.
    // Their cancels are sent now, with no record and whatever the run has
    // become (the rule an execution that loses its row follows).
    const resend = new Map<string, EngineBatchRef>();
    for (const h of goneRows) {
      const done = new Set(h.record.cancelledBatchIds ?? []);
      for (const ref of [...h.record.refs, ...h.owed]) {
        const verdict = verdicts.get(refKey(ref));
        if (
          done.has(ref.id) ||
          ref.id.startsWith("batch-empty-") ||
          verdict?.status === "cancelled" ||
          verdict?.status === "already-terminal"
        ) {
          continue;
        }
        resend.set(refKey(ref), ref);
      }
    }
    const resent = [...resend.entries()];
    const resentVerdicts = await cancelBatchesNow(
      deps,
      resent.map(([, ref]) => ref),
    );
    for (const [i, [key, ref]] of resent.entries()) {
      verdicts.set(key, resentVerdicts[i]!);
      if (!targets.has(key)) {
        const h = goneRows.find((g) =>
          [...g.record.refs, ...g.owed].some((r) => refKey(r) === key),
        )!;
        targets.set(key, {
          ref,
          owners: [
            {
              stageId: h.stageId,
              stageRecordId: h.row.stageRecordId,
              row: h.row,
            },
          ],
        });
      }
    }

    // Owed cancels on rows this sweep did not hold are settled there.
    const owedRows = new Map<StepRecord, EngineBatchRef[]>();
    for (const target of targets.values()) {
      for (const o of target.owners) {
        if (!o.owedOn || heldRows.has(o.owedOn)) continue;
        owedRows.set(o.owedOn, [...(owedRows.get(o.owedOn) ?? []), target.ref]);
      }
    }
    for (const [row, refs] of owedRows) {
      await settleOwedOnRow(
        ledger!,
        row.stageRecordId,
        row.stepId,
        answeredOf(refs, (ref) => verdicts.get(refKey(ref))),
        deps.clock.now(),
      ).catch(() => {});
    }

    // ── Report ──────────────────────────────────────────────────────────
    const outcomes: RunCancelBatchOutcome[] = [];
    const warnings: Array<{
      outcome: RunCancelBatchOutcome;
      stageRecordId: string;
    }> = [];
    for (const [key, target] of targets) {
      const verdict = verdicts.get(key);
      if (!verdict) continue;
      for (const owner of target.owners) {
        // The row could not be given back: it keeps what this sweep last
        // wrote (the hold and the intent), which the next run.cancel or the
        // step's next execution resolves once the hold's lease has expired.
        const unwritten = owner.row && notWrittenBack.get(owner.row);
        const stepId = (owner.row ?? owner.owedOn)?.stepId;
        const answered =
          verdict.status === "cancelled" ||
          verdict.status === "already-terminal";
        const outcome: RunCancelBatchOutcome = {
          stageId: owner.stageId,
          ...(stepId ? { stepId } : {}),
          ref: target.ref,
          ...verdict,
          ...(unwritten === ROW_GONE
            ? {
                error: `${verdict.error ? `${verdict.error}; ` : ""}step "${stepId}" was deleted with its stage record by a run.redrive, so the cancel was sent with no record on the step${answered ? "" : "; nothing else will cancel this batch"}`,
              }
            : unwritten
              ? {
                  error: `${verdict.error ? `${verdict.error}; ` : ""}step "${stepId}" could not be updated afterwards (${unwritten}); it keeps the record of this cancel, and the next run.cancel or the step's next execution completes it`,
                }
              : {}),
        };
        outcomes.push(outcome);
        warnings.push({ outcome, stageRecordId: owner.stageRecordId });
      }
    }
    if (!redriven) {
      outcomes.push(...special);
      warnings.push(...specialWarnings);
    }
    const stillCancelled = await runStillCancelled();
    for (const { outcome } of warnings) {
      const what = outcome.ref
        ? `provider batch "${outcome.ref.id}" (${outcome.ref.provider}, stage "${outcome.stageId}")`
        : `the submit step "${outcome.stepId}" of stage "${outcome.stageId}"`;
      if (
        outcome.status === "cancelled" ||
        outcome.status === "already-terminal"
      ) {
        if (outcome.error !== undefined) {
          await warn(
            `Run cancelled and ${what} ${outcome.status === "cancelled" ? "cancelled" : "found ended"}, but ${outcome.error}.`,
            { ...outcome },
          );
        }
        continue;
      }
      await warn(
        `Run cancelled, but ${what} was not cancelled: ${stillRunning[outcome.status]}${outcome.error ? ` (${outcome.error})` : ""}${outcome.externalKey ? `; external key ${outcome.externalKey}` : ""}. It may still be running and billed; ${batchAdvice(stillCancelled, outcome.status === "held" ? outcome.heldUntil : undefined)}.`,
        { ...outcome },
      );
    }
    return outcomes;
  } catch (error) {
    await writeBackAll().catch(() => {});
    await warn(
      `Run cancelled, but its provider batches could not be cancelled: ${toErrorMessage(error)}. They may still be running and billed; ${(await runStillCancelled()) ? "repeat run.cancel to retry" : "look them up at the provider and cancel them there"}.`,
      { error: toErrorMessage(error) },
    );
    return [];
  }
}

/**
 * A stage body ran in this process and the run turned out to be CANCELLED, so
 * its result is discarded. The body may have created a provider batch after
 * `run.cancel` read the ledger (its abort signal had not fired yet); the
 * handle it recorded is cancelled now. Another terminal status is left alone:
 * a FAILED run keeps its batches for `run.redrive`. Called outside any
 * transaction, never throws.
 */
export async function cancelBatchesOfDiscardedRun(
  workflowRunId: string,
  runStatus: string | null | undefined,
  deps: KernelDeps,
): Promise<void> {
  if (runStatus === "CANCELLED") await cancelRunBatches(workflowRunId, deps);
}
