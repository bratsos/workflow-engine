import { describe, expect, it, vi } from "vitest";
import { PrismaWorkflowPersistence } from "../../persistence/prisma/persistence.js";

describe("skipInteractiveTransactions", () => {
  it("bypasses $transaction when skipInteractiveTransactions is true", async () => {
    const mockPrisma = {
      $transaction: vi.fn(),
    };
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
    };
    const persistence = new PrismaWorkflowPersistence(mockPrisma, {
      skipInteractiveTransactions: false,
    });

    await persistence.withTransaction(async () => "ok");

    expect(mockPrisma.$transaction).toHaveBeenCalled();
  });
});
