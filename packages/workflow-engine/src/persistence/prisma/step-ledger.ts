import type { StepLedger, StepRecord } from "../../kernel/ports.js";
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
    result: record.result ?? undefined,
    error: record.error ?? undefined,
    waitState: record.waitState ?? undefined,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
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
          ...(record.result !== undefined ? { result: record.result } : {}),
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
    patch: Partial<
      Pick<StepRecord, "status" | "result" | "error" | "waitState">
    >,
  ): Promise<StepRecord> {
    const data: Record<string, unknown> = {};
    if (patch.status !== undefined) data.status = patch.status;
    if (patch.result !== undefined) data.result = patch.result;
    if (patch.error !== undefined) data.error = patch.error;
    if (patch.waitState !== undefined) data.waitState = patch.waitState;

    const updated = await this.prisma.workflowStep.update({
      where: { stageRecordId_stepId: { stageRecordId, stepId } },
      data,
    });
    return mapStep(updated);
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
