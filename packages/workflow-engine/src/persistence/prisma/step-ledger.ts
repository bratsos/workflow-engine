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

/** Prisma-backed durable step ledger. */
export class PrismaStepLedger implements StepLedger {
  constructor(private readonly prisma: PrismaClient) {}

  async claim(
    record: Omit<StepRecord, "createdAt" | "updatedAt">,
  ): Promise<{ created: boolean; record: StepRecord }> {
    try {
      const created = await this.prisma.workflowStep.create({
        data: {
          stageRecordId: record.stageRecordId,
          stepId: record.stepId,
          seq: record.seq,
          kind: record.kind,
          status: record.status,
          attempt: record.attempt,
          leaseExpiresAt: record.leaseExpiresAt,
          deadlineAt: record.deadlineAt,
          ...(record.result != null ? { result: record.result } : {}),
          ...(record.error !== undefined ? { error: record.error } : {}),
          ...(record.waitState !== undefined
            ? { waitState: record.waitState }
            : {}),
        },
      });
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
        attempt: expected.attempt,
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
}

export function createPrismaStepLedger(prisma: PrismaClient): StepLedger {
  return new PrismaStepLedger(prisma);
}
