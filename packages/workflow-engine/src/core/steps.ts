/**
 * Durable step types and control-flow errors.
 *
 * The implementation of StepApi lives in the kernel layer because it needs
 * the StepLedger and Clock ports. These types stay in core so stage
 * definitions do not depend on kernel internals.
 */

export interface StepApi {
  run<T>(id: string, fn: () => Promise<T>): Promise<T>;
  waitFor<T>(
    id: string,
    opts: {
      poll: () => Promise<T>;
      ready: (v: T) => boolean;
      every: number | string;
      timeout: number | string;
    },
  ): Promise<T>;
  waitForSignal<T = unknown>(
    id: string,
    opts: { timeout: number | string },
  ): Promise<T>;
  sleep(id: string, duration: number | string): Promise<void>;
}

export interface StepSuspendOptions {
  stepId: string;
  at?: Date;
  nextPollAt: Date;
  maxWaitUntil: Date;
  pollInterval?: number;
}

/** Internal control-flow error used to suspend a durable stage. */
export class StepSuspend extends Error {
  readonly stepId: string;
  readonly nextPollAt: Date;
  readonly maxWaitUntil: Date;
  readonly pollInterval?: number;
  readonly at: Date;

  constructor(options: StepSuspendOptions) {
    super(`Durable step "${options.stepId}" is waiting`);
    this.name = "StepSuspend";
    this.stepId = options.stepId;
    this.at = options.at ?? new Date();
    this.nextPollAt = options.nextPollAt;
    this.maxWaitUntil = options.maxWaitUntil;
    this.pollInterval = options.pollInterval;
  }
}

/** Internal control-flow error used when another replay owns a run step. */
export class StepInFlight extends Error {
  readonly stepId: string;
  readonly at: Date;

  constructor(stepId: string, at = new Date()) {
    super(`Durable step "${stepId}" is already in flight`);
    this.name = "StepInFlight";
    this.stepId = stepId;
    this.at = at;
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
