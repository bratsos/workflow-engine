/**
 * The Prisma read port against a real PostgreSQL database.
 *
 * Every query in `prisma-read-port.ts` is raw SQL, so an in-memory fake
 * cannot tell us whether the identifiers are quoted correctly, whether the
 * `Status` enum cast round-trips, whether the row-wise keyset comparison
 * pages the way it is supposed to, or whether `statement_timeout` actually
 * produces a `ConsoleQueryTimeoutError`. Only Postgres can, and it is the
 * only target the SQL is written for.
 *
 * The other half of the point is the property this whole package exists to
 * preserve: the reader is checked here both with a root client and with a
 * transaction client handed in from outside, because a consumer running
 * under row-level security gives it the latter.
 *
 * Requires:
 *   - DATABASE_URL pointing at a Postgres database
 *   - `pnpm --filter @bratsos/workflow-engine run prisma:generate`
 *   - `pnpm --filter @bratsos/workflow-engine run prisma:db-push`
 *
 * Skipped entirely without DATABASE_URL, so `pnpm test` stays green with
 * no database — the in-memory equivalents in `read-port.test.ts` always run.
 */
import { createRequire } from "node:module";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { ConsoleQueryTimeoutError } from "../errors";
import {
  type ConsolePrismaClient,
  createPrismaConsoleReadPort,
} from "../prisma-read-port";

const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  describe.skip("I want the console read port to work against real Postgres", () => {
    it("skipped - set DATABASE_URL to run against a real Postgres database", () => {});
  });
} else {
  describe("I want the console read port to work against real Postgres", () => {
    // Required lazily so `@prisma/client` -- which only exists once
    // `prisma generate` has run -- is never resolved when this branch is
    // not taken.
    const require = createRequire(import.meta.url);
    const { PrismaClient } = require("@prisma/client");
    const prisma = new PrismaClient({ datasourceUrl: DATABASE_URL });
    const client = prisma as ConsolePrismaClient;

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

    it("assembles a run detail from six statements in one transaction", async () => {
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
        $queryRawUnsafe: () => prisma.$queryRawUnsafe("SELECT pg_sleep(1)"),
        $executeRawUnsafe: (sql: string, ...args: unknown[]) =>
          prisma.$executeRawUnsafe(sql, ...args),
        $transaction: (fn) =>
          prisma.$transaction((tx: ConsolePrismaClient) =>
            fn({
              $queryRawUnsafe: () => tx.$queryRawUnsafe("SELECT pg_sleep(1)"),
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
          });
          const page = await scoped.listRuns({ limit: 3 });
          const setting = await tx.$queryRawUnsafe<
            Array<{ statement_timeout: string }>
          >("SHOW statement_timeout");
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
  });
}
