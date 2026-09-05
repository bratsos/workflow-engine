/**
 * Durable step types and control-flow errors.
 *
 * The implementation of StepApi lives in the kernel layer because it needs
 * the StepLedger and Clock ports. These types stay in core so stage
 * definitions do not depend on kernel internals.
 */

import type { StepAiApi } from "./step-ai";

/** Internal marker carried in suspended-state metadata for durable replay. */
export const DURABLE_SUSPEND_MARKER = "__durable" as const;

/** Cross-bundle brand for durable-step control-flow errors. */
export const STEP_CONTROL_FLOW: unique symbol = Symbol.for(
  "@bratsos/workflow-engine/step-control-flow",
) as typeof STEP_CONTROL_FLOW;

/** Internal accessor used by the stage factory to detect swallowed suspension. */
export const STEP_API_PENDING_CONTROL_FLOW: unique symbol = Symbol.for(
  "@bratsos/workflow-engine/step-api-pending-control-flow",
) as typeof STEP_API_PENDING_CONTROL_FLOW;

/**
 * Internal accessor used by the stage factory to let in-flight `run` steps
 * finish (and record) before a suspension leaves `execute()`.
 */
export const STEP_API_SETTLE_IN_FLIGHT: unique symbol = Symbol.for(
  "@bratsos/workflow-engine/step-api-settle-in-flight",
) as typeof STEP_API_SETTLE_IN_FLIGHT;

export interface StepRunOptions {
  /**
   * Lease held while `fn` executes. A number of milliseconds or a duration
   * string (`"30s"`, `"5m"`). Defaults to five minutes. Also how long a
   * crashed worker's step blocks a replay.
   */
  lease?: number | string;
  /** @deprecated Use `lease`. Ignored when `lease` is also given. */
  leaseMs?: number;
  /** Number of retries after the first failed attempt. Defaults to zero. */
  retries?: number;
  /**
   * Delay before retrying a failed attempt. A number of milliseconds or a
   * duration string (`"30s"`, `"5m"`). Defaults to zero.
   */
  retryDelay?: number | string;
  /** @deprecated Use `retryDelay`. Ignored when `retryDelay` is also given. */
  retryDelayMs?: number | string;
  /**
   * Grow `retryDelay` with each failed attempt. The delay before retrying
   * after attempt *n* is `retryDelay * factor^(n-1)`, capped at `maxDelay`;
   * with `jitter` the wait is a uniform random fraction of that ("full
   * jitter"). Computed from the attempt recorded on the step row, so it is
   * correct when the retry replays in another process. Defaults to a factor
   * of 1 — a fixed `retryDelay`.
   */
  retryBackoff?: StepRetryBackoff;
  /**
   * What to do when this step's lease expired and another worker takes it
   * over — the one case where the engine cannot know whether the body's side
   * effect already happened, because the worker died between the effect and
   * the ledger write.
   *
   * - `"rerun"` (default, and the behaviour of every earlier version):
   *   execute the body again. Correct for a body that is safe to repeat, and
   *   for one that uses `step.externalKey` to make the repeat a no-op.
   * - `"fail"`: refuse, and fail the step with {@link StepNotReplaySafeError}
   *   naming the step. Choose this for a body whose external call cannot be
   *   deduplicated or recovered, where a duplicate costs money or is visible
   *   to a third party.
   *
   * This does not affect `retries`: a body that *threw* has said its effect
   * did not take, and asking for retries is asking for it to be repeated.
   */
  onReclaim?: "rerun" | "fail";
}

/** Exponential growth of a `run` step's retry delay. */
export interface StepRetryBackoff {
  /** Multiplier applied per failed attempt. At least 1; defaults to 1. */
  factor?: number;
  /** Upper bound on the computed delay. Milliseconds or a duration string. */
  maxDelay?: number | string;
  /** Wait a uniform random fraction of the computed delay. Defaults to false. */
  jitter?: boolean;
}

/**
 * What a `ctx.step.run` body is told about its own execution.
 *
 * Bodies that ignore it behave exactly as before; it exists so a body making
 * a non-idempotent external call can name that call in a way that survives a
 * replay.
 */
export interface StepRunContext {
  /** This step's id, as passed to `run`. */
  readonly stepId: string;
  /**
   * A stable, deterministic key for whatever external effect this body
   * creates. Identical on every replay of this step, so it can be sent as a
   * provider idempotency key, stamped into provider-side metadata, or used to
   * search for an effect a dead worker already created.
   *
   * Recorded on the step row before the body runs, never after it returns.
   */
  readonly externalKey: string;
  /** 1 on the first execution; incremented each time the step is taken over. */
  readonly attempt: number;
  /**
   * True when this execution took over an expired lease or a failed attempt,
   * i.e. when an earlier execution of this body may already have run. A body
   * that can recover its external effect should look for it when this is set.
   */
  readonly isReclaim: boolean;
}

export interface StepWaitOptions<T> {
  poll: () => Promise<T>;
  ready: (value: T) => boolean;
  every: number | string;
  timeout: number | string;
  /** Backoff after `poll` throws. Defaults to `every`. */
  pollBackoffMs?: number;
}

export interface StepSignalOptions {
  /** Non-sliding deadline from the first wait. Milliseconds or a duration string. */
  timeout: number | string;
  /**
   * How often the suspended stage re-suspends while no signal has arrived.
   * Milliseconds or a duration string; defaults to five minutes, and is
   * never later than `timeout`.
   *
   * Signal latency is not governed by this: `step.signal` sets the stage's
   * next poll to now, so the stage wakes on the host's next tick. The
   * keepalive only bounds how long a *lost* nudge (a host that was down when
   * the signal landed) can delay the wake, at the cost of one replay of the
   * stage body per interval.
   */
  keepalive?: number | string;
}

/** `waitFor` options whose `ready` is a type guard: the result narrows to `U`. */
export interface StepWaitOptionsNarrowing<T, U extends T>
  extends Omit<StepWaitOptions<T>, "ready"> {
  ready: (value: T) => value is U;
}

/**
 * Durable operations available to a stage.
 *
 * Never catch errors thrown by `ctx.step.*` without rethrowing; use
 * `isStepControlFlowError` when a catch boundary must distinguish suspension.
 */
export interface StepApi {
  /**
   * Memoize one side effect by id.
   *
   * Results round-trip through JSON: Dates become strings, `undefined` object
   * fields disappear, and Maps/Sets lose their runtime types.
   */
  run<T>(
    id: string,
    fn: (step: StepRunContext) => Promise<T>,
    options?: StepRunOptions,
  ): Promise<T>;
  waitFor<T, U extends T>(
    id: string,
    opts: StepWaitOptionsNarrowing<T, U>,
  ): Promise<U>;
  waitFor<T>(id: string, opts: StepWaitOptions<T>): Promise<T>;
  waitForSignal<T = unknown>(id: string, opts: StepSignalOptions): Promise<T>;
  sleep(id: string, duration: number | string): Promise<void>;
  /** Durable AI calls and the realtime/batch `map` primitive. */
  readonly ai: StepAiApi;
  readonly [STEP_API_PENDING_CONTROL_FLOW]?: () =>
    | StepControlFlowError
    | undefined;
  /**
   * Wait for every `run` step still executing in this invocation to settle,
   * bounded by the longest remaining lease. Steps may run concurrently under
   * `Promise.all`; when one of them suspends, the siblings are given the
   * chance to finish and record before the stage suspends, so the replay
   * finds completed rows instead of live leases (`StepInFlight`).
   */
  readonly [STEP_API_SETTLE_IN_FLIGHT]?: () => Promise<void>;
}

export interface StepSuspendOptions {
  stepId: string;
  at?: Date;
  nextPollAt: Date;
  maxWaitUntil: Date;
  pollInterval?: number;
  kind?: "wait" | "retry";
}

/** Internal control-flow error used to suspend a durable stage. */
export class StepSuspend extends Error {
  readonly [STEP_CONTROL_FLOW] = true as const;
  readonly stepId: string;
  readonly nextPollAt: Date;
  readonly resumeAt: Date;
  readonly maxWaitUntil: Date;
  readonly pollInterval?: number;
  readonly at: Date;
  readonly kind: "wait" | "retry";

  constructor(options: StepSuspendOptions) {
    super(`Durable step "${options.stepId}" is waiting`);
    this.name = "StepSuspend";
    this.stepId = options.stepId;
    this.at = options.at ?? new Date();
    this.nextPollAt = options.nextPollAt;
    this.resumeAt = options.nextPollAt;
    this.maxWaitUntil = options.maxWaitUntil;
    this.pollInterval = options.pollInterval;
    this.kind = options.kind ?? "wait";
  }
}

/** Internal control-flow error used when another replay owns a run step. */
export class StepInFlight extends Error {
  readonly [STEP_CONTROL_FLOW] = true as const;
  readonly stepId: string;
  readonly at: Date;

  constructor(stepId: string, at = new Date()) {
    super(`Durable step "${stepId}" is already in flight`);
    this.name = "StepInFlight";
    this.stepId = stepId;
    this.at = at;
  }
}

export type StepControlFlowError = StepSuspend | StepInFlight;

/** Detect durable-step suspension reliably across duplicated package bundles. */
export function isStepControlFlowError(
  error: unknown,
): error is StepControlFlowError {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { [STEP_CONTROL_FLOW]?: unknown })[STEP_CONTROL_FLOW] === true
  );
}

/** Thrown after a durable wait reaches its original, non-sliding deadline. */
export class StepTimeoutError extends Error {
  readonly stepId: string;

  constructor(stepId: string) {
    super(`Durable wait step "${stepId}" exceeded its timeout`);
    this.name = "StepTimeoutError";
    this.stepId = stepId;
  }
}

/** Thrown when a completed step result cannot be committed to its ledger. */
export class StepLedgerWriteError extends Error {
  readonly stepId: string;
  readonly originalError: unknown;

  constructor(stepId: string, originalError: unknown) {
    super(`Failed to persist completed durable step "${stepId}"`);
    this.name = "StepLedgerWriteError";
    this.stepId = stepId;
    this.originalError = originalError;
  }
}

/**
 * Thrown instead of re-executing a `run` step declared `onReclaim: "fail"`
 * whose lease expired. The body may or may not have completed its external
 * effect; the engine refuses to guess, and says so with the key the effect
 * would carry so an operator can go and look.
 */
export class StepNotReplaySafeError extends Error {
  readonly stepId: string;
  readonly externalKey: string;

  constructor(stepId: string, externalKey: string, leaseExpiredAt: Date) {
    super(
      `Durable step "${stepId}" is declared onReclaim: "fail" and its lease expired at ` +
        `${leaseExpiredAt.toISOString()}. A worker was executing this step and did not ` +
        `record an outcome, so its external effect may already have happened; the engine ` +
        `will not re-execute it. Look for the effect under external key "${externalKey}", ` +
        `then either complete the run by hand or re-run the stage with ` +
        `onReclaim: "rerun" once you know the effect is absent.`,
    );
    this.name = "StepNotReplaySafeError";
    this.stepId = stepId;
    this.externalKey = externalKey;
  }
}

/** Cross-bundle brand for the duplicate-step-key programming error. */
export const STEP_DUPLICATE_KEY: unique symbol = Symbol.for(
  "@bratsos/workflow-engine/step-duplicate-key",
) as typeof STEP_DUPLICATE_KEY;

/** Where a step key was used, as the guard saw it. */
export interface StepKeyUse {
  readonly kind: "run" | "wait" | "signal" | "sleep";
  /** Request position within the stage invocation, 1-based. */
  readonly seq: number;
}

/**
 * Thrown when one stage invocation asks for the same step key twice.
 *
 * Steps are keyed by name, not by ordinal position, which is what buys the
 * refactoring tolerance an ordinal engine cannot offer: renaming or
 * reordering surrounding code does not invalidate a run. The debt is that
 * two steps sharing a key would silently answer each other's results — the
 * second `run` would never execute and would return the first one's value
 * with no error anywhere. The engine refuses rather than pay it.
 *
 * This is a programming error, not a runtime fault: it is deterministic, so
 * the stage is failed without consuming retry attempts.
 */
export class DuplicateStepKeyError extends Error {
  readonly [STEP_DUPLICATE_KEY] = true as const;
  readonly stepId: string;
  readonly first: StepKeyUse;
  readonly second: StepKeyUse;

  constructor(stepId: string, first: StepKeyUse, second: StepKeyUse) {
    super(
      `Duplicate durable step key "${stepId}" in one stage invocation: first requested ` +
        `as a ${first.kind} step at position ${first.seq}, requested again as a ` +
        `${second.kind} step at position ${second.seq}. Steps are keyed by name, so the ` +
        `second call would silently return the first call's recorded result instead of ` +
        `running. Give the two call sites different keys — inside a loop, build the key ` +
        `from something unique to the iteration (\`${stepId}-\${item.id}\`) — or hoist the ` +
        `repeated call out of the loop so it runs once.`,
    );
    this.name = "DuplicateStepKeyError";
    this.stepId = stepId;
    this.first = first;
    this.second = second;
  }
}

/**
 * Detect a duplicate step key reliably across duplicated package bundles.
 * Step machinery that turns a thrown body into a recorded failure (the AI
 * map's per-item verdicts, most of all) must rethrow this instead: it names
 * a bug in the stage definition, and burying it in an item's verdict is
 * exactly the silence the guard exists to remove.
 */
export function isDuplicateStepKeyError(
  error: unknown,
): error is DuplicateStepKeyError {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { [STEP_DUPLICATE_KEY]?: unknown })[STEP_DUPLICATE_KEY] === true
  );
}

/** Thrown when a stage uses durable steps without a configured ledger. */
export class StepLedgerNotConfiguredError extends Error {
  constructor() {
    super(
      "Durable steps require a configured StepLedger. Pass stepLedger to createKernel (or createTestKernel) before calling ctx.step.*.",
    );
    this.name = "StepLedgerNotConfiguredError";
  }
}

/** Thrown before a non-JSON value can be written to the step ledger. */
export class StepResultNotSerializable extends Error {
  constructor(stepId: string) {
    super(
      `Result for durable step "${stepId}" is not JSON-serializable and cannot be stored in the step ledger`,
    );
    this.name = "StepResultNotSerializable";
  }
}

/** Parse the duration syntax accepted by durable waits. */
export function parseStepDuration(value: number | string): number {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 0) {
      throw new Error(`Invalid duration: ${String(value)}`);
    }
    return value;
  }

  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)$/.exec(value.trim());
  if (!match) {
    throw new Error(
      `Invalid duration "${value}". Use milliseconds or a value such as 30s, 5m, 24h, or 30d.`,
    );
  }

  const amount = Number(match[1]);
  const multipliers: Record<string, number> = {
    ms: 1,
    s: 1000,
    m: 60 * 1000,
    h: 60 * 60 * 1000,
    d: 24 * 60 * 60 * 1000,
  };
  return amount * multipliers[match[2]!];
}
