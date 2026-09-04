import type {
  StepLedger,
  StepRecord,
  StepRecordExpectation,
  StepRecordPatch,
} from "../../kernel/ports.js";
import type { EnginePrismaClient } from "./prisma-client-type.js";

type PrismaClient = EnginePrismaClient;

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "P2002"
  );
}

function mapStep(record: any): StepRecord {
  return {
    stageRecordId: record.stageRecordId,
    stepId: record.stepId,
    seq: record.seq,
    kind: record.kind,
    status: record.status,
    attempt: record.attempt,
    leaseExpiresAt: record.leaseExpiresAt,
    deadlineAt: record.deadlineAt,
    externalKey: record.externalKey ?? null,
    result: record.result === null ? null : record.result,
    error: record.error ?? null,
    waitState: record.waitState ?? undefined,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function mapPatch(patch: StepRecordPatch): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  if (patch.status !== undefined) data.status = patch.status;
  if (patch.attempt !== undefined) data.attempt = patch.attempt;
  if (patch.leaseExpiresAt !== undefined)
    data.leaseExpiresAt = patch.leaseExpiresAt;
  if (patch.deadlineAt !== undefined) data.deadlineAt = patch.deadlineAt;
  // A null result is left as SQL NULL (the column default): writing Prisma.JsonNull
  // would require importing the consumer's generated client, which Prisma 7
  // no longer exposes under a fixed path. `get` maps SQL NULL back to null.
  if (Object.hasOwn(patch, "result") && patch.result != null) {
    data.result = patch.result;
  }
  if (Object.hasOwn(patch, "error")) data.error = patch.error ?? null;
  if (patch.waitState !== undefined) data.waitState = patch.waitState;
  return data;
}

export interface PrismaStepLedgerOptions {
  /**
   * Database type. Defaults to "postgresql". On Postgres `claim` is an
   * insert-if-absent through `createMany({ skipDuplicates: true })` (an
   * `ON CONFLICT DO NOTHING`) followed by a read-back, so a replay that
   * re-claims completed steps never raises a unique violation — which would
   * abort a consumer's enclosing transaction (`25P02`). SQLite has no
   * `skipDuplicates`; it keeps the create-and-catch path, which is safe there
   * because SQLite does not poison the transaction on a constraint error.
   */
  databaseType?: "postgresql" | "sqlite";
}

/** Prisma-backed durable step ledger. */
export class PrismaStepLedger implements StepLedger {
  private readonly databaseType: "postgresql" | "sqlite";

  constructor(
    private readonly prisma: PrismaClient,
    options: PrismaStepLedgerOptions = {},
  ) {
    this.databaseType = options.databaseType ?? "postgresql";
  }

  async claim(
    record: Omit<StepRecord, "createdAt" | "updatedAt">,
  ): Promise<{ created: boolean; record: StepRecord }> {
    const data = {
      stageRecordId: record.stageRecordId,
      stepId: record.stepId,
      seq: record.seq,
      kind: record.kind,
      status: record.status,
      attempt: record.attempt,
      leaseExpiresAt: record.leaseExpiresAt,
      deadlineAt: record.deadlineAt,
      ...(record.externalKey != null
        ? { externalKey: record.externalKey }
        : {}),
      ...(record.result != null ? { result: record.result } : {}),
      ...(record.error !== undefined ? { error: record.error } : {}),
      ...(record.waitState !== undefined
        ? { waitState: record.waitState }
        : {}),
    };

    if (this.databaseType === "postgresql") {
      // ON CONFLICT DO NOTHING + read-back: no statement error inside the
      // caller's transaction when the row already exists.
      const { count } = await this.prisma.workflowStep.createMany({
        data: [data],
        skipDuplicates: true,
      });
      const row = await this.get(record.stageRecordId, record.stepId);
      if (!row) {
        throw new Error(
          `Durable step "${record.stepId}" could not be read back after claim`,
        );
      }
      return { created: count > 0, record: row };
    }

    try {
      const created = await this.prisma.workflowStep.create({ data });
      return { created: true, record: mapStep(created) };
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      const existing = await this.get(record.stageRecordId, record.stepId);
      if (!existing) {
        throw new Error(
          `Step ${record.stageRecordId}/${record.stepId} conflicted but could not be read back`,
        );
      }
      return { created: false, record: existing };
    }
  }

  async get(stageRecordId: string, stepId: string): Promise<StepRecord | null> {
    const record = await this.prisma.workflowStep.findUnique({
      where: { stageRecordId_stepId: { stageRecordId, stepId } },
    });
    return record ? mapStep(record) : null;
  }

  async update(
    stageRecordId: string,
    stepId: string,
    patch: StepRecordPatch,
  ): Promise<StepRecord> {
    const updated = await this.prisma.workflowStep.update({
      where: { stageRecordId_stepId: { stageRecordId, stepId } },
      data: mapPatch(patch),
    });
    return mapStep(updated);
  }

  async compareAndSet(
    stageRecordId: string,
    stepId: string,
    expected: StepRecordExpectation,
    patch: StepRecordPatch,
  ): Promise<{ applied: boolean; record: StepRecord | null }> {
    const { count } = await this.prisma.workflowStep.updateMany({
      where: {
        stageRecordId,
        stepId,
        status: expected.status,
        // Omitted, not `undefined`-as-any: an absent attempt means "any
        // attempt", so the WHERE must not constrain the column at all.
        ...(expected.attempt !== undefined
          ? { attempt: expected.attempt }
          : {}),
      },
      data: mapPatch(patch),
    });
    const record = await this.get(stageRecordId, stepId);
    return { applied: count > 0 && record !== null, record };
  }

  async list(stageRecordId: string): Promise<StepRecord[]> {
    const records = await this.prisma.workflowStep.findMany({
      where: { stageRecordId },
      orderBy: { seq: "asc" },
    });
    return records.map(mapStep);
  }

  async clear(stageRecordId: string): Promise<void> {
    await this.prisma.workflowStep.deleteMany({ where: { stageRecordId } });
  }

  async clearExcept(
    stageRecordId: string,
    keepStepIds: string[],
  ): Promise<void> {
    if (keepStepIds.length === 0) return this.clear(stageRecordId);
    await this.prisma.workflowStep.deleteMany({
      where: { stageRecordId, stepId: { notIn: keepStepIds } },
    });
  }
}

export function createPrismaStepLedger(
  prisma: PrismaClient,
  options?: PrismaStepLedgerOptions,
): StepLedger {
  return new PrismaStepLedger(prisma, options);
}
