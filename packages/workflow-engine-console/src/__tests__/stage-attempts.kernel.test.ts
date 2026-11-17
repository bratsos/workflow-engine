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
import {
  type AttemptEventInput,
  buildStageAttemptHistory,
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
    })),
    steps,
    // Complete: the in-memory outbox is never purged, so its rows are 1..n.
    stageEvents: { events, complete: true },
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

  it("run.reapStuck of a stage waiting for a job retry has no attempt to close and is unavailable", async () => {
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
    expect(shape(failed, "flaky")).toBe("unavailable:history-gap");
  });

  it("a stage started again after its worker died and its lease was reaped is unavailable, not one attempt", async () => {
    let calls = 0;
    const slow = defineStage({
      id: "slow",
      name: "Slow",
      schemas,
      async execute(ctx: any) {
        calls++;
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
    while (!(await h.persistence.getStage(runId, "slow"))) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    // The worker stopped heartbeating ten minutes ago.
    h.jobQueue.setJobLockedAt(first.jobId, new Date(Date.now() - 10 * 60_000));
    const reaped = await h.kernel.dispatch({
      type: "lease.reapStale",
      staleThresholdMs: 60_000,
    });
    expect(reaped.released).toBe(1);
    await execute(await h.jobQueue.dequeue());

    const redelivered = await snapshot(h, runId);
    expect(
      redelivered.events.filter((e) => e.eventType === "stage:started"),
    ).toHaveLength(2);
    expect(shape(redelivered, "slow")).toBe("unavailable:unproven-boundary");
  });
});
