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
    });
    const all = [
      event(1, "workflow:created", null),
      event(2, "workflow:started", null),
      event(3, "stage:started", "fetch"),
      event(5, "stage:retrying", "fetch", `upstream 503: can't "connect"`),
      event(6, "stage:started", "fetch"),
      event(7, "stage:completed", "fetch"),
      event(8, "workflow:cancelled", null),
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
    // A later read with nothing newer is an empty range past what is held.
    expect(
      (await port.getRunDetail("run-retried", { stageEventsAfter: 99 }))
        ?.stageEvents,
    ).toMatchObject({ events: [], lastSequence: 99, complete: true });

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

    // The cancel and the stage's start removed, the run's first rows kept.
    await db.outboxEvent.deleteMany({
      where: { workflowRunId: runId, sequence: { gte: 3 } },
    });
    expect((await page()).history).toMatchObject({
      available: false,
      reason: "no-stage-events",
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
