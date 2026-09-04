import type {
  StepLedger,
  StepRecord,
  StepRecordExpectation,
  StepRecordPatch,
} from "../kernel/ports.js";

export interface InMemoryStepLedgerOptions {
  now?: () => Date;
}

function cloneJson(value: unknown): unknown {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

/** `undefined` keeps `current`; `null` clears; a date is copied. */
function patchDate(patched: Date | null | undefined, current: Date | null) {
  if (patched === undefined) return current;
  return patched === null ? null : new Date(patched.getTime());
}

function cloneRecord(record: StepRecord): StepRecord {
  return {
    ...record,
    externalKey: record.externalKey ?? null,
    result: cloneJson(record.result),
    waitState: record.waitState ? { ...record.waitState } : undefined,
    leaseExpiresAt: record.leaseExpiresAt
      ? new Date(record.leaseExpiresAt.getTime())
      : null,
    deadlineAt: record.deadlineAt
      ? new Date(record.deadlineAt.getTime())
      : null,
    createdAt: new Date(record.createdAt.getTime()),
    updatedAt: new Date(record.updatedAt.getTime()),
  };
}

/** Map-backed StepLedger for tests and local design spikes. */
export class InMemoryStepLedger implements StepLedger {
  private readonly records = new Map<string, StepRecord>();
  private readonly now: () => Date;

  constructor(options: InMemoryStepLedgerOptions = {}) {
    this.now = options.now ?? (() => new Date());
  }

  async claim(
    record: Omit<StepRecord, "createdAt" | "updatedAt">,
  ): Promise<{ created: boolean; record: StepRecord }> {
    const key = this.key(record.stageRecordId, record.stepId);
    const existing = this.records.get(key);
    if (existing) return { created: false, record: cloneRecord(existing) };

    const now = this.now();
    const created: StepRecord = {
      ...record,
      externalKey: record.externalKey ?? null,
      createdAt: now,
      updatedAt: now,
      // Normalised the way `PrismaStepLedger.mapStep` normalises a freshly
      // inserted row, so a claim that carries neither reads back the same
      // through both adapters: `null`, not `undefined`. `waitState` is the
      // exception in both -- a NULL column maps back to `undefined`.
      result: record.result === undefined ? null : cloneJson(record.result),
      error: record.error ?? null,
      waitState: record.waitState ? { ...record.waitState } : undefined,
      leaseExpiresAt: record.leaseExpiresAt
        ? new Date(record.leaseExpiresAt.getTime())
        : null,
      deadlineAt: record.deadlineAt
        ? new Date(record.deadlineAt.getTime())
        : null,
    };
    // The check and write are synchronous, so no other async caller can
    // interleave between them in this in-memory implementation.
    this.records.set(key, created);
    return { created: true, record: cloneRecord(created) };
  }

  async get(stageRecordId: string, stepId: string): Promise<StepRecord | null> {
    const record = this.records.get(this.key(stageRecordId, stepId));
    return record ? cloneRecord(record) : null;
  }

  async update(
    stageRecordId: string,
    stepId: string,
    patch: StepRecordPatch,
  ): Promise<StepRecord> {
    const key = this.key(stageRecordId, stepId);
    const existing = this.records.get(key);
    if (!existing) {
      throw new Error(`Step record not found: ${stageRecordId}/${stepId}`);
    }

    // One rule for every field, matching `StepRecordPatch` and the Prisma
    // adapter's `mapPatch`: `undefined` (however it got there -- absent, or
    // spread in from an optional property) leaves the field alone; any
    // other value, `null` included, is written.
    const updated: StepRecord = {
      ...existing,
      ...(patch.status !== undefined ? { status: patch.status } : {}),
      ...(patch.attempt !== undefined ? { attempt: patch.attempt } : {}),
      ...(patch.error !== undefined ? { error: patch.error } : {}),
      result:
        patch.result !== undefined ? cloneJson(patch.result) : existing.result,
      waitState:
        patch.waitState !== undefined
          ? { ...patch.waitState }
          : existing.waitState,
      leaseExpiresAt: patchDate(patch.leaseExpiresAt, existing.leaseExpiresAt),
      deadlineAt: patchDate(patch.deadlineAt, existing.deadlineAt),
      updatedAt: this.now(),
    };
    this.records.set(key, updated);
    return cloneRecord(updated);
  }

  async compareAndSet(
    stageRecordId: string,
    stepId: string,
    expected: StepRecordExpectation,
    patch: StepRecordPatch,
  ): Promise<{ applied: boolean; record: StepRecord | null }> {
    const existing = this.records.get(this.key(stageRecordId, stepId));
    if (!existing) return { applied: false, record: null };
    if (
      existing.status !== expected.status ||
      (expected.attempt !== undefined && existing.attempt !== expected.attempt)
    ) {
      return { applied: false, record: cloneRecord(existing) };
    }
    // The check and write are synchronous, so no other async caller can
    // interleave between them in this in-memory implementation.
    const record = await this.update(stageRecordId, stepId, patch);
    return { applied: true, record };
  }

  async list(stageRecordId: string): Promise<StepRecord[]> {
    return Array.from(this.records.values())
      .filter((record) => record.stageRecordId === stageRecordId)
      .sort((a, b) => a.seq - b.seq)
      .map(cloneRecord);
  }

  async clear(stageRecordId: string): Promise<void> {
    for (const [key, record] of this.records) {
      if (record.stageRecordId === stageRecordId) this.records.delete(key);
    }
  }

  async clearExcept(
    stageRecordId: string,
    keepStepIds: string[],
  ): Promise<void> {
    const keep = new Set(keepStepIds);
    for (const [key, record] of this.records) {
      if (record.stageRecordId !== stageRecordId) continue;
      if (keep.has(record.stepId)) continue;
      this.records.delete(key);
    }
  }

  private key(stageRecordId: string, stepId: string): string {
    return `${stageRecordId}\u0000${stepId}`;
  }
}
