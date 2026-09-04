/**
 * The Prisma adapters' raw Postgres statements.
 *
 * Two invariants, checked against the SQL a mocked client receives:
 *  - The status enum's type name is configurable (`statusEnumName`), and
 *    `claimNextPendingRun` binds a JS Date from the injected clock converted
 *    with `AT TIME ZONE 'UTC'` -- never a bare parameter and never `NOW()`,
 *    both of which write session-local time into the naive TIMESTAMP columns
 *    Prisma fills with UTC (see persistence/prisma/utc-timestamps.ts).
 *  - The *job lease* binds no timestamp at all: claim, heartbeat and stale
 *    sweep all read `now() AT TIME ZONE 'UTC'`, so the lease has exactly one
 *    clock and a host whose system clock drifts cannot shorten or extend it.
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

describe("PrismaJobQueue lease statements", () => {
  /** A client whose raw calls record their SQL and bound values. */
  function recordingClient() {
    const queryRaw = vi.fn(async () => []);
    return {
      queryRaw,
      prisma: { $queryRaw: queryRaw } as unknown as EnginePrismaClient,
      sqlAndValues(call = 0) {
        const [strings, ...values] = queryRaw.mock.calls[call] as unknown as [
          TemplateStringsArray,
          ...unknown[],
        ];
        return { sql: strings.join("?"), values };
      },
    };
  }

  it("takes the claim's lease stamps from the database clock, never the application clock", async () => {
    const client = recordingClient();
    const appClock = new Date("2026-09-03T12:00:00.000Z");
    const queue = new PrismaJobQueue(client.prisma, {
      workerId: "w",
      now: () => appClock,
    });

    await expect(queue.dequeue()).resolves.toBeNull();

    const { sql, values } = client.sqlAndValues();
    // `now() AT TIME ZONE 'UTC'` -- never a bare NOW(), which converts
    // through the session's timezone into these naive `timestamp` columns
    // (see utc-timestamps.ts).
    expect(sql).not.toMatch(/now\(\)(?! AT TIME ZONE 'UTC')/i);
    // Both lease columns plus the nextPollAt comparison.
    expect(sql.match(/now\(\) AT TIME ZONE 'UTC'/g)).toHaveLength(3);
    // Nothing time-shaped is bound any more: the lease has one clock, and
    // it is the database's, so two hosts cannot disagree about when a
    // lease expires. The attempt stamp comes back out through RETURNING.
    expect(values.some((v) => v instanceof Date)).toBe(false);
    expect(sql).toContain('RETURNING id, "workflowRunId"');
    expect(sql).toContain('"startedAt"');
  });

  it("derives the stale-lease deadline in the database", async () => {
    const client = recordingClient();
    const queue = new PrismaJobQueue(client.prisma, { workerId: "w" });

    await expect(queue.releaseStaleJobs(300_000)).resolves.toBe(0);

    const { sql, values } = client.sqlAndValues();
    expect(sql).toContain("now() AT TIME ZONE 'UTC'");
    expect(sql).toContain("interval '1 millisecond'");
    // The "now" the threshold is subtracted from is never bound: it is the
    // same database clock the claim stamped. Only the threshold and the
    // dead-letter reason travel as parameters.
    expect(values).toContain(300_000);
    expect(values.some((v) => v instanceof Date)).toBe(false);
  });

  it("renews the heartbeat from the database clock too", async () => {
    const client = recordingClient();
    const queue = new PrismaJobQueue(client.prisma, { workerId: "w" });

    await queue.touchJob("job-1");

    const { sql, values } = client.sqlAndValues();
    expect(sql).toContain(`"lockedAt" = (now() AT TIME ZONE 'UTC')`);
    expect(values).toEqual(["job-1"]);
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

describe("PrismaWorkflowPersistence definition-versioning capability", () => {
  /**
   * The state every consumer passes through, and what a rolling deploy
   * produces when code ships ahead of `migrate deploy`: the generated
   * client advertises `workflowDefinition`, the database has neither the
   * table nor the column. The structural check alone says "supported" and
   * then every claim dies on a raw 42703.
   */
  function clientWithoutSchema(rows: Array<Record<string, unknown>>) {
    const queryRawUnsafe = vi.fn(async () => rows);
    return {
      prisma: {
        $queryRawUnsafe: queryRawUnsafe,
        workflowDefinition: {
          findUnique: vi.fn(),
          create: vi.fn(),
        },
      } as unknown as EnginePrismaClient,
      queryRawUnsafe,
    };
  }

  it("turns versioning off when the database has not been migrated", async () => {
    const { prisma, queryRawUnsafe } = clientWithoutSchema([
      { has_table: false, has_column: false },
    ]);
    const persistence = new PrismaWorkflowPersistence(prisma);

    // The structural guess, before anything has asked the database.
    expect(persistence.supportsDefinitionVersioning()).toBe(true);

    expect(await persistence.ensureDefinitionVersioningDetected()).toBe(false);
    expect(persistence.supportsDefinitionVersioning()).toBe(false);

    // A catalogue read, so it cannot raise and cannot abort a caller's
    // transaction.
    const [sql] = queryRawUnsafe.mock.calls[0] as unknown as [string];
    expect(sql).toContain("to_regclass");
    expect(sql).not.toContain("SELECT id");
  });

  it("keeps versioning on when the database has the schema, and probes once", async () => {
    const { prisma, queryRawUnsafe } = clientWithoutSchema([
      { has_table: true, has_column: true },
    ]);
    const persistence = new PrismaWorkflowPersistence(prisma);

    expect(await persistence.ensureDefinitionVersioningDetected()).toBe(true);
    expect(await persistence.ensureDefinitionVersioningDetected()).toBe(true);
    expect(persistence.supportsDefinitionVersioning()).toBe(true);
    expect(queryRawUnsafe).toHaveBeenCalledTimes(1);
  });

  it("does not probe at all when the capability is configured explicitly", async () => {
    const { prisma, queryRawUnsafe } = clientWithoutSchema([
      { has_table: false, has_column: false },
    ]);
    const persistence = new PrismaWorkflowPersistence(prisma, {
      definitionVersioning: true,
    });

    expect(await persistence.ensureDefinitionVersioningDetected()).toBe(true);
    expect(queryRawUnsafe).not.toHaveBeenCalled();
  });
});
