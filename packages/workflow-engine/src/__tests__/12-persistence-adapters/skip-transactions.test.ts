import { describe, expect, it, vi } from "vitest";
import { PrismaWorkflowPersistence } from "../../persistence/prisma/persistence.js";
import type { EnginePrismaClient } from "../../persistence/prisma/prisma-client-type.js";

describe("skipInteractiveTransactions", () => {
  it("bypasses $transaction when skipInteractiveTransactions is true", async () => {
    // Deliberately minimal -- this test only exercises the
    // skipInteractiveTransactions bypass, never a real delegate call, so
    // the mock doesn't implement the full EnginePrismaClient shape. Cast
    // rather than widen the constructor's real parameter type.
    const mockPrisma = {
      $transaction: vi.fn(),
    } as unknown as EnginePrismaClient;
    const persistence = new PrismaWorkflowPersistence(mockPrisma, {
      skipInteractiveTransactions: true,
    });

    let calledWith: any;
    await persistence.withTransaction(async (tx) => {
      calledWith = tx;
      return "ok";
    });

    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    expect(calledWith).toBe(persistence);
  });

  it("uses $transaction when skipInteractiveTransactions is false", async () => {
    const mockPrisma = {
      $transaction: vi.fn(async (fn: any) => fn(mockPrisma)),
    } as unknown as EnginePrismaClient;
    const persistence = new PrismaWorkflowPersistence(mockPrisma, {
      skipInteractiveTransactions: false,
    });

    await persistence.withTransaction(async () => "ok");

    expect(mockPrisma.$transaction).toHaveBeenCalled();
  });
});

describe("withTransaction keeps every option on the transactional clone", () => {
  it("casts with the configured status enum name inside the transaction", async () => {
    const queryRawUnsafe = vi.fn(async () => []);
    const tx = {
      $queryRawUnsafe: queryRawUnsafe,
    } as unknown as EnginePrismaClient;
    const mockPrisma = {
      $queryRawUnsafe: vi.fn(async () => []),
      $transaction: vi.fn(async (fn: any) => fn(tx)),
    } as unknown as EnginePrismaClient;
    const now = new Date("2026-09-04T10:00:00.000Z");
    const persistence = new PrismaWorkflowPersistence(mockPrisma, {
      statusEnumName: "WorkflowStatus",
      now: () => now,
    });

    await persistence.withTransaction((inner) => inner.claimNextPendingRun());

    expect(queryRawUnsafe).toHaveBeenCalledTimes(1);
    const [sql, ...params] = queryRawUnsafe.mock.calls[0] as unknown as [
      string,
      ...unknown[],
    ];
    expect(sql).toContain('::"WorkflowStatus"');
    expect(sql).not.toContain('"Status"');
    expect(params[2]).toBe(now);
  });
});
