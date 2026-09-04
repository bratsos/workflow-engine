import { describe, expect, it } from "vitest";
import { ConsoleBadRequestError } from "../errors";
import {
  type ConsoleFixtures,
  createInMemoryConsoleReadPort,
} from "../in-memory-read-port";
import {
  clampLimit,
  decodeCursor,
  encodeCursor,
  isConsoleStatus,
  MAX_LIMIT,
} from "../read-port";

const T0 = new Date("2026-01-01T00:00:00.000Z");

function at(minutes: number): Date {
  return new Date(T0.getTime() + minutes * 60_000);
}

function run(
  id: string,
  minutes: number,
  overrides: Record<string, unknown> = {},
) {
  return {
    id,
    createdAt: at(minutes),
    updatedAt: at(minutes),
    workflowId: "wf-a",
    workflowName: "Workflow A",
    workflowType: "standard",
    status: "COMPLETED" as const,
    startedAt: at(minutes),
    completedAt: at(minutes + 1),
    duration: 60_000,
    totalCost: 0.5,
    totalTokens: 100,
    priority: 5,
    ...overrides,
  };
}

describe("cursor encoding", () => {
  it("round-trips a (createdAt, id) keyset tuple", () => {
    const cursor = { createdAt: at(7), id: "run-7" };
    expect(decodeCursor(encodeCursor(cursor))).toEqual(cursor);
  });

  it("rejects a cursor that is not one of ours", () => {
    expect(decodeCursor("not-a-cursor")).toBeNull();
    expect(decodeCursor("")).toBeNull();
  });
});

describe("clampLimit", () => {
  it("caps at MAX_LIMIT and floors at 1", () => {
    expect(clampLimit(10_000)).toBe(MAX_LIMIT);
    expect(clampLimit(0)).toBe(1);
    expect(clampLimit(-5)).toBe(1);
  });

  it("falls back when nothing was asked for", () => {
    expect(clampLimit(undefined, 25)).toBe(25);
    expect(clampLimit(Number.NaN, 25)).toBe(25);
  });
});

describe("isConsoleStatus", () => {
  it("accepts engine statuses and rejects anything else", () => {
    expect(isConsoleStatus("RUNNING")).toBe(true);
    expect(isConsoleStatus("running")).toBe(false);
    expect(isConsoleStatus("EXPLODED")).toBe(false);
  });
});

describe("in-memory read port: listRuns", () => {
  const fixtures: ConsoleFixtures = {
    runs: [
      run("run-1", 0),
      run("run-2", 10, { status: "FAILED" }),
      run("run-3", 20, { workflowId: "wf-b" }),
      run("run-4", 30, { status: "RUNNING" }),
      run("run-5", 40),
    ],
  };

  it("returns newest first", async () => {
    const reader = createInMemoryConsoleReadPort(fixtures);
    const page = await reader.listRuns({});
    expect(page.runs.map((entry) => entry.id)).toEqual([
      "run-5",
      "run-4",
      "run-3",
      "run-2",
      "run-1",
    ]);
    expect(page.nextCursor).toBeNull();
  });

  it("pages forward on the keyset without repeating or skipping a row", async () => {
    const reader = createInMemoryConsoleReadPort(fixtures);
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 10; page += 1) {
      const result = await reader.listRuns({ limit: 2, cursor });
      seen.push(...result.runs.map((entry) => entry.id));
      if (result.nextCursor === null) break;
      cursor = result.nextCursor;
    }
    expect(seen).toEqual(["run-5", "run-4", "run-3", "run-2", "run-1"]);
    expect(new Set(seen).size).toBe(seen.length);
  });

  it("filters by status, workflow and time range", async () => {
    const reader = createInMemoryConsoleReadPort(fixtures);
    expect(
      (
        await reader.listRuns({ filters: { status: ["FAILED", "RUNNING"] } })
      ).runs
        .map((entry) => entry.id)
        .sort(),
    ).toEqual(["run-2", "run-4"]);

    expect(
      (await reader.listRuns({ filters: { workflowId: "wf-b" } })).runs.map(
        (entry) => entry.id,
      ),
    ).toEqual(["run-3"]);

    expect(
      (
        await reader.listRuns({
          filters: { createdAfter: at(10), createdBefore: at(30) },
        })
      ).runs.map((entry) => entry.id),
    ).toEqual(["run-3", "run-2"]);
  });

  it("rejects a cursor it did not issue rather than silently returning page one", async () => {
    const reader = createInMemoryConsoleReadPort(fixtures);
    await expect(reader.listRuns({ cursor: "!!!" })).rejects.toBeInstanceOf(
      ConsoleBadRequestError,
    );
  });
});

describe("in-memory read port: run detail", () => {
  const fixtures: ConsoleFixtures = {
    runs: [run("run-1", 0, { input: { a: 1 }, output: { b: 2 } })],
    stages: [
      {
        id: "stage-rec-2",
        workflowRunId: "run-1",
        stageId: "second",
        stageName: "Second",
        stageNumber: 1,
        executionGroup: 1,
        attempt: 1,
        status: "RUNNING",
        startedAt: at(1),
        completedAt: null,
        duration: null,
        nextPollAt: null,
        pollInterval: null,
        maxWaitUntil: null,
        errorMessage: null,
      },
      {
        id: "stage-rec-1",
        workflowRunId: "run-1",
        stageId: "first",
        stageName: "First",
        stageNumber: 0,
        executionGroup: 0,
        attempt: 1,
        status: "COMPLETED",
        startedAt: at(0),
        completedAt: at(1),
        duration: 60_000,
        nextPollAt: null,
        pollInterval: null,
        maxWaitUntil: null,
        errorMessage: null,
      },
    ],
    events: [
      {
        id: "e2",
        workflowRunId: "run-1",
        sequence: 2,
        eventType: "stage.completed",
        occurredAt: at(1),
        publishedAt: at(1),
        retryCount: 0,
        dlqAt: null,
      },
      {
        id: "e1",
        workflowRunId: "run-1",
        sequence: 1,
        eventType: "run.started",
        occurredAt: at(0),
        publishedAt: at(0),
        retryCount: 0,
        dlqAt: null,
      },
    ],
  };

  it("orders stages by stage number and events by sequence", async () => {
    const reader = createInMemoryConsoleReadPort(fixtures);
    const detail = await reader.getRunDetail("run-1");
    expect(detail?.stages.map((stage) => stage.stageId)).toEqual([
      "first",
      "second",
    ]);
    expect(detail?.events.map((event) => event.sequence)).toEqual([1, 2]);
    expect(detail?.run.input).toEqual({ a: 1 });
  });

  it("reports truncation instead of implying it showed everything", async () => {
    const reader = createInMemoryConsoleReadPort(fixtures);
    const detail = await reader.getRunDetail("run-1", { eventLimit: 1 });
    expect(detail?.events).toHaveLength(1);
    expect(detail?.truncated.events).toBe(true);
  });

  it("returns null for a run that does not exist", async () => {
    const reader = createInMemoryConsoleReadPort(fixtures);
    expect(await reader.getRunDetail("nope")).toBeNull();
  });

  it("tails a run timeline from a sequence cursor", async () => {
    const reader = createInMemoryConsoleReadPort(fixtures);
    expect(
      (await reader.listRunEvents("run-1", 1)).map((event) => event.sequence),
    ).toEqual([2]);
    expect(await reader.listRunEvents("run-1", 2)).toEqual([]);
  });
});

describe("in-memory read port: operational views", () => {
  const now = at(100);
  const fixtures: ConsoleFixtures = {
    runs: [run("run-1", 0), run("run-2", 1, { workflowId: "wf-b" })],
    stages: [
      {
        id: "stage-s",
        workflowRunId: "run-1",
        stageId: "waiting",
        stageName: "Waiting",
        stageNumber: 0,
        executionGroup: 0,
        attempt: 1,
        status: "SUSPENDED",
        startedAt: at(0),
        completedAt: null,
        duration: null,
        nextPollAt: at(90),
        pollInterval: 30_000,
        maxWaitUntil: at(200),
        errorMessage: null,
      },
    ],
    events: [
      {
        id: "dlq-1",
        workflowRunId: "run-1",
        sequence: 9,
        eventType: "stage.failed",
        occurredAt: at(3),
        publishedAt: null,
        retryCount: 5,
        dlqAt: at(4),
      },
    ],
    jobs: [
      {
        id: "j1",
        workflowRunId: "run-1",
        stageId: "a",
        status: "PENDING",
        createdAt: at(5),
      },
      {
        id: "j2",
        workflowRunId: "run-1",
        stageId: "b",
        status: "PENDING",
        createdAt: at(9),
      },
      {
        id: "j3",
        workflowRunId: "run-2",
        stageId: "c",
        status: "RUNNING",
        createdAt: at(6),
        workerId: "worker-1",
        lockedAt: at(80),
      },
      {
        id: "j4",
        workflowRunId: "run-2",
        stageId: "d",
        status: "RUNNING",
        createdAt: at(7),
        workerId: "worker-1",
        lockedAt: at(95),
      },
      {
        id: "j5",
        workflowRunId: "run-1",
        stageId: "e",
        status: "SUSPENDED",
        createdAt: at(8),
        nextPollAt: at(50),
      },
    ],
  };

  const reader = () =>
    createInMemoryConsoleReadPort(fixtures, { now: () => now });

  it("summarises queue health", async () => {
    const health = await reader().getQueueHealth();
    expect(health.countsByStatus.PENDING).toBe(2);
    expect(health.countsByStatus.RUNNING).toBe(2);
    expect(health.countsByStatus.COMPLETED).toBe(0);
    expect(health.oldestPendingAt).toEqual(at(5));
    expect(health.oldestLeaseAt).toEqual(at(80));
    expect(health.overduePolls).toBe(1);
  });

  it("derives workers from the leases they hold", async () => {
    const workers = await reader().listWorkers();
    expect(workers).toEqual([
      {
        workerId: "worker-1",
        runningJobs: 2,
        oldestLockedAt: at(80),
        lastSeenAt: at(95),
      },
    ]);
  });

  it("lists suspended stages by next poll, joined to their run", async () => {
    const suspended = await reader().listSuspendedStages();
    expect(suspended).toHaveLength(1);
    expect(suspended[0]?.workflowId).toBe("wf-a");
    expect(suspended[0]?.nextPollAt).toEqual(at(90));
  });

  it("lists dead letters newest first", async () => {
    const dead = await reader().listDeadLetters();
    expect(dead.map((entry) => entry.id)).toEqual(["dlq-1"]);
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
    expect(byWorkflow.every((bucket) => bucket.runs === 1)).toBe(true);

    const byDay = await reader().getCosts({
      by: "day",
      from: at(-1),
      to: at(100),
    });
    expect(byDay).toEqual([
      { key: "2026-01-01", runs: 2, cost: 1, tokens: 200 },
    ]);
  });
});

describe("capability detection", () => {
  it("lets a reader declare a view it cannot serve", () => {
    const reader = createInMemoryConsoleReadPort(
      {},
      { capabilities: { costs: false, workers: false } },
    );
    expect(reader.capabilities.costs).toBe(false);
    expect(reader.capabilities.workers).toBe(false);
    expect(reader.capabilities.runs).toBe(true);
  });
});
