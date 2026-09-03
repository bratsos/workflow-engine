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
  /** Lease held while `fn` executes. Defaults to five minutes. */
  leaseMs?: number;
  /** Number of retries after the first failed attempt. Defaults to zero. */
  retries?: number;
  /** Delay before retrying a failed attempt. Defaults to zero. */
  retryDelayMs?: number;
}

export interface StepWaitOptions<T> {
  poll: () => Promise<T>;
  ready: (value: T) => boolean;
  every: number | string;
  timeout: number | string;
  /** Backoff after `poll` throws. Defaults to `every`. */
  pollBackoffMs?: number;
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
    fn: () => Promise<T>,
    options?: StepRunOptions,
  ): Promise<T>;
  waitFor<T>(id: string, opts: StepWaitOptions<T>): Promise<T>;
  waitForSignal<T = unknown>(
    id: string,
    opts: { timeout: number | string },
  ): Promise<T>;
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
