import type { StepApi } from "../../core/steps.js";
import {
  parseStepDuration,
  StepInFlight,
  StepLedgerNotConfiguredError,
  StepResultNotSerializable,
  StepSuspend,
} from "../../core/steps.js";
import type { Clock, StepLedger, StepRecord } from "../ports.js";

const SIGNAL_KEEPALIVE_MS = 30_000;
const SLEEP_GRACE_MS = 60 * 60 * 1000;

export interface CreateStepApiOptions {
  stageRecordId?: string;
  stepLedger?: StepLedger;
  clock: Clock;
  onLog?: (level: "WARN", message: string) => void;
}

interface StepInvocation {
  id: string;
  seq: number;
}

function jsonRoundTrip(value: unknown, stepId: string): unknown {
  try {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new Error("undefined result");
    return JSON.parse(encoded);
  } catch {
    throw new StepResultNotSerializable(stepId);
  }
}

function storedError(record: StepRecord): Error {
  return new Error(
    record.error ?? `Durable step "${record.stepId}" previously failed`,
  );
}

function parseStoredDate(value: string | undefined, field: string): Date {
  if (!value) throw new Error(`Durable step is missing ${field}`);
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Durable step has an invalid ${field}: ${value}`);
  }
  return date;
}

/** Creates the StepApi attached to a single stage invocation. */
export function createStepApi(options: CreateStepApiOptions): StepApi {
  let nextSeq = 0;
  const requestedIds = new Set<string>();

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

  return {
    async run<T>(id: string, fn: () => Promise<T>) {
      const invocation = begin(id);
      const claimResult = await claim(invocation, {
        stageRecordId: requireLedger().stageRecordId,
        stepId: id,
        seq: invocation.seq,
        kind: "run",
        status: "running",
      });
      const record = claimResult.record;

      if (!claimResult.created && record.status === "completed") {
        return record.result as T;
      }
      if (!claimResult.created && record.status === "running") {
        throw new StepInFlight(id, options.clock.now());
      }
      if (!claimResult.created && record.status === "failed") {
        throw storedError(record);
      }
      if (claimResult.created) {
        try {
          const result = await fn();
          const encoded = jsonRoundTrip(result, id);
          const completed = await update(id, {
            status: "completed",
            result: encoded,
          });
          return completed.result as T;
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          await update(id, { status: "failed", error: message }).catch(
            () => {},
          );
          throw error;
        }
      }
      throw new Error(
        `Durable run step "${id}" is in unexpected status ${record.status}`,
      );
    },

    async waitFor<T>(
      id: string,
      opts: {
        poll: () => Promise<T>;
        ready: (v: T) => boolean;
        every: number | string;
        timeout: number | string;
      },
    ) {
      const invocation = begin(id);
      const existing = await get(invocation, "wait");
      if (existing?.status === "completed") return existing.result as T;
      if (existing?.status === "failed") throw storedError(existing);

      const everyMs = parseStepDuration(opts.every);
      const timeoutMs = parseStepDuration(opts.timeout);
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
            waitState: {
              everyMs,
              timeoutAt: new Date(now.getTime() + timeoutMs).toISOString(),
            },
          })
        ).record;

      if (record.status === "completed") return record.result as T;
      if (record.status === "failed") throw storedError(record);

      const savedEveryMs = record.waitState?.everyMs ?? everyMs;
      const timeoutAt = parseStoredDate(
        record.waitState?.timeoutAt,
        "timeoutAt",
      );
      const value = await opts.poll();
      if (opts.ready(value)) {
        const result = jsonRoundTrip(value, id);
        const completed = await update(id, { status: "completed", result });
        return completed.result as T;
      }

      if (options.clock.now().getTime() >= timeoutAt.getTime()) {
        throw new Error(`Durable wait step "${id}" exceeded its timeout`);
      }

      const nextPollAt = new Date(options.clock.now().getTime() + savedEveryMs);
      throw new StepSuspend({
        stepId: id,
        at: options.clock.now(),
        nextPollAt,
        maxWaitUntil: timeoutAt,
        pollInterval: savedEveryMs,
      });
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
            waitState: {
              timeoutAt: new Date(now.getTime() + timeoutMs).toISOString(),
            },
          })
        ).record;

      if (record.status === "completed") return record.result as T;
      if (record.status === "failed") throw storedError(record);

      const timeoutAt = parseStoredDate(
        record.waitState?.timeoutAt,
        "timeoutAt",
      );
      const current = options.clock.now();
      if (current.getTime() >= timeoutAt.getTime()) {
        throw new Error(`Durable signal step "${id}" exceeded its timeout`);
      }
      throw new StepSuspend({
        stepId: id,
        at: current,
        nextPollAt: new Date(current.getTime() + SIGNAL_KEEPALIVE_MS),
        maxWaitUntil: timeoutAt,
        pollInterval: SIGNAL_KEEPALIVE_MS,
      });
    },

    async sleep(id, duration) {
      const invocation = begin(id);
      const existing = await get(invocation, "sleep");
      if (existing?.status === "completed") return;
      if (existing?.status === "failed") throw storedError(existing);

      const durationMs = parseStepDuration(duration);
      const now = options.clock.now();
      const record =
        existing ??
        (
          await claim(invocation, {
            stageRecordId: requireLedger().stageRecordId,
            stepId: id,
            seq: invocation.seq,
            kind: "sleep",
            status: "pending",
            waitState: {
              wakeAt: new Date(now.getTime() + durationMs).toISOString(),
            },
          })
        ).record;

      if (record.status === "completed") return;
      if (record.status === "failed") throw storedError(record);

      const wakeAt = parseStoredDate(record.waitState?.wakeAt, "wakeAt");
      const current = options.clock.now();
      if (current.getTime() >= wakeAt.getTime()) {
        await update(id, { status: "completed" });
        return;
      }

      throw new StepSuspend({
        stepId: id,
        at: current,
        nextPollAt: wakeAt,
        maxWaitUntil: new Date(wakeAt.getTime() + SLEEP_GRACE_MS),
        pollInterval: Math.max(0, wakeAt.getTime() - current.getTime()),
      });
    },
  } satisfies StepApi;
}
