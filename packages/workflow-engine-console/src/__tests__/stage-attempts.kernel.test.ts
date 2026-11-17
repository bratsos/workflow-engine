/**
 * The attempt grouping against the real kernel.
 *
 * `run.cancel`, `run.redrive`, `run.reapStuck` and lease reaping end or
 * restart a stage's execution without a `stage:*` event of their own, so a
 * grouping that infers boundaries from adjacent stage events can merge two
 * executions into one attempt. Each case here drives the kernel through its
 * command entry points (and the harness's host loop), reads the outbox rows
 * it wrote, shapes them the way the SQL reader does, and groups them.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createWorkflowConsole } from "../handler";
import { createInMemoryConsoleReadPort } from "../in-memory-read-port";
import {
  type AttemptEventInput,
  type AttemptUnavailableReason,
  buildStageAttemptHistory,
  type HeldStageEvents,
  mergeStageEvents,
  type StageAttemptHistory,
} from "../stage-attempts";

// Reached through vitest's alias to the engine's source. The specifiers are
// variables so `tsc` does not pull that source into this package's typecheck.
const engineSpecifier = "@bratsos/workflow-engine";
const testingSpecifier = "@bratsos/workflow-engine/testing";
const { WorkflowBuilder, defineStage } = await import(engineSpecifier);
const { createTestHarness, createTestKernel } = await import(testingSpecifier);

/**
 * A harness on a clock that starts at the real now: the in-memory stores stamp
 * rows with the real time, and `run.reapStuck` and `lease.reapStale` compare
 * those stamps with the kernel clock.
 */
function harnessOn(workflow: unknown) {
  const { clock } = createTestKernel([], { clockStart: new Date() });
  return createTestHarness({ workflows: [workflow], clock });
}

const io = z.object({ v: z.string() });
const schemas = { input: io, output: io, config: z.object({}) };

/** What the console reads off the outbox (`STAGE_LIFECYCLE_EVENT_TYPES` and `RUN_BOUNDARY_EVENT_TYPES`). */
const HISTORY_TYPES = new Set([
  "stage:started",
  "stage:suspended",
  "stage:retrying",
  "stage:failed",
  "stage:completed",
  "workflow:started",
  "workflow:cancelled",
]);

interface Snapshot {
  runStatus: string;
  redriveCount: number;
  stageStatus: Record<string, string>;
  events: AttemptEventInput[];
  histories: Map<string, StageAttemptHistory>;
  stageIds: Record<string, string>;
}

async function snapshot(h: any, runId: string): Promise<Snapshot> {
  const run = await h.persistence.getRun(runId);
  const stages = await h.persistence.getStagesByRun(runId);
  const rows = (h.persistence.outbox as any[])
    .filter((row) => row.workflowRunId === runId)
    .sort((a, b) => a.sequence - b.sequence);
  const events: AttemptEventInput[] = rows
    .filter((row) => HISTORY_TYPES.has(row.eventType))
    .map((row) => ({
      sequence: row.sequence,
      eventType: row.eventType,
      occurredAt: row.occurredAt,
      stageId: row.payload.stageId ?? null,
      error:
        row.eventType === "stage:retrying" || row.eventType === "stage:failed"
          ? (row.payload.error ?? null)
          : null,
    }));
  const steps: any[] = [];
  for (const stage of stages) {
    for (const step of await h.stepLedger.list(stage.id)) {
      steps.push({
        stageRecordId: stage.id,
        stepId: step.stepId,
        seq: step.seq,
        kind: step.kind,
        status: step.status,
        attempt: step.attempt,
        externalKey: step.externalKey ?? null,
        error: step.error ?? null,
        createdAt: step.createdAt,
        updatedAt: step.updatedAt,
      });
    }
  }
  const histories = buildStageAttemptHistory({
    redriveCount: run.redriveCount ?? 0,
    stages: stages.map((s: any) => ({
      id: s.id,
      stageId: s.stageId,
      attempt: s.attempt,
      status: s.status,
      startedAt: s.startedAt ?? null,
      completedAt: s.completedAt ?? null,
      errorMessage: s.errorMessage ?? null,
    })),
    steps,
    // Complete: the in-memory outbox is never purged, so its rows are 1..n.
    stageEvents: { events, coverage: "from-start" },
  });
  const snap: Snapshot = {
    runStatus: run.status,
    redriveCount: run.redriveCount ?? 0,
    stageStatus: Object.fromEntries(
      stages.map((s: any) => [s.stageId, s.status]),
    ),
    events,
    histories,
    stageIds: Object.fromEntries(stages.map((s: any) => [s.stageId, s.id])),
  };
  // The invariant under test: whatever is reported as available never holds
  // two executions (two `stage:started`) in one attempt.
  for (const history of histories.values()) {
    if (!history.available) continue;
    for (const attempt of history.attempts) {
      expect(
        attempt.events.filter((e) => e.eventType === "stage:started").length,
      ).toBeLessThanOrEqual(1);
    }
  }
  return snap;
}

/** `[trigger, outcome]` of each attempt of a stage, or its fallback reason. */
function shape(snap: Snapshot, stageId: string) {
  const history = snap.histories.get(snap.stageIds[stageId]!)!;
  return history.available
    ? history.attempts.map((a) => [a.trigger, a.outcome])
    : `unavailable:${history.reason}`;
}

function attemptsOf(snap: Snapshot, stageId: string) {
  const history = snap.histories.get(snap.stageIds[stageId]!)!;
  if (!history.available) throw new Error("unavailable");
  return history.attempts;
}

function eventsOf(snap: Snapshot, stageId: string, attempt: number) {
  const history = snap.histories.get(snap.stageIds[stageId]!)!;
  if (!history.available) throw new Error("unavailable");
  return history.attempts[attempt - 1]!.events.map((e) => e.eventType);
}

const redrive = (
  h: any,
  runId: string,
  from: unknown = { kind: "lastFailure" },
) => h.kernel.dispatch({ type: "run.redrive", workflowRunId: runId, from });

async function drain(h: any, runId: string, ticks = 8) {
  for (let i = 0; i < ticks; i++) await h.tick([runId]);
}

describe("I want a cancelled or restarted stage never shown as one attempt with two executions", () => {
  it("run.cancel of a running stage then run.redrive: the cancelled execution is its own attempt", async () => {
    let h: any;
    let runId = "";
    let runs = 0;
    const slow = defineStage({
      id: "slow",
      name: "Slow",
      schemas,
      async execute(ctx: any) {
        runs++;
        if (runs === 1) {
          await h.kernel.dispatch({ type: "run.cancel", workflowRunId: runId });
        }
        return { output: ctx.input };
      },
    });
    h = createTestHarness({
      workflows: [
        new WorkflowBuilder("wf", "wf", "d", io, io).pipe(slow).build(),
      ],
    });
    runId = (await h.start("wf", { v: "x" })).workflowRunId;
    await drain(h, runId, 2);

    const cancelled = await snapshot(h, runId);
    expect(cancelled.runStatus).toBe("CANCELLED");
    expect(cancelled.stageStatus.slow).toBe("CANCELLED");
    expect(shape(cancelled, "slow")).toEqual([["initial", "cancelled"]]);
    expect(eventsOf(cancelled, "slow", 1)).toEqual([
      "stage:started",
      "workflow:cancelled",
    ]);

    await redrive(h, runId);
    await drain(h, runId);
    const done = await snapshot(h, runId);
    expect(done.runStatus).toBe("COMPLETED");
    expect(shape(done, "slow")).toEqual([
      ["initial", "cancelled"],
      ["rerun", "completed"],
    ]);
  });

  it("run.cancel of a suspended stage then run.redrive: the suspended execution is its own attempt", async () => {
    const nap = defineStage({
      id: "nap",
      name: "Nap",
      schemas,
      async execute(ctx: any) {
        await ctx.step.sleep("nap", "20m");
        return { output: ctx.input };
      },
    });
    const h = createTestHarness({
      workflows: [
        new WorkflowBuilder("wf", "wf", "d", io, io).pipe(nap).build(),
      ],
    });
    const { workflowRunId: runId } = await h.start("wf", { v: "x" });
    await h.kernel.dispatch({ type: "run.claimPending", workerId: "w" });
    await h.kernel.dispatch({
      type: "job.execute",
      workflowRunId: runId,
      workflowId: "wf",
      stageId: "nap",
      config: {},
    });
    expect((await h.persistence.getStage(runId, "nap")).status).toBe(
      "SUSPENDED",
    );
    await h.cancel(runId);

    const cancelled = await snapshot(h, runId);
    expect(shape(cancelled, "nap")).toEqual([["initial", "cancelled"]]);
    expect(eventsOf(cancelled, "nap", 1)).toEqual([
      "stage:started",
      "stage:suspended",
      "workflow:cancelled",
    ]);

    await redrive(h, runId);
    await drain(h, runId, 12);
    const done = await snapshot(h, runId);
    expect(done.runStatus).toBe("COMPLETED");
    expect(shape(done, "nap")).toEqual([
      ["initial", "cancelled"],
      ["rerun", "completed"],
    ]);
  });

  it("run.reapStuck then run.redrive: the reaped execution is closed by its stage:failed", async () => {
    const nap = defineStage({
      id: "nap",
      name: "Nap",
      schemas,
      async execute(ctx: any) {
        await ctx.step.sleep("nap", "20m");
        return { output: ctx.input };
      },
    });
    const h = harnessOn(
      new WorkflowBuilder("wf", "wf", "d", io, io).pipe(nap).build(),
    );
    const { workflowRunId: runId } = await h.start("wf", { v: "x" });
    await h.kernel.dispatch({ type: "run.claimPending", workerId: "w" });
    await h.kernel.dispatch({
      type: "job.execute",
      workflowRunId: runId,
      workflowId: "wf",
      stageId: "nap",
      config: {},
    });
    // Past the 20 minute poll deadline and one threshold beyond it.
    h.clock.advance(30 * 60_000);
    const reaped = await h.kernel.dispatch({
      type: "run.reapStuck",
      stuckThresholdMs: 5 * 60_000,
    });
    expect(reaped.failed).toBe(1);

    const failed = await snapshot(h, runId);
    expect(failed.runStatus).toBe("FAILED");
    expect(shape(failed, "nap")).toEqual([["initial", "failed"]]);

    await redrive(h, runId);
    await drain(h, runId, 12);
    const done = await snapshot(h, runId);
    expect(done.runStatus).toBe("COMPLETED");
    expect(shape(done, "nap")).toEqual([
      ["initial", "failed"],
      ["rerun", "completed"],
    ]);
  });

  it("two cancel and redrive cycles in a row give three attempts", async () => {
    let h: any;
    let runId = "";
    let runs = 0;
    const slow = defineStage({
      id: "slow",
      name: "Slow",
      schemas,
      async execute(ctx: any) {
        runs++;
        if (runs <= 2) {
          await h.kernel.dispatch({ type: "run.cancel", workflowRunId: runId });
        }
        return { output: ctx.input };
      },
    });
    h = createTestHarness({
      workflows: [
        new WorkflowBuilder("wf", "wf", "d", io, io).pipe(slow).build(),
      ],
    });
    runId = (await h.start("wf", { v: "x" })).workflowRunId;
    await drain(h, runId, 2);
    await redrive(h, runId);
    await drain(h, runId, 2);

    const second = await snapshot(h, runId);
    expect(second.runStatus).toBe("CANCELLED");
    expect(second.redriveCount).toBe(1);
    expect(shape(second, "slow")).toEqual([
      ["initial", "cancelled"],
      ["rerun", "cancelled"],
    ]);

    await redrive(h, runId);
    await drain(h, runId);
    const done = await snapshot(h, runId);
    expect(done.runStatus).toBe("COMPLETED");
    expect(done.redriveCount).toBe(2);
    expect(shape(done, "slow")).toEqual([
      ["initial", "cancelled"],
      ["rerun", "cancelled"],
      ["rerun", "completed"],
    ]);
  });

  it("a cancel that lands after a redrive and before the stage starts keeps the earlier attempts", async () => {
    let calls = 0;
    const bad = defineStage({
      id: "bad",
      name: "Bad",
      schemas,
      async execute(ctx: any) {
        calls++;
        if (calls <= 3) throw new Error(`always ${calls}`);
        return { output: ctx.input };
      },
    });
    const h = createTestHarness({
      workflows: [
        new WorkflowBuilder("wf", "wf", "d", io, io).pipe(bad).build(),
      ],
    });
    const { workflowRunId: runId } = await h.run("wf", { v: "x" });
    expect((await snapshot(h, runId)).runStatus).toBe("FAILED");

    await redrive(h, runId);
    await h.cancel(runId);
    const idle = await snapshot(h, runId);
    expect(idle.stageStatus.bad).toBe("CANCELLED");
    expect(shape(idle, "bad")).toEqual([
      ["initial", "retrying"],
      ["job-retry", "retrying"],
      ["job-retry", "failed"],
    ]);

    await redrive(h, runId);
    await drain(h, runId);
    const done = await snapshot(h, runId);
    expect(done.runStatus).toBe("COMPLETED");
    expect(shape(done, "bad")).toEqual([
      ["initial", "retrying"],
      ["job-retry", "retrying"],
      ["job-retry", "failed"],
      ["rerun", "completed"],
    ]);
  });

  it("run.redrive from the start and from a chosen stage give every stage one attempt per execution", async () => {
    let calls = 0;
    const a = defineStage({
      id: "a",
      name: "A",
      schemas,
      async execute(ctx: any) {
        return { output: ctx.input };
      },
    });
    const b = defineStage({
      id: "b",
      name: "B",
      schemas,
      async execute(ctx: any) {
        calls++;
        if (calls <= 3) throw new Error(`b failed ${calls}`);
        return { output: ctx.input };
      },
    });
    const h = createTestHarness({
      workflows: [
        new WorkflowBuilder("wf", "wf", "d", io, io).pipe(a).pipe(b).build(),
      ],
    });
    const { workflowRunId: runId } = await h.run("wf", { v: "x" });
    expect((await snapshot(h, runId)).runStatus).toBe("FAILED");

    await redrive(h, runId, { kind: "start" });
    await drain(h, runId);
    const restarted = await snapshot(h, runId);
    expect(restarted.runStatus).toBe("COMPLETED");
    expect(shape(restarted, "a")).toEqual([
      ["initial", "completed"],
      ["rerun", "completed"],
    ]);
    expect(shape(restarted, "b")).toEqual([
      ["initial", "retrying"],
      ["job-retry", "retrying"],
      ["job-retry", "failed"],
      ["rerun", "completed"],
    ]);

    await redrive(h, runId, { kind: "stage", stageId: "a" });
    await drain(h, runId);
    const rerun = await snapshot(h, runId);
    expect(rerun.runStatus).toBe("COMPLETED");
    expect(shape(rerun, "a")).toHaveLength(3);
    expect(shape(rerun, "b")).toHaveLength(5);
  });

  it("a cancel during a job retry's backoff, then a redrive, makes the next attempt a rerun", async () => {
    let calls = 0;
    const flaky = defineStage({
      id: "flaky",
      name: "Flaky",
      schemas,
      async execute(ctx: any) {
        calls++;
        if (calls === 1) throw new Error("boom");
        return { output: ctx.input };
      },
    });
    const h = createTestHarness({
      workflows: [
        new WorkflowBuilder("wf", "wf", "d", io, io).pipe(flaky).build(),
      ],
    });
    const { workflowRunId: runId } = await h.start("wf", { v: "x" });
    await h.kernel.dispatch({ type: "run.claimPending", workerId: "w" });
    const job = await h.jobQueue.dequeue();
    // The first execution throws and the job is due to retry: the stage waits
    // PENDING between attempts, with no stage:started until the retry runs.
    await h.kernel.dispatch({
      type: "job.execute",
      workflowRunId: runId,
      workflowId: "wf",
      stageId: "flaky",
      config: {},
      attempt: job.attempt,
      maxAttempts: 3,
    });
    await h.cancel(runId);
    const cancelled = await snapshot(h, runId);
    expect(cancelled.stageStatus.flaky).toBe("CANCELLED");
    expect(shape(cancelled, "flaky")).toEqual([["initial", "retrying"]]);

    await redrive(h, runId);
    await drain(h, runId);
    const done = await snapshot(h, runId);
    expect(done.runStatus).toBe("COMPLETED");
    expect(shape(done, "flaky")).toEqual([
      ["initial", "retrying"],
      ["rerun", "completed"],
    ]);
  });

  it("run.reapStuck of a stage waiting for a job retry shows a failed attempt that never started", async () => {
    let calls = 0;
    const flaky = defineStage({
      id: "flaky",
      name: "Flaky",
      schemas,
      async execute(ctx: any) {
        calls++;
        if (calls === 1) throw new Error("boom");
        return { output: ctx.input };
      },
    });
    const h = harnessOn(
      new WorkflowBuilder("wf", "wf", "d", io, io).pipe(flaky).build(),
    );
    const { workflowRunId: runId } = await h.start("wf", { v: "x" });
    await h.kernel.dispatch({ type: "run.claimPending", workerId: "w" });
    const job = await h.jobQueue.dequeue();
    await h.kernel.dispatch({
      type: "job.execute",
      workflowRunId: runId,
      workflowId: "wf",
      stageId: "flaky",
      config: {},
      attempt: job.attempt,
      maxAttempts: 3,
    });
    expect((await h.persistence.getStage(runId, "flaky")).status).toBe(
      "PENDING",
    );
    h.clock.advance(30 * 60_000);
    const reaped = await h.kernel.dispatch({
      type: "run.reapStuck",
      stuckThresholdMs: 5 * 60_000,
    });
    expect(reaped.failed).toBe(1);

    const failed = await snapshot(h, runId);
    expect(failed.stageStatus.flaky).toBe("FAILED");
    expect(shape(failed, "flaky")).toEqual([
      ["initial", "retrying"],
      ["job-retry", "failed"],
    ]);
    const attempts = attemptsOf(failed, "flaky");
    expect(attempts.map((a) => a.executed)).toEqual([true, false]);
    expect(attempts[1]!.error).toMatch(/Run stuck for >300000ms/);
    expect(attempts[1]!.events.map((e) => e.eventType)).toEqual([
      "stage:failed",
    ]);
  });

  it.each([
    ["its lease was reaped", "lease"],
    ["the host requeued its job after the worker crashed", "crash"],
  ] as const)("a stage started again after %s shows the earlier execution as lost and the re-delivery as its own attempt", async (_name, route) => {
    let calls = 0;
    const slow = defineStage({
      id: "slow",
      name: "Slow",
      schemas,
      async execute(ctx: any) {
        calls++;
        await ctx.step.run("fetch", async () => "fetched");
        // The first worker never comes back.
        if (calls === 1) await new Promise(() => {});
        return { output: ctx.input };
      },
    });
    const h = harnessOn(
      new WorkflowBuilder("wf", "wf", "d", io, io).pipe(slow).build(),
    );
    const { workflowRunId: runId } = await h.start("wf", { v: "x" });
    await h.kernel.dispatch({ type: "run.claimPending", workerId: "w" });
    const execute = (job: any) =>
      h.kernel.dispatch({
        type: "job.execute",
        workflowRunId: runId,
        workflowId: "wf",
        stageId: "slow",
        config: {},
        attempt: job.attempt,
        maxAttempts: 3,
      });

    const first = await h.jobQueue.dequeue();
    void execute(first);
    const waitFor = async (done: () => Promise<boolean>) => {
      while (!(await done())) await new Promise((r) => setTimeout(r, 1));
    };
    await waitFor(async () => {
      const stage = await h.persistence.getStage(runId, "slow");
      return stage ? (await h.stepLedger.list(stage.id)).length === 1 : false;
    });
    h.clock.advance(5_000);
    if (route === "lease") {
      // The worker stopped heartbeating ten minutes ago.
      h.jobQueue.setJobLockedAt(
        first.jobId,
        new Date(Date.now() - 10 * 60_000),
      );
      const reaped = await h.kernel.dispatch({
        type: "lease.reapStale",
        staleThresholdMs: 60_000,
      });
      expect(reaped.released).toBe(1);
    } else {
      // What a host does when the worker process dies mid-execution.
      await h.jobQueue.fail(first.jobId, "worker crashed", true);
    }
    const second = await h.jobQueue.dequeue();
    expect(second.jobId).toBe(first.jobId);
    await execute(second);

    const redelivered = await snapshot(h, runId);
    expect(
      redelivered.events.filter((e) => e.eventType === "stage:started"),
    ).toHaveLength(2);
    expect(redelivered.stageStatus.slow).toBe("COMPLETED");
    expect(shape(redelivered, "slow")).toEqual([
      ["initial", "lost"],
      ["redelivery", "completed"],
    ]);
    const [lost, again] = attemptsOf(redelivered, "slow");
    // No end event: the window closes where the re-delivery started, and the
    // step the first execution wrote is placed in it by time.
    expect(lost).toMatchObject({
      endedAt: null,
      windowEndedAt: again!.startedAt,
      error: null,
    });
    expect(lost!.events.map((e) => e.eventType)).toEqual(["stage:started"]);
    expect(lost!.steps.map((x) => x.stepId)).toEqual(["fetch"]);
    expect(again!.steps).toEqual([]);
  });
});

/** What the page reads of one run at one moment: its rows and every run's outbox. */
interface Moment {
  runId: string;
  run: any;
  stages: any[];
  steps: any[];
  outbox: any[];
}

async function moment(h: any, runId: string): Promise<Moment> {
  const stages = await h.persistence.getStagesByRun(runId);
  const steps: any[] = [];
  for (const stage of stages) {
    for (const step of await h.stepLedger.list(stage.id)) {
      steps.push({ ...step, stageRecordId: stage.id });
    }
  }
  return {
    runId,
    run: { ...(await h.persistence.getRun(runId)) },
    stages: stages.map((s: any) => ({ ...s })),
    steps,
    outbox: (h.persistence.outbox as any[]).map((row) => ({ ...row })),
  };
}

/**
 * The page's model of a run with some outbox rows removed: the in-memory
 * reader over the remaining rows, served by the console handler, folded by
 * the page's merge (asking again while `more`), grouped from the JSON as the
 * UI receives it.
 */
async function pageModel(m: Moment, removed: (row: any) => boolean) {
  const rows = m.outbox.filter((row) => !removed(row));
  const reader = createInMemoryConsoleReadPort({
    runs: [
      {
        id: m.runId,
        createdAt: m.run.createdAt,
        updatedAt: m.run.updatedAt,
        workflowId: m.run.workflowId,
        workflowName: m.run.workflowName,
        workflowType: m.run.workflowType,
        status: m.run.status,
        startedAt: m.run.startedAt ?? null,
        completedAt: m.run.completedAt ?? null,
        duration: null,
        totalCost: 0,
        totalTokens: 0,
        priority: 0,
        redriveCount: m.run.redriveCount ?? 0,
      },
    ],
    stages: m.stages.map((s) => ({
      id: s.id,
      workflowRunId: m.runId,
      stageId: s.stageId,
      stageName: s.stageName,
      stageNumber: s.stageNumber,
      executionGroup: s.executionGroup,
      attempt: s.attempt,
      status: s.status,
      startedAt: s.startedAt ?? null,
      completedAt: s.completedAt ?? null,
      duration: s.duration ?? null,
      nextPollAt: s.nextPollAt ?? null,
      pollInterval: s.pollInterval ?? null,
      maxWaitUntil: s.maxWaitUntil ?? null,
      errorMessage: s.errorMessage ?? null,
    })),
    steps: m.steps.map((step) => ({
      id: `${step.stageRecordId}:${step.stepId}`,
      stageRecordId: step.stageRecordId,
      stepId: step.stepId,
      seq: step.seq,
      kind: step.kind,
      status: step.status,
      attempt: step.attempt,
      leaseExpiresAt: null,
      deadlineAt: null,
      externalKey: step.externalKey ?? null,
      error: step.error ?? null,
      createdAt: step.createdAt,
      updatedAt: step.updatedAt,
    })),
    events: rows.map((row) => ({
      id: row.id,
      workflowRunId: row.workflowRunId,
      sequence: row.sequence,
      eventType: row.eventType,
      occurredAt: row.occurredAt,
      publishedAt: null,
      retryCount: 0,
      dlqAt: null,
    })),
    stageEvents: rows
      .filter((row) => HISTORY_TYPES.has(row.eventType))
      .map((row) => ({
        workflowRunId: row.workflowRunId,
        sequence: row.sequence,
        eventType: row.eventType,
        occurredAt: row.occurredAt,
        stageId: row.payload.stageId ?? null,
        error:
          row.eventType === "stage:retrying" || row.eventType === "stage:failed"
            ? (row.payload.error ?? null)
            : null,
      })),
  });
  const handler = createWorkflowConsole({ reader, authorize: () => true });
  let held: HeldStageEvents | null = null;
  let body: any;
  for (let read = 0; read < 10; read++) {
    const query = held ? `?stageEventsAfter=${held.lastSequence}` : "";
    const res = await handler(
      new Request(
        `https://console.example/console/api/runs/${m.runId}${query}`,
      ),
    );
    expect(res.status).toBe(200);
    body = await res.json();
    held = mergeStageEvents(held, body.stageEvents);
    if (held && !held.more) break;
  }
  return buildStageAttemptHistory({
    redriveCount: body.run.redriveCount,
    stages: body.stages,
    steps: body.steps,
    stageEvents: {
      events: held!.events,
      coverage: held!.coverage,
      caughtUp: !held!.more,
    },
  });
}

type Retention = {
  name: string;
  removed: (row: any) => boolean;
  /** The only reasons that are true for a stage of the run when rows are removed this way. */
  reasons: AttemptUnavailableReason[];
};

function retentionStates(m: Moment): Retention[] {
  const own = (row: any) => row.workflowRunId === m.runId;
  const n = m.outbox.filter(own).length;
  const states: Retention[] = [
    { name: "all kept", removed: () => false, reasons: [] },
    { name: "all gone", removed: () => true, reasons: ["no-retained-events"] },
    {
      name: "only other runs' rows left",
      removed: own,
      reasons: ["no-retained-events"],
    },
  ];
  for (let k = 1; k < n; k++) {
    states.push({
      name: `prefix 1..${k} gone`,
      removed: (row) => own(row) && row.sequence <= k,
      reasons: ["events-incomplete"],
    });
  }
  for (let i = 2; i < n; i++) {
    states.push({
      name: `middle ${i} gone`,
      removed: (row) => own(row) && row.sequence === i,
      reasons: ["events-incomplete"],
    });
  }
  for (let k = 2; k <= n; k++) {
    // Nothing in the remaining rows can show that a tail is missing; only the
    // stage's row can, and the page must say so instead of a stale history.
    states.push({
      name: `tail ${k}..${n} gone`,
      removed: (row) => own(row) && row.sequence >= k,
      reasons: ["inconsistent", "no-stage-events"],
    });
  }
  return states;
}

/**
 * Every retention state of the run's rows gives, for every stage, either the
 * history read with all rows kept, or unavailable with a reason that is true
 * for what was removed.
 */
async function expectTrueUnderRetention(m: Moment) {
  const truth = await pageModel(m, () => false);
  const tally: Record<string, number> = {};
  for (const state of retentionStates(m)) {
    const model = await pageModel(m, state.removed);
    for (const [stageRecordId, expected] of truth) {
      const got = model.get(stageRecordId)!;
      const label = `${state.name} / ${stageRecordId}`;
      if (got.available) {
        expect(got, label).toEqual(expected);
        tally.same = (tally.same ?? 0) + 1;
      } else {
        expect(state.reasons, label).toContain(got.reason);
        if (got.reason === "inconsistent")
          expect(got.mismatch, label).toBeDefined();
        tally[got.reason] = (tally[got.reason] ?? 0) + 1;
      }
    }
  }
  return { truth, tally };
}

/** A harness whose clock moves 1 ms on every reading, as a real clock moves between two writes. */
function tickingHarness(workflows: unknown[]) {
  const { clock } = createTestKernel([], {
    clockStart: new Date("2026-03-01T12:00:00.000Z"),
  });
  const read = clock.now.bind(clock);
  clock.now = () => {
    const now = read();
    clock.advance(1);
    return now;
  };
  const other = defineStage({
    id: "other",
    name: "Other",
    schemas,
    async execute(ctx: any) {
      return { output: ctx.input };
    },
  });
  return createTestHarness({
    workflows: [
      ...workflows,
      new WorkflowBuilder("other", "other", "d", io, io).pipe(other).build(),
    ],
    clock,
  });
}

function shapeOf(
  histories: Map<string, StageAttemptHistory>,
  m: Moment,
  stageId: string,
) {
  const record = m.stages.find((s) => s.stageId === stageId)!;
  const history = histories.get(record.id)!;
  return history.available
    ? history.attempts.map((a) => [a.trigger, a.outcome])
    : `unavailable:${history.reason}`;
}

describe("I want every statement about a stage's history to be true under any retention of the run's events", () => {
  const wf = (id: string, stage: unknown) =>
    new WorkflowBuilder(id, id, "d", io, io).pipe(stage).build();
  const stageOf = (execute: (ctx: any) => Promise<unknown>) =>
    defineStage({ id: "s", name: "S", schemas, execute });

  async function withOtherRun(h: any) {
    const other = (await h.start("other", { v: "o" })).workflowRunId;
    await drain(h, other, 4);
  }

  const outcomes: Array<{
    name: string;
    expected: unknown;
    run: () => Promise<Moment>;
  }> = [
    {
      name: "never started (claimed, its job not run)",
      expected: [],
      async run() {
        const h = tickingHarness([
          wf(
            "wf",
            stageOf(async (ctx) => ({ output: ctx.input })),
          ),
        ]);
        await withOtherRun(h);
        const runId = (await h.start("wf", { v: "x" })).workflowRunId;
        await h.kernel.dispatch({ type: "run.claimPending", workerId: "w" });
        return moment(h, runId);
      },
    },
    {
      name: "never started (cancelled before its job ran)",
      expected: [],
      async run() {
        const h = tickingHarness([
          wf(
            "wf",
            stageOf(async (ctx) => ({ output: ctx.input })),
          ),
        ]);
        await withOtherRun(h);
        const runId = (await h.start("wf", { v: "x" })).workflowRunId;
        await h.kernel.dispatch({ type: "run.claimPending", workerId: "w" });
        await h.cancel(runId);
        return moment(h, runId);
      },
    },
    {
      name: "running",
      expected: [["initial", "running"]],
      async run() {
        let h: any;
        let runId = "";
        let inside: Moment | undefined;
        h = tickingHarness([
          wf(
            "wf",
            stageOf(async (ctx) => {
              await ctx.step.run("fetch", async () => "x");
              inside = await moment(h, runId);
              return { output: ctx.input };
            }),
          ),
        ]);
        await withOtherRun(h);
        runId = (await h.start("wf", { v: "x" })).workflowRunId;
        await drain(h, runId, 2);
        return inside!;
      },
    },
    {
      name: "suspended",
      expected: [["initial", "suspended"]],
      async run() {
        const h = tickingHarness([
          wf(
            "wf",
            stageOf(async (ctx) => {
              await ctx.step.sleep("nap", "20m");
              return { output: ctx.input };
            }),
          ),
        ]);
        await withOtherRun(h);
        const runId = (await h.start("wf", { v: "x" })).workflowRunId;
        for (let i = 0; i < 5; i++) {
          await h.tick([runId]);
          const stages = await h.persistence.getStagesByRun(runId);
          if (stages[0]?.status === "SUSPENDED") break;
        }
        return moment(h, runId);
      },
    },
    {
      name: "completed after a job retry",
      expected: [
        ["initial", "retrying"],
        ["job-retry", "completed"],
      ],
      async run() {
        let calls = 0;
        const h = tickingHarness([
          wf(
            "wf",
            stageOf(async (ctx) => {
              calls++;
              await ctx.step.run(`call-${calls}`, async () => calls);
              if (calls === 1) throw new Error("upstream 503");
              return { output: ctx.input };
            }),
          ),
        ]);
        await withOtherRun(h);
        const { workflowRunId } = await h.run("wf", { v: "x" });
        return moment(h, workflowRunId);
      },
    },
    {
      name: "failed",
      expected: [
        ["initial", "retrying"],
        ["job-retry", "retrying"],
        ["job-retry", "failed"],
      ],
      async run() {
        let calls = 0;
        const h = tickingHarness([
          wf(
            "wf",
            stageOf(async () => {
              calls++;
              throw new Error(`always ${calls}`);
            }),
          ),
        ]);
        await withOtherRun(h);
        const { workflowRunId } = await h.run("wf", { v: "x" });
        return moment(h, workflowRunId);
      },
    },
    {
      name: "cancelled while running",
      expected: [["initial", "cancelled"]],
      async run() {
        let h: any;
        let runId = "";
        h = tickingHarness([
          wf(
            "wf",
            stageOf(async (ctx) => {
              await ctx.step.run("fetch", async () => "x");
              await h.kernel.dispatch({
                type: "run.cancel",
                workflowRunId: runId,
              });
              return { output: ctx.input };
            }),
          ),
        ]);
        await withOtherRun(h);
        runId = (await h.start("wf", { v: "x" })).workflowRunId;
        await drain(h, runId, 2);
        return moment(h, runId);
      },
    },
    {
      name: "completed on a rerun after a redrive",
      expected: [
        ["initial", "retrying"],
        ["job-retry", "retrying"],
        ["job-retry", "failed"],
        ["rerun", "completed"],
      ],
      async run() {
        let failing = true;
        const h = tickingHarness([
          wf(
            "wf",
            stageOf(async (ctx) => {
              if (failing) throw new Error("down");
              return { output: ctx.input };
            }),
          ),
        ]);
        await withOtherRun(h);
        const { workflowRunId } = await h.run("wf", { v: "x" });
        failing = false;
        await redrive(h, workflowRunId);
        await drain(h, workflowRunId);
        return moment(h, workflowRunId);
      },
    },
    {
      name: "suspended again after a retry inside stage.pollSuspended",
      expected: [
        ["initial", "retrying"],
        ["poll-retry", "suspended"],
      ],
      async run() {
        let replays = 0;
        const h = tickingHarness([
          wf(
            "wf",
            stageOf(async (ctx) => {
              await ctx.step.sleep("nap", "1m");
              await ctx.step.run("after-nap", async () => {
                replays++;
                if (replays === 1) throw new Error("flaky after the wait");
                return "ok";
              });
              return { output: ctx.input };
            }),
          ),
        ]);
        await withOtherRun(h);
        const runId = (await h.start("wf", { v: "x" })).workflowRunId;
        for (let i = 0; i < 8 && replays === 0; i++) await h.tick([runId]);
        const stages = await h.persistence.getStagesByRun(runId);
        expect(stages[0]?.status).toBe("SUSPENDED");
        return moment(h, runId);
      },
    },
    {
      name: "completed after its job was delivered again (worker crash)",
      expected: [
        ["initial", "lost"],
        ["redelivery", "completed"],
      ],
      async run() {
        let calls = 0;
        const h: any = tickingHarness([
          wf(
            "wf",
            stageOf(async (ctx) => {
              calls++;
              await ctx.step.run("fetch", async () => "fetched");
              if (calls === 1) await new Promise(() => {});
              return { output: ctx.input };
            }),
          ),
        ]);
        await withOtherRun(h);
        const runId = (await h.start("wf", { v: "x" })).workflowRunId;
        await h.kernel.dispatch({ type: "run.claimPending", workerId: "w" });
        const execute = (job: any) =>
          h.kernel.dispatch({
            type: "job.execute",
            workflowRunId: runId,
            workflowId: "wf",
            stageId: "s",
            config: {},
            attempt: job.attempt,
            maxAttempts: 3,
          });
        const first = await h.jobQueue.dequeue();
        void execute(first);
        for (;;) {
          const stage = await h.persistence.getStage(runId, "s");
          if (stage && (await h.stepLedger.list(stage.id)).length === 1) break;
          await new Promise((r) => setTimeout(r, 1));
        }
        await h.jobQueue.fail(first.jobId, "worker crashed", true);
        await execute(await h.jobQueue.dequeue());
        return moment(h, runId);
      },
    },
  ];

  it.each(outcomes)("$name", async ({ expected, run }) => {
    const m = await run();
    const { truth, tally } = await expectTrueUnderRetention(m);
    expect(shapeOf(truth, m, "s")).toEqual(expected);
    // Every stage is available with all rows kept, and some state of each
    // kind made the page fall back.
    expect(tally["no-retained-events"]).toBeGreaterThan(0);
    expect(tally["events-incomplete"]).toBeGreaterThan(0);
  });
});
