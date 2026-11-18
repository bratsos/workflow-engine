import { spawn } from "node:child_process";
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
import { STAGE_EVENT_WINDOW } from "../read-port";
import {
  buildStageAttemptHistory,
  type HeldStageEvents,
  mergeStageEvents,
} from "../stage-attempts";
import { type RecordedStatement, recordingClient } from "./recording-client";
import { readStoredRows, runStoreOracle, storeWorld } from "./store-oracle";

const major = process.env.PRISMA_MAJOR ?? "7";
const isPrisma8 = major === "8";
const enginePersistence = "@bratsos/workflow-engine/persistence";
// Variables, so `tsc` does not pull the engine's source into this typecheck.
const kernelSpecifier = "@bratsos/workflow-engine/kernel";
const engineSpecifier = "@bratsos/workflow-engine";
const fromPrisma8 = isPrisma8
  ? (await import(enginePersistence)).fromPrisma8
  : undefined;
const fixture = createRequire(import.meta.url)(
  "../../../prisma-fixtures/index.cjs",
);

// The tests that write or read the file beside Prisma use `node:sqlite`,
// which Node has from 22.13; the package supports Node 22.11 and later, and
// its code does not use it. Below 22.13 those tests are skipped.
const [nodeMajor, nodeMinor] = process.versions.node.split(".").map(Number);
const hasNodeSqlite = nodeMajor! > 22 || (nodeMajor === 22 && nodeMinor! >= 13);
if (!hasNodeSqlite)
  console.warn(
    `Node ${process.versions.node} has no node:sqlite (22.13+): the SQLite plan and one-moment tests are skipped`,
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
    // `prisma generate` and `db push` run here, in child processes.
  }, 60_000);

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
        // Created before the cost and filter windows the other tests read.
        mkRun("run-retried", at(-9_000), "COMPLETED", "wf-d", 0, 0),
        mkRun("run-purged", at(-9_001), "COMPLETED", "wf-d", 0, 0),
        mkRun("run-gap", at(-9_002), "COMPLETED", "wf-d", 0, 0),
        mkRun("run-long-error", at(-9_003), "FAILED", "wf-d", 0, 0),
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
        // A stage that retried once, with the progress and run events a real
        // run interleaves, and an output that must never leave the table.
        // Every payload carries fields the console must never read.
        ...[
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
        ].map(([type, payload], index) =>
          mkEvent(
            `retried-${index + 1}`,
            "run-retried",
            index + 1,
            type as string,
            at(430 + index),
            at(440),
            null,
            { type, ...(payload as object) },
          ),
        ),
        // Error texts past the cap, one of 4-byte characters, one exactly at it.
        ...[
          ["stage:started", { stageId: "fetch" }, 1],
          ["stage:retrying", { stageId: "fetch", error: "y".repeat(2000) }, 2],
          [
            "stage:failed",
            { stageId: "fetch", error: "\u{1F600}".repeat(2500) },
            3,
          ],
        ].map(([type, payload, sequence]) =>
          mkEvent(
            `long-${sequence}`,
            "run-long-error",
            sequence as number,
            type as string,
            at(470 + (sequence as number)),
            at(480),
            null,
            { type, ...(payload as object) },
          ),
        ),
        // Retention removed the oldest rows of one run and a middle row of another.
        ...[3, 4].map((sequence) =>
          mkEvent(
            `purged-${sequence}`,
            "run-purged",
            sequence,
            "stage:started",
            at(450),
            at(451),
            null,
            {
              stageId: "fetch",
            },
          ),
        ),
        ...[1, 2, 4].map((sequence) =>
          mkEvent(
            `gap-${sequence}`,
            "run-gap",
            sequence,
            "stage:started",
            at(460),
            at(461),
            null,
            {
              stageId: "fetch",
            },
          ),
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

  it("reads the attempt history's events of a run past a sequence, with only their stage and error, and reports a purged or broken range as incomplete", async () => {
    const port = reader();
    const retried = (await port.getRunDetail("run-retried"))!;
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
    expect(retried.stageEvents).toEqual({
      events: all,
      after: 0,
      lastSequence: 9,
      complete: true,
      more: false,
    });
    // The plain event list still carries every row, payload-free.
    expect(retried.events).toHaveLength(9);
    expect(JSON.stringify(retried)).not.toContain("do-not-read");

    // A poll reads the rows after the page's last sequence, and nothing it already holds.
    expect(
      (await port.getRunDetail("run-retried", { stageEventsAfter: 5 }))
        ?.stageEvents,
    ).toEqual({
      events: all.slice(4),
      after: 5,
      lastSequence: 9,
      complete: true,
      more: false,
    });
    expect(
      (await port.getRunDetail("run-retried", { stageEventsAfter: 9 }))
        ?.stageEvents,
    ).toEqual({
      events: [],
      after: 9,
      lastSequence: 9,
      complete: true,
      more: false,
    });

    // Rows 1-2 are purged: the range from 0 is broken, the range after them is not.
    expect((await port.getRunDetail("run-purged"))?.stageEvents).toMatchObject({
      complete: false,
    });
    expect(
      (await port.getRunDetail("run-purged", { stageEventsAfter: 2 }))
        ?.stageEvents,
    ).toMatchObject({ lastSequence: 4, complete: true });
    expect((await port.getRunDetail("run-gap"))?.stageEvents).toMatchObject({
      complete: false,
    });
    expect(
      (await port.getRunDetail("run-gap", { stageEventsAfter: 2 }))
        ?.stageEvents,
    ).toMatchObject({ lastSequence: 4, complete: false });
    // A first read of a run with no retained row is not complete: a run has
    // an outbox row from its creation, so none means they were removed.
    expect((await port.getRunDetail("run-pending"))?.stageEvents).toEqual({
      events: [],
      after: 0,
      lastSequence: 0,
      complete: false,
      more: false,
    });
    // A read past the run's highest row says where the run's rows end, so
    // the page sees that rows past what it holds were removed.
    expect(
      (await port.getRunDetail("run-retried", { stageEventsAfter: 99 }))
        ?.stageEvents,
    ).toEqual({
      events: [],
      after: 99,
      lastSequence: 9,
      complete: false,
      more: false,
    });
    // The next part of a long history reads the run and its events only.
    const part = (await port.getRunDetail("run-retried", {
      stageEventsAfter: 5,
      stageEventsOnly: true,
    }))!;
    expect(part.stageEvents).toEqual(
      (await port.getRunDetail("run-retried", { stageEventsAfter: 5 }))!
        .stageEvents,
    );
    expect(part.run.id).toBe("run-retried");
    expect([
      part.stages,
      part.steps,
      part.annotations,
      part.logs,
      part.events,
    ]).toEqual([[], [], [], [], []]);

    const response = await createWorkflowConsole({
      reader: port,
      authorize: () => true,
    })(
      new Request(
        "https://console.example/console/api/runs/run-retried?stageEventsAfter=5",
      ),
    );
    const body = (await response.json()) as {
      stageEvents: { after: number; events: Array<{ occurredAt: string }> };
    };
    expect(body.stageEvents.after).toBe(5);
    expect(body.stageEvents.events[0]?.occurredAt).toBe(at(435).toISOString());
    const bad = await createWorkflowConsole({
      reader: port,
      authorize: () => true,
    })(
      new Request(
        "https://console.example/console/api/runs/run-retried?stageEventsAfter=-1",
      ),
    );
    expect(bad.status).toBe(400);
  });

  it("reads a run with more lifecycle events than the limit in chunks, each unbroken, until it has caught up", async () => {
    await prisma.workflowRun.createMany({
      data: [mkRun("run-many", at(-9_004), "RUNNING", "wf-d", 0, 0)],
    });
    await prisma.outboxEvent.createMany({
      data: Array.from({ length: 2001 }, (_, i) =>
        mkEvent(
          `many-${i + 1}`,
          "run-many",
          i + 1,
          "stage:started",
          at(490),
          null,
          null,
          { stageId: `s${i + 1}` },
        ),
      ),
    });
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

  it("reads at most a window of a run's sequences per read, however few of them are lifecycle events", {
    timeout: 30_000,
  }, async () => {
    const span = STAGE_EVENT_WINDOW + 500;
    await prisma.workflowRun.createMany({
      data: [mkRun("run-window", at(-9_005), "RUNNING", "wf-d", 0, 0)],
    });
    for (let start = 1; start <= span; start += 1000) {
      await prisma.outboxEvent.createMany({
        data: Array.from(
          { length: Math.min(1000, span - start + 1) },
          (_, i) => {
            const sequence = start + i;
            const lifecycle = sequence === 1 || sequence === span;
            return mkEvent(
              `window-${sequence}`,
              "run-window",
              sequence,
              lifecycle ? "stage:started" : "stage:progress",
              at(491),
              null,
              null,
              { stageId: "fetch" },
            );
          },
        ),
      });
    }
    const calls: RecordedStatement[] = [];
    const port = createPrismaConsoleReadPort(recordingClient(prisma, calls), {
      databaseType: "sqlite",
      now: () => at(100),
    });
    const first = (await port.getRunDetail("run-window"))!.stageEvents!;
    expect(first).toMatchObject({
      lastSequence: STAGE_EVENT_WINDOW,
      complete: true,
      more: true,
    });
    expect(first.events.map((e) => e.sequence)).toEqual([1]);
    // Both range statements of the read are closed at the window.
    const ranged = calls.filter(
      (c) => c.sql.includes("outbox_events") && c.params.length === 3,
    );
    expect(ranged.length).toBe(2);
    for (const call of ranged) expect(call.params[2]).toBe(STAGE_EVENT_WINDOW);
    const rest = (await port.getRunDetail("run-window", {
      stageEventsAfter: first.lastSequence,
    }))!.stageEvents!;
    expect(rest).toMatchObject({
      lastSequence: span,
      complete: true,
      more: false,
    });
    expect(rest.events.map((e) => e.sequence)).toEqual([span]);
  });

  it("never says a stage that ran has not started when the run's outbox rows are gone (real kernel)", {
    timeout: 30_000,
  }, async () => {
    // The gate's reproduction: a stage running when its run is cancelled,
    // then the run's outbox rows removed as a retention job would.
    const { createKernel } = await import(kernelSpecifier);
    const persistenceModule = await import(enginePersistence);
    const { defineStage, WorkflowBuilder } = await import(engineSpecifier);
    const { z } = await import("zod");
    const io = z.object({ v: z.string() });
    let kernel: any;
    let runId = "";
    let executions = 0;
    const slow = defineStage({
      id: "slow",
      name: "Slow",
      schemas: { input: io, output: io, config: z.object({}) },
      async execute(ctx: any) {
        // The first execution is cancelled while it runs; the reruns complete.
        if (++executions === 1)
          await kernel.dispatch({ type: "run.cancel", workflowRunId: runId });
        return { output: ctx.input };
      },
    });
    const workflow = new WorkflowBuilder("purged", "purged", "d", io, io)
      .pipe(slow)
      .build();
    // Its own file: a claim takes every pending run it finds.
    const file = join(directory, "kernel.db");
    const db: ConsolePrismaClient & Record<string, any> = isPrisma8
      ? (() => {
          const raw = fixture.createSqliteDb(file);
          return Object.assign(fromPrisma8!(raw), {
            $disconnect: () => raw.close(),
          });
        })()
      : fixture.createSqliteClient(file);
    const options = { databaseType: "sqlite" as const };
    kernel = createKernel({
      persistence: persistenceModule.createPrismaWorkflowPersistence(
        db,
        options,
      ),
      jobTransport: persistenceModule.createPrismaJobQueue(db, {
        ...options,
        workerId: "w",
      }),
      stepLedger: persistenceModule.createPrismaStepLedger(db, options),
      blobStore: persistenceModule.createPrismaBlobStore(db),
      clock: { now: () => new Date() },
      eventSink: { emit: async () => {} },
      registry: { getWorkflow: () => workflow },
    });
    runId = (
      await kernel.dispatch({
        type: "run.create",
        idempotencyKey: "purged-run",
        workflowId: "purged",
        input: { v: "x" },
      })
    ).workflowRunId;
    await kernel.dispatch({ type: "run.claimPending", workerId: "w" });
    await kernel.dispatch({
      type: "job.execute",
      workflowRunId: runId,
      workflowId: "purged",
      stageId: "slow",
      config: {},
      attempt: 1,
      maxAttempts: 3,
    });

    const handler = createWorkflowConsole({
      reader: createPrismaConsoleReadPort(db, { databaseType: "sqlite" }),
      authorize: () => true,
    });
    const page = async () => {
      let held: HeldStageEvents | null = null;
      let body: any;
      do {
        const query = held ? `?stageEventsAfter=${held.lastSequence}` : "";
        body = await (
          await handler(
            new Request(
              `https://console.example/console/api/runs/${runId}${query}`,
            ),
          )
        ).json();
        held = mergeStageEvents(held, body.stageEvents);
      } while (held?.more);
      const histories = buildStageAttemptHistory({
        redriveCount: body.run.redriveCount,
        runStatus: body.run.status,
        stages: body.stages,
        steps: body.steps,
        stageEvents: {
          events: held!.events,
          coverage: held!.coverage,
          caughtUp: !held!.more,
        },
      });
      return {
        run: body.run,
        stage: body.stages[0],
        history: [...histories.values()][0]!,
      };
    };

    const kept = await page();
    expect(kept.stage).toMatchObject({ status: "CANCELLED", attempt: 0 });
    expect(kept.stage.startedAt).not.toBeNull();
    expect(
      kept.history.available &&
        kept.history.attempts.map((a) => [a.trigger, a.outcome]),
    ).toEqual([["initial", "cancelled"]]);

    // The cancel and the stage's start removed, the run's first rows kept:
    // the run's events end running, and its row says CANCELLED.
    await db.outboxEvent.deleteMany({
      where: { workflowRunId: runId, sequence: { gte: 3 } },
    });
    expect((await page()).history).toMatchObject({
      available: false,
      reason: "run-inconsistent",
      runMismatch: "status",
    });

    // Every row removed: before this change, "This stage has not started."
    await db.outboxEvent.deleteMany({ where: { workflowRunId: runId } });
    expect((await page()).history).toMatchObject({
      available: false,
      reason: "no-retained-events",
    });

    // A redrive after every row was removed: the store numbers the run's rows
    // from 1 again, so its `workflow:started` is sequence 1 and the range is
    // unbroken. Before this check the rerun read as the stage's first run.
    const rerun = async () => {
      await kernel.dispatch({
        type: "run.redrive",
        workflowRunId: runId,
        from: { kind: "start" },
      });
      const stage = (await db.workflowStage.findFirst({
        where: { workflowRunId: runId },
      }))!;
      await kernel.dispatch({
        type: "job.execute",
        workflowRunId: runId,
        workflowId: "purged",
        stageId: "slow",
        config: {},
        attempt: stage.attempt,
        maxAttempts: 3,
      });
      await kernel.dispatch({ type: "run.transition", workflowRunId: runId });
    };
    await rerun();
    const first = await db.outboxEvent.findFirst({
      where: { workflowRunId: runId },
      orderBy: { sequence: "asc" },
    });
    expect(first).toMatchObject({ sequence: 1, eventType: "workflow:started" });
    const afterOne = await page();
    expect(afterOne.stage).toMatchObject({ status: "COMPLETED" });
    expect(afterOne.run).toMatchObject({
      status: "COMPLETED",
      redriveCount: 1,
    });
    expect(afterOne.history).toMatchObject({
      available: false,
      reason: "events-incomplete",
    });

    // Removed again and redriven again: still incomplete, and the run row
    // counts two redrives where the rows record one.
    await db.outboxEvent.deleteMany({ where: { workflowRunId: runId } });
    await rerun();
    const afterTwo = await page();
    expect(afterTwo.run).toMatchObject({
      status: "COMPLETED",
      redriveCount: 2,
    });
    expect(afterTwo.history).toMatchObject({
      available: false,
      reason: "events-incomplete",
    });
    await db.$disconnect?.();
  });

  it("finds rows removed from the end of a run's outbox after the run wrote again, by the run's own events (real kernel)", {
    timeout: 60_000,
  }, async () => {
    // The store numbers a run's next row one past the highest it still holds,
    // so after rows are removed from the end and the run writes again, the
    // range from `workflow:created` is unbroken. Stage b fails three times,
    // the run is redriven and b completes: four executions.
    const { createKernel, executeJobWithHeartbeat } = await import(
      kernelSpecifier
    );
    const persistenceModule = await import(enginePersistence);
    const { defineStage, WorkflowBuilder } = await import(engineSpecifier);
    const { z } = await import("zod");
    const io = z.object({ v: z.string() });
    const schemas = { input: io, output: io, config: z.object({}) };

    async function world(name: string, sinkFails: (type: string) => boolean) {
      let failing = 3;
      const workflow = new WorkflowBuilder("tail", "tail", "d", io, io)
        .pipe(
          defineStage({
            id: "a",
            name: "A",
            schemas,
            async execute(ctx: any) {
              return { output: ctx.input };
            },
          }),
        )
        .pipe(
          defineStage({
            id: "b",
            name: "B",
            schemas,
            async execute(ctx: any) {
              if (failing-- > 0) throw new Error("crm down");
              return { output: ctx.input };
            },
          }),
        )
        .build();
      const file = join(directory, `${name}.db`);
      const db: ConsolePrismaClient & Record<string, any> = isPrisma8
        ? (() => {
            const raw = fixture.createSqliteDb(file);
            return Object.assign(fromPrisma8!(raw), {
              $disconnect: () => raw.close(),
            });
          })()
        : fixture.createSqliteClient(file);
      const options = { databaseType: "sqlite" as const };
      const jobTransport = persistenceModule.createPrismaJobQueue(db, {
        ...options,
        workerId: "w",
      });
      const kernel: any = createKernel({
        persistence: persistenceModule.createPrismaWorkflowPersistence(
          db,
          options,
        ),
        jobTransport,
        stepLedger: persistenceModule.createPrismaStepLedger(db, options),
        blobStore: persistenceModule.createPrismaBlobStore(db),
        clock: { now: () => new Date() },
        eventSink: {
          async emit(event: any) {
            if (sinkFails(event.type))
              throw new Error(`subscriber cannot handle ${event.type}`);
          },
        },
        registry: { getWorkflow: () => workflow },
      });
      const runId = (
        await kernel.dispatch({
          type: "run.create",
          idempotencyKey: `${name}-run`,
          workflowId: "tail",
          input: { v: "x" },
        })
      ).workflowRunId as string;
      const drain = async () => {
        for (let round = 0; round < 12; round++) {
          await kernel.dispatch({
            type: "run.claimPending",
            workerId: "w",
            maxClaims: 10,
          });
          // Every job is due now: the queue's retry backoff is skipped.
          await db.jobQueue.updateMany({ data: { nextPollAt: null } });
          const job = await jobTransport.dequeue();
          if (!job) break;
          await executeJobWithHeartbeat(kernel, {
            jobTransport,
            job,
            jobHeartbeatIntervalMs: 5_000,
            logPrefix: "[tail]",
          });
        }
      };
      const handler = createWorkflowConsole({
        reader: createPrismaConsoleReadPort(db, { databaseType: "sqlite" }),
        authorize: () => true,
      });
      const page = async () => {
        let held: HeldStageEvents | null = null;
        let body: any;
        do {
          const query = held ? `?stageEventsAfter=${held.lastSequence}` : "";
          body = await (
            await handler(
              new Request(
                `https://console.example/console/api/runs/${runId}${query}`,
              ),
            )
          ).json();
          held = mergeStageEvents(held, body.stageEvents);
        } while (held?.more);
        const histories = buildStageAttemptHistory({
          redriveCount: body.run.redriveCount,
          runStatus: body.run.status,
          stages: body.stages,
          steps: body.steps,
          stageEvents: {
            events: held!.events,
            coverage: held!.coverage,
            caughtUp: !held!.more,
          },
        });
        const b = body.stages.find((s: any) => s.stageId === "b");
        return { run: body.run, held: held!, b, history: histories.get(b.id)! };
      };
      const redrive = async () => {
        await kernel.dispatch({
          type: "run.redrive",
          workflowRunId: runId,
          from: { kind: "lastFailure" },
        });
        await drain();
      };
      return { db, kernel, runId, drain, page, redrive, handler };
    }

    // A: a subscriber that cannot handle `workflow:created` leaves that row
    // as a dead letter, and a retention job removes every published row.
    const dlq = await world("dlq", (type) => type === "workflow:created");
    await dlq.drain();
    for (let pass = 0; pass < 5; pass++)
      await dlq.kernel.dispatch({ type: "outbox.flush", maxEvents: 100 });
    await dlq.db.outboxEvent.deleteMany({
      where: { workflowRunId: dlq.runId, publishedAt: { not: null } },
    });
    await dlq.redrive();
    const a = await dlq.page();
    expect(a.run).toMatchObject({ status: "COMPLETED", redriveCount: 1 });
    expect(a.b).toMatchObject({ status: "COMPLETED" });
    // The numbering shows nothing missing: sequence 1 is the run's creation.
    expect(a.held.coverage).toBe("from-start");
    expect(a.held.events.map((e) => e.eventType)).toEqual([
      "workflow:created",
      "workflow:started",
      "stage:started",
      "stage:completed",
      "workflow:completed",
    ]);
    // Before: "1 attempt, First run". The redrive's start follows the run's
    // creation, so it reads as the claim and records no redrive.
    expect(a.history).toMatchObject({
      available: false,
      reason: "fewer-redrives",
    });
    await dlq.db.$disconnect?.();

    // B: the rows from sequence 7 on removed, then the run is redriven.
    const tail = await world("tail", () => false);
    await tail.drain();
    const open = (await tail.page()).held;
    await tail.db.outboxEvent.deleteMany({
      where: { workflowRunId: tail.runId, sequence: { gte: 7 } },
    });
    // A page open on the run asks for the rows after what it holds: the read
    // ends below that, so the page drops what it holds and starts again.
    const poll: any = await (
      await tail.handler(
        new Request(
          `https://console.example/console/api/runs/${tail.runId}?stageEventsAfter=${open.lastSequence}`,
        ),
      )
    ).json();
    expect(poll.stageEvents).toMatchObject({
      lastSequence: 6,
      complete: false,
    });
    expect(mergeStageEvents(open, poll.stageEvents)).toBeNull();
    await tail.redrive();
    const b = await tail.page();
    expect(b.run).toMatchObject({ status: "COMPLETED", redriveCount: 1 });
    expect(b.held.coverage).toBe("from-start");
    // Before: "initial -> retrying, rerun -> completed". The redrive's start
    // follows no end of the run, which a redrive needs, so it is not counted
    // as one (it reads as the claim after a transition), and the run's row
    // counts a redrive its retained events do not record.
    expect(b.history).toMatchObject({
      available: false,
      reason: "fewer-redrives",
    });
    await tail.db.$disconnect?.();
  });

  describe("the attempt history on the engine's Prisma store (real kernel)", () => {
    let world: Awaited<ReturnType<typeof storeWorld>>;
    let db: ConsolePrismaClient & Record<string, any>;
    beforeAll(async () => {
      // Its own file: a claim takes every pending run it finds.
      const file = join(directory, "store-oracle.db");
      db = isPrisma8
        ? (() => {
            const raw = fixture.createSqliteDb(file);
            return Object.assign(fromPrisma8!(raw), {
              $disconnect: () => raw.close(),
            });
          })()
        : fixture.createSqliteClient(file);
      world = await storeWorld(db, "sqlite");
    }, 60_000);
    afterAll(async () => {
      await db?.$disconnect?.();
    });

    it("states nothing false after any dispatch, nor after rows removed from the end of a run's outbox", {
      timeout: 300_000,
    }, async () => {
      const result = await runStoreOracle(world);
      console.log(
        [
          `store oracle (SQLite, Prisma ${major}): ${result.samples} page reads with nothing removed, ${result.unavailableWithNothingRemoved.length} unavailable; ${result.removals} removals, ${result.outside.length} wrong outside the stated limit, ${result.limit.length} within it`,
          ...result.limit.map((f) => `  ${f}`),
        ].join("\n"),
      );
      expect(result.unavailableWithNothingRemoved).toEqual([]);
      expect(result.outside).toEqual([]);
      expect(result.visible).toEqual([]);
      expect(result.samples).toBeGreaterThan(100);
    });

    it("reads the stored rows of every release since alpha.13", {
      timeout: 120_000,
    }, async () => {
      const { files, lines } = await readStoredRows(world);
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
      const queued = lines.filter((line) => line.scenario === "running-queued");
      expect(queued.length).toBeGreaterThanOrEqual(10);
      expect(new Set(queued.map((line) => line.read))).toEqual(
        new Set(["available "]),
      );
    });
  });

  it.skipIf(!hasNodeSqlite)(
    "reads a run's rows and events at one moment, whatever another process commits between its statements",
    {
      timeout: 60_000,
    },
    async () => {
      // With a statement timeout and without one (no `SET LOCAL` to scope).
      for (const statementTimeoutMs of [15_000, 0]) {
        const k = statementTimeoutMs;
        const runId = `run-moment-${k}`;
        const stageRecord = `stage-moment-${k}`;
        await prisma.workflowRun.createMany({
          data: [mkRun(runId, at(-9_010), "RUNNING", "wf-d", 0, 0)],
        });
        await prisma.workflowStage.createMany({
          data: [
            {
              id: stageRecord,
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
          ],
        });
        const row = (sequence: number, eventType: string) =>
          mkEvent(
            `moment-${k}-${sequence}`,
            runId,
            sequence,
            eventType,
            at(10 + sequence),
            null,
            null,
            { stageId: eventType.startsWith("stage:") ? "only" : undefined },
          );
        await prisma.outboxEvent.createMany({
          data: [
            row(1, "workflow:created"),
            row(2, "workflow:started"),
            row(3, "stage:started"),
          ],
        });
        // Another process, with its own connection to the same file and its
        // own file locks (a thread of this process shares them). The stage
        // completes, and the run with it; the new rows copy the stored form of
        // the existing ones.
        const copy = (sequence: number, type: string, payload: string) =>
          `INSERT INTO outbox_events (id, workflowRunId, sequence, eventType, payload, causationId, occurredAt, createdAt, retryCount)
SELECT 'moment-${k}-${sequence}', workflowRunId, ${sequence}, '${type}', ${payload}, 'cause-moment-${k}-${sequence}', occurredAt, createdAt, 0
FROM outbox_events WHERE id = 'moment-${k}-3'`;
        const statements = [
          "BEGIN IMMEDIATE",
          `UPDATE workflow_stages SET status = 'COMPLETED', completedAt = startedAt WHERE id = '${stageRecord}'`,
          copy(4, "stage:completed", "payload"),
          copy(5, "workflow:completed", "'{}'"),
          `UPDATE workflow_runs SET status = 'COMPLETED' WHERE id = '${runId}'`,
          "COMMIT",
        ];
        const complete = () =>
          new Promise<void>((resolve, reject) => {
            const writer = spawn(
              process.execPath,
              [
                "-e",
                `const { DatabaseSync } = require("node:sqlite");
const { file, statements } = JSON.parse(process.env.CONSOLE_TEST_WRITE);
const db = new DatabaseSync(file);
db.exec("PRAGMA busy_timeout = 20000");
for (const statement of statements) db.exec(statement);
db.close();`,
              ],
              {
                env: {
                  ...process.env,
                  CONSOLE_TEST_WRITE: JSON.stringify({
                    file: join(directory, "console.db"),
                    statements,
                  }),
                },
                stdio: ["ignore", "ignore", "pipe"],
              },
            );
            let stderr = "";
            writer.stderr!.on("data", (chunk) => {
              stderr += chunk;
            });
            writer.once("error", reject);
            writer.once("exit", (code) =>
              code === 0
                ? resolve()
                : reject(new Error(`writer exited ${code}: ${stderr}`)),
            );
          });
        let write: Promise<void> | undefined;
        let readDone = false;
        let committedDuringRead = false;
        const port = createPrismaConsoleReadPort(
          recordingClient(prisma, [], async (call) => {
            if (write || !call.sql.includes('FROM "workflow_stages"')) return;
            // Right after the stage rows are read. A writer cannot commit while
            // a read holds a rollback-journal file; give it the time to (a
            // process takes longer to start than a thread).
            write = complete().then(() => {
              committedDuringRead = !readDone;
            });
            await Promise.race([
              write.catch(() => {}),
              new Promise((r) => setTimeout(r, 1_500)),
            ]);
          }),
          { databaseType: "sqlite", statementTimeoutMs },
        );
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
          }).get(stageRecord)!;
          return history.available
            ? history.attempts.map((a) => `${a.trigger}:${a.outcome}`)
            : `unavailable ${history.reason}`;
        };
        try {
          const during = await port.getRunDetail(runId);
          readDone = true;
          expect(write).toBeDefined();
          await write;
          // The write either waited for the read, or committed during it unseen.
          console.log(
            `SQLite, Prisma ${major}, statement timeout ${k}: the write ${committedDuringRead ? "committed during the read" : "waited for the read to end"}`,
          );
          expect(during?.run.status).toBe("RUNNING");
          expect(during?.stages[0]?.status).toBe("RUNNING");
          expect(during?.stageEvents?.lastSequence).toBe(3);
          expect(page(during)).toEqual(["initial:running"]);
          // The next read sees all of the write.
          expect(page(await reader().getRunDetail(runId))).toEqual([
            "initial:completed",
          ]);
        } finally {
          await write?.catch(() => {});
        }
      }
    },
  );

  it.skipIf(!hasNodeSqlite)(
    "plans every statement on a run's outbox rows by the run's index, in each state of the table's statistics",
    {
      timeout: 120_000,
    },
    async () => {
      // Its own file: ANALYZE here must not change the plans of the others.
      const file = join(directory, "plan.db");
      const db: ConsolePrismaClient & Record<string, any> = isPrisma8
        ? (() => {
            const raw = fixture.createSqliteDb(file);
            return Object.assign(fromPrisma8!(raw), {
              $disconnect: () => raw.close(),
            });
          })()
        : fixture.createSqliteClient(file);
      const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite");
      try {
        const runs = [
          "run-plan-0",
          "run-plan-1000",
          "run-plan-30000",
          "run-plan-few",
          "run-plan-others",
        ];
        await db.workflowRun.createMany({
          data: runs.map((id, i) =>
            mkRun(id, at(-9_100 - i), "RUNNING", "wf-d", 0, 0),
          ),
        });
        // One row in the stored form of this Prisma major, then copies of it.
        await db.outboxEvent.createMany({
          data: [
            mkEvent(
              "plan-model",
              "run-plan-model",
              1,
              "stage:started",
              at(10),
              null,
              null,
              { stageId: "fetch" },
            ),
          ],
        });
        const fill = (sql: string) => {
          const raw = new DatabaseSync(file);
          try {
            raw.exec(sql);
          } finally {
            raw.close();
          }
        };
        const copies = (runId: string, rows: number) =>
          `INSERT INTO outbox_events (id, workflowRunId, sequence, eventType, payload, causationId, occurredAt, createdAt, retryCount)
WITH RECURSIVE g(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM g WHERE n < ${rows})
SELECT '${runId}-' || n, '${runId}', n, CASE WHEN n % 500 = 1 THEN 'stage:started' ELSE 'stage:progress' END,
       payload, 'c', occurredAt, createdAt, 0
FROM g, plan_model`;
        const load = () => {
          fill(copies("run-plan-1000", 1_000));
          fill(copies("run-plan-30000", 30_000));
          fill(copies("run-plan-others", 50_000));
        };
        // The model row moves to a table of its own, so the outbox can be empty.
        fill(
          "CREATE TABLE plan_model AS SELECT * FROM outbox_events WHERE id = 'plan-model'; DELETE FROM outbox_events",
        );
        const clear = () => fill("DELETE FROM outbox_events");
        // What the planner holds for the table, read on a new connection.
        const statistics = () => {
          const raw = new DatabaseSync(file);
          try {
            const table = raw
              .prepare(
                "SELECT count(*) AS n FROM sqlite_schema WHERE name = 'sqlite_stat1'",
              )
              .get().n;
            return table === 0
              ? "no sqlite_stat1"
              : (raw
                  .prepare(
                    "SELECT group_concat(coalesce(idx, '(table)') || '=' || coalesce(stat, 'null'), '; ') AS s FROM sqlite_stat1 WHERE tbl = 'outbox_events'",
                  )
                  // ANALYZE of an empty table stores no row for it.
                  .get().s ?? "no row");
          } finally {
            raw.close();
          }
        };
        const states: Array<[string, () => void, (s: string) => boolean]> = [
          ["never analysed", load, (s) => s === "no sqlite_stat1"],
          [
            "analysed empty",
            () => {
              clear();
              fill("ANALYZE outbox_events");
              load();
            },
            (s) => s === "no row",
          ],
          [
            "analysed at size",
            () => fill("ANALYZE outbox_events"),
            (s) => /=8\d{4}/.test(s),
          ],
          // Analysed while one run held its few rows, then grown.
          [
            "stale",
            () => {
              clear();
              fill(copies("run-plan-few", 7));
              fill("ANALYZE outbox_events");
              load();
            },
            // 7 rows, all of one run.
            (s) => /=7 7 1(;|$)/.test(s),
          ],
        ];
        const seen: string[] = [];
        for (const [state, setup, holds] of states) {
          setup();
          const stats = statistics();
          expect(holds(stats), `${state}: ${stats}`).toBe(true);
          const calls: RecordedStatement[] = [];
          const port = createPrismaConsoleReadPort(recordingClient(db, calls), {
            databaseType: "sqlite",
            now: () => at(100),
          });
          await port.getRunDetail("run-plan-30000");
          await port.getRunDetail("run-plan-30000", {
            stageEventsAfter: 29_990,
          });
          await port.getRunDetail("run-plan-30000", {
            stageEventsAfter: 30_000,
          });
          await port.getRunDetail("run-plan-0");
          await port.listRunEvents("run-plan-30000", 0);
          await port.listRunEvents("run-plan-30000", 29_990);
          const outbox = calls.filter(
            (c) =>
              c.sql.includes('"outbox_events"') &&
              c.sql.includes('"workflowRunId" ='),
          );
          expect(outbox.length).toBeGreaterThanOrEqual(14);
          // The planner of a new connection, which loads the statistics now in the file.
          const raw = new DatabaseSync(file);
          try {
            for (const { sql, params } of outbox) {
              const plan = raw
                // Numbered `?NNN`, which binds by position like the `$n` and `?` the readers write.
                .prepare(`EXPLAIN QUERY PLAN ${sql.replace(/\$(\d+)/g, "?$1")}`)
                .all(...(params as never[]))
                .map((row: { detail: string }) => row.detail)
                .join(" | ");
              seen.push(`${state} (sqlite_stat1: ${stats}): ${plan}`);
              expect(plan, `${state}: ${sql}`).toMatch(
                // The unique (workflowRunId, sequence) index: named by Prisma 6 and 7, an
                // inline constraint's automatic index on Prisma 8.
                /SEARCH outbox_events USING (COVERING )?INDEX (outbox_events_workflowRunId_sequence_key|sqlite_autoindex_outbox_events_\d) \(workflowRunId=\?/,
              );
              expect(plan, `${state}: ${sql}`).not.toMatch(
                /SCAN outbox_events|TEMP B-TREE/,
              );
            }
          } finally {
            raw.close();
          }
        }
        console.log([...new Set(seen)].join("\n"));
      } finally {
        await db.$disconnect?.();
      }
    },
  );

  it.skipIf(!hasNodeSqlite)(
    "plans a run's stages and annotations by the run's indexes, and its steps and logs as the docs state, in each state of the tables' statistics",
    {
      timeout: 120_000,
    },
    async () => {
      const file = join(directory, "plan-tables.db");
      const db: ConsolePrismaClient & Record<string, any> = isPrisma8
        ? (() => {
            const raw = fixture.createSqliteDb(file);
            return Object.assign(fromPrisma8!(raw), {
              $disconnect: () => raw.close(),
            });
          })()
        : fixture.createSqliteClient(file);
      const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite");
      const tables = [
        "workflow_stages",
        "workflow_steps",
        "workflow_annotations",
        "workflow_logs",
      ];
      try {
        await db.workflowRun.createMany({
          data: [
            "run-plan-model",
            "run-plan-1000",
            "run-plan-30000",
            "run-plan-few",
            "run-plan-others",
          ].map((id, i) => mkRun(id, at(-9_200 - i), "RUNNING", "wf-d", 0, 0)),
        });
        // One row of each table in the stored form of this Prisma major.
        await db.workflowStage.createMany({
          data: [
            {
              id: "model-stage",
              workflowRunId: "run-plan-model",
              stageId: "s",
              stageName: "S",
              stageNumber: 1,
              executionGroup: 1,
              status: "COMPLETED",
              createdAt: at(0),
              updatedAt: at(0),
            },
          ],
        });
        await db.workflowStep.createMany({
          data: [
            {
              id: "model-step",
              stageRecordId: "model-stage",
              stepId: "t",
              seq: 1,
              kind: "run",
              status: "completed",
              attempt: 1,
              createdAt: at(0),
              updatedAt: at(0),
            },
          ],
        });
        await db.workflowAnnotation.createMany({
          data: [
            {
              id: "model-annotation",
              workflowRunId: "run-plan-model",
              attempt: 0,
              scope: "run",
              key: "k",
              value: {},
              createdAt: at(0),
            },
          ],
        });
        await db.workflowLog.createMany({
          data: [
            {
              id: "model-log",
              workflowRunId: "run-plan-model",
              level: "INFO",
              message: "m",
              createdAt: at(0),
            },
          ],
        });
        const fill = (sql: string) => {
          const raw = new DatabaseSync(file);
          try {
            raw.exec(sql);
          } finally {
            raw.close();
          }
        };
        // The model rows move to tables of their own, so the tables can be empty.
        fill(
          tables
            .map(
              (t) =>
                `CREATE TABLE plan_model_${t} AS SELECT * FROM ${t}; DELETE FROM ${t};`,
            )
            .join("\n"),
        );
        // A time `seconds` after a stored one, in the stored form.
        const later = (column: string, seconds: string) =>
          `CASE typeof(${column}) WHEN 'integer' THEN ${column} + (${seconds}) * 1000
 ELSE strftime('%Y-%m-%dT%H:%M:%f', ${column}, '+' || (${seconds}) || ' seconds') || substr(${column}, 24) END`;
        const series = (rows: number) =>
          `WITH RECURSIVE g(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM g WHERE n < ${rows})`;
        // A run of 20 stages and `rows` steps, annotations (three to a time) and logs.
        const copies = (runId: string, rows: number) => `
INSERT INTO workflow_stages (id, createdAt, updatedAt, version, workflowRunId, stageId, stageName, stageNumber, executionGroup, attempt, status)
${series(20)} SELECT '${runId}-s' || n, createdAt, updatedAt, version, '${runId}', 's' || n, 'S' || n, n, n, attempt, status FROM g, plan_model_workflow_stages;
INSERT INTO workflow_steps (id, stageRecordId, stepId, seq, kind, status, attempt, createdAt, updatedAt)
${series(rows)} SELECT '${runId}-t' || n, '${runId}-s' || (1 + n % 20), 't' || n, n, kind, status, attempt, createdAt, updatedAt FROM g, plan_model_workflow_steps;
INSERT INTO workflow_annotations (id, createdAt, workflowRunId, attempt, scope, key, value)
${series(rows)} SELECT '${runId}-a' || n, ${later("createdAt", "n / 3")}, '${runId}', attempt, scope, 'k' || n, value FROM g, plan_model_workflow_annotations;
INSERT INTO workflow_logs (id, createdAt, workflowRunId, level, message)
${series(rows)} SELECT '${runId}-l' || n, ${later("createdAt", "n")}, '${runId}', level, message FROM g, plan_model_workflow_logs;`;
        const load = () => {
          fill(copies("run-plan-1000", 1_000));
          fill(copies("run-plan-30000", 30_000));
          fill(copies("run-plan-others", 50_000));
        };
        const clear = () =>
          fill(tables.map((t) => `DELETE FROM ${t};`).join("\n"));
        const analyze = () =>
          fill(tables.map((t) => `ANALYZE ${t};`).join("\n"));
        const statistics = () => {
          const raw = new DatabaseSync(file);
          try {
            if (
              raw
                .prepare(
                  "SELECT count(*) AS n FROM sqlite_schema WHERE name = 'sqlite_stat1'",
                )
                .get().n === 0
            )
              return "no sqlite_stat1";
            return (
              raw
                .prepare(
                  "SELECT group_concat(idx || '=' || stat, '; ') AS s FROM sqlite_stat1 WHERE tbl = 'workflow_annotations'",
                )
                .get().s ?? "no row"
            );
          } finally {
            raw.close();
          }
        };
        const states: Array<[string, () => void, (s: string) => boolean]> = [
          ["never analysed", load, (s) => s === "no sqlite_stat1"],
          [
            "analysed empty",
            () => {
              clear();
              analyze();
              load();
            },
            (s) => s === "no row",
          ],
          ["analysed at size", analyze, (s) => /=8\d{4}/.test(s)],
          [
            "stale",
            () => {
              clear();
              fill(copies("run-plan-few", 7));
              analyze();
              load();
            },
            (s) => /=7 7(;| |$)/.test(s),
          ],
        ];
        const seen: string[] = [];
        for (const [state, setup, holds] of states) {
          setup();
          const stats = statistics();
          expect(holds(stats), `${state}: ${stats}`).toBe(true);
          const calls: RecordedStatement[] = [];
          const detail = await createPrismaConsoleReadPort(
            recordingClient(db, calls),
            { databaseType: "sqlite", now: () => at(100) },
          ).getRunDetail("run-plan-30000");
          // The page of 200 ends inside a group of three: the group is read too.
          expect(detail?.annotations).toHaveLength(200);
          expect(detail?.truncated.annotations).toBe(true);
          const raw = new DatabaseSync(file);
          const plans: Record<string, string[]> = {};
          try {
            for (const { sql, params } of calls) {
              const table = tables.find((t) => sql.includes(`FROM "${t}"`));
              if (!table) continue;
              const plan = raw
                .prepare(`EXPLAIN QUERY PLAN ${sql.replace(/\$(\d+)/g, "?$1")}`)
                // A time binds as text here; the plan is that of its stored form.
                .all(
                  ...(params.map((p) =>
                    p instanceof Date ? p.toISOString() : p,
                  ) as never[]),
                )
                .map((row: { detail: string }) => row.detail)
                .join(" | ");
              plans[table] = [...(plans[table] ?? []), plan];
              seen.push(`${state}: ${table}: ${plan}`);
            }
          } finally {
            raw.close();
          }
          expect(plans.workflow_annotations, state).toHaveLength(2);
          for (const plan of plans.workflow_annotations!) {
            expect(plan, state).toMatch(
              // Prisma 8 adds a hash to an index's name on SQLite.
              /SEARCH workflow_annotations USING INDEX workflow_annotations_workflowRunId_createdAt_idx(_[0-9a-f]{8})? \(workflowRunId=\?/,
            );
            expect(plan, state).not.toMatch(
              /TEMP B-TREE|SCAN workflow_annotations/,
            );
          }
          expect(plans.workflow_stages!.join(" | "), state).toMatch(
            /SEARCH workflow_stages USING INDEX (workflow_stages_workflowRunId_\w+|sqlite_autoindex_workflow_stages_\d) \(workflowRunId=\?/,
          );
          // Logs and steps: no index serves their order, so a page sorts
          // every log or step of the run, found by the run's index or, with
          // statistics taken when the table held few rows, by a scan of the
          // whole table (the cost the docs state).
          expect(plans.workflow_logs!.join(" | "), state).toMatch(
            state === "stale"
              ? /SCAN workflow_logs|SEARCH workflow_logs USING INDEX workflow_logs_workflowRunId_idx/
              : /SEARCH workflow_logs USING INDEX workflow_logs_workflowRunId_idx(_[0-9a-f]{8})? \(workflowRunId=\?\)/,
          );
        }
        console.log([...new Set(seen)].join("\n"));
      } finally {
        await db.$disconnect?.();
      }
    },
  );

  it("pages annotations newest first, ordering those that share a time by id across the page's end", async () => {
    await prisma.workflowRun.createMany({
      data: [mkRun("run-annotation-ties", at(-9_030), "RUNNING", "wf-d", 0, 0)],
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
    const { events } = (await reader().getRunDetail("run-long-error"))!
      .stageEvents!;
    const [, atLimit, past] = events;
    expect(atLimit).toMatchObject({
      eventType: "stage:retrying",
      errorTruncated: false,
    });
    expect(atLimit?.error).toHaveLength(2000);
    expect(past).toMatchObject({
      eventType: "stage:failed",
      errorTruncated: true,
    });
    // Cut on whole characters, not in the middle of a surrogate pair.
    expect([...past!.error!]).toHaveLength(2000);
    expect(past!.error).toBe("\u{1F600}".repeat(2000));

    // The database cut it: no row left it longer than the limit plus the one
    // character that tells the read it was cut.
    const calls: RecordedStatement[] = [];
    await createPrismaConsoleReadPort(recordingClient(prisma, calls), {
      databaseType: "sqlite",
    }).getRunDetail("run-long-error");
    const lifecycle = calls.find((call) => call.sql.includes('"eventType" IN'));
    const errors = (lifecycle!.rows as Array<{ error: string | null }>)
      .map((row) => row.error)
      .filter((error): error is string => error !== null);
    expect(errors).toHaveLength(2);
    expect(Math.max(...errors.map((error) => [...error].length))).toBe(2001);
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
  payload: object = { seeded: true },
) {
  return {
    id,
    workflowRunId,
    sequence,
    eventType,
    payload,
    causationId: `cause-${id}`,
    occurredAt,
    createdAt: occurredAt,
    publishedAt,
    dlqAt,
    retryCount: dlqAt ? 5 : 0,
  };
}
