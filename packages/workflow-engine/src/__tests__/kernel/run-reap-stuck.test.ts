import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineStage } from "../../core/stage-factory.js";
import { WorkflowBuilder } from "../../core/workflow.js";
import { FakeClock } from "../../kernel/testing/fake-clock.js";
import { InMemoryStepLedger } from "../../testing/in-memory-step-ledger.js";
import { createTestKernel } from "../utils/index.js";

function createPassthroughStage(id: string, schema: z.ZodTypeAny) {
  return defineStage({
    id,
    name: `Stage ${id}`,
    schemas: { input: schema, output: schema, config: z.object({}) },
    async execute(ctx) {
      return { output: ctx.input };
    },
  });
}

function createSimpleWorkflow(id: string = "test-workflow") {
  const schema = z.object({ data: z.string() });
  const stage = createPassthroughStage("stage-1", schema);
  return new WorkflowBuilder(id, "Test Workflow", "Test", schema, schema)
    .pipe(stage)
    .build();
}

// Every kernel in this file is created with `clockStart: new Date()` so the
// FakeClock aligns with the real `new Date()` timestamps InMemoryWorkflowPersistence
// stamps on records -- otherwise `run.reapStuck`'s elapsed-time math would
// compare a fixed 2025-01-01 clock against real "now" timestamps.

describe("kernel: run.reapStuck", () => {
  it("marks stuck RUNNING run as FAILED when no activity past threshold", async () => {
    const workflow = createSimpleWorkflow();
    const { kernel, persistence, clock } = createTestKernel([workflow], {
      clockStart: new Date(),
    });

    await kernel.dispatch({
      type: "run.create",
      idempotencyKey: "key-1",
      workflowId: "test-workflow",
      input: { data: "hello" },
    });
    await kernel.dispatch({ type: "run.claimPending", workerId: "w1" });

    // Advance clock past stuck threshold
    clock.advance(10 * 60 * 1000); // 10 minutes

    const result = await kernel.dispatch({
      type: "run.reapStuck",
      stuckThresholdMs: 5 * 60 * 1000,
    });

    expect(result.failed).toBe(1);

    const failedRuns = await persistence.getRunsByStatus("FAILED");
    expect(failedRuns).toHaveLength(1);
    expect((failedRuns[0]!.output as any).error.code).toBe("STUCK_RUN_REAPED");
  });

  it("does not reap runs with recent activity", async () => {
    const workflow = createSimpleWorkflow();
    const { kernel, clock } = createTestKernel([workflow], {
      clockStart: new Date(),
    });

    await kernel.dispatch({
      type: "run.create",
      idempotencyKey: "key-1",
      workflowId: "test-workflow",
      input: { data: "hello" },
    });
    await kernel.dispatch({ type: "run.claimPending", workerId: "w1" });

    // Only advance 1 minute (below 5min threshold)
    clock.advance(60 * 1000);

    const result = await kernel.dispatch({
      type: "run.reapStuck",
      stuckThresholdMs: 5 * 60 * 1000,
    });

    expect(result.failed).toBe(0);
    expect(result.transitioned).toBe(0);
  });

  it("does not reap PENDING or COMPLETED runs", async () => {
    const workflow = createSimpleWorkflow();
    const { kernel, clock } = createTestKernel([workflow], {
      clockStart: new Date(),
    });

    // Create a run that stays PENDING (never claimed)
    await kernel.dispatch({
      type: "run.create",
      idempotencyKey: "key-1",
      workflowId: "test-workflow",
      input: { data: "hello" },
    });

    clock.advance(10 * 60 * 1000);

    const result = await kernel.dispatch({
      type: "run.reapStuck",
      stuckThresholdMs: 5 * 60 * 1000,
    });

    // PENDING runs should NOT be reaped
    expect(result.failed).toBe(0);
  });

  it("skips reaping a run that recovered between query and update", async () => {
    const workflow = createSimpleWorkflow();
    const { kernel, persistence, jobTransport, clock } = createTestKernel(
      [workflow],
      { clockStart: new Date() },
    );

    const { workflowRunId } = await kernel.dispatch({
      type: "run.create",
      idempotencyKey: "key-1",
      workflowId: "test-workflow",
      input: { data: "hello" },
    });
    await kernel.dispatch({ type: "run.claimPending", workerId: "w1" });

    // Execute the job so the run completes (recovers)
    const job = await jobTransport.dequeue();
    await kernel.dispatch({
      type: "job.execute",
      workflowRunId: job!.workflowRunId,
      workflowId: job!.workflowId,
      stageId: job!.stageId,
      config: {},
    });
    await jobTransport.complete(job!.jobId);
    await kernel.dispatch({ type: "run.transition", workflowRunId });

    // Now the run is COMPLETED — advance clock and try to reap
    clock.advance(10 * 60 * 1000);

    // Simulate race: getStuckRuns might return this run (in real code,
    // the query filters by RUNNING, but the status guard provides defense-in-depth)
    const result = await kernel.dispatch({
      type: "run.reapStuck",
      stuckThresholdMs: 5 * 60 * 1000,
    });

    expect(result.failed).toBe(0);
    const run = await persistence.getRun(workflowRunId);
    expect(run!.status).toBe("COMPLETED");
  });

  it("reports transitioned equal to failed (the only transition it performs)", async () => {
    const workflow = createSimpleWorkflow();
    const { kernel, clock } = createTestKernel([workflow], {
      clockStart: new Date(),
    });

    await kernel.dispatch({
      type: "run.create",
      idempotencyKey: "key-1",
      workflowId: "test-workflow",
      input: { data: "hello" },
    });
    await kernel.dispatch({ type: "run.claimPending", workerId: "w1" });

    clock.advance(10 * 60 * 1000);

    const result = await kernel.dispatch({
      type: "run.reapStuck",
      stuckThresholdMs: 5 * 60 * 1000,
    });

    expect(result.failed).toBe(1);
    expect(result.transitioned).toBe(1);
  });

  it("does not double-reap when a concurrent updateRun changed the version first (version guard)", async () => {
    const workflow = createSimpleWorkflow();
    const { kernel, persistence, clock } = createTestKernel([workflow], {
      clockStart: new Date(),
    });

    const { workflowRunId } = await kernel.dispatch({
      type: "run.create",
      idempotencyKey: "key-race",
      workflowId: "test-workflow",
      input: { data: "hello" },
    });
    await kernel.dispatch({ type: "run.claimPending", workerId: "w1" });

    clock.advance(10 * 60 * 1000);

    // Simulate a second host's reaper winning the race: it bumps the
    // run's version out from under the query snapshot used below.
    const runBeforeRace = await persistence.getRun(workflowRunId);
    await persistence.updateRun(workflowRunId, {
      expectedVersion: runBeforeRace!.version,
      status: "FAILED",
      completedAt: clock.now(),
    });

    const result = await kernel.dispatch({
      type: "run.reapStuck",
      stuckThresholdMs: 5 * 60 * 1000,
    });

    // The run is already FAILED (status guard), so this host's reap is a
    // no-op — it must not throw or double-count.
    expect(result.failed).toBe(0);
    expect(result.transitioned).toBe(0);
  });

  it("re-enqueues a PENDING stage with no matching job instead of failing the run (enqueue-outside-tx recovery)", async () => {
    const workflow = createSimpleWorkflow();
    const { kernel, persistence, jobTransport, clock } = createTestKernel(
      [workflow],
      { clockStart: new Date() },
    );

    const { workflowRunId } = await kernel.dispatch({
      type: "run.create",
      idempotencyKey: "key-recovery",
      workflowId: "test-workflow",
      input: { data: "hello" },
    });
    await kernel.dispatch({ type: "run.claimPending", workerId: "w1" });

    // Simulate the enqueue-outside-the-transaction race: the stage
    // record is PENDING but its job never made it into the queue (e.g.
    // the process crashed after the DB transaction committed but before
    // jobTransport.enqueueParallel ran).
    jobTransport.clear();
    expect(jobTransport.getAllJobs()).toHaveLength(0);

    clock.advance(10 * 60 * 1000);

    const result = await kernel.dispatch({
      type: "run.reapStuck",
      stuckThresholdMs: 5 * 60 * 1000,
    });

    // Recovered, not reaped.
    expect(result.failed).toBe(0);
    expect(result.transitioned).toBe(0);

    const run = await persistence.getRun(workflowRunId);
    expect(run!.status).toBe("RUNNING");

    // A fresh job was enqueued for the orphaned PENDING stage.
    const jobs = jobTransport.getAllJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.workflowRunId).toBe(workflowRunId);
    expect(jobs[0]!.status).toBe("PENDING");
  });

  it("enqueues the recovery job after the transaction commits, not inside it", async () => {
    const workflow = createSimpleWorkflow();
    const { kernel, persistence, jobTransport, clock } = createTestKernel(
      [workflow],
      { clockStart: new Date() },
    );

    await kernel.dispatch({
      type: "run.create",
      idempotencyKey: "key-recovery-postcommit",
      workflowId: "test-workflow",
      input: { data: "hello" },
    });
    await kernel.dispatch({ type: "run.claimPending", workerId: "w1" });
    jobTransport.clear();

    // Observe whether the enqueue lands while the kernel transaction is
    // still open. An enqueue inside the transaction publishes work that
    // references state another worker cannot see yet (and that a
    // rollback would erase) — the shape that wedged runs before alpha.8.
    let inTransaction = false;
    const enqueuedInTransaction: boolean[] = [];
    const originalWithTransaction =
      persistence.withTransaction.bind(persistence);
    persistence.withTransaction = async (fn: any) => {
      inTransaction = true;
      try {
        return await originalWithTransaction(fn);
      } finally {
        inTransaction = false;
      }
    };
    const originalEnqueueParallel =
      jobTransport.enqueueParallel.bind(jobTransport);
    jobTransport.enqueueParallel = async (jobs: any) => {
      enqueuedInTransaction.push(inTransaction);
      return originalEnqueueParallel(jobs);
    };

    clock.advance(10 * 60 * 1000);

    await kernel.dispatch({
      type: "run.reapStuck",
      stuckThresholdMs: 5 * 60 * 1000,
    });

    expect(enqueuedInTransaction).toEqual([false]);
    expect(jobTransport.getAllJobs()).toHaveLength(1);
  });

  it("leaves a run pinned to a version this build does not serve", async () => {
    // A run stranded by a rolling deploy looks exactly like a stuck run
    // from a host that cannot serve it: nothing here touches the run or
    // its stages, so it crosses the threshold untouched. Reaping it would
    // fail a run that is healthy on the build that owns it.
    const schema = z.object({ data: z.string() });
    const v1 = new WorkflowBuilder(
      "pinned-wf",
      "Pinned",
      "Test",
      schema,
      schema,
    )
      .pipe(createPassthroughStage("stage-1", schema))
      .build();
    const v2 = new WorkflowBuilder(
      "pinned-wf",
      "Pinned",
      "Test",
      schema,
      schema,
    )
      .pipe(createPassthroughStage("stage-1", schema))
      .pipe(createPassthroughStage("stage-2", schema))
      .build();

    const { kernel, persistence, registry, clock } = createTestKernel([v1], {
      clockStart: new Date(),
    });
    const created = await kernel.dispatch({
      type: "run.create",
      idempotencyKey: "pinned-1",
      workflowId: v1.id,
      input: { data: "hello" },
    });
    await kernel.dispatch({ type: "run.claimPending", workerId: "w1" });

    // The deploy lands: this process now presents a different structure.
    registry.set(v1.id, v2);
    clock.advance(10 * 60 * 1000);

    const result = await kernel.dispatch({
      type: "run.reapStuck",
      stuckThresholdMs: 5 * 60 * 1000,
    });

    expect(result.failed).toBe(0);
    const run = await persistence.getRun(created.workflowRunId);
    expect(run!.status).toBe("RUNNING");
  });
});

describe("kernel: run.reapStuck dropped-transition heal", () => {
  it("heals a wedged run (all stages terminal, transition dropped) instead of failing it", async () => {
    const workflow = createSimpleWorkflow();
    const { kernel, persistence, clock } = createTestKernel([workflow], {
      clockStart: new Date(),
    });

    const { workflowRunId } = await kernel.dispatch({
      type: "run.create",
      idempotencyKey: "key-heal-1",
      workflowId: "test-workflow",
      input: { data: "hello" },
    });
    await kernel.dispatch({ type: "run.claimPending", workerId: "w1" });

    // Execute the only stage, but never fire run.transition — the state a
    // dead host (or a double stale-claim noop) leaves behind: every stage
    // terminal, run still RUNNING.
    await kernel.dispatch({
      type: "job.execute",
      workflowRunId,
      workflowId: "test-workflow",
      stageId: "stage-1",
      config: {},
    });

    clock.advance(10 * 60 * 1000);

    const result = await kernel.dispatch({
      type: "run.reapStuck",
      stuckThresholdMs: 5 * 60 * 1000,
    });

    expect(result.healed).toBe(1);
    expect(result.failed).toBe(0);

    const run = await persistence.getRun(workflowRunId);
    expect(run!.status).toBe("COMPLETED");
    expect(run!.output).toEqual({ data: "hello" });
  });
});

describe("kernel: run.reapStuck leaves a run that is waiting on a later poll", () => {
  const THRESHOLD = 5 * 60 * 1000;

  // Runs a stage up to its `ctx.step.sleep("nap", "20m")` suspension: the
  // run and stage rows are written once and then not touched for 20 minutes.
  async function suspendOnLongSleep() {
    const schema = z.object({});
    const stage = defineStage({
      id: "nap",
      name: "Nap",
      schemas: { input: schema, output: schema, config: schema },
      async execute(ctx) {
        await ctx.step.sleep("nap", "20m");
        return { output: {} };
      },
    });
    const workflow = new WorkflowBuilder(
      "sleepy",
      "Sleepy",
      "Test",
      schema,
      schema,
    )
      .pipe(stage)
      .build();
    const clock = new FakeClock(new Date());
    const env = createTestKernel([workflow], {
      clock,
      stepLedger: new InMemoryStepLedger({ now: () => clock.now() }),
    });
    const { workflowRunId } = await env.kernel.dispatch({
      type: "run.create",
      idempotencyKey: "sleepy-1",
      workflowId: workflow.id,
      input: {},
    });
    await env.kernel.dispatch({ type: "run.claimPending", workerId: "w1" });
    await env.kernel.dispatch({
      type: "job.execute",
      workflowRunId,
      workflowId: workflow.id,
      stageId: stage.id,
      config: {},
    });
    const suspended = await env.persistence.getStage(workflowRunId, stage.id);
    expect(suspended!.status).toBe("SUSPENDED");
    return { ...env, clock, workflowRunId, stage: suspended! };
  }

  it("does not reap a suspended stage whose poll is due later than the threshold, and reaps it once the poll is overdue by a threshold", async () => {
    const { kernel, persistence, clock, workflowRunId, stage } =
      await suspendOnLongSleep();

    // 10 minutes of silence against a 5 minute threshold, poll due in 10 more.
    clock.advance(10 * 60 * 1000);
    const early = await kernel.dispatch({
      type: "run.reapStuck",
      stuckThresholdMs: THRESHOLD,
    });
    expect(early.failed).toBe(0);
    expect((await persistence.getRun(workflowRunId))!.status).toBe("RUNNING");

    // The poll came due 3 minutes ago and nobody has run it yet: still
    // inside one threshold, so the poller keeps its chance.
    clock.advance(13 * 60 * 1000);
    expect(clock.now().getTime() - stage.nextPollAt!.getTime()).toBe(
      3 * 60 * 1000,
    );
    const due = await kernel.dispatch({
      type: "run.reapStuck",
      stuckThresholdMs: THRESHOLD,
    });
    expect(due.failed).toBe(0);

    // Overdue for more than a threshold: nothing is polling it.
    clock.advance(3 * 60 * 1000);
    const overdue = await kernel.dispatch({
      type: "run.reapStuck",
      stuckThresholdMs: THRESHOLD,
    });
    expect(overdue.failed).toBe(1);
    const run = await persistence.getRun(workflowRunId);
    expect(run!.status).toBe("FAILED");
    expect((run!.output as any).error.code).toBe("STUCK_RUN_REAPED");
  });

  it("still reaps a suspended stage that has no poll scheduled", async () => {
    const { kernel, persistence, clock, workflowRunId, stage } =
      await suspendOnLongSleep();
    await persistence.updateStage(stage.id, { nextPollAt: null });

    clock.advance(10 * 60 * 1000);
    const result = await kernel.dispatch({
      type: "run.reapStuck",
      stuckThresholdMs: THRESHOLD,
    });

    expect(result.failed).toBe(1);
    expect((await persistence.getRun(workflowRunId))!.status).toBe("FAILED");
  });
});
