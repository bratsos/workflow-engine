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
      result: cloneJson(record.result),
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

    const updated: StepRecord = {
      ...existing,
      ...patch,
      result: Object.hasOwn(patch, "result")
        ? cloneJson(patch.result)
        : existing.result,
      waitState: Object.hasOwn(patch, "waitState")
        ? patch.waitState
          ? { ...patch.waitState }
          : undefined
        : existing.waitState,
      leaseExpiresAt: Object.hasOwn(patch, "leaseExpiresAt")
        ? patch.leaseExpiresAt
          ? new Date(patch.leaseExpiresAt.getTime())
          : null
        : existing.leaseExpiresAt,
      deadlineAt: Object.hasOwn(patch, "deadlineAt")
        ? patch.deadlineAt
          ? new Date(patch.deadlineAt.getTime())
          : null
        : existing.deadlineAt,
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
