/**
 * Insert-if-absent paths in the Prisma adapters must not rely on a caught
 * unique violation on Postgres: a failed statement aborts a consumer's
 * enclosing transaction (25P02), and replays re-claim completed steps on
 * every poll. They use `createMany({ skipDuplicates: true })` plus a
 * read-back instead.
 */

import { describe, expect, it, vi } from "vitest";
import { PrismaWorkflowPersistence } from "../../persistence/prisma/persistence.js";
import type { EnginePrismaClient } from "../../persistence/prisma/prisma-client-type.js";
import { PrismaStepLedger } from "../../persistence/prisma/step-ledger.js";

const now = new Date("2026-09-03T12:00:00.000Z");
const row = {
  stageRecordId: "stage-1",
  stepId: "items:0",
  seq: 1,
  kind: "run",
  status: "completed",
  attempt: 1,
  leaseExpiresAt: null,
  deadlineAt: null,
  result: { ok: true },
  error: null,
  waitState: null,
  createdAt: now,
  updatedAt: now,
};

describe("PrismaStepLedger.claim on Postgres", () => {
  it("never issues a bare create; an existing row wins without a statement error", async () => {
    const create = vi.fn();
    const createMany = vi.fn(async () => ({ count: 0 }));
    const findUnique = vi.fn(async () => row);
    const prisma = {
      workflowStep: { create, createMany, findUnique },
    } as unknown as EnginePrismaClient;
    const ledger = new PrismaStepLedger(prisma);

    const result = await ledger.claim({
      stageRecordId: "stage-1",
      stepId: "items:0",
      seq: 1,
      kind: "run",
      status: "running",
      attempt: 1,
      leaseExpiresAt: null,
      deadlineAt: null,
    });

    expect(create).not.toHaveBeenCalled();
    expect(createMany).toHaveBeenCalledWith(
      expect.objectContaining({ skipDuplicates: true }),
    );
    expect(result.created).toBe(false);
    expect(result.record).toMatchObject({
      stepId: "items:0",
      status: "completed",
    });
  });

  it("reports created when the insert landed", async () => {
    const createMany = vi.fn(async () => ({ count: 1 }));
    const findUnique = vi.fn(async () => ({ ...row, status: "running" }));
    const prisma = {
      workflowStep: { create: vi.fn(), createMany, findUnique },
    } as unknown as EnginePrismaClient;
    const ledger = new PrismaStepLedger(prisma);

    const result = await ledger.claim({
      stageRecordId: "stage-1",
      stepId: "items:0",
      seq: 1,
      kind: "run",
      status: "running",
      attempt: 1,
      leaseExpiresAt: null,
      deadlineAt: null,
    });

    expect(result.created).toBe(true);
    expect(result.record.status).toBe("running");
  });
});

describe("PrismaWorkflowPersistence.acquireIdempotencyKey on Postgres", () => {
  it("acquires through createMany skipDuplicates and replays from the read-back", async () => {
    const create = vi.fn();
    const createMany = vi.fn(async () => ({ count: 0 }));
    const findUnique = vi.fn(async () => ({
      id: "k1",
      result: { done: true },
      createdAt: now,
    }));
    const prisma = {
      idempotencyKey: { create, createMany, findUnique },
    } as unknown as EnginePrismaClient;
    const persistence = new PrismaWorkflowPersistence(prisma);

    const result = await persistence.acquireIdempotencyKey("key", "run.create");

    expect(create).not.toHaveBeenCalled();
    expect(createMany).toHaveBeenCalledWith(
      expect.objectContaining({ skipDuplicates: true }),
    );
    expect(result).toEqual({ status: "replay", result: { done: true } });
  });
});
