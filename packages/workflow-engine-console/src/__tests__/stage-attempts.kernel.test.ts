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
  RUN_BOUNDARY_EVENT_TYPES,
  STAGE_LIFECYCLE_EVENT_TYPES,
} from "../read-port";
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
  return prepared(createTestHarness({ workflows: [workflow], clock }));
}

/**
 * How the store writes a stage row's `startedAt` before the stage starts:
 * the in-memory store leaves it null; the Prisma store stamps the time it
 * creates the row (an upsert's create, with its own clock), which the oracle
 * reproduces here.
 */
type StoreForm = "null until started" | "stamped at creation";
let storeForm: StoreForm = "null until started";
/** Called with each harness the oracle creates, to watch its dispatches. */
let onHarness: ((h: any) => void) | undefined;

function prepared(h: any) {
  if (storeForm === "stamped at creation") {
    const p = h.persistence;
    const upsert = p.upsertStage.bind(p);
    p.upsertStage = async (data: any) =>
      upsert(
        data.create.startedAt !== undefined ||
          (await p.getStage(data.workflowRunId, data.stageId))
          ? data
          : { ...data, create: { ...data.create, startedAt: new Date() } },
      );
  }
  onHarness?.(h);
  return h;
}

const io = z.object({ v: z.string() });
const schemas = { input: io, output: io, config: z.object({}) };

/** What the console reads off the outbox (`STAGE_LIFECYCLE_EVENT_TYPES` and `RUN_BOUNDARY_EVENT_TYPES`). */
const HISTORY_TYPES = new Set<string>([
  ...STAGE_LIFECYCLE_EVENT_TYPES,
  ...RUN_BOUNDARY_EVENT_TYPES,
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
      causationId: row.eventType.startsWith("stage:") ? row.causationId : null,
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

/**
 * Removes every outbox row of a run, as a retention job does. The reference
 * Prisma store numbers a run's next row from the highest one it still holds
 * (`max(sequence) + 1`), so after this the next row is sequence 1 again; the
 * in-memory store keeps a counter per run, reset here to number the same way.
 */
function purgeOutbox(h: any, runId: string) {
  h.persistence.outbox = (h.persistence.outbox as any[]).filter(
    (row) => row.workflowRunId !== runId,
  );
  h.persistence.outboxSequences.delete(runId);
}

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

  // G7: a cancelled execution whose body keeps running records its outcome
  // after a redrive started the stage again. The events carry which
  // `job.execute` wrote them, so the page does not show that outcome on the
  // rerun, in any of the three orders.
  for (const variant of [
    "the old body completes after the rerun completed",
    "the old body fails after the rerun completed",
    "the old body completes while the rerun is still running",
  ] as const) {
    it(`never attributes a late writer's outcome to the rerun: ${variant}`, async () => {
      let release!: () => void;
      const old = new Promise<void>((r) => {
        release = r;
      });
      let finishRerun!: () => void;
      const rerun = new Promise<void>((r) => {
        finishRerun = r;
      });
      let calls = 0;
      const slow = defineStage({
        id: "slow",
        name: "Slow",
        schemas,
        async execute(ctx: any) {
          const mine = ++calls;
          await ctx.step.run(`w${mine}`, async () => "x");
          if (mine === 1) {
            await old;
            if (variant.includes("fails")) throw new Error("late failure");
          }
          if (mine === 2 && variant.includes("still running")) await rerun;
          return { output: ctx.input };
        },
      });
      const c = defineStage({
        id: "c",
        name: "C",
        schemas,
        execute: async (ctx: any) => ({ output: ctx.input }),
      });
      const h = tickingHarness([
        new WorkflowBuilder("wf", "wf", "d", io, io).pipe(slow).pipe(c).build(),
      ]);
      const runId = (await h.start("wf", { v: "x" })).workflowRunId;
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
      const page = async () => {
        const m = await moment(h, runId);
        return shapeOf(await pageModel(m, () => false), m, "slow");
      };
      const firstDone = execute(await h.jobQueue.dequeue());
      while (calls === 0) await new Promise((r) => setTimeout(r, 1));
      await h.kernel.dispatch({ type: "run.cancel", workflowRunId: runId });
      await redrive(h, runId);
      await h.kernel.dispatch({ type: "run.claimPending", workerId: "w" });
      const secondDone = execute(await h.jobQueue.dequeue());
      if (variant.includes("still running")) {
        while (calls < 2) await new Promise((r) => setTimeout(r, 1));
        expect(await page()).toEqual([
          ["initial", "cancelled"],
          ["rerun", "running"],
        ]);
      } else {
        await secondDone;
        expect(await page()).toEqual([
          ["initial", "cancelled"],
          ["rerun", "completed"],
        ]);
      }
      release();
      await firstDone.catch(() => {});
      // The old execution's outcome is recorded now: the page does not say
      // which attempt it ended.
      expect(await page()).toBe("unavailable:unproven-boundary");
      finishRerun();
      await secondDone;
      await drain(h, runId, 6);
      expect(await page()).toBe("unavailable:unproven-boundary");
    });
  }
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
        causationId: row.eventType.startsWith("stage:")
          ? row.causationId
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
    runStatus: body.run.status,
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

function retentionStates(m: Moment, purged: boolean): Retention[] {
  const own = (row: any) => row.workflowRunId === m.runId;
  const n = m.outbox.filter(own).length;
  const states: Retention[] = [
    {
      name: "all kept",
      removed: () => false,
      reasons: purged ? ["events-incomplete"] : [],
    },
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
    // The numbering cannot show that a tail is missing; only the run's and
    // the stage's rows can, and the page must say so instead of a stale
    // history. After an earlier purge no remaining row is the run's creation.
    // A removed tail that held a redrive's `workflow:started` leaves fewer of
    // them than the run row's `redriveCount`; one that held the run's last
    // `workflow:*` event leaves a run state that is not the run row's status.
    states.push({
      name: `tail ${k}..${n} gone`,
      removed: (row) => own(row) && row.sequence >= k,
      reasons: purged
        ? ["events-incomplete"]
        : [
            "inconsistent",
            "no-stage-events",
            "fewer-redrives",
            "run-inconsistent",
          ],
    });
  }
  return states;
}

/**
 * Every retention state of the run's rows gives, for every stage, either the
 * history read with all rows kept, or unavailable with a reason that is true
 * for what was removed.
 */
async function expectTrueUnderRetention(m: Moment, purged = false) {
  const truth = await pageModel(m, () => false);
  const tally: Record<string, number> = {};
  for (const state of retentionStates(m, purged)) {
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
  return prepared(
    createTestHarness({
      workflows: [
        ...workflows,
        new WorkflowBuilder("other", "other", "d", io, io).pipe(other).build(),
      ],
      clock,
    }),
  );
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
    /** Every row of the run was purged at some point before the moment. */
    purged?: boolean;
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
      // Without the run's creation among its rows, the redrive's events would
      // read as the stage's first run.
      name: "every row purged, then a redrive that completed",
      expected: "unavailable:events-incomplete",
      purged: true,
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
        purgeOutbox(h, workflowRunId);
        failing = false;
        await redrive(h, workflowRunId);
        await drain(h, workflowRunId);
        const m = await moment(h, workflowRunId);
        const own = m.outbox.filter(
          (row) => row.workflowRunId === workflowRunId,
        );
        expect(own[0]).toMatchObject({
          sequence: 1,
          eventType: "workflow:started",
        });
        return m;
      },
    },
    {
      name: "purged, redriven, purged again, redriven",
      expected: "unavailable:events-incomplete",
      purged: true,
      async run() {
        let failures = 2;
        const h = tickingHarness([
          wf(
            "wf",
            stageOf(async (ctx) => {
              if (failures > 0) throw new Error("down");
              return { output: ctx.input };
            }),
          ),
        ]);
        await withOtherRun(h);
        const { workflowRunId } = await h.run("wf", { v: "x" });
        purgeOutbox(h, workflowRunId);
        failures = 1;
        await redrive(h, workflowRunId, { kind: "start" });
        await drain(h, workflowRunId);
        expect((await h.persistence.getRun(workflowRunId)).status).toBe(
          "FAILED",
        );
        purgeOutbox(h, workflowRunId);
        failures = 0;
        await redrive(h, workflowRunId, { kind: "start" });
        await drain(h, workflowRunId);
        const m = await moment(h, workflowRunId);
        expect(m.run).toMatchObject({ status: "COMPLETED", redriveCount: 2 });
        return m;
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

  it.each(outcomes)("$name", async ({ expected, run, purged }) => {
    const m = await run();
    const { truth, tally } = await expectTrueUnderRetention(m, purged);
    expect(shapeOf(truth, m, "s")).toEqual(expected);
    // Every stage is available with all rows kept, and some state of each
    // kind made the page fall back.
    expect(tally["no-retained-events"]).toBeGreaterThan(0);
    expect(tally["events-incomplete"]).toBeGreaterThan(0);
  });
});

/**
 * Two worlds run the same kernel commands. One keeps every outbox row; in the
 * other, rows of the run are removed at a mark and the run then goes on
 * writing, numbered as the Prisma store numbers them (one past the highest
 * row it still holds). Whatever the page shows as available in the second
 * world must be what it shows in the first.
 *
 * Rows removed from the start or the middle are always found. Rows removed
 * from the end are found only when what remains contradicts the run or stage
 * rows; the histories that remain wrong after such a removal are counted per
 * scenario, printed with their shapes, and must each be a history the row
 * checks cannot see: one that differs from the kept history only by
 * executions the stage row does not count (a re-delivery after a crash) or
 * by where the steps are placed.
 */
describe("I want a history shown as available after rows were removed and the run wrote again to be the one kept in full", () => {
  type Purge = { name: string; keep: (row: any) => boolean };
  type Mark = (label: string, h: any, runId: string) => Promise<void>;
  type Scenario = {
    name: string;
    marks: string[];
    /** Wrong histories after removals from the end, as measured. */
    tailLimit: number;
    run: (mark: Mark) => Promise<{ h: any; runId: string }>;
  };
  const TAIL = "tail gone (head kept)";
  const NONE = "none gone";

  const stage = (id: string, execute: (ctx: any) => Promise<unknown>) =>
    defineStage({ id, name: id.toUpperCase(), schemas, execute });
  const pass = async (ctx: any) => ({ output: ctx.input });

  /** Removes rows of one run; the next row is numbered one past the highest left. */
  function applyPurge(h: any, runId: string, purge: Purge): string {
    const all = h.persistence.outbox as any[];
    const own = all.filter((r) => r.workflowRunId === runId);
    h.persistence.outbox = all.filter(
      (r) => r.workflowRunId !== runId || purge.keep(r),
    );
    const seqs = own
      .filter((r) => purge.keep(r))
      .map((r) => r.sequence as number)
      .sort((a, b) => a - b);
    h.persistence.outboxSequences.set(runId, seqs[seqs.length - 1] ?? 0);
    const contiguous =
      seqs.length > 0 && seqs[seqs.length - 1]! - seqs[0]! + 1 === seqs.length;
    return seqs.length === 0
      ? "all gone"
      : seqs.length === own.length
        ? NONE
        : contiguous && seqs[0] === 1
          ? TAIL
          : contiguous && seqs[seqs.length - 1] === own.length
            ? "prefix gone (tail kept)"
            : seqs[0] === 1
              ? "creation kept, gaps"
              : "gaps, creation gone";
  }

  const scenarios: Scenario[] = [
    {
      name: "fail, redrive lastFailure twice, redrive from start",
      marks: ["g1", "g2", "g3"],
      tailLimit: 0,
      async run(mark) {
        let failing = 5;
        const a = stage("a", pass);
        const b = stage("b", async (ctx) => {
          if (failing > 0) {
            failing--;
            throw new Error(`b down ${failing}`);
          }
          return { output: ctx.input };
        });
        const h = tickingHarness([
          new WorkflowBuilder("wf", "wf", "d", io, io).pipe(a).pipe(b).build(),
        ]);
        await h.start("other", { v: "o" });
        const { workflowRunId: runId } = await h.run("wf", { v: "x" });
        await mark("g1", h, runId);
        await redrive(h, runId);
        await drain(h, runId, 10);
        await mark("g2", h, runId);
        await redrive(h, runId);
        await drain(h, runId, 10);
        await mark("g3", h, runId);
        await redrive(h, runId, { kind: "start" });
        await drain(h, runId, 10);
        return { h, runId };
      },
    },
    {
      name: "parallel group, one member fails, redrive, redrive from stage",
      marks: ["g1", "g2"],
      tailLimit: 0,
      async run(mark) {
        let failing = 3;
        const p = stage("p", async (ctx) => {
          if (failing > 0) {
            failing--;
            throw new Error("p down");
          }
          return { output: ctx.input };
        });
        const h = tickingHarness([
          new WorkflowBuilder("wf", "wf", "d", io, io)
            .parallel([p, stage("q", pass)])
            .pipe(stage("c", pass))
            .build(),
        ]);
        const { workflowRunId: runId } = await h.run("wf", { v: "x" });
        await mark("g1", h, runId);
        await redrive(h, runId);
        await drain(h, runId, 10);
        await mark("g2", h, runId);
        await redrive(h, runId, { kind: "stage", stageId: "q" });
        await drain(h, runId, 10);
        return { h, runId };
      },
    },
    {
      name: "suspended stage with a poll retry, redrive from stage",
      marks: ["g1", "g2"],
      tailLimit: 0,
      async run(mark) {
        let replays = 0;
        const s = stage("s", async (ctx) => {
          await ctx.step.sleep("nap", "1m");
          await ctx.step.run("after-nap", async () => {
            replays++;
            if (replays === 1) throw new Error("flaky after the wait");
            return "ok";
          });
          return { output: ctx.input };
        });
        const h = tickingHarness([
          new WorkflowBuilder("wf", "wf", "d", io, io)
            .pipe(s)
            .pipe(stage("c", pass))
            .build(),
        ]);
        const { workflowRunId: runId } = await h.run("wf", { v: "x" });
        await mark("g1", h, runId);
        await redrive(h, runId, { kind: "stage", stageId: "s" });
        await drain(h, runId, 14);
        await mark("g2", h, runId);
        await redrive(h, runId, { kind: "start" });
        await drain(h, runId, 14);
        return { h, runId };
      },
    },
    {
      name: "cancel while running, redrive, cancel again, redrive",
      marks: ["g1", "g2", "g3"],
      tailLimit: 0,
      async run(mark) {
        let h: any;
        let runId = "";
        let runs = 0;
        const slow = stage("slow", async (ctx) => {
          runs++;
          await ctx.step.run(`w${runs}`, async () => "x");
          if (runs <= 2)
            await h.kernel.dispatch({
              type: "run.cancel",
              workflowRunId: runId,
            });
          return { output: ctx.input };
        });
        h = tickingHarness([
          new WorkflowBuilder("wf", "wf", "d", io, io)
            .pipe(slow)
            .pipe(stage("c", pass))
            .build(),
        ]);
        runId = (await h.start("wf", { v: "x" })).workflowRunId;
        await drain(h, runId, 4);
        await mark("g1", h, runId);
        await redrive(h, runId);
        await drain(h, runId, 4);
        await mark("g2", h, runId);
        await redrive(h, runId);
        await drain(h, runId, 6);
        await mark("g3", h, runId);
        await redrive(h, runId, { kind: "start" });
        await drain(h, runId, 6);
        return { h, runId };
      },
    },
    {
      name: "reapStuck of a suspended stage, redrive",
      marks: ["g1"],
      tailLimit: 0,
      async run(mark) {
        const nap = stage("nap", async (ctx) => {
          await ctx.step.sleep("nap", "20m");
          return { output: ctx.input };
        });
        const h = harnessOn(
          new WorkflowBuilder("wf", "wf", "d", io, io).pipe(nap).build(),
        );
        const runId = (await h.start("wf", { v: "x" })).workflowRunId;
        await h.kernel.dispatch({ type: "run.claimPending", workerId: "w" });
        await h.kernel.dispatch({
          type: "job.execute",
          workflowRunId: runId,
          workflowId: "wf",
          stageId: "nap",
          config: {},
        });
        h.clock.advance(30 * 60_000);
        await h.kernel.dispatch({
          type: "run.reapStuck",
          stuckThresholdMs: 5 * 60_000,
        });
        await mark("g1", h, runId);
        await redrive(h, runId);
        await drain(h, runId, 14);
        return { h, runId };
      },
    },
    {
      name: "crash re-delivery, completed, redrive from start",
      marks: ["g1", "g2"],
      tailLimit: 2,
      async run(mark) {
        let h: any;
        let runId = "";
        let calls = 0;
        const slow = stage("slow", async (ctx) => {
          calls++;
          await ctx.step.run(`w${calls}`, async () => "x");
          // The first worker never comes back; the re-delivery's start is
          // written when the mark removes rows.
          if (calls === 1) await new Promise(() => {});
          if (calls === 2) await mark("g1", h, runId);
          return { output: ctx.input };
        });
        h = harnessOn(
          new WorkflowBuilder("wf", "wf", "d", io, io)
            .pipe(slow)
            .pipe(stage("c", pass))
            .build(),
        );
        runId = (await h.start("wf", { v: "x" })).workflowRunId;
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
        while (calls === 0) await new Promise((r) => setTimeout(r, 1));
        h.clock.advance(5_000);
        await h.jobQueue.fail(first.jobId, "worker crashed", true);
        const second = await h.jobQueue.dequeue();
        await execute(second);
        await h.jobQueue.complete(second.jobId);
        await h.kernel.dispatch({
          type: "run.transition",
          workflowRunId: runId,
        });
        await drain(h, runId, 10);
        await mark("g2", h, runId);
        await redrive(h, runId, { kind: "start" });
        await drain(h, runId, 10);
        return { h, runId };
      },
    },
    {
      name: "cancel while b runs, redrive from a later stage c, then from b",
      marks: ["g1", "g2"],
      tailLimit: 0,
      async run(mark) {
        // A redrive from c keeps b's row CANCELLED (G6).
        let h: any;
        let runId = "";
        let runs = 0;
        const b = stage("b", async (ctx) => {
          runs++;
          await ctx.step.run(`w${runs}`, async () => "x");
          if (runs === 1)
            await h.kernel.dispatch({
              type: "run.cancel",
              workflowRunId: runId,
            });
          return { output: ctx.input };
        });
        h = tickingHarness([
          new WorkflowBuilder("wf", "wf", "d", io, io)
            .pipe(stage("a", pass))
            .pipe(b)
            .pipe(stage("c", pass))
            .build(),
        ]);
        runId = (await h.start("wf", { v: "x" })).workflowRunId;
        await drain(h, runId, 6);
        await mark("g1", h, runId);
        await redrive(h, runId, { kind: "stage", stageId: "c" });
        await drain(h, runId, 6);
        await mark("g2", h, runId);
        await redrive(h, runId, { kind: "stage", stageId: "b" });
        await drain(h, runId, 6);
        return { h, runId };
      },
    },
    {
      name: "cancelled before its first stage started, redrive",
      marks: ["g1"],
      tailLimit: 0,
      async run(mark) {
        const h = tickingHarness([
          new WorkflowBuilder("wf", "wf", "d", io, io)
            .parallel([stage("p", pass), stage("q", pass)])
            .pipe(stage("c", pass))
            .build(),
        ]);
        const runId = (await h.start("wf", { v: "x" })).workflowRunId;
        await h.kernel.dispatch({ type: "run.claimPending", workerId: "w" });
        await h.kernel.dispatch({ type: "run.cancel", workflowRunId: runId });
        await mark("g1", h, runId);
        await redrive(h, runId);
        await drain(h, runId, 6);
        return { h, runId };
      },
    },
    {
      name: "job retry, completed, redrive from start, redrive from stage",
      marks: ["g1", "g2"],
      tailLimit: 0,
      async run(mark) {
        let calls = 0;
        const a = stage("a", async (ctx) => {
          calls++;
          if (calls === 1) throw new Error("upstream 503");
          return { output: ctx.input };
        });
        const h = tickingHarness([
          new WorkflowBuilder("wf", "wf", "d", io, io)
            .pipe(a)
            .pipe(stage("b", pass))
            .build(),
        ]);
        const { workflowRunId: runId } = await h.run("wf", { v: "x" });
        await mark("g1", h, runId);
        await redrive(h, runId, { kind: "start" });
        await drain(h, runId, 10);
        await mark("g2", h, runId);
        await redrive(h, runId, { kind: "stage", stageId: "b" });
        await drain(h, runId, 10);
        return { h, runId };
      },
    },
  ];

  /** mulberry32: the same removals on every run. */
  function prng(seed: number) {
    return () => {
      seed |= 0;
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function purgesFor(n: number, rand: () => number): Purge[] {
    const out: Purge[] = [
      { name: "all", keep: () => false },
      { name: "only seq 1", keep: (r) => r.sequence === 1 },
      {
        name: "only workflow:* rows",
        keep: (r) => r.eventType.startsWith("workflow:"),
      },
      {
        name: "no workflow:started",
        keep: (r) => r.eventType !== "workflow:started",
      },
      {
        name: "no stage:* rows",
        keep: (r) => !r.eventType.startsWith("stage:"),
      },
      {
        name: "no progress/annotation rows",
        keep: (r) => !/progress|annotation/.test(r.eventType),
      },
    ];
    for (let k = 1; k < n; k++) {
      out.push({ name: `prefix ${k}`, keep: (r) => r.sequence > k });
      out.push({ name: `head ${k}`, keep: (r) => r.sequence <= k });
    }
    for (let i = 2; i < n; i++)
      out.push({ name: `middle ${i}`, keep: (r) => r.sequence !== i });
    for (let t = 0; t < 40; t++) {
      const p = 0.2 + rand() * 0.6;
      const drop = new Set<number>();
      for (let i = 1; i <= n; i++) if (rand() > p) drop.add(i);
      out.push({
        name: `random drop {${[...drop].join(",")}}`,
        keep: (r) => !drop.has(r.sequence),
      });
    }
    return out;
  }

  const project = (history: StageAttemptHistory, steps = true) =>
    history.available
      ? {
          attempts: history.attempts.map((a) => ({
            trigger: a.trigger,
            outcome: a.outcome,
            executed: a.executed,
            events: a.events.map((e) => e.eventType),
            error: a.error,
            ...(steps ? { steps: a.steps.map((s) => s.stepId) } : {}),
          })),
          ...(steps
            ? { unplaced: history.unplacedSteps.map((s) => s.stepId) }
            : {}),
        }
      : null;

  /** The executions the stage row counts: neither re-deliveries nor their lost predecessors. */
  const counted = (history: StageAttemptHistory) =>
    history.available
      ? history.attempts
          .filter((a) => a.trigger !== "redelivery")
          .map((a) => ({
            trigger: a.trigger,
            executed: a.executed,
            error: a.error,
          }))
      : null;

  async function model(h: any, runId: string) {
    const m = await moment(h, runId);
    const histories = await pageModel(m, () => false);
    const byStage = new Map<string, StageAttemptHistory>();
    for (const s of m.stages) byStage.set(s.stageId, histories.get(s.id)!);
    return byStage;
  }

  /**
   * Runs the scenario with nothing removed and reads the page of every run
   * after each kernel dispatch: a stage it calls unavailable then is a
   * false statement, since nothing was removed.
   */
  async function sampled(scenario: Scenario) {
    const unavailable = new Set<string>();
    let samples = 0;
    onHarness = (h) => {
      const dispatch = h.kernel.dispatch.bind(h.kernel);
      let busy = false;
      h.kernel.dispatch = async (command: any) => {
        const result = await dispatch(command);
        if (!busy && !/^(outbox|lease)\./.test(command.type)) {
          busy = true;
          try {
            for (const runId of (h.persistence as any).runs.keys()) {
              const m = await moment(h, runId);
              const histories = await pageModel(m, () => false);
              samples++;
              for (const stage of m.stages) {
                const got = histories.get(stage.id)!;
                if (!got.available)
                  unavailable.add(
                    `after ${command.type} | run ${m.run.status} | ${stage.stageId} ${stage.status} a=${stage.attempt} | ${got.reason}/${(got as any).mismatch ?? (got as any).runMismatch ?? ""}`,
                  );
              }
            }
          } finally {
            busy = false;
          }
        }
        return result;
      };
    };
    try {
      return { ...(await scenario.run(async () => {})), unavailable, samples };
    } finally {
      onHarness = undefined;
    }
  }

  const forms: StoreForm[] = ["null until started", "stamped at creation"];
  for (const form of forms)
    for (const scenario of scenarios) {
      it(`${scenario.name} (stage start ${form})`, {
        timeout: 600_000,
      }, async () => {
        storeForm = form;
        const kept = await sampled(scenario);
        expect([...kept.unavailable], `${kept.samples} samples`).toEqual([]);
        const truth = await model(kept.h, kept.runId);
        const sizes: Record<string, number> = {};
        await scenario.run(async (label, h, runId) => {
          sizes[label] = (h.persistence.outbox as any[]).filter(
            (r) => r.workflowRunId === runId,
          ).length;
        });

        const outside: string[] = [];
        const limit: string[] = [];
        const visible: string[] = [];
        const check = async (
          shapes: string[],
          how: string,
          w: { h: any; runId: string },
        ) => {
          const got = await model(w.h, w.runId);
          const inLimit =
            shapes.includes(TAIL) &&
            shapes.every((s) => s === TAIL || s === NONE);
          for (const [stageId, g] of got) {
            const t = truth.get(stageId)!;
            const label = `[${shapes.join(" / ")}] ${how} | ${stageId}`;
            if (!g.available) {
              if (t.available && shapes.every((s) => s === NONE))
                outside.push(
                  `${label}: unavailable (${g.reason}) with nothing removed`,
                );
              continue;
            }
            const same =
              t.available &&
              JSON.stringify(project(g)) === JSON.stringify(project(t));
            if (same) continue;
            const finding = `${label}\n      shown: ${JSON.stringify(project(g, false))}\n      kept:  ${JSON.stringify(project(t, false))}`;
            if (!inLimit) {
              outside.push(finding);
              continue;
            }
            limit.push(finding);
            if (
              !t.available ||
              JSON.stringify(counted(g)) !== JSON.stringify(counted(t))
            )
              visible.push(finding);
          }
        };

        const rand = prng(scenario.name.length * 7919);
        let trials = 0;
        for (const mark of scenario.marks) {
          for (const purge of purgesFor(sizes[mark]!, rand)) {
            let shape = "";
            const w = await scenario.run(async (label, h, runId) => {
              if (label === mark) shape = applyPurge(h, runId, purge);
            });
            trials++;
            await check([shape], `${mark}: ${purge.name}`, w);
          }
        }
        // Two removals, at two marks.
        if (scenario.marks.length > 1) {
          for (let t = 0; t < 150; t++) {
            const i1 = Math.floor(rand() * (scenario.marks.length - 1));
            const m1 = scenario.marks[i1]!;
            const m2 =
              scenario.marks[
                i1 + 1 + Math.floor(rand() * (scenario.marks.length - 1 - i1))
              ]!;
            const p1 = purgesFor(sizes[m1]!, rand);
            const p2 = purgesFor(sizes[m2]! + 3, rand);
            const a = p1[Math.floor(rand() * p1.length)]!;
            const b = p2[Math.floor(rand() * p2.length)]!;
            const shapes: string[] = [];
            const w = await scenario.run(async (label, h, runId) => {
              if (label === m1) shapes.push(applyPurge(h, runId, a));
              if (label === m2) shapes.push(applyPurge(h, runId, b));
            });
            trials++;
            await check(shapes, `${m1}: ${a.name} then ${m2}: ${b.name}`, w);
          }
        }

        if (process.env.ORACLE_TRUTH)
          for (const [id, t] of truth)
            console.log(`kept ${id}: ${JSON.stringify(project(t, false))}`);
        console.log(
          [
            `${scenario.name}: ${trials} removals, ${outside.length} wrong outside the stated limit, ${limit.length} within it`,
            ...limit.map((f) => `  ${f}`),
          ].join("\n"),
        );
        expect(outside).toEqual([]);
        // Every wrong history left is one the row checks cannot see.
        expect(visible).toEqual([]);
        expect(limit.length).toBe(scenario.tailLimit);
        storeForm = "null until started";
      });
    }
});
