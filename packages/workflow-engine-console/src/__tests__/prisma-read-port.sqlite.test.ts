import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createWorkflowConsole } from "../handler";
import {
  type ConsolePrismaClient,
  createPrismaConsoleReadPort,
} from "../prisma-read-port";

const major = process.env.PRISMA_MAJOR ?? "7";
const isPrisma8 = major === "8";
const enginePersistence = "@bratsos/workflow-engine/persistence";
const fromPrisma8 = isPrisma8
  ? (await import(enginePersistence)).fromPrisma8
  : undefined;
const fixture = createRequire(import.meta.url)(
  "../../../prisma-fixtures/index.cjs",
);

const T0 = new Date("2026-03-01T23:30:00.000Z");
const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);

describe(`I want the console read port to work against real SQLite on Prisma ${major}`, () => {
  let directory: string;
  let prisma: ConsolePrismaClient & Record<string, any>;

  beforeAll(async () => {
    directory = mkdtempSync(join(tmpdir(), "workflow-console-sqlite-"));
    const file = join(directory, "console.db");
    if (isPrisma8) {
      const db = fixture.createSqliteDb(file);
      prisma = Object.assign(fromPrisma8!(db), {
        $disconnect: () => db.close(),
      });
    } else {
      prisma = fixture.createSqliteClient(file);
    }

    await seed();
  });

  afterAll(async () => {
    await prisma?.$disconnect?.();
    if (directory) rmSync(directory, { recursive: true, force: true });
  });

  function reader(statementTimeoutMs = 15_000) {
    return createPrismaConsoleReadPort(prisma, {
      databaseType: "sqlite",
      statementTimeoutMs,
      now: () => at(100),
    });
  }

  async function seed() {
    await prisma.workflowRun.createMany({
      data: [
        mkRun("run-day-1", at(0), "COMPLETED", "wf-a", 0.25, 100, "sha-days"),
        mkRun("run-day-2", at(120), "COMPLETED", "wf-a", 0.5, 200, "sha-days"),
        mkRun("run-failed", at(180), "FAILED", "wf-b", 0.75, 50, "sha-failed"),
        mkRun("run-running", at(240), "RUNNING", "wf-b", 0.1, 10),
        mkRun("run-pending", at(300), "PENDING", "wf-a", 0, 0),
        mkRun("run-suspended", at(360), "SUSPENDED", "wf-c", 0.05, 5),
      ],
    });
    await prisma.workflowStage.createMany({
      data: [
        {
          id: "stage-day-1",
          workflowRunId: "run-day-1",
          stageId: "finish",
          stageName: "Finish",
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
          id: "stage-suspended",
          workflowRunId: "run-suspended",
          stageId: "waiting",
          stageName: "Waiting",
          stageNumber: 0,
          executionGroup: 0,
          attempt: 2,
          status: "SUSPENDED",
          createdAt: at(30),
          updatedAt: at(30),
          startedAt: at(30),
          nextPollAt: at(35),
          pollInterval: 30_000,
          maxWaitUntil: at(1_000),
        },
      ],
    });
    await prisma.workflowStep.createMany({
      data: [
        {
          id: "step-day-1",
          stageRecordId: "stage-day-1",
          stepId: "work",
          seq: 1,
          kind: "run",
          status: "completed",
          attempt: 1,
          externalKey: "wf-a:run-day-1:finish:1:work",
          createdAt: at(0),
          updatedAt: at(1),
        },
      ],
    });
    await prisma.workflowAnnotation.createMany({
      data: [
        {
          id: "annotation-day-1",
          workflowRunId: "run-day-1",
          workflowStageRecordId: "stage-day-1",
          attempt: 1,
          scope: "stage",
          scopeId: "finish",
          actorKind: "worker",
          actorId: "worker-1",
          key: "result",
          value: { accepted: true },
          createdAt: at(2),
        },
      ],
    });
    await prisma.workflowLog.createMany({
      data: [
        {
          id: "log-day-1",
          workflowRunId: "run-day-1",
          workflowStageId: "stage-day-1",
          level: "INFO",
          message: "finished",
          createdAt: at(3),
        },
      ],
    });
    await prisma.outboxEvent.createMany({
      data: [
        mkEvent("event-1", "run-day-1", 1, "run.started", at(0), at(1), null),
        mkEvent("event-2", "run-day-1", 2, "run.completed", at(2), at(3), null),
        mkEvent(
          "event-dead",
          "run-failed",
          1,
          "stage.failed",
          at(11),
          null,
          at(12),
        ),
      ],
    });
    await prisma.jobQueue.createMany({
      data: [
        {
          id: "job-pending-1",
          workflowRunId: "run-pending",
          stageId: "a",
          status: "PENDING",
          createdAt: at(5),
          updatedAt: at(5),
        },
        {
          id: "job-pending-2",
          workflowRunId: "run-pending",
          stageId: "b",
          status: "PENDING",
          createdAt: at(9),
          updatedAt: at(9),
        },
        {
          id: "job-running-1",
          workflowRunId: "run-running",
          stageId: "c",
          status: "RUNNING",
          workerId: "worker-1",
          lockedAt: at(50),
          createdAt: at(6),
          updatedAt: at(50),
        },
        {
          id: "job-running-2",
          workflowRunId: "run-running",
          stageId: "d",
          status: "RUNNING",
          workerId: "worker-1",
          lockedAt: at(60),
          createdAt: at(7),
          updatedAt: at(60),
        },
        {
          id: "job-suspended",
          workflowRunId: "run-suspended",
          stageId: "e",
          status: "SUSPENDED",
          nextPollAt: at(35),
          createdAt: at(8),
          updatedAt: at(8),
        },
      ],
    });
  }

  it("filters and keyset-pages runs while decoding SQLite timestamps as UTC dates", async () => {
    const port = reader();
    const first = await port.listRuns({
      filters: {
        status: ["COMPLETED"],
        workflowId: "wf-a",
        workflowType: "standard",
        definitionVersion: "sha-days",
        createdAfter: at(0),
        createdBefore: at(121),
      },
      limit: 1,
    });

    expect(first.runs.map((run) => run.id)).toEqual(["run-day-2"]);
    expect(first.runs[0]?.createdAt.toISOString()).toBe(at(120).toISOString());
    expect(first.nextCursor).not.toBeNull();

    const second = await port.listRuns({
      filters: {
        status: ["COMPLETED"],
        workflowId: "wf-a",
        workflowType: "standard",
        definitionVersion: "sha-days",
        createdAfter: at(0),
        createdBefore: at(121),
      },
      cursor: first.nextCursor!,
      limit: 1,
    });
    expect(second.runs.map((run) => run.id)).toEqual(["run-day-1"]);
    expect(second.nextCursor).toBeNull();
  });

  it("reads run details, JSON fields, stages, steps, annotations, logs, and events", async () => {
    const detail = await reader().getRunDetail("run-day-1");

    expect(detail?.run.input).toEqual({ payload: "run-day-1" });
    expect(detail?.run.output).toEqual({ completed: true });
    expect(detail?.run.config).toEqual({ retry: 2 });
    expect(detail?.run.metadata).toEqual({ source: "sqlite-test" });
    expect(detail?.run.createdAt.toISOString()).toBe(at(0).toISOString());
    expect(detail?.stages[0]).toMatchObject({
      id: "stage-day-1",
      startedAt: at(0),
      completedAt: at(1),
    });
    expect(detail?.steps[0]).toMatchObject({
      id: "step-day-1",
      externalKey: "wf-a:run-day-1:finish:1:work",
      createdAt: at(0),
      updatedAt: at(1),
    });
    expect(detail?.annotations[0]).toMatchObject({
      value: { accepted: true },
      createdAt: at(2),
    });
    expect(detail?.logs[0]).toMatchObject({
      message: "finished",
      createdAt: at(3),
    });
    expect(detail?.events.map((event) => event.sequence)).toEqual([1, 2]);
    expect(detail?.truncated).toEqual({
      steps: false,
      annotations: false,
      logs: false,
      events: false,
    });

    const events = await reader().listRunEvents("run-day-1", 1, 1);
    expect(events.map((event) => event.id)).toEqual(["event-2"]);
    expect(events[0]?.occurredAt.toISOString()).toBe(at(2).toISOString());
  });

  it("reports queue health, suspended stages, dead letters, and workers", async () => {
    const port = reader();
    const health = await port.getQueueHealth();
    expect(health.countsByStatus).toMatchObject({
      PENDING: 2,
      RUNNING: 2,
      SUSPENDED: 1,
    });
    expect(health.oldestPendingAt?.toISOString()).toBe(at(5).toISOString());
    expect(health.oldestLeaseAt?.toISOString()).toBe(at(50).toISOString());
    expect(health.overduePolls).toBe(1);

    const suspended = await port.listSuspendedStages();
    expect(suspended).toHaveLength(1);
    expect(suspended[0]).toMatchObject({
      id: "stage-suspended",
      workflowId: "wf-c",
      nextPollAt: at(35),
      maxWaitUntil: at(1_000),
    });

    const deadLetters = await port.listDeadLetters();
    expect(deadLetters).toHaveLength(1);
    expect(deadLetters[0]).toMatchObject({
      id: "event-dead",
      occurredAt: at(11),
      dlqAt: at(12),
      retryCount: 5,
    });

    const workers = await port.listWorkers();
    expect(workers).toEqual([
      {
        workerId: "worker-1",
        runningJobs: 2,
        oldestLockedAt: at(50),
        lastSeenAt: at(60),
      },
    ]);
  });

  it("aggregates workflow costs and groups cost dates in UTC", async () => {
    const port = reader();
    const from = at(0);
    const to = new Date("2026-03-03T00:00:00.000Z");
    const byWorkflow = await port.getCosts({ by: "workflow", from, to });
    expect(byWorkflow.find((bucket) => bucket.key === "wf-a")).toMatchObject({
      runs: 3,
      cost: 0.75,
      tokens: 300,
    });

    const byDay = await port.getCosts({ by: "day", from, to });
    expect(byDay).toEqual([
      { key: "2026-03-02", runs: 5, cost: 1.4, tokens: 265 },
      { key: "2026-03-01", runs: 1, cost: 0.25, tokens: 100 },
    ]);
  });

  it("serves SQLite-backed runs through the real console handler and does not issue SET LOCAL", async () => {
    const port = reader(1);
    const handler = createWorkflowConsole({
      reader: port,
      authorize: () => true,
    });
    const response = await handler(
      new Request(
        "https://console.example/console/api/runs?status=COMPLETED&workflowId=wf-a",
      ),
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      runs: Array<{ id: string; createdAt: string }>;
    };
    expect(body.runs.map((run) => run.id)).toEqual(["run-day-2", "run-day-1"]);
    expect(body.runs[0]?.createdAt).toBe(at(120).toISOString());
  });

  it.skipIf(!isPrisma8)(
    "rejects databaseType mismatches with the contract target's corrective option",
    () => {
      expect(() => createPrismaConsoleReadPort(prisma)).toThrow(
        /databaseType: "sqlite"/,
      );

      // The reverse label exercises the same pre-SQL validation branch for the
      // other supported contract target. No query is issued by this check.
      const postgresTarget = Object.create(prisma, {
        $databaseType: { value: "postgresql" },
      });
      expect(() =>
        createPrismaConsoleReadPort(postgresTarget, { databaseType: "sqlite" }),
      ).toThrow(/databaseType: "postgresql"/);
    },
  );
});

function mkRun(
  id: string,
  createdAt: Date,
  status: string,
  workflowId: string,
  totalCost: number,
  totalTokens: number,
  definitionVersion?: string,
) {
  return {
    id,
    createdAt,
    updatedAt: createdAt,
    workflowId,
    workflowName: `Workflow ${workflowId}`,
    workflowType: "standard",
    status,
    startedAt: createdAt,
    input: { payload: id },
    output: { completed: true },
    config: { retry: 2 },
    totalCost,
    totalTokens,
    priority: 5,
    metadata: { source: "sqlite-test" },
    definitionVersion,
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
    payload: { seeded: true },
    causationId: `cause-${id}`,
    occurredAt,
    createdAt: occurredAt,
    publishedAt,
    dlqAt,
    retryCount: dlqAt ? 5 : 0,
  };
}
