import type { AIHelper } from "../../ai/types.js";
import { deriveStepExternalKey } from "../../core/step-external-key.js";
import type {
  StepApi,
  StepControlFlowError,
  StepKeyUse,
  StepRunContext,
  StepRunOptions,
  StepSignalOptions,
  StepWaitOptions,
} from "../../core/steps.js";
import {
  DuplicateStepKeyError,
  parseStepDuration,
  STEP_API_PENDING_CONTROL_FLOW,
  STEP_API_SETTLE_IN_FLIGHT,
  StepInFlight,
  StepLeaseLostError,
  StepLedgerNotConfiguredError,
  StepLedgerWriteError,
  StepNotReplaySafeError,
  StepResultNotSerializable,
  StepSuspend,
  StepTimeoutError,
} from "../../core/steps.js";
import { AIServicesNotConfiguredError } from "../errors.js";
import type { Clock, StepLedger, StepRecord } from "../ports.js";
import { createStepAi } from "./step-ai.js";

const DEFAULT_LEASE_MS = 5 * 60 * 1000;
/**
 * Default re-suspend interval of a signal wait. A landed signal wakes the
 * stage through `step.signal`'s nextPollAt reset, so this only bounds the
 * delay after a lost nudge; short values replay the stage body for nothing.
 */
const SIGNAL_KEEPALIVE_MS = 5 * 60 * 1000;
const SLEEP_GRACE_MS = 60 * 60 * 1000;
/**
 * Consecutive `poll` throws logged at DEBUG before the wait step escalates
 * to WARN. A provider that is eventually consistent after a submit (an
 * OpenRouter batch answers 404 to the first status check) is not a fault.
 */
const POLL_FAILURES_BEFORE_WARN = 3;

export interface CreateStepApiOptions {
  stageRecordId?: string;
  stepLedger?: StepLedger;
  clock: Clock;
  onLog?: (level: "DEBUG" | "WARN", message: string) => void;
  /**
   * Records a ledger-integrity finding on the run itself, so it survives the
   * log stream. Optional: a caller with no annotation sink still gets the
   * WARN.
   */
  onAnnotate?: (
    key: string,
    value: string,
    opts: { payload: Record<string, unknown>; idempotencyKey: string },
  ) => void;
  /** Default lease for `run()` calls. Defaults to five minutes. */
  defaultLeaseMs?: number;
  /** Lazy accessor for the stage's AI helper, used by `step.ai.*`. */
  ai?: () => AIHelper;
  /**
   * Uniform source in [0, 1) for `retryBackoff.jitter`. Defaults to
   * `Math.random`; injectable so a test can pin the drawn delay.
   */
  random?: () => number;
}

interface StepInvocation {
  id: string;
  seq: number;
}

/** A `run` step still executing in this invocation. */
interface InFlightRun {
  /** Settles once the step has recorded its outcome in the ledger. */
  done: Promise<unknown>;
  /** When this step's lease expires — the bound on waiting for it. */
  leaseUntil: number;
}

function jsonRoundTrip(value: unknown, stepId: string): unknown {
  if (value === undefined) return null;
  try {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) return null;
    return JSON.parse(encoded);
  } catch {
    throw new StepResultNotSerializable(stepId);
  }
}

/**
 * What a worker returns after parking on an outcome it did not write: the
 * recorded one, exactly as a later replay would read it.
 */
function parkedResult<T>(record: StepRecord): T {
  if (record.status === "failed") throw storedError(record);
  return record.result as T;
}

function storedError(record: StepRecord): Error {
  const timeout = new StepTimeoutError(record.stepId);
  if (record.error === timeout.message) return timeout;
  return new Error(
    record.error ?? `Durable step "${record.stepId}" previously failed`,
  );
}

function positiveDuration(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive finite number`);
  }
  return value;
}

function nonNegativeInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return value;
}

/**
 * The lease a `run` step asked for, in milliseconds. `lease` is canonical;
 * `leaseMs` is the deprecated alias and yields to it when both are given.
 */
function resolveLeaseMs(opts: StepRunOptions, defaultLeaseMs: number): number {
  const requested = opts.lease ?? opts.leaseMs;
  return positiveDuration(
    requested === undefined ? defaultLeaseMs : parseStepDuration(requested),
    "lease",
  );
}

/**
 * The wait before re-running a step whose attempt `failedAttempt` just
 * failed. Reads the attempt off the row, not a counter: the retry suspends
 * the stage and replays in whichever process picks it up next.
 */
function retryDelayFor(
  opts: StepRunOptions,
  failedAttempt: number,
  random: () => number,
): number {
  const base = parseStepDuration(opts.retryDelay ?? opts.retryDelayMs ?? 0);
  const backoff = opts.retryBackoff;
  if (!backoff) return base;
  const factor = backoff.factor ?? 1;
  if (!Number.isFinite(factor) || factor < 1) {
    throw new Error("retryBackoff.factor must be a finite number >= 1");
  }
  const maxDelay =
    backoff.maxDelay === undefined
      ? Number.POSITIVE_INFINITY
      : parseStepDuration(backoff.maxDelay);
  const delay = Math.min(base * factor ** (failedAttempt - 1), maxDelay);
  return backoff.jitter ? Math.floor(random() * delay) : delay;
}

/** The automatic heartbeat interval of a `run` step, or undefined for none. */
function resolveHeartbeatMs(
  opts: StepRunOptions,
  leaseMs: number,
): number | undefined {
  if (opts.heartbeat === undefined || opts.heartbeat === false)
    return undefined;
  const heartbeatMs = positiveDuration(
    parseStepDuration(opts.heartbeat),
    "heartbeat",
  );
  if (heartbeatMs >= leaseMs) {
    throw new Error(
      `heartbeat (${heartbeatMs}ms) must be shorter than the lease (${leaseMs}ms) it extends`,
    );
  }
  return heartbeatMs;
}

/** Creates the StepApi attached to a single stage invocation. */
export function createStepApi(options: CreateStepApiOptions): StepApi {
  let nextSeq = 0;
  /**
   * Every step key this invocation has asked for, and where. Keeping the
   * first use (not just the key) is what lets the duplicate error name both
   * call sites: the stage body is a function we cannot inspect statically,
   * so first use within one invocation is the only place the collision is
   * visible.
   */
  const requestedIds = new Map<string, StepKeyUse>();
  let pendingControlFlow: StepControlFlowError | undefined;
  const defaultLeaseMs = positiveDuration(
    options.defaultLeaseMs ?? DEFAULT_LEASE_MS,
    "defaultLeaseMs",
  );

  function suspend(error: StepControlFlowError): never {
    pendingControlFlow ??= error;
    throw error;
  }

  function begin(id: string, kind: StepRecord["kind"]): StepInvocation {
    if (!id) throw new Error("Durable step id must not be empty");
    const seq = ++nextSeq;
    const first = requestedIds.get(id);
    if (first) throw new DuplicateStepKeyError(id, first, { kind, seq });
    requestedIds.set(id, { kind, seq });
    return { id, seq };
  }

  function requireLedger(): { stageRecordId: string; ledger: StepLedger } {
    if (!options.stepLedger) throw new StepLedgerNotConfiguredError();
    if (!options.stageRecordId) {
      throw new Error(
        "Durable steps require a stageRecordId in the stage execution context",
      );
    }
    return { stageRecordId: options.stageRecordId, ledger: options.stepLedger };
  }

  function warnOnOrder(invocation: StepInvocation, record: StepRecord): void {
    // seq=0 is reserved for early signal records, whose request position is
    // not known when the external signal arrives.
    if (record.seq !== 0 && record.seq !== invocation.seq) {
      options.onLog?.(
        "WARN",
        `non-deterministic step order: step "${invocation.id}" was stored at seq ${record.seq}, requested at seq ${invocation.seq}`,
      );
    }
  }

  function assertKind(record: StepRecord, kind: StepRecord["kind"]): void {
    if (record.kind !== kind) {
      throw new Error(
        `Durable step "${record.stepId}" was previously used as ${record.kind} and cannot be used as ${kind}`,
      );
    }
  }

  async function claim(
    invocation: StepInvocation,
    record: Omit<StepRecord, "createdAt" | "updatedAt">,
  ): Promise<{ created: boolean; record: StepRecord }> {
    const { ledger } = requireLedger();
    const result = await ledger.claim(record);
    assertKind(result.record, record.kind);
    warnOnOrder(invocation, result.record);
    return result;
  }

  async function get(
    invocation: StepInvocation,
    kind: StepRecord["kind"],
  ): Promise<StepRecord | null> {
    const { stageRecordId, ledger } = requireLedger();
    const record = await ledger.get(stageRecordId, invocation.id);
    if (record) {
      assertKind(record, kind);
      warnOnOrder(invocation, record);
    }
    return record;
  }

  async function update(
    stepId: string,
    patch: Parameters<StepLedger["update"]>[2],
  ): Promise<StepRecord> {
    const { stageRecordId, ledger } = requireLedger();
    return ledger.update(stageRecordId, stepId, patch);
  }

  /**
   * Take over a run step whose lease expired or whose attempt failed. The
   * compare-and-set on (status, attempt) guarantees that only one replay
   * bumps the attempt and executes `fn`; the loser suspends as in-flight.
   */
  async function reclaim(
    stepId: string,
    record: StepRecord,
    leaseMs: number,
  ): Promise<StepRecord> {
    const { stageRecordId, ledger } = requireLedger();
    const now = options.clock.now();
    const outcome = await ledger.compareAndSet(
      stageRecordId,
      stepId,
      { status: record.status, attempt: record.attempt },
      {
        status: "running",
        attempt: record.attempt + 1,
        leaseExpiresAt: new Date(now.getTime() + leaseMs),
        error: null,
      },
    );
    if (!outcome.applied || !outcome.record) {
      suspend(new StepInFlight(stepId, now));
    }
    return outcome.record;
  }

  /**
   * Record a step's outcome under a first-write-wins constraint.
   *
   * An ordinal ledger gets drift detection for free — position is identity,
   * so a second writer is a second position. A keyed ledger does not, and we
   * now have two independent mechanisms that can decide a step is takeable
   * (the lease, and the reclaim path), so a wrong liveness verdict can put
   * two workers in the same body. The compare-and-set makes the *ledger*
   * safe regardless: the write applies only while the row is still open, so
   * whichever worker checkpoints first owns the outcome and the loser parks
   * on what is recorded instead of overwriting it.
   *
   * `parked: true` therefore means "the body ran twice; the ledger kept the
   * first answer". The run stays correct — only the recorded outcome is ever
   * returned to a caller — but a duplicate external effect is possible, so
   * it is reported rather than swallowed.
   */
  async function commitOutcome(
    stepId: string,
    open: StepRecord["status"],
    patch: Parameters<StepLedger["update"]>[2],
  ): Promise<{ parked: boolean; record: StepRecord }> {
    const { stageRecordId, ledger } = requireLedger();
    let outcome: Awaited<ReturnType<StepLedger["compareAndSet"]>>;
    try {
      outcome = await ledger.compareAndSet(
        stageRecordId,
        stepId,
        { status: open },
        patch,
      );
    } catch (error) {
      throw new StepLedgerWriteError(stepId, error);
    }
    if (outcome.applied && outcome.record) {
      return { parked: false, record: outcome.record };
    }
    // The row is gone (a concurrent ledger reset) — nothing to park on.
    if (!outcome.record) {
      throw new StepLedgerWriteError(
        stepId,
        new Error(
          `Durable step "${stepId}" disappeared from the ledger before its outcome was recorded`,
        ),
      );
    }
    reportDrift(stepId, open, outcome.record);
    return { parked: true, record: outcome.record };
  }

  function reportDrift(
    stepId: string,
    open: StepRecord["status"],
    record: StepRecord,
  ): void {
    const message =
      `durable step "${stepId}" was still ${open} for this worker but the ledger already ` +
      `records it as ${record.status} at attempt ${record.attempt}: another execution of ` +
      `the same step checkpointed first. Keeping the recorded outcome. The body ran more ` +
      `than once, so an external effect may be duplicated — look for it under external ` +
      `key "${record.externalKey ?? "(none recorded)"}".`;
    options.onLog?.("WARN", message);
    options.onAnnotate?.("step.outcome-conflict", record.status, {
      payload: {
        stepId,
        kind: record.kind,
        recordedStatus: record.status,
        recordedAttempt: record.attempt,
        externalKey: record.externalKey ?? null,
      },
      // Two workers reporting the same conflict describe one event.
      idempotencyKey: `step-outcome-conflict:${options.stageRecordId}:${stepId}:${record.attempt}`,
    });
  }

  async function complete(
    stepId: string,
    open: StepRecord["status"],
    result?: unknown,
  ): Promise<{ parked: boolean; record: StepRecord }> {
    return commitOutcome(stepId, open, {
      status: "completed",
      result,
      error: null,
      leaseExpiresAt: null,
    });
  }

  /**
   * Fail a wait or signal step at its deadline — unless the thing it was
   * waiting for landed first. A signal delivered, or another poller's ready
   * verdict, is an outcome recorded out of band; the deadline write must
   * lose to it rather than convert an answered step into a timed-out one.
   * Returns the recorded outcome when it lost; otherwise it throws.
   */
  async function timeout(stepId: string): Promise<StepRecord> {
    const error = new StepTimeoutError(stepId);
    const outcome = await commitOutcome(stepId, "pending", {
      status: "failed",
      error: error.message,
      leaseExpiresAt: null,
    });
    if (!outcome.parked) throw error;
    return outcome.record;
  }

  function boundedNextPoll(now: Date, delayMs: number, deadline: Date): Date {
    return new Date(Math.min(now.getTime() + delayMs, deadline.getTime()));
  }

  const inFlight = new Set<InFlightRun>();

  /**
   * Let every in-flight `run` finish so its ledger row is written before the
   * stage suspends. Bounded by the longest remaining lease: a step that
   * outlives its lease belongs to the lease-expiry path, not to a suspension
   * that would otherwise block forever. Failures need no handling here —
   * `run` already recorded them as failed rows.
   */
  async function settleInFlight(): Promise<void> {
    while (inFlight.size > 0) {
      const pending = [...inFlight];
      const boundMs = Math.max(
        0,
        Math.max(...pending.map((entry) => entry.leaseUntil)) -
          options.clock.now().getTime(),
      );
      let timer: ReturnType<typeof setTimeout> | undefined;
      const bounded = new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), boundMs);
        // Never hold the process open for a lease that outlives the run.
        (timer as unknown as { unref?: () => void }).unref?.();
      });
      let outcome: "settled" | "timeout";
      try {
        outcome = await Promise.race([
          Promise.allSettled(pending.map((entry) => entry.done)).then(
            () => "settled" as const,
          ),
          bounded,
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
      for (const entry of pending) inFlight.delete(entry);
      if (outcome === "timeout") {
        options.onLog?.(
          "WARN",
          `${pending.length} durable run step(s) outlived their lease while the stage was suspending`,
        );
        return;
      }
    }
  }

  const impl = {
    async run<T>(
      id: string,
      fn: (step: StepRunContext) => Promise<T>,
      opts: StepRunOptions = {},
      onLeaseExtended?: (leaseUntil: number) => void,
    ) {
      const invocation = begin(id, "run");
      const leaseMs = resolveLeaseMs(opts, defaultLeaseMs);
      const heartbeatMs = resolveHeartbeatMs(opts, leaseMs);
      const retries = nonNegativeInteger(opts.retries ?? 0, "retries");
      // Validate the delay options up front, before the body runs.
      retryDelayFor(opts, 1, () => 0);
      const onReclaim = opts.onReclaim ?? "rerun";
      const now = options.clock.now();
      const { stageRecordId } = requireLedger();
      // Derived, not generated: the same (stage record, step) pair yields the
      // same key in every process and on every replay, so the body can name
      // its external effect before making it.
      const externalKey = deriveStepExternalKey(stageRecordId, id);
      const claimResult = await claim(invocation, {
        stageRecordId,
        stepId: id,
        seq: invocation.seq,
        kind: "run",
        status: "running",
        attempt: 1,
        leaseExpiresAt: new Date(now.getTime() + leaseMs),
        deadlineAt: null,
        externalKey,
      });
      let record = claimResult.record;
      let shouldExecute = claimResult.created;
      let isReclaim = false;

      if (!claimResult.created && record.status === "completed") {
        return record.result as T;
      }
      if (!claimResult.created && record.status === "running") {
        if (
          record.leaseExpiresAt !== null &&
          record.leaseExpiresAt.getTime() > now.getTime()
        ) {
          suspend(new StepInFlight(id, now));
        }
        if (onReclaim === "fail") {
          // The dead worker may have completed the body's external effect.
          // Fail the row so the replay after this one meets a stored error
          // rather than racing to the same decision again.
          const expiredAt = record.leaseExpiresAt ?? now;
          const error = new StepNotReplaySafeError(id, externalKey, expiredAt);
          // Under the same constraint as any other outcome write: the
          // worker whose lease looked dead may have recorded its result
          // between the read above and here, and refusing to replay must
          // not overwrite an answer that exists.
          const refused = await commitOutcome(id, "running", {
            status: "failed",
            error: error.message,
            leaseExpiresAt: null,
          });
          if (refused.parked) return parkedResult<T>(refused.record);
          throw error;
        }
        record = await reclaim(id, record, leaseMs);
        shouldExecute = true;
        isReclaim = true;
      }
      if (!claimResult.created && record.status === "failed") {
        if (record.attempt > retries) throw storedError(record);
        record = await reclaim(id, record, leaseMs);
        shouldExecute = true;
        isReclaim = true;
      }

      if (!shouldExecute) {
        throw new Error(
          `Durable run step "${id}" is in unexpected status ${record.status}`,
        );
      }

      /**
       * Push this execution's lease out by `leaseMs` from now. Pinned to
       * (running, this attempt): a body whose row was already taken over
       * cannot revive its lease, and learns so through the rejection.
       */
      const attempt = record.attempt;
      const extendLease = async (): Promise<void> => {
        const { stageRecordId, ledger } = requireLedger();
        const leaseUntil = options.clock.now().getTime() + leaseMs;
        const outcome = await ledger.compareAndSet(
          stageRecordId,
          id,
          { status: "running", attempt },
          { leaseExpiresAt: new Date(leaseUntil) },
        );
        if (!outcome.applied) throw new StepLeaseLostError(id, attempt);
        onLeaseExtended?.(leaseUntil);
      };
      let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
      if (heartbeatMs !== undefined) {
        heartbeatTimer = setInterval(() => {
          extendLease().catch((error: unknown) => {
            // The outcome write below will lose the same compare-and-set
            // and report the conflict; here, stop trying.
            if (heartbeatTimer) clearInterval(heartbeatTimer);
            heartbeatTimer = undefined;
            options.onLog?.(
              "WARN",
              `durable step "${id}" heartbeat stopped: ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
          });
        }, heartbeatMs);
        // Never hold the process open for a body the run has abandoned.
        (heartbeatTimer as unknown as { unref?: () => void }).unref?.();
      }

      let value: T;
      try {
        value = await fn({
          stepId: id,
          externalKey: record.externalKey ?? externalKey,
          attempt,
          isReclaim,
          heartbeat: extendLease,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        // Under the same constraint as the success write: a body that threw
        // here must not bury an outcome another execution already recorded.
        const failure = await commitOutcome(id, "running", {
          status: "failed",
          error: message,
          leaseExpiresAt: null,
        });
        if (failure.parked) return parkedResult<T>(failure.record);
        if (record.attempt <= retries) {
          const retryDelayMs = retryDelayFor(
            opts,
            record.attempt,
            options.random ?? Math.random,
          );
          const retryAt = new Date(
            options.clock.now().getTime() + retryDelayMs,
          );
          suspend(
            new StepSuspend({
              stepId: id,
              kind: "retry",
              at: options.clock.now(),
              nextPollAt: retryAt,
              maxWaitUntil: new Date(retryAt.getTime() + defaultLeaseMs),
              pollInterval: retryDelayMs,
            }),
          );
        }
        throw error;
      } finally {
        if (heartbeatTimer) clearInterval(heartbeatTimer);
      }

      const encoded = jsonRoundTrip(value, id);
      const completed = await complete(id, "running", encoded);
      if (completed.parked) return parkedResult<T>(completed.record);
      return completed.record.result as T;
    },

    async waitFor<T>(id: string, opts: StepWaitOptions<T>) {
      const invocation = begin(id, "wait");
      const existing = await get(invocation, "wait");
      if (existing?.status === "completed") return existing.result as T;
      if (existing?.status === "failed") throw storedError(existing);

      const everyMs = parseStepDuration(opts.every);
      const timeoutMs = parseStepDuration(opts.timeout);
      const pollBackoffMs = parseStepDuration(opts.pollBackoffMs ?? everyMs);
      const now = options.clock.now();
      const record =
        existing ??
        (
          await claim(invocation, {
            stageRecordId: requireLedger().stageRecordId,
            stepId: id,
            seq: invocation.seq,
            kind: "wait",
            status: "pending",
            attempt: 1,
            leaseExpiresAt: null,
            deadlineAt: new Date(now.getTime() + timeoutMs),
            waitState: { everyMs },
          })
        ).record;

      if (record.status === "completed") return record.result as T;
      if (record.status === "failed") throw storedError(record);
      if (!record.deadlineAt) {
        throw new Error(`Durable wait step "${id}" is missing deadlineAt`);
      }

      const current = options.clock.now();
      if (current.getTime() >= record.deadlineAt.getTime()) {
        return parkedResult<T>(await timeout(id));
      }

      let value: T;
      try {
        value = await opts.poll();
      } catch (error) {
        // The count lives on the row so it survives a replay in another
        // process; the first few consecutive failures are DEBUG (eventual
        // consistency right after a submit), then WARN.
        const pollFailures = (record.waitState?.pollFailures ?? 0) + 1;
        options.onLog?.(
          pollFailures <= POLL_FAILURES_BEFORE_WARN ? "DEBUG" : "WARN",
          `Durable wait step "${id}" poll failed (${pollFailures} consecutive); retrying: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        await update(id, {
          waitState: { ...record.waitState, pollFailures },
        });
        const afterPoll = options.clock.now();
        if (afterPoll.getTime() >= record.deadlineAt.getTime()) {
          return parkedResult<T>(await timeout(id));
        }
        suspend(
          new StepSuspend({
            stepId: id,
            at: afterPoll,
            nextPollAt: boundedNextPoll(
              afterPoll,
              pollBackoffMs,
              record.deadlineAt,
            ),
            maxWaitUntil: record.deadlineAt,
            pollInterval: pollBackoffMs,
          }),
        );
      }

      if (opts.ready(value)) {
        const result = jsonRoundTrip(value, id);
        // A wait row is open while `pending`: an out-of-band completion
        // (a signal delivered, another poller ahead of this one) wins.
        const completed = await complete(id, "pending", result);
        if (completed.parked) return parkedResult<T>(completed.record);
        return completed.record.result as T;
      }

      const afterPoll = options.clock.now();
      if (afterPoll.getTime() >= record.deadlineAt.getTime()) {
        return parkedResult<T>(await timeout(id));
      }
      if (record.waitState?.pollFailures) {
        // The poll answered: a later failure starts a new streak.
        const { pollFailures: _reset, ...rest } = record.waitState;
        await update(id, { waitState: rest });
      }
      const savedEveryMs = record.waitState?.everyMs ?? everyMs;
      suspend(
        new StepSuspend({
          stepId: id,
          at: afterPoll,
          nextPollAt: boundedNextPoll(
            afterPoll,
            savedEveryMs,
            record.deadlineAt,
          ),
          maxWaitUntil: record.deadlineAt,
          pollInterval: savedEveryMs,
        }),
      );
    },

    async waitForSignal<T = unknown>(id: string, opts: StepSignalOptions) {
      const invocation = begin(id, "signal");
      const existing = await get(invocation, "signal");
      if (existing?.status === "completed") return existing.result as T;
      if (existing?.status === "failed") throw storedError(existing);

      const timeoutMs = parseStepDuration(opts.timeout);
      const keepaliveMs = positiveDuration(
        parseStepDuration(opts.keepalive ?? SIGNAL_KEEPALIVE_MS),
        "keepalive",
      );
      const now = options.clock.now();
      const record =
        existing ??
        (
          await claim(invocation, {
            stageRecordId: requireLedger().stageRecordId,
            stepId: id,
            seq: invocation.seq,
            kind: "signal",
            status: "pending",
            attempt: 1,
            leaseExpiresAt: null,
            deadlineAt: new Date(now.getTime() + timeoutMs),
          })
        ).record;

      if (record.status === "completed") return record.result as T;
      if (record.status === "failed") throw storedError(record);
      if (!record.deadlineAt) {
        throw new Error(`Durable signal step "${id}" is missing deadlineAt`);
      }
      const current = options.clock.now();
      if (current.getTime() >= record.deadlineAt.getTime()) {
        return parkedResult<T>(await timeout(id));
      }
      suspend(
        new StepSuspend({
          stepId: id,
          at: current,
          nextPollAt: boundedNextPoll(current, keepaliveMs, record.deadlineAt),
          maxWaitUntil: record.deadlineAt,
          pollInterval: keepaliveMs,
        }),
      );
    },

    async sleep(id: string, duration: number | string): Promise<void> {
      const invocation = begin(id, "sleep");
      const existing = await get(invocation, "sleep");
      if (existing?.status === "completed") return;
      if (existing?.status === "failed") throw storedError(existing);

      const durationMs = parseStepDuration(duration);
      const now = options.clock.now();
      const wakeAt = new Date(now.getTime() + durationMs);
      const record =
        existing ??
        (
          await claim(invocation, {
            stageRecordId: requireLedger().stageRecordId,
            stepId: id,
            seq: invocation.seq,
            kind: "sleep",
            status: "pending",
            attempt: 1,
            leaseExpiresAt: null,
            deadlineAt: new Date(wakeAt.getTime() + SLEEP_GRACE_MS),
            waitState: { wakeAt: wakeAt.toISOString() },
          })
        ).record;

      if (record.status === "completed") return;
      if (record.status === "failed") throw storedError(record);

      const storedWakeAt = new Date(record.waitState?.wakeAt ?? "");
      if (Number.isNaN(storedWakeAt.getTime())) {
        throw new Error(`Durable sleep step "${id}" has an invalid wakeAt`);
      }
      const current = options.clock.now();
      if (current.getTime() >= storedWakeAt.getTime()) {
        await complete(id, "pending", null);
        return;
      }

      suspend(
        new StepSuspend({
          stepId: id,
          at: current,
          nextPollAt: storedWakeAt,
          maxWaitUntil:
            record.deadlineAt ??
            new Date(storedWakeAt.getTime() + SLEEP_GRACE_MS),
          pollInterval: Math.max(0, storedWakeAt.getTime() - current.getTime()),
        }),
      );
    },
  };

  const api = {
    ...impl,
    /**
     * Steps may run concurrently under `Promise.all`. Each `run` is tracked
     * while it executes so a suspension elsewhere can wait for it (see
     * `settleInFlight`) instead of abandoning it mid-flight with a live
     * lease, which the replay would meet as `StepInFlight`.
     */
    run<T>(
      id: string,
      fn: (step: StepRunContext) => Promise<T>,
      opts: StepRunOptions = {},
    ) {
      const leaseUntil =
        options.clock.now().getTime() + resolveLeaseMs(opts, defaultLeaseMs);
      const entry: InFlightRun = { done: Promise.resolve(), leaseUntil };
      // A heartbeat (manual or automatic) moves the bound `settleInFlight`
      // waits under, so the entry tracks the extended lease.
      const promise = impl.run(id, fn, opts, (extendedUntil) => {
        entry.leaseUntil = extendedUntil;
      });
      entry.done = promise;
      inFlight.add(entry);
      // The caller owns `promise` and its rejection; this branch only
      // removes the bookkeeping entry without creating a second rejection.
      void promise.catch(() => {}).finally(() => inFlight.delete(entry));
      return promise;
    },
  } as StepApi;

  Object.defineProperty(api, "ai", {
    configurable: false,
    enumerable: true,
    writable: false,
    value: createStepAi({
      run: (id, fn, opts) => api.run(id, fn, opts),
      waitFor: <T>(id: string, opts: StepWaitOptions<T>) =>
        api.waitFor(id, opts),
      async isCompleted(stepId) {
        const { stageRecordId, ledger } = requireLedger();
        const record = await ledger.get(stageRecordId, stepId);
        return record?.status === "completed";
      },
      async noteAttempt(stepId) {
        // Increment, never assign: the row's attempt is monotonic across
        // job attempts (a reopened row continues from where it stopped).
        const { stageRecordId, ledger } = requireLedger();
        const record = await ledger.get(stageRecordId, stepId);
        await update(stepId, { attempt: (record?.attempt ?? 0) + 1 });
      },
      async storeFailedVerdict(stepId, verdict) {
        // The item's `run` already recorded the row as `failed`; this write
        // only attaches the verdict to it. Constrained to that state so a
        // slow worker cannot drag a row a new job attempt has already
        // re-opened back to `failed`.
        const { stageRecordId, ledger } = requireLedger();
        await ledger.compareAndSet(
          stageRecordId,
          stepId,
          { status: "failed" },
          {
            status: "failed",
            error:
              typeof (verdict as { error?: unknown })?.error === "string"
                ? (verdict as { error: string }).error
                : "map item failed",
            result: verdict,
            leaseExpiresAt: null,
          },
        );
      },
      async loadFailedVerdict(stepId) {
        const { stageRecordId, ledger } = requireLedger();
        const record = await ledger.get(stageRecordId, stepId);
        if (record?.status !== "failed") return undefined;
        const result = record.result;
        return typeof result === "object" &&
          result !== null &&
          (result as { status?: unknown }).status === "failed"
          ? result
          : undefined;
      },
      assertReady: () => void requireLedger(),
      ai: () => {
        if (!options.ai) throw new AIServicesNotConfiguredError();
        return options.ai();
      },
      onLog: options.onLog,
    }),
  });

  Object.defineProperty(api, STEP_API_PENDING_CONTROL_FLOW, {
    configurable: false,
    enumerable: false,
    value: () => pendingControlFlow,
  });

  Object.defineProperty(api, STEP_API_SETTLE_IN_FLIGHT, {
    configurable: false,
    enumerable: false,
    value: settleInFlight,
  });

  return api;
}
