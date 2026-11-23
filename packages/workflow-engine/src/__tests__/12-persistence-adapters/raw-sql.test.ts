/**
 * The Prisma adapters' raw Postgres statements.
 *
 * Two invariants, checked against the SQL a mocked client receives:
 *  - The status enum's type name is configurable (`statusEnumName`), and
 *    `claimNextPendingRun` binds the injected clock's ISO string converted
 *    with `AT TIME ZONE 'UTC'` -- never a bare parameter, a JS Date or `NOW()`,
 *    which write session-local time into the naive TIMESTAMP columns Prisma
 *    fills with UTC (see persistence/prisma/utc-timestamps.ts).
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
    expect(params).toEqual(["PENDING", "RUNNING", now.toISOString()]);
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
    expect(params[2]).toBe(now.toISOString());
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
    expect(values.filter((v) => v instanceof Date)).toHaveLength(0);
    expect(
      values.filter((v) => typeof v === "string" && v.endsWith("Z")),
    ).toHaveLength(2);
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
    // Both claim stamps, both deadlines and the nextPollAt comparison.
    expect(sql.match(/now\(\) AT TIME ZONE 'UTC'/g)).toHaveLength(4);
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

    await queue.touchJob("job-1", 9_000);

    const { sql, values } = client.sqlAndValues();
    expect(sql).toContain(`"lockedAt" = (now() AT TIME ZONE 'UTC')`);
    expect(sql).toContain('"leaseExpiresAt"');
    expect(values).toContain("job-1");
    expect(values).toContain(9_000);
    expect(values.some((v) => v instanceof Date)).toBe(false);
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

describe("PrismaWorkflowPersistence.claimOutboxDelivery raw SQL", () => {
  it("claims an unblocked run head with SKIP LOCKED without stamping publishedAt", async () => {
    const now = new Date("2026-09-04T10:00:00.000Z");
    const claim = "2026-09-04T10:01:00.000Z|owner";
    const row = {
      id: "evt-1",
      workflowRunId: "run-1",
      sequence: 1,
      eventType: "workflow:created",
      payload: {},
      causationId: "cmd-1",
      occurredAt: now,
      publishedAt: null,
      retryCount: 0,
      dlqAt: null,
    };
    const queryRawUnsafe = vi.fn(
      async (_sql: string, ..._params: unknown[]) => [row],
    );
    const tx = {
      $queryRawUnsafe: queryRawUnsafe,
      $executeRaw: vi.fn(async () => 0),
    };
    const prisma = {
      ...tx,
      outboxEvent: { findFirst: vi.fn(async () => null) },
      $transaction: (work: (client: typeof tx) => unknown) => work(tx),
    } as unknown as EnginePrismaClient;
    const persistence = new PrismaWorkflowPersistence(prisma);
    expect(await persistence.claimOutboxDelivery(25, claim, now, [])).toEqual([
      row,
    ]);
    // One planner statement, then the claim, in one transaction.
    expect(queryRawUnsafe).toHaveBeenCalledTimes(2);
    expect(queryRawUnsafe.mock.calls[0]![0]).toContain(
      "set_config('enable_seqscan', 'off', true)",
    );
    const [sql, ...params] = queryRawUnsafe.mock.calls[1]!;
    expect(sql).toContain("FOR UPDATE OF e SKIP LOCKED");
    expect(sql).toContain('"workflowRunId" > walk.run_id');
    expect(sql).toContain("cursor AS MATERIALIZED");
    expect(params).toEqual([25, `${now.toISOString()}~`, claim]);
    expect(sql).toContain('SET "deliveryClaim"');
    expect(sql).not.toMatch(/SET "publishedAt"/);
    expect(prisma.outboxEvent.findFirst).not.toHaveBeenCalled();
  });

  it("refuses a PostgreSQL root without a raw read when it is built", () => {
    const prisma = {
      outboxEvent: { findFirst: vi.fn(), updateMany: vi.fn() },
      $executeRawUnsafe: vi.fn(),
      $transaction: vi.fn(),
    } as unknown as EnginePrismaClient;
    expect(
      () =>
        new PrismaWorkflowPersistence(prisma, { databaseType: "postgresql" }),
    ).toThrow(
      expect.objectContaining({
        name: "OutboxClaimUnsupportedError",
        code: "OUTBOX_CLAIM_UNSUPPORTED",
      }),
    );
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
