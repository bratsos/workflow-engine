/**
 * The Prisma read port against a real PostgreSQL database.
 *
 * An in-memory fake cannot tell us whether the identifiers are quoted
 * correctly, whether the `Status` enum cast round-trips, whether the
 * row-wise keyset comparison pages the way it is supposed to, or whether
 * `statement_timeout` actually produces a `ConsoleQueryTimeoutError`. This
 * suite covers those Postgres-specific behaviors; the SQLite suite covers
 * its separate SQL and storage behavior.
 *
 * The other half of the point is the property this whole package exists to
 * preserve: the reader is checked here both with a root client and with a
 * transaction client handed in from outside, because a consumer running
 * under row-level security gives it the latter.
 *
 * Requires:
 *   - DATABASE_URL pointing at a Postgres database
 *   - PRISMA_MAJOR (6, 7 or 8, default 7): the Prisma major under test
 *   - `pnpm --filter @bratsos/workflow-engine run prisma:generate`
 *   - `pnpm --filter @bratsos/workflow-engine run prisma:db-push`
 *
 * Skipped entirely without DATABASE_URL, so `pnpm test` stays green with
 * no database — the in-memory equivalents in `read-port.test.ts` always run.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { ConsoleQueryTimeoutError, isStatementTimeout } from "../errors";
import {
  type ConsolePrismaClient,
  createPrismaConsoleReadPort,
} from "../prisma-read-port";
import { createPostgresClient } from "./postgres-client";
import { type RecordedStatement, recordingClient } from "./recording-client";

const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  describe.skip("I want the console read port to work against real Postgres", () => {
    it("skipped - set DATABASE_URL to run against a real Postgres database", () => {});
  });
} else {
  describe("I want the console read port to work against real Postgres", () => {
    // Built lazily so the generated `@prisma/client` -- which only exists
    // once `prisma:generate` has run -- is never resolved when this branch is
    // not taken. The fixture for the Prisma major in PRISMA_MAJOR builds it.
    const prisma = createPostgresClient(DATABASE_URL);
    const client = prisma as ConsolePrismaClient;
    // A raw read that returns `columns`: on Prisma 8 it has to declare them.
    const rawRead = (c: ConsolePrismaClient, columns = {}) =>
      c.$withColumns?.(columns) ?? c;

    const T0 = new Date("2026-03-01T12:00:00.000Z");
    const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);

    async function truncateAll() {
      await prisma.$executeRawUnsafe(
        `TRUNCATE TABLE "job_queue", "workflow_annotations", "workflow_artifacts", "workflow_logs", "workflow_steps", "workflow_stages", "workflow_runs", "ai_calls", "outbox_events", "idempotency_keys" RESTART IDENTITY CASCADE`,
      );
    }

    async function seed() {
      await prisma.workflowRun.createMany({
        data: [
          mkRun("run-1", at(0), "COMPLETED", "wf-a"),
          mkRun("run-2", at(10), "FAILED", "wf-a"),
          {
            ...mkRun("run-3", at(20), "RUNNING", "wf-b"),
            definitionVersion: "sha256-old",
            redriveCount: 2,
          },
          mkRun("run-4", at(30), "SUSPENDED", "wf-b"),
          mkRun("run-5", at(40), "PENDING", "wf-a"),
        ],
      });
      await prisma.workflowStage.createMany({
        data: [
          {
            id: "stage-1",
            workflowRunId: "run-1",
            stageId: "first",
            stageName: "First",
            stageNumber: 0,
            executionGroup: 0,
            status: "COMPLETED",
            createdAt: at(0),
            updatedAt: at(0),
            startedAt: at(0),
            completedAt: at(1),
            duration: 60_000,
          },
          {
            id: "stage-2",
            workflowRunId: "run-1",
            stageId: "second",
            stageName: "Second",
            stageNumber: 1,
            executionGroup: 1,
            status: "COMPLETED",
            createdAt: at(1),
            updatedAt: at(1),
            startedAt: at(1),
            completedAt: at(2),
            duration: 60_000,
          },
          {
            id: "stage-3",
            workflowRunId: "run-4",
            stageId: "waiting",
            stageName: "Waiting",
            stageNumber: 0,
            executionGroup: 0,
            status: "SUSPENDED",
            createdAt: at(30),
            updatedAt: at(30),
            startedAt: at(30),
            nextPollAt: at(35),
            pollInterval: 30_000,
          },
        ],
      });
      await prisma.workflowStep.createMany({
        data: [
          {
            id: "step-1",
            stageRecordId: "stage-1",
            stepId: "fetch",
            seq: 1,
            kind: "run",
            status: "completed",
            createdAt: at(0),
            updatedAt: at(0),
          },
          {
            id: "step-2",
            stageRecordId: "stage-2",
            stepId: "write",
            seq: 1,
            kind: "run",
            status: "completed",
            externalKey: "wf-a:run-1:second:1:write",
            createdAt: at(1),
            updatedAt: at(1),
          },
          {
            id: "step-3",
            stageRecordId: "stage-3",
            stepId: "approval",
            seq: 1,
            kind: "signal",
            status: "pending",
            deadlineAt: at(90),
            createdAt: at(30),
            updatedAt: at(30),
          },
        ],
      });
      await prisma.workflowLog.createMany({
        data: [
          {
            id: "log-1",
            workflowRunId: "run-1",
            level: "INFO",
            message: "started",
            createdAt: at(0),
          },
        ],
      });
      await prisma.workflowAnnotation.createMany({
        data: [
          {
            id: "ann-1",
            workflowRunId: "run-1",
            scope: "run",
            key: "note",
            value: "seeded",
            createdAt: at(0),
          },
        ],
      });
      await prisma.outboxEvent.createMany({
        data: [
          mkEvent("evt-1", "run-1", 1, "run.started", at(0), at(0), null),
          mkEvent("evt-2", "run-1", 2, "run.completed", at(2), at(2), null),
          // Dead-lettered: unpublished, with dlqAt set.
          mkEvent("evt-3", "run-2", 1, "stage.failed", at(11), null, at(12)),
        ],
      });
      await prisma.jobQueue.createMany({
        data: [
          {
            id: "job-1",
            workflowRunId: "run-5",
            stageId: "a",
            status: "PENDING",
            createdAt: at(5),
            updatedAt: at(5),
          },
          {
            id: "job-2",
            workflowRunId: "run-5",
            stageId: "b",
            status: "PENDING",
            createdAt: at(9),
            updatedAt: at(9),
          },
          {
            id: "job-3",
            workflowRunId: "run-3",
            stageId: "c",
            status: "RUNNING",
            createdAt: at(6),
            updatedAt: at(6),
            workerId: "worker-1",
            lockedAt: at(50),
          },
          {
            id: "job-4",
            workflowRunId: "run-3",
            stageId: "d",
            status: "RUNNING",
            createdAt: at(7),
            updatedAt: at(7),
            workerId: "worker-1",
            lockedAt: at(60),
          },
          {
            id: "job-5",
            workflowRunId: "run-4",
            stageId: "e",
            status: "SUSPENDED",
            createdAt: at(8),
            updatedAt: at(8),
            nextPollAt: at(35),
          },
        ],
      });
    }

    function mkRun(
      id: string,
      createdAt: Date,
      status: string,
      workflowId: string,
    ) {
      return {
        id,
        createdAt,
        updatedAt: createdAt,
        workflowId,
        workflowName: `Workflow ${workflowId}`,
        workflowType: "standard",
        status: status as never,
        startedAt: createdAt,
        input: { seeded: true },
        config: {},
        totalCost: 0.25,
        totalTokens: 100,
        priority: 5,
      };
    }

    function mkEvent(
      id: string,
      workflowRunId: string,
      sequence: number,
      eventType: string,
      occurredAt: Date,
      publishedAt: Date | null,
      dlqAt: Date | null,
    ) {
      return {
        id,
        workflowRunId,
        sequence,
        eventType,
        payload: {},
        causationId: `cause-${id}`,
        occurredAt,
        createdAt: occurredAt,
        publishedAt,
        dlqAt,
        retryCount: dlqAt ? 5 : 0,
      };
    }

    beforeEach(async () => {
      await truncateAll();
      await seed();
    });

    afterAll(async () => {
      await truncateAll();
      await prisma.$disconnect();
    });

    const reader = () =>
      createPrismaConsoleReadPort(client, { now: () => at(100) });

    it("lists runs newest first with the identifiers quoted correctly", async () => {
      const page = await reader().listRuns({});
      expect(page.runs.map((entry) => entry.id)).toEqual([
        "run-5",
        "run-4",
        "run-3",
        "run-2",
        "run-1",
      ]);
      expect(page.runs[0]?.workflowName).toBe("Workflow wf-a");
      expect(page.runs[0]?.totalCost).toBeCloseTo(0.25);
    });

    it("pages on the keyset without repeating or skipping a row", async () => {
      const seen: string[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < 10; page += 1) {
        const result = await reader().listRuns({ limit: 2, cursor });
        seen.push(...result.runs.map((entry) => entry.id));
        if (result.nextCursor === null) break;
        cursor = result.nextCursor;
      }
      expect(seen).toEqual(["run-5", "run-4", "run-3", "run-2", "run-1"]);
    });

    it("round-trips the Status enum cast through a real enum column", async () => {
      const page = await reader().listRuns({
        filters: { status: ["FAILED", "RUNNING"] },
      });
      expect(page.runs.map((entry) => entry.id).sort()).toEqual([
        "run-2",
        "run-3",
      ]);
    });

    it("filters on a time range against naive UTC timestamp columns", async () => {
      // The bound Dates are converted with AT TIME ZONE 'UTC'; without that
      // this assertion moves with the session timezone.
      const page = await reader().listRuns({
        filters: { createdAfter: at(10), createdBefore: at(30) },
      });
      expect(page.runs.map((entry) => entry.id)).toEqual(["run-3", "run-2"]);
    });

    it("selects and filters on the versioning columns", async () => {
      const page = await reader().listRuns({
        filters: { definitionVersion: "sha256-old" },
      });
      expect(page.runs.map((entry) => entry.id)).toEqual(["run-3"]);
      expect(page.runs[0]).toMatchObject({
        definitionVersion: "sha256-old",
        redriveCount: 2,
      });
      // A run that never recorded a version is not silently a version.
      const all = await reader().listRuns({});
      expect(all.runs.find((entry) => entry.id === "run-1")).toMatchObject({
        definitionVersion: null,
        redriveCount: 0,
      });
      expect((await reader().getRunDetail("run-3"))?.run).toMatchObject({
        definitionVersion: "sha256-old",
        redriveCount: 2,
      });
    });

    it("assembles a run detail from eight statements in one transaction", async () => {
      const detail = await reader().getRunDetail("run-1");
      expect(detail?.run.id).toBe("run-1");
      expect(detail?.run.input).toEqual({ seeded: true });
      expect(detail?.stages.map((stage) => stage.stageId)).toEqual([
        "first",
        "second",
      ]);
      expect(detail?.steps.map((step) => step.stepId)).toEqual([
        "fetch",
        "write",
      ]);
      expect(detail?.events.map((event) => event.sequence)).toEqual([1, 2]);
      expect(detail?.logs).toHaveLength(1);
      expect(detail?.annotations).toHaveLength(1);
      expect(detail?.truncated.events).toBe(false);
    });

    it("returns null for a run that does not exist", async () => {
      expect(await reader().getRunDetail("nope")).toBeNull();
    });

    it("reads the attempt history's events of a run past a sequence, with only their stage and error, and reports a purged or broken range as incomplete", async () => {
      await prisma.workflowRun.createMany({
        data: [
          mkRun("run-retried", at(-9_000), "COMPLETED", "wf-d"),
          mkRun("run-purged", at(-9_001), "COMPLETED", "wf-d"),
          mkRun("run-gap", at(-9_002), "COMPLETED", "wf-d"),
        ],
      });
      // Every payload carries fields the console must never read.
      const events = (
        [
          ["workflow:created", { input: { secret: "do-not-read" } }],
          ["workflow:started", { secret: "do-not-read" }],
          [
            "stage:started",
            { stageId: "fetch", input: { secret: "do-not-read" } },
          ],
          ["stage:progress", { stageId: "fetch", progress: 0.5 }],
          [
            "stage:retrying",
            {
              stageId: "fetch",
              attempt: 1,
              maxAttempts: 3,
              error: `upstream 503: can't "connect"`,
              output: { secret: "do-not-read" },
            },
          ],
          ["stage:started", { stageId: "fetch" }],
          [
            "stage:completed",
            {
              stageId: "fetch",
              duration: 5,
              output: { secret: "do-not-read" },
            },
          ],
          ["workflow:cancelled", { reason: "do-not-read" }],
          ["workflow:completed", { output: { secret: "do-not-read" } }],
        ] as Array<[string, object]>
      ).map(([type, payload], index) => ({
        ...mkEvent(
          `retried-${index + 1}`,
          "run-retried",
          index + 1,
          type,
          at(430 + index),
          at(440),
          null,
        ),
        payload: { type, ...payload },
      }));
      const lifecycle = (id: string, runId: string, sequence: number) => ({
        ...mkEvent(
          id,
          runId,
          sequence,
          "stage:started",
          at(450),
          at(451),
          null,
        ),
        payload: { stageId: "fetch" },
      });
      await prisma.outboxEvent.createMany({
        data: [
          ...events,
          ...[3, 4].map((n) => lifecycle(`purged-${n}`, "run-purged", n)),
          ...[1, 2, 4].map((n) => lifecycle(`gap-${n}`, "run-gap", n)),
        ],
      });

      const event = (
        sequence: number,
        eventType: string,
        stageId: string | null,
        error: string | null = null,
      ) => ({
        sequence,
        eventType,
        occurredAt: at(429 + sequence),
        stageId,
        error,
        errorTruncated: false,
      });
      const all = [
        event(2, "workflow:started", null),
        event(3, "stage:started", "fetch"),
        event(5, "stage:retrying", "fetch", `upstream 503: can't "connect"`),
        event(6, "stage:started", "fetch"),
        event(7, "stage:completed", "fetch"),
        event(8, "workflow:cancelled", null),
      ];
      const retried = (await reader().getRunDetail("run-retried"))!;
      expect(retried.stageEvents).toEqual({
        events: all,
        after: 0,
        lastSequence: 9,
        complete: true,
      });
      expect(retried.events).toHaveLength(9);
      expect(JSON.stringify(retried)).not.toContain("do-not-read");

      expect(
        (await reader().getRunDetail("run-retried", { stageEventsAfter: 5 }))
          ?.stageEvents,
      ).toEqual({
        events: all.slice(3),
        after: 5,
        lastSequence: 9,
        complete: true,
      });
      expect(
        (await reader().getRunDetail("run-retried", { stageEventsAfter: 9 }))
          ?.stageEvents,
      ).toEqual({ events: [], after: 9, lastSequence: 9, complete: true });

      expect(
        (await reader().getRunDetail("run-purged"))?.stageEvents?.complete,
      ).toBe(false);
      expect(
        (await reader().getRunDetail("run-purged", { stageEventsAfter: 2 }))
          ?.stageEvents,
      ).toMatchObject({ lastSequence: 4, complete: true });
      expect(
        (await reader().getRunDetail("run-gap"))?.stageEvents?.complete,
      ).toBe(false);
      expect(
        (await reader().getRunDetail("run-gap", { stageEventsAfter: 2 }))
          ?.stageEvents,
      ).toMatchObject({ lastSequence: 4, complete: false });
    });

    it("cuts a lifecycle event's error text in SQL and says it was cut", async () => {
      await prisma.workflowRun.createMany({
        data: [mkRun("run-long-error", at(-9_003), "FAILED", "wf-d")],
      });
      await prisma.outboxEvent.createMany({
        data: [
          ["stage:started", { stageId: "fetch" }],
          ["stage:retrying", { stageId: "fetch", error: "y".repeat(2000) }],
          [
            "stage:failed",
            { stageId: "fetch", error: "\u{1F600}".repeat(2500) },
          ],
        ].map(([type, payload], index) => ({
          ...mkEvent(
            `long-${index + 1}`,
            "run-long-error",
            index + 1,
            type as string,
            at(470 + index),
            at(480),
            null,
          ),
          payload: payload as object,
        })),
      });
      const { events } = (await reader().getRunDetail("run-long-error"))!
        .stageEvents!;
      expect(events[1]).toMatchObject({ errorTruncated: false });
      expect(events[1]?.error).toHaveLength(2000);
      expect(events[2]).toMatchObject({ errorTruncated: true });
      expect(events[2]?.error).toBe("\u{1F600}".repeat(2000));

      // The database cut it: no row left it longer than the limit plus the one
      // character that tells the read it was cut.
      const calls: RecordedStatement[] = [];
      await createPrismaConsoleReadPort(recordingClient(client, calls), {
        now: () => at(100),
      }).getRunDetail("run-long-error");
      const lifecycle = calls.find((call) =>
        call.sql.includes('"eventType" IN'),
      );
      const errors = (lifecycle!.rows as Array<{ error: string | null }>)
        .map((row) => row.error)
        .filter((error): error is string => error !== null);
      expect(errors).toHaveLength(2);
      expect(Math.max(...errors.map((error) => [...error].length))).toBe(2001);
    });

    it("reports a run with more lifecycle events than the read's limit as incomplete", async () => {
      await prisma.workflowRun.createMany({
        data: [mkRun("run-many", at(-9_004), "RUNNING", "wf-d")],
      });
      await prisma.$executeRawUnsafe(
        `INSERT INTO outbox_events (id, "workflowRunId", sequence, "eventType", payload, "causationId", "occurredAt")
SELECT 'many-' || g, 'run-many', g, 'stage:started', jsonb_build_object('stageId', 's' || g), 'c', now()
FROM generate_series(1, 2001) g`,
      );
      const log = (await reader().getRunDetail("run-many"))!.stageEvents!;
      expect(log.events).toHaveLength(2000);
      expect(log).toMatchObject({ lastSequence: 2001, complete: false });
    });

    it("does not skip a row committed between its two statements", async () => {
      await prisma.workflowRun.createMany({
        data: [mkRun("run-race", at(-9_005), "RUNNING", "wf-d")],
      });
      const row = (sequence: number) => ({
        ...mkEvent(
          `race-${sequence}`,
          "run-race",
          sequence,
          "stage:started",
          at(480),
          null,
          null,
        ),
        payload: { stageId: "fetch" },
      });
      await prisma.outboxEvent.createMany({ data: [row(1), row(2)] });
      let injected = false;
      const raced = await createPrismaConsoleReadPort(
        recordingClient(client, [], async (call) => {
          // A writer commits sequence 3 after the read has counted the range.
          if (!injected && call.sql.includes("max(sequence)")) {
            injected = true;
            await prisma.outboxEvent.createMany({ data: [row(3)] });
          }
        }),
        { now: () => at(100) },
      ).getRunDetail("run-race");
      expect(injected).toBe(true);
      expect(raced?.stageEvents).toMatchObject({
        lastSequence: 2,
        complete: true,
      });
      expect(raced?.stageEvents?.events.map((e) => e.sequence)).toEqual([1, 2]);
      // The page's next read starts after 2 and finds it.
      const next = await reader().getRunDetail("run-race", {
        stageEventsAfter: 2,
      });
      expect(next?.stageEvents?.events.map((e) => e.sequence)).toEqual([3]);
    });

    it("reads only the new rows of a run on a poll: the plan's cost does not grow with the run's outbox", async () => {
      const calls: RecordedStatement[] = [];
      // `$n` -> a literal, so EXPLAIN plans the statement with the values it ran with.
      const inline = (sql: string, params: unknown[]) =>
        sql.replace(/\$(\d+)/g, (_m, n) => {
          const value = params[Number(n) - 1];
          return typeof value === "number"
            ? String(value)
            : `'${String(value).replace(/'/g, "''")}'`;
        });
      const planOf = async (sql: string, params: unknown[]) => {
        const rows = await rawRead(client, {
          "QUERY PLAN": "json",
        }).$queryRawUnsafe<Array<{ "QUERY PLAN": unknown }>>(
          `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${inline(sql, params)}`,
        );
        const plan = rows[0]!["QUERY PLAN"];
        return (typeof plan === "string" ? JSON.parse(plan) : plan)[0].Plan;
      };
      // Buffers and node types of every outbox statement one read issues.
      const measure = async (runId: string, after?: number) => {
        calls.length = 0;
        await createPrismaConsoleReadPort(recordingClient(client, calls), {
          now: () => at(100),
        }).getRunDetail(
          runId,
          after === undefined ? {} : { stageEventsAfter: after },
        );
        const outbox = calls.filter((c) => c.sql.includes('"outbox_events"'));
        let buffers = 0;
        const nodes: string[] = [];
        for (const { sql, params } of outbox) {
          const plan = await planOf(sql, params);
          buffers += plan["Shared Hit Blocks"] + plan["Shared Read Blocks"];
          nodes.push(JSON.stringify(plan));
        }
        return { statements: outbox.length, buffers, nodes };
      };

      const sizes = [1_000, 30_000];
      for (const rows of sizes) {
        const runId = `run-plan-${rows}`;
        await prisma.workflowRun.createMany({
          data: [mkRun(runId, at(-9_100 - rows), "RUNNING", "wf-d")],
        });
        await prisma.$executeRawUnsafe(
          `INSERT INTO outbox_events (id, "workflowRunId", sequence, "eventType", payload, "causationId", "occurredAt")
SELECT 'plan-${rows}-' || g, '${runId}', g,
       CASE WHEN g % 500 = 1 THEN 'stage:started' ELSE 'stage:progress' END,
       jsonb_build_object('stageId', 'fetch'), 'c', now()
FROM generate_series(1, ${rows}) g`,
        );
      }
      await prisma.$executeRawUnsafe(`ANALYZE "outbox_events"`);

      const poll = [];
      for (const rows of sizes) {
        poll.push(await measure(`run-plan-${rows}`, rows - 10));
      }
      const first = await measure("run-plan-30000");

      // Ten new rows: the same statements, the same few pages, at 1,000 and
      // at 30,000 rows (one more index level at most).
      expect(poll[0]!.statements).toBe(poll[1]!.statements);
      expect(poll[1]!.buffers).toBeLessThanOrEqual(poll[0]!.buffers + 6);
      expect(poll[1]!.buffers).toBeLessThan(60);
      for (const node of poll[1]!.nodes) {
        expect(node).not.toContain("Seq Scan");
      }
      expect(poll[1]!.nodes.join("")).toContain(
        "outbox_events_workflowRunId_sequence_key",
      );
      // A first read goes through the run once; that is what the poll avoids.
      expect(first.buffers).toBeGreaterThan(poll[1]!.buffers * 10);
    });

    it("selects the step columns the UI needs to offer a signal", async () => {
      const completed = await reader().getRunDetail("run-1");
      expect(
        completed?.steps.find((step) => step.stepId === "write"),
      ).toMatchObject({
        kind: "run",
        status: "completed",
        deadlineAt: null,
        externalKey: "wf-a:run-1:second:1:write",
      });
      const suspended = await reader().getRunDetail("run-4");
      expect(suspended?.steps).toHaveLength(1);
      expect(suspended?.steps[0]).toMatchObject({
        kind: "signal",
        status: "pending",
        externalKey: null,
      });
      expect(suspended?.steps[0]?.deadlineAt?.toISOString()).toBe(
        at(90).toISOString(),
      );
    });

    it("tails a run timeline from a sequence cursor", async () => {
      expect(
        (await reader().listRunEvents("run-1", 1)).map((e) => e.sequence),
      ).toEqual([2]);
    });

    it("counts the queue and finds the oldest pending job and lease", async () => {
      const health = await reader().getQueueHealth();
      expect(health.countsByStatus.PENDING).toBe(2);
      expect(health.countsByStatus.RUNNING).toBe(2);
      expect(health.countsByStatus.SUSPENDED).toBe(1);
      expect(health.countsByStatus.COMPLETED).toBe(0);
      expect(health.oldestPendingAt?.toISOString()).toBe(at(5).toISOString());
      expect(health.oldestLeaseAt?.toISOString()).toBe(at(50).toISOString());
      expect(health.overduePolls).toBe(1);
    });

    it("derives workers from the leases they hold", async () => {
      const workers = await reader().listWorkers();
      expect(workers).toHaveLength(1);
      expect(workers[0]?.workerId).toBe("worker-1");
      expect(workers[0]?.runningJobs).toBe(2);
      expect(workers[0]?.lastSeenAt?.toISOString()).toBe(at(60).toISOString());
    });

    it("lists suspended stages joined to their run", async () => {
      const suspended = await reader().listSuspendedStages();
      expect(suspended).toHaveLength(1);
      expect(suspended[0]?.workflowId).toBe("wf-b");
      expect(suspended[0]?.stageId).toBe("waiting");
    });

    it("lists dead letters off the dlqAt index", async () => {
      const dead = await reader().listDeadLetters();
      expect(dead.map((entry) => entry.id)).toEqual(["evt-3"]);
      expect(dead[0]?.retryCount).toBe(5);
    });

    it("rolls cost up by workflow and by day", async () => {
      const byWorkflow = await reader().getCosts({
        by: "workflow",
        from: at(-1),
        to: at(100),
      });
      expect(byWorkflow.map((bucket) => bucket.key).sort()).toEqual([
        "wf-a",
        "wf-b",
      ]);
      const wfA = byWorkflow.find((bucket) => bucket.key === "wf-a");
      expect(wfA?.runs).toBe(3);
      expect(wfA?.tokens).toBe(300);

      const byDay = await reader().getCosts({
        by: "day",
        from: at(-1),
        to: at(100),
      });
      expect(byDay).toEqual([
        { key: "2026-03-01", runs: 5, cost: 1.25, tokens: 500 },
      ]);
    });

    it("reports a cancelled statement as a timeout instead of hanging", async () => {
      const slow = createPrismaConsoleReadPort(
        {
          $queryRawUnsafe: () =>
            Promise.reject(
              Object.assign(
                new Error("canceling statement due to statement timeout"),
                { code: "57014" },
              ),
            ),
        },
        { statementTimeoutMs: 1 },
      );
      await expect(slow.listRuns({})).rejects.toBeInstanceOf(
        ConsoleQueryTimeoutError,
      );
    });

    it("actually applies statement_timeout on a root client", async () => {
      // A client that answers every read with a one-second sleep. The point
      // is that the `SET LOCAL statement_timeout` the reader issues inside
      // the transaction it opened really takes effect, not that listRuns is
      // slow -- pg_sleep is just the only reliable way to outrun a 1ms
      // budget.
      const sleepy: ConsolePrismaClient = {
        $queryRawUnsafe: () =>
          rawRead(prisma).$queryRawUnsafe("SELECT pg_sleep(1)"),
        $executeRawUnsafe: (sql: string, ...args: unknown[]) =>
          prisma.$executeRawUnsafe(sql, ...args),
        $transaction: (fn) =>
          prisma.$transaction((tx: ConsolePrismaClient) =>
            fn({
              $queryRawUnsafe: () =>
                rawRead(tx).$queryRawUnsafe("SELECT pg_sleep(1)"),
              $executeRawUnsafe: (sql: string, ...args: unknown[]) =>
                tx.$executeRawUnsafe?.(sql, ...args) ?? Promise.resolve(0),
            }),
          ),
      };
      const impatient = createPrismaConsoleReadPort(sleepy, {
        statementTimeoutMs: 1,
      });
      await expect(impatient.listRuns({})).rejects.toBeInstanceOf(
        ConsoleQueryTimeoutError,
      );
    });

    it("runs inside a transaction the caller opened, and leaves its settings alone", async () => {
      // The row-level-security case: the consumer hands the reader their
      // transaction client, so the console's reads happen on their
      // connection, inside their transaction. The client has no
      // `$transaction`, so the reader must neither open one nor touch
      // statement_timeout.
      const [runsInside, timeoutAfter] = await prisma.$transaction(
        async (tx: ConsolePrismaClient) => {
          await tx.$executeRawUnsafe?.("SET LOCAL statement_timeout = 4321");
          const scoped = createPrismaConsoleReadPort({
            $queryRawUnsafe: tx.$queryRawUnsafe.bind(tx),
            $withColumns: tx.$withColumns?.bind(tx),
          });
          const page = await scoped.listRuns({ limit: 3 });
          const setting = await rawRead(tx, {
            statement_timeout: "text",
          }).$queryRawUnsafe<Array<{ statement_timeout: string }>>(
            "SHOW statement_timeout",
          );
          return [page.runs.length, setting[0]?.statement_timeout];
        },
      );
      expect(runsInside).toBe(3);
      expect(timeoutAfter).toBe("4321ms");
    });

    it("refuses an enum name that is not a plain identifier", () => {
      expect(() =>
        createPrismaConsoleReadPort(client, {
          statusEnumName: 'Status"; DROP TABLE "workflow_runs',
        }),
      ).toThrow(/statusEnumName/);
    });

    it("recognises a real cancelled statement by its SQLSTATE, whatever the message says", async () => {
      const error: any = await prisma
        .$transaction(async (tx: ConsolePrismaClient) => {
          await tx.$executeRawUnsafe?.("SET LOCAL statement_timeout = 20");
          await rawRead(tx).$queryRawUnsafe("SELECT pg_sleep(2)");
        })
        .then(
          () => {
            throw new Error("expected the statement to be cancelled");
          },
          (caught: unknown) => caught,
        );
      expect(isStatementTimeout(error)).toBe(true);
      // The same driver error with every message removed: only the fields
      // this Prisma major puts the SQLSTATE on are left.
      const bare = Object.assign(new Error("failed"), {
        code: error.code,
        sqlState: error.sqlState,
        meta: error.meta && { ...error.meta, message: undefined },
      });
      expect(isStatementTimeout(bare)).toBe(true);
    });
  });
}
