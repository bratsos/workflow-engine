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
import {
  ConsoleBadRequestError,
  ConsoleQueryTimeoutError,
  isStatementTimeout,
} from "../errors";
import { createWorkflowConsole } from "../handler";
import {
  type ConsolePrismaClient,
  createPrismaConsoleReadPort,
} from "../prisma-read-port";
import { STAGE_EVENT_WINDOW } from "../read-port";
import { buildStageAttemptHistory, mergeStageEvents } from "../stage-attempts";
import { createPostgresClient } from "./postgres-client";
import { type RecordedStatement, recordingClient } from "./recording-client";
import { countServerErrors } from "./server-errors";
import { readStoredRows, runStoreOracle, storeWorld } from "./store-oracle";

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

    // The plan tests read as an ordinary role, as an application does: one
    // made inside their rolled-back transaction, so it exists nowhere else.
    async function asOrdinaryRole(tx: any) {
      const role = `console_plan_reader_${process.pid}`;
      for (const statement of [
        `CREATE ROLE ${role} NOLOGIN NOSUPERUSER`,
        `GRANT USAGE ON SCHEMA console_plan_statistics, public TO ${role}`,
        `GRANT SELECT ON ALL TABLES IN SCHEMA console_plan_statistics, public TO ${role}`,
        `SET LOCAL ROLE ${role}`,
      ])
        await tx.$executeRawUnsafe(statement);
    }

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

    // The plan test leaves about 190,000 outbox rows to truncate.
    beforeEach(async () => {
      await truncateAll();
      await seed();
    }, 60_000);

    afterAll(async () => {
      await truncateAll();
      await prisma.$disconnect();
    }, 60_000);

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

    it("assembles a run detail in one transaction", async () => {
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
        // Only a stage event's: `run.create` writes the caller's key there.
        causationId: eventType.startsWith("stage:")
          ? `cause-retried-${sequence}`
          : null,
      });
      const all = [
        // Its payload carries the run's input: only the two fields are read.
        event(1, "workflow:created", null),
        event(2, "workflow:started", null),
        event(3, "stage:started", "fetch"),
        event(5, "stage:retrying", "fetch", `upstream 503: can't "connect"`),
        event(6, "stage:started", "fetch"),
        event(7, "stage:completed", "fetch"),
        event(8, "workflow:cancelled", null),
        // Read for the run checks; its payload (the run's output) is not.
        event(9, "workflow:completed", null),
      ];
      const retried = (await reader().getRunDetail("run-retried"))!;
      expect(retried.stageEvents).toEqual({
        events: all,
        after: 0,
        lastSequence: 9,
        complete: true,
        more: false,
      });
      expect(retried.events).toHaveLength(9);
      expect(JSON.stringify(retried)).not.toContain("do-not-read");

      expect(
        (await reader().getRunDetail("run-retried", { stageEventsAfter: 5 }))
          ?.stageEvents,
      ).toEqual({
        events: all.slice(4),
        after: 5,
        lastSequence: 9,
        complete: true,
        more: false,
      });
      expect(
        (await reader().getRunDetail("run-retried", { stageEventsAfter: 9 }))
          ?.stageEvents,
      ).toEqual({
        events: [],
        after: 9,
        lastSequence: 9,
        complete: true,
        more: false,
      });

      expect(
        (await reader().getRunDetail("run-purged"))?.stageEvents?.complete,
      ).toBe(false);
      expect(
        (await reader().getRunDetail("run-retried", { stageEventsAfter: 99 }))
          ?.stageEvents,
      ).toEqual({
        events: [],
        after: 99,
        lastSequence: 9,
        complete: false,
        more: false,
      });
      const part = (await reader().getRunDetail("run-retried", {
        stageEventsAfter: 5,
        stageEventsOnly: true,
      }))!;
      expect(part.stageEvents?.events.map((e) => e.sequence)).toEqual([
        6, 7, 8, 9,
      ]);
      expect([part.stages, part.steps, part.events]).toEqual([[], [], []]);
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

      // A first read of a run with no retained row is not complete: a run
      // has an outbox row from its creation, so none means they were removed.
      await prisma.workflowRun.createMany({
        data: [mkRun("run-no-rows", at(-9_010), "COMPLETED", "wf-d")],
      });
      expect((await reader().getRunDetail("run-no-rows"))?.stageEvents).toEqual(
        {
          events: [],
          after: 0,
          lastSequence: 0,
          complete: false,
          more: false,
        },
      );
    });

    it("pages annotations newest first, ordering those that share a time by id across the page's end", async () => {
      await prisma.workflowRun.createMany({
        data: [mkRun("run-annotation-ties", at(-9_030), "RUNNING", "wf-d")],
      });
      // Written in the opposite order of their ids, so that the order the
      // rows were written in is not the answer.
      for (const [id, minute] of [
        ["tie-5", 40],
        ["tie-4", 40],
        ["tie-3", 40],
        ["tie-2", 40],
        ["tie-1", 40],
        ["tie-newest", 41],
      ] as const) {
        await prisma.workflowAnnotation.createMany({
          data: [
            {
              id,
              workflowRunId: "run-annotation-ties",
              attempt: 0,
              scope: "run",
              key: id,
              value: {},
              createdAt: at(minute),
            },
          ],
        });
      }
      const ids = async (annotationLimit: number) => {
        const detail = await reader().getRunDetail("run-annotation-ties", {
          annotationLimit,
        });
        return [
          detail!.annotations.map((a) => a.id),
          detail!.truncated.annotations,
        ];
      };
      expect(await ids(3)).toEqual([["tie-newest", "tie-5", "tie-4"], true]);
      expect(await ids(1)).toEqual([["tie-newest"], true]);
      expect(await ids(6)).toEqual([
        ["tie-newest", "tie-5", "tie-4", "tie-3", "tie-2", "tie-1"],
        false,
      ]);
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

    it("reads a run with more lifecycle events than the limit in chunks, each unbroken, until it has caught up", async () => {
      await prisma.workflowRun.createMany({
        data: [mkRun("run-many", at(-9_004), "RUNNING", "wf-d")],
      });
      await prisma.$executeRawUnsafe(
        `INSERT INTO outbox_events (id, "workflowRunId", sequence, "eventType", payload, "causationId", "occurredAt")
SELECT 'many-' || g, 'run-many', g, 'stage:started', jsonb_build_object('stageId', 's' || g), 'c', now()
FROM generate_series(1, 2001) g`,
      );
      const first = (await reader().getRunDetail("run-many"))!.stageEvents!;
      expect(first.events).toHaveLength(2000);
      expect(first).toMatchObject({
        lastSequence: 2000,
        complete: true,
        more: true,
      });
      const rest = (await reader().getRunDetail("run-many", {
        stageEventsAfter: first.lastSequence,
      }))!.stageEvents!;
      expect(rest.events.map((e) => e.sequence)).toEqual([2001]);
      expect(rest).toMatchObject({
        lastSequence: 2001,
        complete: true,
        more: false,
      });
    });

    it("reads at most a window of a run's sequences per read, and says rows remain past it however few of them are lifecycle events", async () => {
      const span = STAGE_EVENT_WINDOW + 500;
      await prisma.workflowRun.createMany({
        data: [mkRun("run-window", at(-9_005), "RUNNING", "wf-d")],
      });
      await prisma.$executeRawUnsafe(
        `INSERT INTO outbox_events (id, "workflowRunId", sequence, "eventType", payload, "causationId", "occurredAt")
SELECT 'window-' || g, 'run-window', g,
  CASE WHEN g = 1 THEN 'workflow:created' WHEN g = ${span} THEN 'stage:started' ELSE 'stage:progress' END,
  jsonb_build_object('stageId', 'fetch'), 'c', now()
FROM generate_series(1, ${span}) g`,
      );
      // The window ends the read long before the event limit does.
      const first = (await reader().getRunDetail("run-window"))!.stageEvents!;
      expect(first.events.map((e) => e.sequence)).toEqual([1]);
      expect(first).toMatchObject({
        lastSequence: STAGE_EVENT_WINDOW,
        complete: true,
        more: true,
      });
      const rest = (await reader().getRunDetail("run-window", {
        stageEventsAfter: first.lastSequence,
      }))!.stageEvents!;
      expect(rest.events.map((e) => e.sequence)).toEqual([span]);
      expect(rest).toMatchObject({
        lastSequence: span,
        complete: true,
        more: false,
      });
    });

    it("does not skip a row committed between its statements, at one moment or inside a caller's READ COMMITTED transaction", async () => {
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
      // Another connection commits a row once the read has taken the run's
      // highest sequence.
      const committing = (c: ConsolePrismaClient, sequence: number) => {
        let injected = false;
        return {
          client: recordingClient(c, [], async (call) => {
            if (
              (!injected &&
                call.sql.includes("ORDER BY sequence DESC LIMIT 1")) ||
              call.sql.includes("max(sequence)")
            ) {
              injected = true;
              await prisma.outboxEvent.createMany({ data: [row(sequence)] });
            }
          }),
          injected: () => injected,
        };
      };
      // Its own transaction is REPEATABLE READ: the row is not seen.
      const own = committing(client, 3);
      const first = await createPrismaConsoleReadPort(own.client, {
        now: () => at(100),
      }).getRunDetail("run-race");
      expect(own.injected()).toBe(true);
      expect(first?.stageEvents).toMatchObject({
        lastSequence: 2,
        complete: true,
      });
      expect(first?.stageEvents?.events.map((e) => e.sequence)).toEqual([1, 2]);
      // Inside a caller's READ COMMITTED transaction the later statements see
      // it; the read is closed at the sequence it took first, so the page's
      // next read finds it.
      const inCaller = await prisma.$transaction(async (tx: any) => {
        const c = committing(tx, 4);
        const detail = await createPrismaConsoleReadPort(c.client, {
          now: () => at(100),
        }).getRunDetail("run-race", { stageEventsAfter: 2 });
        expect(c.injected()).toBe(true);
        return detail;
      });
      expect(inCaller?.stageEvents).toMatchObject({
        lastSequence: 3,
        complete: true,
      });
      expect(
        inCaller?.stageEvents?.events.map(
          (e: { sequence: number }) => e.sequence,
        ),
      ).toEqual([3]);
      const next = await reader().getRunDetail("run-race", {
        stageEventsAfter: 3,
      });
      expect(next?.stageEvents?.events.map((e) => e.sequence)).toEqual([4]);
    });

    it("reads a run's rows and events at one moment, whatever another connection commits between its statements", async () => {
      const runId = "run-moment";
      await prisma.workflowRun.createMany({
        data: [mkRun(runId, at(-9_010), "RUNNING", "wf-d")],
      });
      await prisma.workflowStage.create({
        data: {
          id: "stage-moment",
          workflowRunId: runId,
          stageId: "only",
          stageName: "Only",
          stageNumber: 1,
          executionGroup: 0,
          status: "RUNNING",
          createdAt: at(10),
          updatedAt: at(12),
          startedAt: at(12),
        },
      });
      const ev = (sequence: number, eventType: string) => ({
        ...mkEvent(
          `moment-${sequence}`,
          runId,
          sequence,
          eventType,
          at(10 + sequence),
          null,
          null,
        ),
        payload: eventType.startsWith("stage:") ? { stageId: "only" } : {},
      });
      await prisma.outboxEvent.createMany({
        data: [
          ev(1, "workflow:created"),
          ev(2, "workflow:started"),
          ev(3, "stage:started"),
        ],
      });
      const page = (detail: any) => {
        const json = JSON.parse(JSON.stringify(detail));
        const held = mergeStageEvents(null, json.stageEvents)!;
        const history = buildStageAttemptHistory({
          redriveCount: json.run.redriveCount,
          runStatus: json.run.status,
          stages: json.stages,
          steps: json.steps,
          stageEvents: {
            events: held.events,
            coverage: held.coverage,
            caughtUp: !held.more,
          },
        }).get("stage-moment")!;
        return history.available
          ? history.attempts.map((a) => `${a.trigger}:${a.outcome}`)
          : `unavailable ${history.reason}`;
      };
      // With a statement timeout and without one (no `SET LOCAL` to scope).
      for (const statementTimeoutMs of [15_000, 0]) {
        await prisma.outboxEvent.deleteMany({
          where: { workflowRunId: runId, sequence: { gt: 3 } },
        });
        await prisma.workflowStage.update({
          where: { id: "stage-moment" },
          data: { status: "RUNNING", completedAt: null },
        });
        await prisma.workflowRun.update({
          where: { id: runId },
          data: { status: "RUNNING", completedAt: null },
        });
        let committed = false;
        const during = await createPrismaConsoleReadPort(
          recordingClient(client, [], async (call) => {
            if (committed || !call.sql.includes('FROM "workflow_stages"'))
              return;
            // Right after the stage rows are read, the stage completes and
            // the run with it, committed on another connection.
            committed = true;
            await prisma.workflowStage.update({
              where: { id: "stage-moment" },
              data: { status: "COMPLETED", completedAt: at(14) },
            });
            await prisma.outboxEvent.createMany({
              data: [ev(4, "stage:completed"), ev(5, "workflow:completed")],
            });
            await prisma.workflowRun.update({
              where: { id: runId },
              data: { status: "COMPLETED", completedAt: at(15) },
            });
          }),
          { now: () => at(100), statementTimeoutMs },
        ).getRunDetail(runId);
        expect(committed).toBe(true);
        expect(during?.stages[0]?.status).toBe("RUNNING");
        expect(during?.stageEvents?.lastSequence).toBe(3);
        expect(page(during)).toEqual(["initial:running"]);
        expect(page(await reader().getRunDetail(runId))).toEqual([
          "initial:completed",
        ]);
      }
    });

    it("reads only the new rows of a run on a poll: the cost of every outbox statement is bounded by its window, in each state of the table's statistics", {
      timeout: 300_000,
    }, async () => {
      // `$n` -> a literal, so EXPLAIN plans the statement with the values it ran with.
      const inline = (sql: string, params: unknown[]) =>
        sql.replace(/\$(\d+)/g, (_m, n) => {
          const value = params[Number(n) - 1];
          return typeof value === "number"
            ? String(value)
            : `'${String(value).replace(/'/g, "''")}'`;
        });
      const sizes = [1_000, 12_000, 30_000];
      const load = async (tx: any) => {
        for (const rows of sizes) {
          await tx.$executeRawUnsafe(
            `INSERT INTO outbox_events (id, "workflowRunId", sequence, "eventType", payload, "causationId", "occurredAt")
SELECT 'plan-${rows}-' || g, 'run-plan-${rows}', g,
       CASE WHEN g % 500 = 1 THEN 'stage:started' ELSE 'stage:progress' END,
       jsonb_build_object('stageId', 'fetch'), 'c', now()
FROM generate_series(1, ${rows}) g`,
          );
        }
        // Other runs' rows, as a real outbox holds: with the 30,000-row run
        // most of a small table, a sampled ANALYZE can rightly prefer
        // reading the whole table to the run's range.
        await tx.$executeRawUnsafe(
          `INSERT INTO outbox_events (id, "workflowRunId", sequence, "eventType", payload, "causationId", "occurredAt")
SELECT 'plan-others-' || g, 'run-plan-others', g, 'stage:progress',
       jsonb_build_object('stageId', 'fetch'), 'c', now()
FROM generate_series(1, 150000) g`,
        );
      };
      // The statistics the planner has for the table, and what it estimates
      // for the 30,000-row run.
      const statistics = async (tx: any) => {
        const [table] = await rawRead(tx, {
          reltuples: "float",
          columns: "bigint",
        }).$queryRawUnsafe<Array<{ reltuples: number; columns: bigint }>>(
          `SELECT c.reltuples::float8 AS reltuples,
       (SELECT count(*) FROM pg_stats s
        WHERE s.schemaname = n.nspname AND s.tablename = c.relname) AS columns
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.oid = 'outbox_events'::regclass`,
        );
        const [estimate] = await rawRead(tx, {
          "QUERY PLAN": "json",
        }).$queryRawUnsafe<Array<{ "QUERY PLAN": unknown }>>(
          `EXPLAIN (FORMAT JSON) SELECT sequence FROM outbox_events WHERE "workflowRunId" = 'run-plan-30000'`,
        );
        const plan = estimate!["QUERY PLAN"];
        return {
          reltuples: Number(table!.reltuples),
          columns: Number(table!.columns),
          estimate: (typeof plan === "string" ? JSON.parse(plan) : plan)[0]
            .Plan["Plan Rows"] as number,
        };
      };
      // Each state is set up and measured in one transaction, on a copy of
      // the table in a schema of its own that the read finds first on its
      // search path: its statistics are this test's own, whatever the
      // engine's suites or autovacuum left on the real table, and autovacuum
      // never sees it. Nothing is committed. (Not a temporary table: the
      // planner costs those differently and does not show the stale plan.)
      const states = {
        "never analysed": {
          before: async () => {},
          after: async () => {},
          holds: (s: Awaited<ReturnType<typeof statistics>>) =>
            s.reltuples === -1 && s.columns === 0,
        },
        // Analysed by autovacuum while the table was empty, then written.
        "analysed empty": {
          before: (tx: any) => tx.$executeRawUnsafe("ANALYZE outbox_events"),
          after: async () => {},
          holds: (s: Awaited<ReturnType<typeof statistics>>) =>
            s.reltuples === 0 && s.columns === 0,
        },
        "analysed at size": {
          before: async () => {},
          after: (tx: any) => tx.$executeRawUnsafe("ANALYZE outbox_events"),
          holds: (s: Awaited<ReturnType<typeof statistics>>) =>
            s.reltuples > 150_000 && s.columns > 0,
        },
        // Analysed while one run held its few rows, then grown: the planner
        // takes every other run for one row (what the engine's suite leaves
        // behind when autovacuum analyses its table).
        stale: {
          before: async (tx: any) => {
            await tx.$executeRawUnsafe(
              `INSERT INTO outbox_events (id, "workflowRunId", sequence, "eventType", payload, "causationId", "occurredAt")
SELECT 'plan-few-' || g, 'run-plan-few', g, 'stage:progress', '{}'::jsonb, 'c', now()
FROM generate_series(1, 7) g`,
            );
            await tx.$executeRawUnsafe("ANALYZE outbox_events");
          },
          after: async () => {},
          holds: (s: Awaited<ReturnType<typeof statistics>>) =>
            s.reltuples === 7 && s.columns > 0 && s.estimate <= 1,
        },
      };
      const rollback = new Error("rolled back on purpose");
      const seen: string[] = [];
      for (const [state, setup] of Object.entries(states)) {
        await prisma
          .$transaction(
            async (tx: any) => {
              for (const statement of [
                "CREATE SCHEMA console_plan_statistics",
                "CREATE TABLE console_plan_statistics.outbox_events (LIKE public.outbox_events INCLUDING ALL)",
                "SET LOCAL search_path = console_plan_statistics, public",
              ])
                await tx.$executeRawUnsafe(statement);
              await tx.workflowRun.createMany({
                data: [
                  mkRun("run-plan-0", at(-9_000), "RUNNING", "wf-d"),
                  ...sizes.map((rows) =>
                    mkRun(
                      `run-plan-${rows}`,
                      at(-9_100 - rows),
                      "RUNNING",
                      "wf-d",
                    ),
                  ),
                ],
              });
              await setup.before(tx);
              await load(tx);
              await setup.after(tx);
              const stats = await statistics(tx);
              expect(
                setup.holds(stats),
                `${state}: ${JSON.stringify(stats)}`,
              ).toBe(true);
              await asOrdinaryRole(tx);

              const calls: RecordedStatement[] = [];
              const planOf = async (sql: string, params: unknown[]) => {
                const rows = await rawRead(tx, {
                  "QUERY PLAN": "json",
                }).$queryRawUnsafe<Array<{ "QUERY PLAN": unknown }>>(
                  `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${inline(sql, params)}`,
                );
                const plan = rows[0]!["QUERY PLAN"];
                return (typeof plan === "string" ? JSON.parse(plan) : plan)[0]
                  .Plan;
              };
              // Pages read and plans of every outbox statement one read
              // issues, and the pages of its probe of the run's highest
              // sequence (in whichever form it is written).
              const measure = async (runId: string, after?: number) => {
                calls.length = 0;
                await createPrismaConsoleReadPort(recordingClient(tx, calls), {
                  now: () => at(100),
                }).getRunDetail(
                  runId,
                  after === undefined ? {} : { stageEventsAfter: after },
                );
                const outbox = calls.filter((c) =>
                  c.sql.includes('"outbox_events"'),
                );
                let buffers = 0;
                const nodes: string[] = [];
                let probe = -1;
                for (const { sql, params } of outbox) {
                  const plan = await planOf(sql, params);
                  const pages =
                    plan["Shared Hit Blocks"] + plan["Shared Read Blocks"];
                  buffers += pages;
                  if (/DESC LIMIT 1|max\(sequence\)/.test(sql)) probe = pages;
                  nodes.push(JSON.stringify(plan));
                }
                return { statements: outbox.length, buffers, probe, nodes };
              };
              const poll = [];
              for (const rows of [1_000, 30_000]) {
                poll.push(await measure(`run-plan-${rows}`, rows - 10));
              }
              const first = await measure("run-plan-30000");
              const firstOfSmaller = await measure("run-plan-12000");
              // Nothing new: the highest-sequence probe answers and no range is read.
              const idle = await measure("run-plan-30000", 30_000);
              // A run with no row: the probe alone.
              const empty = await measure("run-plan-0");
              const all = [...poll, first, firstOfSmaller, idle, empty];
              // The timeline's tail: one page of rows from a sequence on,
              // at the start and at the end of the largest run.
              const tails: number[] = [];
              for (const after of [0, 29_990]) {
                calls.length = 0;
                await createPrismaConsoleReadPort(recordingClient(tx, calls), {
                  now: () => at(100),
                }).listRunEvents("run-plan-30000", after);
                const statements = calls.filter((c) =>
                  c.sql.includes('"outbox_events"'),
                );
                expect(statements).toHaveLength(2);
                let pages = 0;
                for (const call of statements) {
                  const plan = await planOf(call.sql, call.params);
                  expect(JSON.stringify(plan)).not.toContain("Seq Scan");
                  pages +=
                    plan["Shared Hit Blocks"] + plan["Shared Read Blocks"];
                }
                tails.push(pages);
              }
              // Pages: poll at 1,000 and 30,000, first read at 30,000 and
              // 12,000, idle, no row; then the probe of each.
              const line = `${state}: ${JSON.stringify(all.map((m) => m.buffers))} probes ${JSON.stringify(all.map((m) => m.probe))} tails ${JSON.stringify(tails)}`;
              seen.push(line);
              console.log(line);
              // The probe of the run's highest sequence reads a few index
              // pages whatever the run's size: never its whole range.
              for (const m of all) {
                expect(m.probe, line).toBeGreaterThan(0);
                expect(m.probe, line).toBeLessThanOrEqual(10);
              }
              expect(poll[1]!.probe, line).toBeLessThanOrEqual(
                poll[0]!.probe + 2,
              );
              for (const pages of tails) expect(pages, line).toBeLessThan(60);
              expect(idle.statements, line).toBe(poll[1]!.statements - 2);
              expect(idle.buffers, line).toBeLessThan(poll[1]!.buffers);
              expect(empty.buffers, line).toBeLessThanOrEqual(idle.buffers);
              // Ten new rows: the same statements, the same few pages, at
              // 1,000 and at 30,000 rows (one more index level at most).
              expect(poll[0]!.statements, line).toBe(poll[1]!.statements);
              expect(poll[1]!.buffers, line).toBeLessThanOrEqual(
                poll[0]!.buffers + 6,
              );
              expect(poll[1]!.buffers, line).toBeLessThan(60);
              for (const node of all.flatMap((m) => m.nodes)) {
                expect(node, line).not.toContain("Seq Scan");
              }
              expect(poll[1]!.nodes.join(""), line).toContain(
                "outbox_events_workflowRunId_sequence_idx", // its copy in the test's schema
              );
              // A first read covers one window of the run's rows: what a
              // poll avoids, and the same at 12,000 and at 30,000 rows.
              expect(first.buffers, line).toBeGreaterThan(
                poll[1]!.buffers * 10,
              );
              expect(first.buffers, line).toBeLessThanOrEqual(
                firstOfSmaller.buffers * 1.25 + 10,
              );
              throw rollback;
            },
            { timeout: 240_000 },
          )
          .catch((error: unknown) => {
            if (error !== rollback) throw error;
          });
      }
      expect(seen).toHaveLength(4);
    });

    it("reads a run's stages, steps, annotations and logs with plans that do not depend on the tables' statistics, or at the cost the docs state", {
      timeout: 300_000,
    }, async () => {
      const inline = (sql: string, params: unknown[]) =>
        sql.replace(/\$(\d+)/g, (_m, n) => {
          const value = params[Number(n) - 1];
          return typeof value === "number"
            ? String(value)
            : `'${String(value).replace(/'/g, "''")}'`;
        });
      const tables = [
        "workflow_stages",
        "workflow_steps",
        "workflow_annotations",
        "workflow_logs",
      ];
      const sizes = [1_000, 30_000];
      // Rows of runs, interleaved in the tables as runs that work at once
      // write them: 20 stages each, and `rows` steps, annotations (three to
      // a millisecond, so the page boundary has ties) and logs.
      const fill = async (tx: any, runs: Array<[string, number]>) => {
        const values = runs.map(([id, n]) => `('${id}', ${n})`).join(", ");
        const max = Math.max(...runs.map(([, n]) => n));
        const each = (select: string) =>
          `${select}
FROM generate_series(1, ${max}) g CROSS JOIN (VALUES ${values}) AS r(id, n)
WHERE g <= r.n ORDER BY g, r.id`;
        await tx.$executeRawUnsafe(
          `INSERT INTO workflow_stages (id, "updatedAt", "workflowRunId", "stageId", "stageName", "stageNumber", "executionGroup", status)
SELECT r.id || '-s' || k, now(), r.id, 's' || k, 'S' || k, k, k, 'COMPLETED'::"Status"
FROM generate_series(1, 20) k CROSS JOIN (VALUES ${values}) AS r(id, n) ORDER BY k, r.id`,
        );
        await tx.$executeRawUnsafe(
          `INSERT INTO workflow_steps (id, "stageRecordId", "stepId", seq, kind, status, "updatedAt")
${each(`SELECT r.id || '-t' || g, r.id || '-s' || (1 + g % 20), 't' || g, g, 'run', 'COMPLETED', now()`)}`,
        );
        await tx.$executeRawUnsafe(
          `INSERT INTO workflow_annotations (id, "createdAt", "workflowRunId", scope, key, value)
${each(`SELECT r.id || '-a' || g, timestamp '2026-03-01' + (g / 3) * interval '1 millisecond', r.id, 'run', 'k' || g, '{}'::jsonb`)}`,
        );
        await tx.$executeRawUnsafe(
          `INSERT INTO workflow_logs (id, "createdAt", "workflowRunId", level, message)
${each(`SELECT r.id || '-l' || g, timestamp '2026-03-01' + g * interval '1 millisecond', r.id, 'INFO', 'm'`)}`,
        );
      };
      const load = async (tx: any) => {
        await fill(tx, [
          ...sizes.map((n): [string, number] => [`run-plan-${n}`, n]),
          ["run-plan-others", 60_000],
        ]);
        // A run of 1,000 stages, one step each: a stage-id list this long
        // is planned as a scan of the whole steps table.
        await tx.$executeRawUnsafe(
          `INSERT INTO workflow_stages (id, "updatedAt", "workflowRunId", "stageId", "stageName", "stageNumber", "executionGroup", status)
SELECT 'run-plan-stages-s' || k, now(), 'run-plan-stages', 's' || k, 'S' || k, k, k, 'COMPLETED'::"Status"
FROM generate_series(1, 1000) k`,
        );
        await tx.$executeRawUnsafe(
          `INSERT INTO workflow_steps (id, "stageRecordId", "stepId", seq, kind, status, "updatedAt")
SELECT 'run-plan-stages-t' || g, 'run-plan-stages-s' || g, 't' || g, g, 'run', 'COMPLETED', now()
FROM generate_series(1, 1000) g`,
        );
      };
      const reltuples = async (tx: any) =>
        Object.fromEntries(
          (
            await rawRead(tx, {
              relname: "text",
              reltuples: "float",
            }).$queryRawUnsafe<Array<{ relname: string; reltuples: number }>>(
              `SELECT c.relname, c.reltuples::float8 AS reltuples FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'console_plan_statistics' AND c.relkind = 'r'`,
            )
          ).map((r) => [r.relname, Number(r.reltuples)]),
        );
      const analyze = async (tx: any) => {
        for (const table of tables)
          await tx.$executeRawUnsafe(`ANALYZE ${table}`);
      };
      const states: Record<
        string,
        {
          before: (tx: any) => Promise<void>;
          after: (tx: any) => Promise<void>;
          holds: (r: Record<string, number>) => boolean;
        }
      > = {
        "never analysed": {
          before: async () => {},
          after: async () => {},
          holds: (r) => tables.every((t) => r[t] === -1),
        },
        "analysed empty": {
          before: analyze,
          after: async () => {},
          holds: (r) => tables.every((t) => r[t] === 0),
        },
        "analysed at size": {
          before: async () => {},
          after: analyze,
          holds: (r) => r.workflow_logs! > 60_000,
        },
        // Analysed while one run held a few rows, then grown.
        stale: {
          before: async (tx) => {
            await fill(tx, [["run-plan-few", 7]]);
            await analyze(tx);
          },
          after: async () => {},
          holds: (r) => r.workflow_logs === 7,
        },
      };
      const rollback = new Error("rolled back on purpose");
      const lines: string[] = [];
      for (const [state, setup] of Object.entries(states)) {
        await prisma
          .$transaction(
            async (tx: any) => {
              await tx.$executeRawUnsafe(
                "CREATE SCHEMA console_plan_statistics",
              );
              for (const table of tables)
                await tx.$executeRawUnsafe(
                  `CREATE TABLE console_plan_statistics.${table} (LIKE public.${table} INCLUDING ALL)`,
                );
              await tx.$executeRawUnsafe(
                "SET LOCAL search_path = console_plan_statistics, public",
              );
              await tx.workflowRun.createMany({
                data: [
                  "run-plan-few",
                  "run-plan-others",
                  "run-plan-stages",
                  ...sizes.map((n) => `run-plan-${n}`),
                ].map((id, i) => mkRun(id, at(-9_200 - i), "RUNNING", "wf-d")),
              });
              await setup.before(tx);
              await load(tx);
              await setup.after(tx);
              const r = await reltuples(tx);
              expect(setup.holds(r), `${state}: ${JSON.stringify(r)}`).toBe(
                true,
              );
              await asOrdinaryRole(tx);
              const pages: Record<string, number[]> = {};
              const plans: Record<string, string[]> = {};
              for (const rows of [...sizes, "stages"]) {
                const calls: RecordedStatement[] = [];
                await createPrismaConsoleReadPort(recordingClient(tx, calls), {
                  now: () => at(100),
                }).getRunDetail(`run-plan-${rows}`);
                for (const { sql, params } of calls) {
                  const table = tables.find((t) => sql.includes(`FROM "${t}"`));
                  if (!table) continue;
                  const [row] = await rawRead(tx, {
                    "QUERY PLAN": "json",
                  }).$queryRawUnsafe<Array<{ "QUERY PLAN": unknown }>>(
                    `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${inline(sql, params)}`,
                  );
                  const raw = row!["QUERY PLAN"];
                  const plan = (
                    typeof raw === "string" ? JSON.parse(raw) : raw
                  )[0].Plan;
                  const key = `${table}@${rows}`;
                  pages[key] = [
                    ...(pages[key] ?? []),
                    plan["Shared Hit Blocks"] + plan["Shared Read Blocks"],
                  ];
                  plans[key] = [...(plans[key] ?? []), JSON.stringify(plan)];
                }
              }
              const line = `${state}: ${JSON.stringify(pages)}`;
              lines.push(line);
              console.log(line);
              const sum = (key: string) =>
                pages[key]!.reduce((a, b) => a + b, 0);
              const nodes = (plan: any): any[] => [
                plan,
                ...(plan.Plans ?? []).flatMap(nodes),
              ];
              // No statement reads another run's rows: every table is read
              // through an index on the run (or on the run's stage ids),
              // whatever the statistics say.
              // (The stages table holds 80 rows here, one page, which a plan
              // may rightly read whole; its bound is the page count below.)
              for (const [key, list] of Object.entries(plans))
                if (!key.startsWith("workflow_stages@"))
                  for (const plan of list)
                    for (const node of nodes(JSON.parse(plan)))
                      expect(node["Node Type"], `${key}: ${line}`).not.toBe(
                        "Seq Scan",
                      );
              // Annotations: cursors whose plans walk the run's
              // ("workflowRunId", "createdAt") index backwards and stop at
              // the page, then the first ids of the group of rows that share
              // the time the page ends at: never more rows than a page.
              for (const rows of sizes) {
                const key = `workflow_annotations@${rows}`;
                expect(plans[key]!.length, line).toBeGreaterThanOrEqual(1);
                // The first statement reads times only (one past the page);
                // the others, the page's rows.
                const fetched = plans[key]!.map(
                  (plan) => JSON.parse(plan)["Actual Rows"] as number,
                );
                expect(fetched[0], line).toBeLessThanOrEqual(201);
                expect(
                  fetched.slice(1).reduce((a, b) => a + b, 0),
                  line,
                ).toBeLessThanOrEqual(200);
                for (const plan of plans[key]!) {
                  const walk = JSON.parse(plan);
                  if (
                    walk["Node Type"] === "Limit" &&
                    walk.Plans[0]["Node Type"] === "Sort"
                  )
                    continue;
                  const scan =
                    walk["Node Type"] === "Limit" ? walk.Plans[0] : walk;
                  expect(scan, line).toMatchObject({
                    "Node Type": expect.stringMatching(/^Index (Only )?Scan$/),
                    "Scan Direction": "Backward",
                    "Index Name":
                      "workflow_annotations_workflowRunId_createdAt_idx",
                  });
                }
              }
              // Three annotations to a millisecond: the page of 200 ends in
              // a group, so the group's first id is read too.
              // The two walks read at most a page per row they return; the
              // group is read through an index on the run: through the
              // ("workflowRunId", "createdAt") index, its rows, or, when the
              // statistics expect the run to hold a few rows, every row of
              // the run (the cost the docs state), and never another run's.
              for (const rows of sizes) {
                const [times, newer, group] =
                  pages[`workflow_annotations@${rows}`]!;
                expect(times! + newer!, line).toBeLessThan(20 + 2 * 201);
                expect(group ?? 0, line).toBeLessThanOrEqual(20 + rows);
              }
              expect(plans["workflow_annotations@30000"], line).toHaveLength(3);
              // Stages: the run's 20 rows by an index on the run.
              expect(sum("workflow_stages@30000"), line).toBeLessThan(20);
              // Logs and steps: no index serves their order, so a page of
              // them reads every row of the run, through an index: the cost
              // the console docs state ("How the events are read"), at most
              // a page per row of the run, and never another run's rows.
              expect(sum("workflow_steps@stages"), line).toBeLessThanOrEqual(
                100 + 1_000 * 4,
              );
              for (const rows of sizes) {
                expect(sum(`workflow_logs@${rows}`), line).toBeLessThanOrEqual(
                  20 + rows,
                );
                expect(sum(`workflow_steps@${rows}`), line).toBeLessThanOrEqual(
                  100 + rows,
                );
              }
              throw rollback;
            },
            { timeout: 240_000 },
          )
          .catch((error: unknown) => {
            if (error !== rollback) throw error;
          });
      }
      expect(lines).toHaveLength(4);
    });

    describe("the attempt history on the engine's Prisma store (real kernel)", () => {
      // The store's own runs only: a claim takes every pending run it finds.
      beforeEach(truncateAll, 60_000);

      it("states nothing false after any dispatch, nor after rows removed from the end of a run's outbox", {
        timeout: 600_000,
      }, async () => {
        const result = await runStoreOracle(
          await storeWorld(prisma, "postgresql"),
        );
        console.log(
          [
            `store oracle (Postgres, Prisma ${process.env.PRISMA_MAJOR ?? "7"}): ${result.samples} page reads with nothing removed, ${result.unavailableWithNothingRemoved.length} unavailable; ${result.removals} removals, ${result.outside.length} wrong outside the stated limit, ${result.limit.length} within it`,
            ...result.limit.map((f) => `  ${f}`),
          ].join("\n"),
        );
        expect(result.unavailableWithNothingRemoved).toEqual([]);
        expect(result.outside).toEqual([]);
        expect(result.visible).toEqual([]);
        expect(result.samples).toBeGreaterThan(100);
      });

      it("reads the stored rows of every release since alpha.13", {
        timeout: 300_000,
      }, async () => {
        const { files, lines } = await readStoredRows(
          await storeWorld(prisma, "postgresql"),
        );
        expect(files).toBeGreaterThanOrEqual(110);
        const wrong = lines.filter((line) =>
          // Its capture harness appends two `workflow:started` rows of its own
          // to the completed run, and the run row counts no redrive. The first
          // reads as a redrive; the second, with no end between, is neither a
          // redrive nor the claim after a transition (that pair is a run's first
          // start only), so the order check finds it.
          line.scenario === "unpublished-outbox"
            ? line.read !== "unavailable run-inconsistent/order"
            : !line.read.startsWith("available"),
        );
        expect(wrong).toEqual([]);
        // A stage queued with its row stamped at creation (G1).
        const queued = lines.filter(
          (line) => line.scenario === "running-queued",
        );
        expect(queued.length).toBeGreaterThanOrEqual(10);
        expect(new Set(queued.map((line) => line.read))).toEqual(
          new Set(["available "]),
        );
      });
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
      // Past a gap wider than the sequences it reads from: it never stops
      // at it, and returns fewer rows than the limit across a smaller one.
      await prisma.workflowRun.createMany({
        data: [mkRun("run-tail-gap", at(-9_020), "RUNNING", "wf-d")],
      });
      await prisma.outboxEvent.createMany({
        data: [1, 2, 3 + STAGE_EVENT_WINDOW, 4 + STAGE_EVENT_WINDOW].map((n) =>
          mkEvent(
            `tail-gap-${n}`,
            "run-tail-gap",
            n,
            "stage:progress",
            at(20),
            null,
            null,
          ),
        ),
      });
      const tail = (after: number, limit?: number) =>
        reader()
          .listRunEvents("run-tail-gap", after, limit)
          .then((events) => events.map((e) => e.sequence));
      expect(await tail(0)).toEqual([1, 2]);
      expect(await tail(2)).toEqual([
        3 + STAGE_EVENT_WINDOW,
        4 + STAGE_EVENT_WINDOW,
      ]);
      expect(await tail(0, 1)).toEqual([1]);
      expect(await tail(0, 3)).toEqual([1, 2]);
      expect(await tail(4 + STAGE_EVENT_WINDOW)).toEqual([]);
      // Near and past the largest value of the sequence column, through the
      // handler: the rows there, or none, not a 500 for a bound Postgres
      // refuses.
      await prisma.outboxEvent.createMany({
        data: [
          mkEvent(
            "tail-gap-top",
            "run-tail-gap",
            2_147_483_600,
            "stage:progress",
            at(21),
            null,
            null,
          ),
        ],
      });
      const handle = createWorkflowConsole({
        reader: reader(),
        authorize: () => true,
      });
      for (const query of [
        "events?afterSequence=9007199254740993",
        "events?afterSequence=2147483647",
        "events?afterSequence=2147483599&limit=500",
        "?stageEventsAfter=9007199254740993",
      ]) {
        const response = await handle(
          new Request(
            `https://console.example/console/api/runs/run-tail-gap${query.startsWith("?") ? "" : "/"}${query}`,
          ),
        );
        expect(response.status, query).toBe(200);
        if (query.startsWith("events"))
          expect(
            ((await response.json()) as Array<{ sequence: number }>).map(
              (e) => e.sequence,
            ),
            query,
          ).toEqual(query.includes("limit") ? [2_147_483_600] : []);
      }
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

    it("makes the server raise no error, at its own level or inside a caller's transaction, and leaves the caller's statement_timeout as it was", {
      timeout: 60_000,
    }, async () => {
      const relay = await countServerErrors(DATABASE_URL);
      const observed = createPostgresClient(relay.url);
      try {
        const reads = async (c: ConsolePrismaClient) => {
          const port = createPrismaConsoleReadPort(c, { now: () => at(100) });
          for (let i = 0; i < 10; i++) {
            const detail = await port.getRunDetail("run-1");
            expect(detail?.run.id).toBe("run-1");
          }
          await port.listRunEvents("run-1", 0);
          await port.listRuns({ limit: 3 });
        };
        await reads(observed);
        // The caller's transaction: on Prisma 7 its client has a
        // `$transaction` of its own (a savepoint); on 6 and 8 it has none.
        const after = await observed.$transaction(
          async (tx: ConsolePrismaClient) => {
            await tx.$executeRawUnsafe?.("SET LOCAL statement_timeout = 4321");
            await reads(tx);
            const [row] = await rawRead(tx, {
              statement_timeout: "text",
            }).$queryRawUnsafe<Array<{ statement_timeout: string }>>(
              "SHOW statement_timeout",
            );
            return row?.statement_timeout;
          },
          { timeout: 30_000 },
        );
        expect(after).toBe("4321ms");
        expect(relay.errors).toEqual([]);
      } finally {
        await observed.$disconnect?.();
        await relay.close();
      }
    });

    it("gives a read's transaction the time its statements may take, and reports a client that gives up as a console timeout", {
      timeout: 60_000,
    }, async () => {
      // A statement that outlasts Prisma's default transaction limit (5 s):
      // with no statement timeout the read waits for it.
      const slow = (c: ConsolePrismaClient, ms: number) =>
        recordingClient(c, [], async (call) => {
          if (call.sql.includes('FROM "workflow_stages"'))
            await new Promise((r) => setTimeout(r, ms));
        });
      const unbounded = await createPrismaConsoleReadPort(slow(client, 6_000), {
        now: () => at(100),
        statementTimeoutMs: 0,
      }).getRunDetail("run-1");
      expect(unbounded?.run.id).toBe("run-1");
      // A client-side wait past the read's budget (12 statements of 50 ms):
      // the client ends the transaction (P2028), reported as the console's
      // timeout.
      const error = await createPrismaConsoleReadPort(slow(client, 1_500), {
        now: () => at(100),
        statementTimeoutMs: 50,
      })
        .getRunDetail("run-1")
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ConsoleQueryTimeoutError);
      expect((error as { cause?: { code?: string } }).cause?.code).toBe(
        "P2028",
      );
      // The message names the limit that fired: 20 statements of 50 ms.
      expect((error as ConsoleQueryTimeoutError).limit).toBe("transaction");
      expect((error as Error).message).toMatch(
        /ran past its transaction's limit of 1000ms/,
      );
    });

    it("actually applies statement_timeout on a root client", async () => {
      // A client that answers every read with a one-second sleep. The point
      // is that the `SET LOCAL statement_timeout` the reader issues inside
      // the transaction it opened really takes effect, not that listRuns is
      // slow -- pg_sleep is just the only reliable way to outrun a 200ms
      // budget.
      const sleepy: ConsolePrismaClient = {
        $queryRawUnsafe: () =>
          rawRead(prisma, { pg_sleep: "text" }).$queryRawUnsafe(
            "SELECT pg_sleep(1)::text AS pg_sleep",
          ),
        $executeRawUnsafe: (sql: string, ...args: unknown[]) =>
          prisma.$executeRawUnsafe(sql, ...args),
        $transaction: (fn, options) =>
          prisma.$transaction(
            (tx: ConsolePrismaClient) =>
              fn({
                // The reader's own settings statements run as they are.
                $queryRawUnsafe: (sql: string, ...args: unknown[]) =>
                  /^SHOW |set_config/.test(sql)
                    ? rawRead(
                        tx,
                        sql.startsWith("SHOW ")
                          ? { statement_timeout: "text" }
                          : { set_config: "text" },
                      ).$queryRawUnsafe(sql, ...args)
                    : // Prisma 8 reads only the columns it is told of.
                      rawRead(tx, { pg_sleep: "text" }).$queryRawUnsafe(
                        "SELECT pg_sleep(1)::text AS pg_sleep",
                      ),
                $executeRawUnsafe: (sql: string, ...args: unknown[]) =>
                  tx.$executeRawUnsafe?.(sql, ...args) ?? Promise.resolve(0),
              }),
            options,
          ),
        // Prisma 8's shim says so, and takes no `maxWait`.
        ...(prisma.$databaseType
          ? { $databaseType: prisma.$databaseType }
          : {}),
      };
      // The transaction may take 20 times this: the server's cancel comes first.
      const impatient = createPrismaConsoleReadPort(sleepy, {
        statementTimeoutMs: 200,
      });
      const error = await impatient.listRuns({}).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ConsoleQueryTimeoutError);
      // The server cancelled the statement (57014), before the client's
      // transaction limit.
      expect(isStatementTimeout((error as Error).cause)).toBe(true);
      expect((error as ConsoleQueryTimeoutError).limit).toBe(
        "statement_timeout",
      );
      expect((error as Error).message).toMatch(
        /cancelled after 200ms by statement_timeout/,
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

    const http = (port: ReturnType<typeof reader>, path: string) =>
      createWorkflowConsole({ reader: port, authorize: () => true })(
        new Request(`https://console.example/console/api/runs/${path}`),
      );
    const openCursors = async (c: ConsolePrismaClient) =>
      Number(
        (
          await rawRead(c, { n: "int" }).$queryRawUnsafe<Array<{ n: unknown }>>(
            "SELECT count(*)::int AS n FROM pg_cursors WHERE name LIKE 'workflow_console_%'",
          )
        )[0]!.n,
      );

    it("reads with any statementTimeoutMs, up to Postgres's maximum and past it", {
      timeout: 60_000,
    }, async () => {
      // 20 times 107,374,183 passes the longest timer Node keeps (2^31 - 1
      // ms): every limit the port derives stays within it.
      for (const ms of [107_374_183, 2_147_483_647, 10 ** 12]) {
        const port = createPrismaConsoleReadPort(client, {
          now: () => at(100),
          statementTimeoutMs: ms,
        });
        expect((await port.getRunDetail("run-1"))?.run.id, `${ms}`).toBe(
          "run-1",
        );
        expect((await port.listRuns({ limit: 2 })).runs, `${ms}`).toHaveLength(
          2,
        );
        expect((await http(port, "run-1")).status, `${ms}`).toBe(200);
      }
    });

    it("answers a busy pool with a console timeout after statementTimeoutMs, on every Prisma major", {
      timeout: 60_000,
    }, async () => {
      const one = createPostgresClient(DATABASE_URL, { max: 1 });
      try {
        const busy = () =>
          one.$transaction(
            (tx: ConsolePrismaClient) =>
              rawRead(tx, { s: "text" }).$queryRawUnsafe(
                "SELECT pg_sleep(3)::text AS s",
              ),
            { timeout: 20_000 },
          );
        const port = createPrismaConsoleReadPort(one, {
          now: () => at(100),
          statementTimeoutMs: 500,
        });
        let holder = busy();
        await new Promise((r) => setTimeout(r, 300));
        let started = Date.now();
        const error = await port.getRunDetail("run-1").catch((e: unknown) => e);
        expect(Date.now() - started).toBeLessThan(2_000);
        expect(error).toBeInstanceOf(ConsoleQueryTimeoutError);
        expect((error as ConsoleQueryTimeoutError).limit).toBe("connection");
        expect((error as Error).message).toMatch(
          /waited 500ms for a database connection/,
        );
        await holder;
        holder = busy();
        await new Promise((r) => setTimeout(r, 300));
        started = Date.now();
        const response = await http(port, "run-1");
        expect(Date.now() - started).toBeLessThan(2_000);
        expect(response.status).toBe(504);
        expect(await response.json()).toMatchObject({
          error: { code: "query_timeout" },
        });
        await holder;
        // The pool is free again: the next read works.
        expect((await port.getRunDetail("run-1"))?.run.id).toBe("run-1");
      } finally {
        await one.$disconnect?.();
      }
    });

    it("reads with a client that has no $transaction and is not a transaction client, with the same results and no server error", {
      timeout: 60_000,
    }, async () => {
      const relay = await countServerErrors(DATABASE_URL);
      const observed = createPostgresClient(relay.url);
      try {
        // A wrapper of a root client that forwards the raw methods only.
        const wrapped: ConsolePrismaClient = {
          $queryRawUnsafe: observed.$queryRawUnsafe.bind(observed),
          $executeRawUnsafe: observed.$executeRawUnsafe.bind(observed),
          ...(observed.$withColumns
            ? { $withColumns: observed.$withColumns.bind(observed) }
            : {}),
          ...(observed.$databaseType
            ? { $databaseType: observed.$databaseType }
            : {}),
        };
        const calls: RecordedStatement[] = [];
        for (const statementTimeoutMs of [undefined, 0]) {
          const port = createPrismaConsoleReadPort(
            recordingClient(wrapped, calls),
            { now: () => at(100), statementTimeoutMs },
          );
          expect(await port.getRunDetail("run-1")).toEqual(
            await reader().getRunDetail("run-1"),
          );
          expect((await http(port, "run-1")).status).toBe(200);
        }
        // No cursor: it needs a transaction block.
        expect(calls.some((c) => c.sql.startsWith("DECLARE "))).toBe(false);
        expect(relay.errors).toEqual([]);
      } finally {
        await observed.$disconnect?.();
        await relay.close();
      }
    });

    it("closes its cursor when a read fails on the client side inside a caller's transaction", {
      timeout: 60_000,
    }, async () => {
      const failure = new Error("the client failed");
      // After the server ran the DECLARE, after the FETCH, and in place of
      // the CLOSE (the client fails before sending it).
      for (const after of ["DECLARE", "FETCH", "CLOSE"]) {
        await prisma.$transaction(
          async (tx: ConsolePrismaClient) => {
            let thrown = 0;
            const failing = recordingClient(
              tx,
              [],
              async (call) => {
                if (
                  after === "FETCH" &&
                  call.sql.startsWith("FETCH ") &&
                  !thrown++
                )
                  throw failure;
              },
              async (sql) => {
                if (
                  after === "DECLARE" &&
                  sql.startsWith("DECLARE ") &&
                  !thrown++
                )
                  throw failure;
              },
              async (sql) => {
                if (after === "CLOSE" && sql.startsWith("CLOSE ") && !thrown) {
                  thrown++;
                  throw failure;
                }
              },
            );
            const port = createPrismaConsoleReadPort(failing, {
              now: () => at(100),
            });
            await expect(port.getRunDetail("run-1"), after).rejects.toBe(
              failure,
            );
            expect(thrown, after).toBe(1);
            expect(await openCursors(tx), after).toBe(0);
            // The caller's transaction still takes statements.
            expect((await port.getRunDetail("run-1"))?.run.id).toBe("run-1");
            expect(await openCursors(tx), after).toBe(0);
          },
          { timeout: 30_000 },
        );
      }
    });

    it("names its cursors apart from those of another copy of the module on the same client", async () => {
      // A duplicated bundle: a second instance of the module, its own counter.
      const specifier = "../prisma-read-port.ts?second-copy";
      const copy: typeof import("../prisma-read-port") = await import(
        /* @vite-ignore */ specifier
      );
      const calls: RecordedStatement[] = [];
      const recorded = recordingClient(client, calls);
      const ports = [
        createPrismaConsoleReadPort(recorded, { now: () => at(100) }),
        copy.createPrismaConsoleReadPort(recorded, { now: () => at(100) }),
      ];
      const details = [];
      for (let i = 0; i < 3; i++)
        for (const port of ports)
          details.push(await port.getRunDetail("run-1"));
      for (const detail of details) expect(detail).toEqual(details[0]);
      const names = calls
        .filter((c) => c.sql.startsWith("DECLARE "))
        .map((c) => c.sql.split(" ")[1]);
      expect(names.length).toBeGreaterThanOrEqual(12);
      expect(new Set(names).size).toBe(names.length);
    });

    it("reads the steps of a run with more stages than a statement takes parameters", {
      timeout: 120_000,
    }, async () => {
      // 66,000 stages: past the 65,535 parameters of Postgres's protocol
      // (and Prisma 6's 32,767).
      await prisma.workflowRun.createMany({
        data: [mkRun("run-many-stages", at(-9_050), "RUNNING", "wf-d")],
      });
      await prisma.$executeRawUnsafe(
        `INSERT INTO workflow_stages (id, "updatedAt", "workflowRunId", "stageId", "stageName", "stageNumber", "executionGroup", status)
SELECT 'many-s' || k, now(), 'run-many-stages', 's' || k, 'S' || k, k, k, 'COMPLETED'::"Status"
FROM generate_series(1, 66000) k`,
      );
      // Steps in the first stage and in the last ones only: a page reads on
      // through every part of the stage list.
      await prisma.$executeRawUnsafe(
        `INSERT INTO workflow_steps (id, "stageRecordId", "stepId", seq, kind, status, "updatedAt")
VALUES ('many-t1', 'many-s1', 'first', 1, 'run', 'completed', now()),
       ('many-t3', 'many-s65800', 'late-2', 2, 'run', 'completed', now()),
       ('many-t2', 'many-s65800', 'late-1', 1, 'run', 'completed', now()),
       ('many-t4', 'many-s66000', 'last', 1, 'run', 'completed', now())`,
      );
      const detail = await reader().getRunDetail("run-many-stages");
      expect(detail?.stages).toHaveLength(66_000);
      expect(detail?.steps.map((s) => s.stepId)).toEqual([
        "first",
        "late-1",
        "late-2",
        "last",
      ]);
      expect(detail?.truncated.steps).toBe(false);
      const paged = await reader().getRunDetail("run-many-stages", {
        stepLimit: 2,
      });
      expect(paged?.steps.map((s) => s.stepId)).toEqual(["first", "late-1"]);
      expect(paged?.truncated.steps).toBe(true);
      const response = await http(reader(), "run-many-stages");
      expect(response.status).toBe(200);
      expect(
        ((await response.json()) as { steps: Array<{ stepId: string }> }).steps
          .length,
      ).toBe(4);
    });

    it("refuses an afterSequence that is not a number at the port", async () => {
      for (const value of [Number.NaN, "3" as unknown as number])
        await expect(
          reader().listRunEvents("run-1", value),
          String(value),
        ).rejects.toBeInstanceOf(ConsoleBadRequestError);
      expect(
        (await http(reader(), "run-1/events?afterSequence=abc")).status,
      ).toBe(400);
    });

    it("fetches no more than a page of annotations, whatever the size of the group of rows that share the time it ends at", {
      timeout: 60_000,
    }, async () => {
      await prisma.workflowRun.createMany({
        data: [mkRun("run-tie-group", at(-9_040), "RUNNING", "wf-d")],
      });
      // 100 newer rows, then 5,000 rows written at one time (one
      // createMany), then 50 older ones: the page of 200 ends in the group.
      await prisma.$executeRawUnsafe(
        `INSERT INTO workflow_annotations (id, "createdAt", "workflowRunId", scope, key, value)
SELECT CASE WHEN g <= 100 THEN 'n' WHEN g <= 5100 THEN 't' ELSE 'o' END || lpad((g * 7919 % 100003)::text, 6, '0'),
       CASE WHEN g <= 100 THEN timestamp '2026-03-01 12:10:00' + g * interval '1 millisecond'
            WHEN g <= 5100 THEN timestamp '2026-03-01 12:05:00'
            ELSE timestamp '2026-03-01 12:00:00' END,
       'run-tie-group', 'run', 'k' || g, '{}'::jsonb
FROM generate_series(1, 5150) g`,
      );
      const calls: RecordedStatement[] = [];
      const detail = await createPrismaConsoleReadPort(
        recordingClient(client, calls),
        { now: () => at(100) },
      ).getRunDetail("run-tie-group");
      const fetched = calls
        .filter((c) => /^FETCH |FROM "workflow_annotations"/.test(c.sql))
        .map((c) => (c.rows as unknown[]).length)
        .filter((n) => n >= 0);
      // The times of 201 rows, then 100 newer rows and the group's first 100.
      expect(fetched).toEqual([201, 100, 100]);
      const all = await rawRead(prisma, {
        id: "text",
        t: "text",
      }).$queryRawUnsafe<Array<{ id: string; t: string }>>(
        `SELECT id, "createdAt"::text AS t FROM workflow_annotations WHERE "workflowRunId" = 'run-tie-group'
ORDER BY "createdAt" DESC, id COLLATE "C" DESC LIMIT 200`,
      );
      expect(detail?.annotations.map((a) => a.id)).toEqual(
        all.map((r) => r.id),
      );
      expect(detail?.truncated.annotations).toBe(true);
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
