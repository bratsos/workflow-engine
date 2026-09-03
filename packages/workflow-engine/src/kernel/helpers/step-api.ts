import type { AIHelper } from "../../ai/types.js";
import type {
  StepApi,
  StepControlFlowError,
  StepRunOptions,
  StepWaitOptions,
} from "../../core/steps.js";
import {
  parseStepDuration,
  STEP_API_PENDING_CONTROL_FLOW,
  StepInFlight,
  StepLedgerNotConfiguredError,
  StepLedgerWriteError,
  StepResultNotSerializable,
  StepSuspend,
  StepTimeoutError,
} from "../../core/steps.js";
import { AIServicesNotConfiguredError } from "../errors.js";
import type { Clock, StepLedger, StepRecord } from "../ports.js";
import { createStepAi } from "./step-ai.js";

const DEFAULT_LEASE_MS = 5 * 60 * 1000;
const SIGNAL_KEEPALIVE_MS = 30_000;
const SLEEP_GRACE_MS = 60 * 60 * 1000;

export interface CreateStepApiOptions {
  stageRecordId?: string;
  stepLedger?: StepLedger;
  clock: Clock;
  onLog?: (level: "WARN", message: string) => void;
  /** Default lease for `run()` calls. Defaults to five minutes. */
  defaultLeaseMs?: number;
  /** Lazy accessor for the stage's AI helper, used by `step.ai.*`. */
  ai?: () => AIHelper;
}

interface StepInvocation {
  id: string;
  seq: number;
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

/** Creates the StepApi attached to a single stage invocation. */
export function createStepApi(options: CreateStepApiOptions): StepApi {
  let nextSeq = 0;
  const requestedIds = new Set<string>();
  let pendingControlFlow: StepControlFlowError | undefined;
  const defaultLeaseMs = positiveDuration(
    options.defaultLeaseMs ?? DEFAULT_LEASE_MS,
    "defaultLeaseMs",
  );

  function suspend(error: StepControlFlowError): never {
    pendingControlFlow ??= error;
    throw error;
  }

  function begin(id: string): StepInvocation {
    if (!id) throw new Error("Durable step id must not be empty");
    if (requestedIds.has(id)) {
      throw new Error(
        `Duplicate durable step id "${id}" requested in one stage invocation`,
      );
    }
    requestedIds.add(id);
    return { id, seq: ++nextSeq };
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

  async function complete(
    stepId: string,
    result?: unknown,
  ): Promise<StepRecord> {
    try {
      return await update(stepId, {
        status: "completed",
        result,
        error: null,
        leaseExpiresAt: null,
      });
    } catch (error) {
      throw new StepLedgerWriteError(stepId, error);
    }
  }

  async function timeout(stepId: string): Promise<never> {
    const error = new StepTimeoutError(stepId);
    await update(stepId, {
      status: "failed",
      error: error.message,
      leaseExpiresAt: null,
    });
    throw error;
  }

  function boundedNextPoll(now: Date, delayMs: number, deadline: Date): Date {
    return new Date(Math.min(now.getTime() + delayMs, deadline.getTime()));
  }

  const api = {
    async run<T>(id: string, fn: () => Promise<T>, opts: StepRunOptions = {}) {
      const invocation = begin(id);
      const leaseMs = positiveDuration(
        opts.leaseMs ?? defaultLeaseMs,
        "leaseMs",
      );
      const retries = nonNegativeInteger(opts.retries ?? 0, "retries");
      const retryDelayMs = parseStepDuration(opts.retryDelayMs ?? 0);
      const now = options.clock.now();
      const claimResult = await claim(invocation, {
        stageRecordId: requireLedger().stageRecordId,
        stepId: id,
        seq: invocation.seq,
        kind: "run",
        status: "running",
        attempt: 1,
        leaseExpiresAt: new Date(now.getTime() + leaseMs),
        deadlineAt: null,
      });
      let record = claimResult.record;
      let shouldExecute = claimResult.created;

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
        record = await reclaim(id, record, leaseMs);
        shouldExecute = true;
      }
      if (!claimResult.created && record.status === "failed") {
        if (record.attempt > retries) throw storedError(record);
        record = await reclaim(id, record, leaseMs);
        shouldExecute = true;
      }

      if (!shouldExecute) {
        throw new Error(
          `Durable run step "${id}" is in unexpected status ${record.status}`,
        );
      }

      let value: T;
      try {
        value = await fn();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await update(id, {
          status: "failed",
          error: message,
          leaseExpiresAt: null,
        });
        if (record.attempt <= retries) {
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
      }

      const encoded = jsonRoundTrip(value, id);
      const completed = await complete(id, encoded);
      return completed.result as T;
    },

    async waitFor<T>(id: string, opts: StepWaitOptions<T>) {
      const invocation = begin(id);
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
        await timeout(id);
      }

      let value: T;
      try {
        value = await opts.poll();
      } catch (error) {
        options.onLog?.(
          "WARN",
          `Durable wait step "${id}" poll failed; retrying: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        const afterPoll = options.clock.now();
        if (afterPoll.getTime() >= record.deadlineAt.getTime()) {
          await timeout(id);
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
        const completed = await complete(id, result);
        return completed.result as T;
      }

      const afterPoll = options.clock.now();
      if (afterPoll.getTime() >= record.deadlineAt.getTime()) {
        await timeout(id);
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

    async waitForSignal<T = unknown>(
      id: string,
      opts: { timeout: number | string },
    ) {
      const invocation = begin(id);
      const existing = await get(invocation, "signal");
      if (existing?.status === "completed") return existing.result as T;
      if (existing?.status === "failed") throw storedError(existing);

      const timeoutMs = parseStepDuration(opts.timeout);
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
        await timeout(id);
      }
      suspend(
        new StepSuspend({
          stepId: id,
          at: current,
          nextPollAt: boundedNextPoll(
            current,
            SIGNAL_KEEPALIVE_MS,
            record.deadlineAt,
          ),
          maxWaitUntil: record.deadlineAt,
          pollInterval: SIGNAL_KEEPALIVE_MS,
        }),
      );
    },

    async sleep(id, duration) {
      const invocation = begin(id);
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
        await complete(id, null);
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
  } as StepApi;

  Object.defineProperty(api, "ai", {
    configurable: false,
    enumerable: true,
    writable: false,
    value: createStepAi({
      run: (id, fn, opts) => api.run(id, fn, opts),
      waitFor: (id, opts) => api.waitFor(id, opts),
      async isCompleted(stepId) {
        const { stageRecordId, ledger } = requireLedger();
        const record = await ledger.get(stageRecordId, stepId);
        return record?.status === "completed";
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

  return api;
}
