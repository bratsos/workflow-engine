/**
 * `PrismaWorkflowPersistence` forwards every `UpdateStageInput` field to the
 * Prisma update — in particular `attempt`, which the kernel bumps on a job
 * retry and which the adapter dropped on alpha.2 (the row stayed at 0
 * after three job attempts while `version` advanced).
 */

import { describe, expect, it, vi } from "vitest";
import { PrismaWorkflowPersistence } from "../../persistence/prisma/persistence.js";
import type { EnginePrismaClient } from "../../persistence/prisma/prisma-client-type.js";

function stageRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "stage-1",
    workflowRunId: "run-1",
    stageId: "extract",
    stageName: "Extract",
    stageNumber: 1,
    executionGroup: 0,
    attempt: 0,
    status: "RUNNING",
    version: 1,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe("PrismaWorkflowPersistence stage updates", () => {
  it("writes attempt through upsertStage on a job retry", async () => {
    const upsert = vi.fn(async (args: any) => stageRow(args.update));
    const prisma = {
      workflowStage: { upsert },
    } as unknown as EnginePrismaClient;
    const persistence = new PrismaWorkflowPersistence(prisma);

    const record = await persistence.upsertStage({
      workflowRunId: "run-1",
      stageId: "extract",
      create: {
        workflowRunId: "run-1",
        stageId: "extract",
        stageName: "Extract",
        stageNumber: 1,
        executionGroup: 0,
        status: "RUNNING",
      },
      update: { status: "RUNNING", attempt: 2 },
    });

    const data = upsert.mock.calls[0]![0].update;
    expect(data.attempt).toBe(2);
    expect(data.version).toEqual({ increment: 1 });
    expect(record.attempt).toBe(2);
  });

  it("writes attempt and a null errorMessage through updateStage", async () => {
    const update = vi.fn(async (args: any) => stageRow(args.data));
    const prisma = {
      workflowStage: { update },
    } as unknown as EnginePrismaClient;
    const persistence = new PrismaWorkflowPersistence(prisma);

    await persistence.updateStage("stage-1", {
      status: "COMPLETED",
      attempt: 1,
      errorMessage: null,
    });

    const data = update.mock.calls[0]![0].data;
    expect(data.attempt).toBe(1);
    expect(data.errorMessage).toBeNull();
  });

  it("leaves attempt untouched when the update does not name it", async () => {
    const update = vi.fn(async (args: any) => stageRow(args.data));
    const prisma = {
      workflowStage: { update },
    } as unknown as EnginePrismaClient;
    const persistence = new PrismaWorkflowPersistence(prisma);

    await persistence.updateStage("stage-1", { status: "SUSPENDED" });

    expect(update.mock.calls[0]![0].data.attempt).toBeUndefined();
  });
});
