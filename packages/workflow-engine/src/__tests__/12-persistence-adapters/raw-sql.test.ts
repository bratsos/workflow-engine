/**
 * The Prisma adapters' raw Postgres statements: the status enum's type name
 * is configurable (`statusEnumName`) and every timestamp is a bound JS Date
 * from the injected clock, never `NOW()` (which writes session-local time
 * into naive TIMESTAMP columns while Prisma writes UTC).
 */

import { describe, expect, it, vi } from "vitest";
import { PrismaJobQueue } from "../../persistence/prisma/job-queue.js";
import { PrismaWorkflowPersistence } from "../../persistence/prisma/persistence.js";
import type { EnginePrismaClient } from "../../persistence/prisma/prisma-client-type.js";

describe("PrismaWorkflowPersistence.claimNextPendingRun raw SQL", () => {
  it("casts with the configured status enum name and binds the clock time", async () => {
    const queryRawUnsafe = vi.fn(async () => []);
    const prisma = {
      $queryRawUnsafe: queryRawUnsafe,
    } as unknown as EnginePrismaClient;
    const now = new Date("2026-09-03T10:00:00.000Z");
    const persistence = new PrismaWorkflowPersistence(prisma, {
      statusEnumName: "WorkflowStatus",
      now: () => now,
    });

    await expect(persistence.claimNextPendingRun()).resolves.toBeNull();

    expect(queryRawUnsafe).toHaveBeenCalledTimes(1);
    const [sql, ...params] = queryRawUnsafe.mock.calls[0] as unknown as [
      string,
      ...unknown[],
    ];
    expect(sql).toContain('$1::"WorkflowStatus"');
    expect(sql).toContain('$2::"WorkflowStatus"');
    expect(sql).not.toContain('"Status"');
    expect(sql).not.toContain("NOW()");
    expect(params).toEqual(["PENDING", "RUNNING", now]);
  });

  it('defaults the enum name to "Status" and honours a per-call now', async () => {
    const queryRawUnsafe = vi.fn(async () => []);
    const prisma = {
      $queryRawUnsafe: queryRawUnsafe,
    } as unknown as EnginePrismaClient;
    const persistence = new PrismaWorkflowPersistence(prisma);
    const now = new Date("2026-09-03T11:00:00.000Z");

    await persistence.claimNextPendingRun({ now });

    const [sql, ...params] = queryRawUnsafe.mock.calls[0] as unknown as [
      string,
      ...unknown[],
    ];
    expect(sql).toContain('::"Status"');
    expect(params[2]).toBe(now);
  });

  it("falls back to the tagged template on a client without $queryRawUnsafe", async () => {
    const queryRaw = vi.fn(async () => []);
    const prisma = { $queryRaw: queryRaw } as unknown as EnginePrismaClient;
    const persistence = new PrismaWorkflowPersistence(prisma);

    await persistence.claimNextPendingRun();

    const [strings, ...values] = queryRaw.mock.calls[0] as unknown as [
      TemplateStringsArray,
      ...unknown[],
    ];
    const sql = strings.join("?");
    expect(sql).toContain('::"Status"');
    expect(sql).not.toContain("NOW()");
    expect(values.filter((v) => v instanceof Date)).toHaveLength(2);
  });

  it("rejects a custom enum name on a client that only has $queryRaw", async () => {
    const prisma = {
      $queryRaw: vi.fn(async () => []),
    } as unknown as EnginePrismaClient;
    const persistence = new PrismaWorkflowPersistence(prisma, {
      statusEnumName: "WorkflowStatus",
    });

    await expect(persistence.claimNextPendingRun()).rejects.toThrow(
      /\$queryRawUnsafe/,
    );
  });

  it("rejects an enum name that is not a plain identifier", () => {
    expect(
      () =>
        new PrismaWorkflowPersistence({} as unknown as EnginePrismaClient, {
          statusEnumName: 'Status"; DROP TABLE',
        }),
    ).toThrow(/plain SQL identifier/);
  });
});

describe("PrismaJobQueue.dequeue raw SQL", () => {
  it("binds the clock time instead of NOW()", async () => {
    const queryRaw = vi.fn(async () => []);
    const prisma = { $queryRaw: queryRaw } as unknown as EnginePrismaClient;
    const now = new Date("2026-09-03T12:00:00.000Z");
    const queue = new PrismaJobQueue(prisma, {
      workerId: "w",
      now: () => now,
    });

    await expect(queue.dequeue()).resolves.toBeNull();

    const [strings, ...values] = queryRaw.mock.calls[0] as unknown as [
      TemplateStringsArray,
      ...unknown[],
    ];
    const sql = strings.join("?");
    expect(sql).not.toContain("NOW()");
    expect(values.filter((v) => v === now)).toHaveLength(3);
  });
});
