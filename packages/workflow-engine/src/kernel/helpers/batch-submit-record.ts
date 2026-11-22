/**
 * The step-ledger record of a `ctx.step.ai.map` batch submit, shared by the
 * code that writes it (`step-ai.ts`), the code that reads it back
 * (`cancel-run-batches.ts`) and the ledger reset (`step-ledger-reset.ts`), so
 * they cannot drift apart.
 *
 * The step `${id}:submit` stores `{ handleId, refs, requestIds,
 * totalRequests }`. A row is taken for a batch submit only when it is a `run`
 * row whose id ends in `:submit` AND whose stored result has that shape with
 * every ref a valid `EngineBatchRef`. That is the shape, not ownership: an
 * ordinary step can memoise a handle of its own. The engine proves a record is
 * its own with `externalKey`, the key of the row it was written in (the same
 * `(stage record, step)` derivation the provider-side stamp uses); only a
 * record whose `externalKey` equals its row's is cancelled. A record written
 * before this field existed carries none and is never cancelled.
 *
 * Optional fields track what happened to the batches of a step:
 *
 * - `partial`: `refs` are only the partitions the provider accepted before a
 *   later one was rejected (`BatchSubmitError`). The record keeps them
 *   reachable, and the retry resumes after them instead of creating them again.
 * - `cancelledBatchIds`: provider batch ids of this step whose cancel the
 *   provider acknowledged (cancelling or cancelled). A cancel can be
 *   asynchronous (Gemini keeps listing the batch as running for a while), so a
 *   search for the step's external key must never return one of them. The list
 *   carries forward across submissions.
 * - `cancelOwed`: the refs of batches an execution of this step created and
 *   lost (another execution recorded the step first), recorded before their
 *   cancel is sent and kept until the provider acknowledges it, when the id
 *   moves to `cancelledBatchIds`. Every reader that completes cancels acts on
 *   them: the cancel sweep, the step's next execution, and a redrive that
 *   deletes the row. Like `cancelledBatchIds` they are never adopted. The field
 *   may sit on a row whose result is not a submit record (a failed row): it is
 *   read on its own (`owedRefsOf`). Rows written before 1.0.0-alpha.21 carry
 *   neither field.
 * - `cancelRetry`: per owed id whose cancel the step's own readers tried and
 *   could not complete: the attempts so far, when the next one is due and the
 *   kind of failure. A replay of the step tries again only when it is due
 *   (`owedRetryDelayMs`: 1 minute, doubling to at most 1 hour) and names the
 *   batch in a WARN only when the kind changes. `run.cancel` and `run.redrive`
 *   ignore it and send at once.
 * - `noCancelBatchIds`: owed ids whose transport answered that the provider
 *   has no cancel call (OpenRouter). Settled once: they leave `cancelOwed`,
 *   are never sent again, and are never adopted.
 * - `engineCancelled`: the tombstone, written once every batch of the record is
 *   cancelled (or found already cancelled). It names the `attempt` the row had
 *   and the `generation` the replacement carries. The re-opened row is taken
 *   over as `attempt + 1`, and only that execution may skip the adoption search
 *   and create a new batch on any transport; a later takeover (a crash while
 *   creating the replacement) searches again, as it does for any submit.
 * - `generation`: numbers the submissions of one step: absent (0) for the
 *   first, then 1, 2, ... for each replacement. The poll and collect steps of
 *   generation `g > 0` are `${id}:poll.${g}` and `${id}:collect.${g}`, so a
 *   poll or collect row the cancelled batch left behind (which a redrive keeps
 *   when it is completed) is never replayed for the new batch.
 * A failure write of a submit row leaves `result` alone (`step-api.ts`), and
 * the ledger reset and the retry re-open rows without touching it, so the
 * record survives them; the record's schema ignores keys it does not know.
 *
 * - `cancelFence`: written while a cancel sweep holds the row (see "HOLDING THE
 *   ROWS" in `cancel-run-batches.ts`). Taking hold is a
 *   takeover: the row becomes `running` with a lease at `attempt + 1`, and every
 *   later write of that sweep is pinned to (`running`, that attempt), so a sweep,
 *   replay or reset that took the row over afterwards (always at a higher
 *   attempt) cannot be overwritten by it, and it cannot touch theirs. The fence
 *   names the run generation, the status the row was held from (`heldFrom`) and
 *   the attempt it had before the first hold (`fromAttempt`). Once its lease
 *   has expired the sweep is dead. A fence also stays on a row whose submit
 *   step failed while it resolved it (it could not complete the cancel): the
 *   row is `failed`, and the fence still says what it was held from.
 * - `cancelIntent`: provider batch ids a cancel may have been sent for whose
 *   outcome is not recorded, and the status the row had before the cancel.
 *   Written, pinned to the hold, before the request can leave the process, and kept through a timeout, a lost response, a crash and
 *   a lost final write. It leaves the record only when the outcome is known:
 *   the batch is cancelling or cancelled (`cancelledBatchIds`), or it ended on
 *   its own first. A row that carries it is never `completed`: whoever executes
 *   the step next asks the provider to cancel those batches again (idempotent)
 *   and goes on from the answer, never from an active status alone.
 *
 * One marker counts from an attempt: the tombstone (`engineCancelled.attempt`).
 * A hold moves the row's attempt without executing anything, so whoever writes
 * a held row back moves a marker that pointed at the attempt before the hold
 * (`markerBases`) to the attempt after it (`rebaseMarkers`).
 */

import { z } from "zod";
import {
  type EngineBatchRef,
  EngineBatchRefSchema,
} from "../../ai/batch/model.js";
import type { StepLedger, StepRecord } from "../ports.js";

/** The id suffix of the batch submit step. */
export const BATCH_SUBMIT_STEP_SUFFIX = ":submit";

export const StoredSubmitSchema = z.object({
  handleId: z.string(),
  refs: z.array(EngineBatchRefSchema).min(1),
  requestIds: z.array(z.string()),
  totalRequests: z.number(),
  /** ISO time of the submit, for `durationMs` on the accounting rows. */
  submittedAt: z.string().optional(),
  externalKey: z.string().optional(),
  partial: z.boolean().optional(),
  generation: z.number().int().positive().optional(),
  cancelledBatchIds: z.array(z.string()).optional(),
  cancelOwed: z.array(EngineBatchRefSchema).optional(),
  cancelRetry: z
    .record(
      z.string(),
      z.object({
        tries: z.number().int().positive(),
        /** ISO time the next attempt of a replay is due. */
        nextAt: z.string(),
        kind: z.string(),
      }),
    )
    .optional(),
  noCancelBatchIds: z.array(z.string()).optional(),
  engineCancelled: z
    .object({
      attempt: z.number().int(),
      generation: z.number().int().positive(),
    })
    .optional(),
  cancelFence: z
    .object({
      /** `redriveCount` of the cancelled run the sweep belongs to. */
      runGeneration: z.number().int(),
      /** ISO time the lease expires. */
      until: z.string(),
      /**
       * The status the row was held from. The hold turns the row `running`, so
       * without this a sweep that dies before it releases the row leaves no
       * trace of whether the step had completed, failed or been re-opened.
       */
      heldFrom: z.enum(["completed", "failed", "running"]),
      /**
       * The row's attempt before the first hold: the attempt the tombstone and
       * the failure record count from while the row is held.
       */
      fromAttempt: z.number().int(),
    })
    .optional(),
  cancelIntent: z
    .object({
      /** Provider batch ids a cancel may have been sent for. */
      batchIds: z.array(z.string()).min(1),
      /**
       * The status the row had before the cancel: what it goes back to once
       * the outcome is known and nothing was cancelled.
       */
      from: z.enum(["completed", "failed", "running"]),
    })
    .optional(),
});

export type StoredSubmit = z.infer<typeof StoredSubmitSchema>;

type RowLike = Pick<StepRecord, "kind" | "stepId" | "result">;

/** Whether a ledger row is, by kind and id, a candidate batch submit. */
export function isSubmitStepRow(row: Pick<StepRecord, "kind" | "stepId">) {
  return row.kind === "run" && row.stepId.endsWith(BATCH_SUBMIT_STEP_SUFFIX);
}

/** The submit record a value holds, or `undefined` when it is not one. */
export function parseStoredSubmit(value: unknown): StoredSubmit | undefined {
  const parsed = StoredSubmitSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

/** The submit record a ledger row holds, or `undefined` when it is not a batch submit. */
export function submitRecordOfRow(row: RowLike): StoredSubmit | undefined {
  return isSubmitStepRow(row) ? parseStoredSubmit(row.result) : undefined;
}

const OwedSchema = z.array(EngineBatchRefSchema);

/** The `cancelOwed` refs a row's result lists, whatever else it holds. */
export function owedRefsOf(result: unknown): EngineBatchRef[] {
  const parsed = OwedSchema.safeParse(
    (result as { cancelOwed?: unknown } | null | undefined)?.cancelOwed,
  );
  return parsed.success ? parsed.data : [];
}

const idsOf = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((x): x is string => typeof x === "string")
    : [];

/**
 * Batch ids a row says must never be adopted or waited on: those cancelled
 * and those whose cancel is owed.
 */
export function excludedIdsOf(result: unknown): string[] {
  return [
    ...new Set([
      ...idsOf(
        (result as { cancelledBatchIds?: unknown } | null | undefined)
          ?.cancelledBatchIds,
      ),
      ...owedRefsOf(result).map((ref) => ref.id),
    ]),
  ];
}

/** How the provider answered an owed cancel. */
export type OwedAnswer = "cancelled" | "ended" | "unsupported";

export type OwedRetry = NonNullable<StoredSubmit["cancelRetry"]>;

const RetrySchema = StoredSubmitSchema.shape.cancelRetry.unwrap();

/** The recorded retry state of the owed cancels a row's result lists. */
export function owedRetryOf(result: unknown): OwedRetry {
  const parsed = RetrySchema.safeParse(
    (result as { cancelRetry?: unknown } | null | undefined)?.cancelRetry,
  );
  return parsed.success ? parsed.data : {};
}

/** Wait before a replay's attempt number `tries + 1`: 1 min, doubling, at most 1 h. */
export function owedRetryDelayMs(tries: number): number {
  return Math.min(60_000 * 2 ** (tries - 1), 3_600_000);
}

/** The owed refs a replay of the step may try now (none recorded, or due). */
export function dueOwedRefs(result: unknown, now: Date): EngineBatchRef[] {
  const retry = owedRetryOf(result);
  return owedRefsOf(result).filter((ref) => {
    const next = retry[ref.id]?.nextAt;
    return next === undefined || Date.parse(next) <= now.getTime();
  });
}

/** `retry` with one more failed attempt recorded for each id in `failed`. */
export function nextOwedRetry(
  retry: OwedRetry,
  failed: ReadonlyMap<string, string>,
  now: Date,
): OwedRetry {
  const next = { ...retry };
  for (const [id, kind] of failed) {
    const tries = (retry[id]?.tries ?? 0) + 1;
    next[id] = {
      tries,
      kind,
      nextAt: new Date(now.getTime() + owedRetryDelayMs(tries)).toISOString(),
    };
  }
  return next;
}

/**
 * `result` with the owed cancels the provider has answered settled: an id it
 * cancelled moves to `cancelledBatchIds`, one whose provider has no cancel
 * call to `noCancelBatchIds`, one that had ended leaves; the rest stay owed.
 * `failed` (with `now`) records one more failed attempt for those ids in
 * `cancelRetry`. `undefined` when nothing changes.
 */
export function settleOwed(
  result: Record<string, unknown>,
  answered: ReadonlyMap<string, OwedAnswer>,
  failed?: ReadonlyMap<string, string>,
  now?: Date,
): Record<string, unknown> | undefined {
  const owed = owedRefsOf(result);
  const left = owed.filter((ref) => !answered.has(ref.id));
  const stillFailed = new Map(
    [...(failed ?? [])].filter(([id]) => left.some((ref) => ref.id === id)),
  );
  if (left.length === owed.length && (stillFailed.size === 0 || !now)) {
    return undefined;
  }
  const answeredAs = (how: OwedAnswer) =>
    owed.filter((ref) => answered.get(ref.id) === how).map((ref) => ref.id);
  const { cancelOwed: _owed, cancelRetry: _retry, ...rest } = result;
  const cancelled = [
    ...new Set([
      ...idsOf(result.cancelledBatchIds),
      ...answeredAs("cancelled"),
    ]),
  ];
  const noCancel = [
    ...new Set([
      ...idsOf(result.noCancelBatchIds),
      ...answeredAs("unsupported"),
    ]),
  ];
  const recorded = owedRetryOf(result);
  const retry = Object.fromEntries(
    Object.entries(
      now ? nextOwedRetry(recorded, stillFailed, now) : recorded,
    ).filter(([id]) => left.some((ref) => ref.id === id)),
  );
  return {
    ...rest,
    ...(cancelled.length > 0 ? { cancelledBatchIds: cancelled } : {}),
    ...(noCancel.length > 0 ? { noCancelBatchIds: noCancel } : {}),
    ...(left.length > 0 ? { cancelOwed: left } : {}),
    ...(Object.keys(retry).length > 0 ? { cancelRetry: retry } : {}),
  };
}

/** What `settleOwedOnRow` wrote. */
export interface OwedSettlement {
  /** The write applied. */
  applied: boolean;
  /** Failed ids whose recorded kind of failure is new or changed. */
  changed: string[];
  /** Ids newly settled as having no cancel call. */
  noCancel: string[];
}

/**
 * Settle the owed cancels the provider answered on the row `stepId`, pinned to
 * the status and attempt it has when read, and only when nothing holds it (no
 * live lease). Best effort: a cancel left owed is sent again by the next
 * reader, which is idempotent.
 */
export async function settleOwedOnRow(
  ledger: Pick<StepLedger, "get" | "compareAndSet">,
  stageRecordId: string,
  stepId: string,
  answered: ReadonlyMap<string, OwedAnswer>,
  now: Date,
  failed?: ReadonlyMap<string, string>,
): Promise<OwedSettlement> {
  const none: OwedSettlement = { applied: false, changed: [], noCancel: [] };
  if (answered.size === 0 && !failed?.size) return none;
  const row = await ledger.get(stageRecordId, stepId);
  if (
    !row ||
    typeof row.result !== "object" ||
    row.result === null ||
    Array.isArray(row.result) ||
    (row.status === "running" &&
      row.leaseExpiresAt !== null &&
      row.leaseExpiresAt.getTime() > now.getTime())
  ) {
    return none;
  }
  const before = row.result as Record<string, unknown>;
  const result = settleOwed(before, answered, failed, now);
  if (!result) return none;
  const outcome = await ledger.compareAndSet(
    stageRecordId,
    stepId,
    { status: row.status, attempt: row.attempt },
    { result },
  );
  if (!outcome.applied) return none;
  const owed = owedRefsOf(before).map((ref) => ref.id);
  const prior = owedRetryOf(before);
  return {
    applied: true,
    changed: [...(failed ?? [])]
      .filter(([id, kind]) => owed.includes(id) && prior[id]?.kind !== kind)
      .map(([id]) => id),
    noCancel: owed.filter((id) => answered.get(id) === "unsupported"),
  };
}

/** Whether the engine can prove it wrote the record held by `row`. */
export function isEngineOwned(
  row: Pick<StepRecord, "externalKey">,
  record: StoredSubmit,
): boolean {
  return (
    record.externalKey !== undefined &&
    row.externalKey != null &&
    record.externalKey === row.externalKey
  );
}

/** The batches a ledger row holds, or none when it is not a batch submit. */
export function batchRefsOfSubmitRow(row: RowLike): EngineBatchRef[] {
  return submitRecordOfRow(row)?.refs ?? [];
}

/** `""` for the first submission of a step, `".1"`, `".2"`, ... for each replacement. */
export function generationTag(generation: number | undefined): string {
  return generation !== undefined && generation > 0 ? `.${generation}` : "";
}

/** Whether a cancel sweep currently holds `row` (its lease is live and the record is fenced). */
export function isFencedBySweep(
  row: Pick<
    StepRecord,
    "kind" | "stepId" | "result" | "status" | "leaseExpiresAt"
  >,
  now: Date,
): boolean {
  return (
    row.status === "running" &&
    row.leaseExpiresAt !== null &&
    row.leaseExpiresAt.getTime() > now.getTime() &&
    submitRecordOfRow(row)?.cancelFence !== undefined
  );
}

/**
 * The attempts the tombstone and the failure record of `row` may count from:
 * the row's own attempt, and while a fence is on the row also the attempt
 * before the first hold. A hold, and a submit step that failed while it
 * resolved a hold, create nothing, so a marker that counted from the attempt
 * before the hold still applies.
 */
export function markerBases(
  row: Pick<StepRecord, "attempt">,
  record: Pick<StoredSubmit, "cancelFence"> | undefined,
): number[] {
  const fence = record?.cancelFence;
  return fence ? [fence.fromAttempt, row.attempt] : [row.attempt];
}

/** `result` with its tombstone moved to `to` when it counted from one of `bases`. */
export function rebaseMarkers(
  result: Record<string, unknown>,
  bases: readonly number[],
  to: number,
): Record<string, unknown> {
  const out = { ...result };
  const marker = out.engineCancelled as { attempt?: unknown } | undefined;
  if (
    marker &&
    typeof marker === "object" &&
    typeof marker.attempt === "number" &&
    bases.includes(marker.attempt)
  ) {
    out.engineCancelled = { ...marker, attempt: to };
  }
  return out;
}

/** Whether a cancel sweep ever held `row`: a live lease, or a fence left by a sweep that died. */
export function hasCancelFence(
  row: Pick<StepRecord, "kind" | "stepId" | "result">,
): boolean {
  return submitRecordOfRow(row)?.cancelFence !== undefined;
}
