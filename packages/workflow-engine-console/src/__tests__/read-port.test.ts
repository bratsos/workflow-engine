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
  STAGE_EVENT_ERROR_LIMIT,
  STAGE_EVENT_LIMIT,
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
      run("run-4", 30, { status: "RUNNING", definitionVersion: "v-old" }),
      run("run-5", 40, { definitionVersion: "v-old", redriveCount: 2 }),
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

  it("carries the definition version and redrive count of every run", async () => {
    const reader = createInMemoryConsoleReadPort(fixtures);
    const page = await reader.listRuns({});
    expect(
      page.runs.map((entry) => [
        entry.id,
        entry.definitionVersion,
        entry.redriveCount,
      ]),
    ).toEqual([
      ["run-5", "v-old", 2],
      ["run-4", "v-old", 0],
      ["run-3", null, 0],
      ["run-2", null, 0],
      ["run-1", null, 0],
    ]);
  });

  it("filters by definition version, which is how a stranded run is found", async () => {
    const reader = createInMemoryConsoleReadPort(fixtures);
    expect(
      (
        await reader.listRuns({ filters: { definitionVersion: "v-old" } })
      ).runs.map((entry) => entry.id),
    ).toEqual(["run-5", "run-4"]);
    expect(
      (await reader.listRuns({ filters: { definitionVersion: "v-new" } })).runs,
    ).toEqual([]);
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
    runs: [
      run("run-1", 0, {
        input: { a: 1 },
        output: { b: 2 },
        definitionVersion: "sha256-abcdef",
        redriveCount: 3,
      }),
    ],
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
    steps: [
      {
        id: "step-rec-1",
        stageRecordId: "stage-rec-2",
        stepId: "approval",
        seq: 2,
        kind: "signal",
        status: "pending",
        attempt: 1,
        leaseExpiresAt: null,
        deadlineAt: at(60),
        externalKey: null,
        error: null,
        createdAt: at(1),
        updatedAt: at(1),
      },
      {
        id: "step-rec-0",
        stageRecordId: "stage-rec-1",
        stepId: "charge",
        seq: 1,
        kind: "run",
        status: "completed",
        attempt: 1,
        leaseExpiresAt: null,
        deadlineAt: null,
        externalKey: "wf:run-1:first:1:charge",
        error: null,
        createdAt: at(0),
        updatedAt: at(0),
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

  it("carries what the UI needs to offer a signal on a step", async () => {
    const reader = createInMemoryConsoleReadPort(fixtures);
    const detail = await reader.getRunDetail("run-1");
    expect(detail?.steps.map((step) => step.stepId)).toEqual([
      "charge",
      "approval",
    ]);
    expect(detail?.steps[0]).toMatchObject({
      kind: "run",
      status: "completed",
      deadlineAt: null,
      externalKey: "wf:run-1:first:1:charge",
    });
    expect(detail?.steps[1]).toMatchObject({
      kind: "signal",
      status: "pending",
      deadlineAt: at(60),
      externalKey: null,
    });
  });

  it("carries the version and redrive count a stranded run is diagnosed with", async () => {
    const reader = createInMemoryConsoleReadPort(fixtures);
    const detail = await reader.getRunDetail("run-1");
    expect(detail?.run.definitionVersion).toBe("sha256-abcdef");
    expect(detail?.run.redriveCount).toBe(3);
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

  it("returns the attempt history's events past a sequence, and calls the range complete only when its rows are unbroken", async () => {
    const stageEvent = (
      sequence: number,
      eventType: any,
      workflowRunId = "run-1",
      stageId: string | null = "first",
    ) => ({
      workflowRunId,
      sequence,
      eventType,
      occurredAt: at(sequence),
      stageId,
      error: eventType === "stage:retrying" ? "boom" : null,
    });
    const reader = createInMemoryConsoleReadPort({
      ...fixtures,
      events: [], // the plain event list is independent of the lifecycle log
      stageEvents: [
        stageEvent(3, "stage:retrying"),
        stageEvent(2, "stage:started"),
        stageEvent(1, "stage:started", "other-run"),
      ],
    });
    const detail = await reader.getRunDetail("run-1");
    expect(detail?.stageEvents?.events.map((e) => e.sequence)).toEqual([2, 3]);
    expect(detail?.stageEvents?.events[1]).toMatchObject({
      eventType: "stage:retrying",
      stageId: "first",
      error: "boom",
      errorTruncated: false,
    });
    // Sequence 1 is missing for run-1: its first rows were purged.
    expect(detail?.stageEvents).toMatchObject({
      after: 0,
      lastSequence: 3,
      complete: false,
      more: false,
    });
    // After them the range is unbroken.
    expect(
      (await reader.getRunDetail("run-1", { stageEventsAfter: 1 }))
        ?.stageEvents,
    ).toMatchObject({ after: 1, lastSequence: 3, complete: true });
    // Nothing newer: an empty, unbroken range at the same sequence.
    expect(
      (await reader.getRunDetail("run-1", { stageEventsAfter: 3 }))
        ?.stageEvents,
    ).toEqual({
      events: [],
      after: 3,
      lastSequence: 3,
      complete: true,
      more: false,
    });

    const whole = createInMemoryConsoleReadPort({
      ...fixtures,
      events: [fixtures.events![1]!], // sequence 1 is a non-stage event
      stageEvents: [
        stageEvent(2, "stage:started"),
        stageEvent(3, "workflow:cancelled", "run-1", null),
      ],
    });
    const wholeDetail = await whole.getRunDetail("run-1");
    expect(wholeDetail?.stageEvents?.complete).toBe(true);
    expect(wholeDetail?.stageEvents?.events[1]).toMatchObject({
      eventType: "workflow:cancelled",
      stageId: null,
    });
  });

  it("applies the SQL reader's chunk limit and error cap to the attempt history's events", async () => {
    const stageEvent = (sequence: number, error: string | null = null) => ({
      workflowRunId: "run-1",
      sequence,
      eventType: "stage:started" as const,
      occurredAt: at(0),
      stageId: "first",
      error,
    });
    const many = createInMemoryConsoleReadPort({
      ...fixtures,
      events: [],
      stageEvents: Array.from({ length: STAGE_EVENT_LIMIT + 1 }, (_, i) =>
        stageEvent(i + 1),
      ),
    });
    // The first read stops at the limit and says more remain; the next read
    // starts after its last event and finishes the history, each unbroken.
    const cut = (await many.getRunDetail("run-1"))!.stageEvents!;
    expect(cut.events).toHaveLength(STAGE_EVENT_LIMIT);
    expect(cut).toMatchObject({
      lastSequence: STAGE_EVENT_LIMIT,
      complete: true,
      more: true,
    });
    const rest = (await many.getRunDetail("run-1", {
      stageEventsAfter: cut.lastSequence,
    }))!.stageEvents!;
    expect(rest.events.map((e) => e.sequence)).toEqual([STAGE_EVENT_LIMIT + 1]);
    expect(rest).toMatchObject({
      lastSequence: STAGE_EVENT_LIMIT + 1,
      complete: true,
      more: false,
    });

    const exact = createInMemoryConsoleReadPort({
      ...fixtures,
      events: [],
      stageEvents: Array.from({ length: STAGE_EVENT_LIMIT }, (_, i) =>
        stageEvent(i + 1),
      ),
    });
    expect((await exact.getRunDetail("run-1"))!.stageEvents!).toMatchObject({
      complete: true,
      more: false,
    });

    const long = createInMemoryConsoleReadPort({
      ...fixtures,
      events: [],
      stageEvents: [stageEvent(1, "x".repeat(STAGE_EVENT_ERROR_LIMIT + 1))],
    });
    const [event] = (await long.getRunDetail("run-1"))!.stageEvents!.events;
    expect(event?.error).toHaveLength(STAGE_EVENT_ERROR_LIMIT);
    expect(event?.errorTruncated).toBe(true);
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
