/**
 * The Prisma adapters' raw Postgres statements: the status enum's type name
 * is configurable (`statusEnumName`), and every timestamp is a bound JS Date
 * from the injected clock converted with `AT TIME ZONE 'UTC'` -- never
 * `NOW()` and never a bare parameter, both of which write session-local time
 * into the naive TIMESTAMP columns Prisma fills with UTC (see
 * persistence/prisma/utc-timestamps.ts).
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
    expect(sql).toContain(`"startedAt" = ($3::timestamptz AT TIME ZONE 'UTC')`);
    expect(sql).toContain(`"updatedAt" = ($3::timestamptz AT TIME ZONE 'UTC')`);
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
    expect(sql).toContain("AT TIME ZONE 'UTC'");
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
    // Both lease columns and the nextPollAt comparison go through the
    // explicit UTC conversion, so they mean the same thing as the values
    // Prisma's model API writes on any session timezone.
    expect(sql.match(/AT TIME ZONE 'UTC'/g)).toHaveLength(3);
    expect(values.filter((v) => v === now)).toHaveLength(3);
  });
});

describe("PrismaJobQueue.dequeue on a row without a payload", () => {
  it("fails the row as a dead job and dequeues the next one", async () => {
    const rows = [
      {
        id: "job-null",
        workflowRunId: "run-1",
        stageId: "s1",
        priority: 0,
        attempt: 1,
        maxAttempts: 3,
        payload: null,
      },
      {
        id: "job-ok",
        workflowRunId: "run-1",
        stageId: "s2",
        priority: 0,
        attempt: 1,
        maxAttempts: 3,
        payload: { _workflowId: "wf", config: {} },
      },
    ];
    const queryRaw = vi.fn(async () => {
      const next = rows.shift();
      return next ? [next] : [];
    });
    const update = vi.fn(
      async (_args: { where: unknown; data: unknown }) => ({}),
    );
    const prisma = {
      $queryRaw: queryRaw,
      jobQueue: { update },
    } as unknown as EnginePrismaClient;
    const queue = new PrismaJobQueue(prisma, { workerId: "w1" });

    const job = await queue.dequeue();

    expect(job).toMatchObject({
      jobId: "job-ok",
      workflowId: "wf",
      stageId: "s2",
    });
    expect(queryRaw).toHaveBeenCalledTimes(2);
    expect(update).toHaveBeenCalledTimes(1);
    expect(update.mock.calls[0]![0]).toMatchObject({
      where: { id: "job-null" },
      data: {
        status: "FAILED",
        lastError: expect.stringContaining("Job job-null has no payload"),
      },
    });
    expect(
      (update.mock.calls[0]![0].data as { completedAt: unknown }).completedAt,
    ).toBeInstanceOf(Date);
  });
});

describe("PrismaWorkflowPersistence.claimUnpublishedOutboxEvents raw SQL", () => {
  it("claims with FOR UPDATE SKIP LOCKED and stamps publishedAt from the clock in one statement", async () => {
    const now = new Date("2026-09-04T10:00:00.000Z");
    const row = {
      id: "evt-1",
      workflowRunId: "run-1",
      sequence: 1,
      eventType: "workflow:created",
      payload: { type: "workflow:created" },
      causationId: "cmd-1",
      occurredAt: now,
      publishedAt: now,
      retryCount: 0,
      dlqAt: null,
    };
    const queryRawUnsafe = vi.fn(async () => [row]);
    const prisma = {
      $queryRawUnsafe: queryRawUnsafe,
    } as unknown as EnginePrismaClient;
    const persistence = new PrismaWorkflowPersistence(prisma, {
      now: () => now,
    });

    const claimed = await persistence.claimUnpublishedOutboxEvents(25);

    expect(claimed).toEqual([row]);
    const [sql, ...params] = queryRawUnsafe.mock.calls[0] as unknown as [
      string,
      ...unknown[],
    ];
    expect(sql).toContain("FOR UPDATE SKIP LOCKED");
    expect(sql).toContain('"publishedAt" IS NULL AND "dlqAt" IS NULL');
    expect(sql).toContain(
      `SET "publishedAt" = ($2::timestamptz AT TIME ZONE 'UTC')`,
    );
    expect(sql).toContain("RETURNING");
    expect(sql).not.toContain("NOW()");
    expect(params).toEqual([25, now]);
  });

  it("falls back to a per-row compare-and-set on SQLite", async () => {
    const now = new Date("2026-09-04T11:00:00.000Z");
    const rows = [
      {
        id: "a",
        workflowRunId: "run-1",
        sequence: 1,
        publishedAt: null,
        dlqAt: null,
        retryCount: 0,
      },
      {
        id: "b",
        workflowRunId: "run-1",
        sequence: 2,
        publishedAt: null,
        dlqAt: null,
        retryCount: 0,
      },
    ];
    const findMany = vi.fn(async () => rows);
    // "a" was claimed by another flush between the read and the update.
    const updateMany = vi.fn(async (args: any) => ({
      count: args.where.id === "a" ? 0 : 1,
    }));
    const prisma = {
      outboxEvent: { findMany, updateMany },
    } as unknown as EnginePrismaClient;
    const persistence = new PrismaWorkflowPersistence(prisma, {
      databaseType: "sqlite",
      now: () => now,
    });

    const claimed = await persistence.claimUnpublishedOutboxEvents();

    expect(claimed.map((e) => e.id)).toEqual(["b"]);
    expect(claimed[0]!.publishedAt).toBe(now);
    expect(updateMany).toHaveBeenCalledTimes(2);
    expect(updateMany.mock.calls[0]![0].where).toEqual({
      id: "a",
      publishedAt: null,
      dlqAt: null,
    });
  });
});
