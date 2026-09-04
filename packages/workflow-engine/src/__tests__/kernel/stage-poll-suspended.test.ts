import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  defineAsyncBatchStage,
  defineStage,
} from "../../core/stage-factory.js";
import { WorkflowBuilder } from "../../core/workflow.js";
import type { Kernel } from "../../kernel/kernel.js";
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

function createTwoStageWorkflow(id: string = "test-workflow") {
  const schema = z.object({ data: z.string() });
  const stage1 = createPassthroughStage("stage-1", schema);
  const stage2 = createPassthroughStage("stage-2", schema);
  return new WorkflowBuilder(id, "Test Workflow", "Test", schema, schema)
    .pipe(stage1)
    .pipe(stage2)
    .build();
}

describe("kernel: stage.pollSuspended", () => {
  it("resumes a completed suspended stage", async () => {
    const schema = z.object({ data: z.string() });
    let pollCount = 0;

    const stage = defineAsyncBatchStage({
      id: "batch-stage",
      name: "Batch Stage",
      mode: "async-batch",
      schemas: {
        input: schema,
        output: z.object({ result: z.string() }),
        config: z.object({}),
      },
      async execute() {
        return {
          suspended: true,
          state: {
            batchId: "batch-1",
            submittedAt: new Date().toISOString(),
            pollInterval: 1000,
            maxWaitTime: 60000,
          },
          pollConfig: {
            pollInterval: 1000,
            maxWaitTime: 60000,
            nextPollAt: new Date(Date.now() + 1000),
          },
        };
      },
      async checkCompletion() {
        pollCount++;
        return { ready: true, output: { result: "batch completed" } };
      },
    });

    const workflow = new WorkflowBuilder(
      "test-workflow",
      "Test",
      "Test",
      schema,
      z.object({ result: z.string() }),
    )
      .pipe(stage)
      .build();

    const { kernel, persistence, blobStore, clock, eventSink } =
      createTestKernel([workflow]);

    // Create run and a suspended stage
    const run = await persistence.createRun({
      workflowId: "test-workflow",
      workflowName: "Test",
      workflowType: "test-workflow",
      input: { data: "hello" },
    });

    await persistence.updateRun(run.id, { status: "RUNNING" });

    await persistence.createStage({
      workflowRunId: run.id,
      stageId: "batch-stage",
      stageName: "Batch Stage",
      stageNumber: 1,
      executionGroup: 1,
      status: "SUSPENDED",
      startedAt: clock.now(),
    });

    // Set the stage's nextPollAt to be in the past
    const stages = await persistence.getStagesByRun(run.id);
    await persistence.updateStage(stages[0]!.id, {
      suspendedState: {
        batchId: "batch-1",
        submittedAt: new Date().toISOString(),
        pollInterval: 1000,
        maxWaitTime: 60000,
      },
      nextPollAt: new Date(clock.now().getTime() - 1000),
      pollInterval: 1000,
    });

    eventSink.clear();

    const result = await kernel.dispatch({
      type: "stage.pollSuspended",
    });

    expect(result.checked).toBe(1);
    expect(result.resumed).toBe(1);
    expect(result.failed).toBe(0);
    expect(pollCount).toBe(1);

    // Verify stage is now completed
    const updatedStages = await persistence.getStagesByRun(run.id);
    expect(updatedStages[0]!.status).toBe("COMPLETED");

    // Verify output was stored in blobStore
    expect(blobStore.size()).toBeGreaterThan(0);
  });

  it("completes stage when checkCompletion returns ready without output", async () => {
    const schema = z.object({ data: z.string() });

    const stage = defineAsyncBatchStage({
      id: "batch-stage",
      name: "Batch Stage",
      mode: "async-batch",
      schemas: {
        input: schema,
        output: z.object({ result: z.string().optional() }),
        config: z.object({}),
      },
      async execute() {
        return {
          suspended: true,
          state: { batchId: "batch-1" },
          pollConfig: {
            pollInterval: 1000,
            maxWaitTime: 60000,
            nextPollAt: new Date(Date.now() + 1000),
          },
        };
      },
      async checkCompletion() {
        return { ready: true };
      },
    });

    const workflow = new WorkflowBuilder(
      "test-workflow",
      "Test",
      "Test",
      schema,
      z.object({ result: z.string().optional() }),
    )
      .pipe(stage)
      .build();

    const { kernel, persistence, clock } = createTestKernel([workflow]);

    const run = await persistence.createRun({
      workflowId: "test-workflow",
      workflowName: "Test",
      workflowType: "test-workflow",
      input: { data: "hello" },
    });

    await persistence.updateRun(run.id, { status: "RUNNING" });

    await persistence.createStage({
      workflowRunId: run.id,
      stageId: "batch-stage",
      stageName: "Batch Stage",
      stageNumber: 1,
      executionGroup: 1,
      status: "SUSPENDED",
      startedAt: clock.now(),
    });

    const stages = await persistence.getStagesByRun(run.id);
    await persistence.updateStage(stages[0]!.id, {
      suspendedState: { batchId: "batch-1" },
      nextPollAt: new Date(clock.now().getTime() - 1000),
      pollInterval: 1000,
    });

    const result = await kernel.dispatch({ type: "stage.pollSuspended" });

    expect(result.checked).toBe(1);
    expect(result.resumed).toBe(1);
    expect(result.resumedWorkflowRunIds).toEqual([run.id]);

    const updatedStage = await persistence.getStage(run.id, "batch-stage");
    expect(updatedStage?.status).toBe("COMPLETED");
    expect(updatedStage?.nextPollAt).toBeNull();
  });

  it("logs a WARN and persists the raw output when checkCompletion's output fails schema validation", async () => {
    const schema = z.object({ data: z.string() });

    const stage = defineAsyncBatchStage({
      id: "batch-stage",
      name: "Batch Stage",
      mode: "async-batch",
      schemas: {
        input: schema,
        output: z.object({ result: z.string() }),
        config: z.object({}),
      },
      async execute() {
        return {
          suspended: true,
          state: { batchId: "batch-1" },
          pollConfig: {
            pollInterval: 1000,
            maxWaitTime: 60000,
            nextPollAt: new Date(Date.now() + 1000),
          },
        };
      },
      // Returns an output shape that does not satisfy outputSchema
      // (`result` is required, not present here) — the handler must fall
      // back to persisting the raw output rather than throwing.
      async checkCompletion() {
        return { ready: true, output: { unexpectedField: 123 } as any };
      },
    });

    const workflow = new WorkflowBuilder(
      "test-workflow",
      "Test",
      "Test",
      schema,
      z.object({ result: z.string() }),
    )
      .pipe(stage)
      .build();

    const { kernel, persistence, blobStore, clock } = createTestKernel([
      workflow,
    ]);

    const run = await persistence.createRun({
      workflowId: "test-workflow",
      workflowName: "Test",
      workflowType: "test-workflow",
      input: { data: "hello" },
    });

    await persistence.updateRun(run.id, { status: "RUNNING" });

    await persistence.createStage({
      workflowRunId: run.id,
      stageId: "batch-stage",
      stageName: "Batch Stage",
      stageNumber: 1,
      executionGroup: 1,
      status: "SUSPENDED",
      startedAt: clock.now(),
    });

    const stages = await persistence.getStagesByRun(run.id);
    await persistence.updateStage(stages[0]!.id, {
      suspendedState: { batchId: "batch-1" },
      nextPollAt: new Date(clock.now().getTime() - 1000),
      pollInterval: 1000,
    });

    const result = await kernel.dispatch({ type: "stage.pollSuspended" });

    // No behavior change beyond the log: the stage still resumes/completes
    // with the raw (unvalidated) output persisted.
    expect(result.resumed).toBe(1);
    const updatedStage = await persistence.getStage(run.id, "batch-stage");
    expect(updatedStage?.status).toBe("COMPLETED");
    expect(blobStore.size()).toBeGreaterThan(0);

    const logs = persistence.getAllLogs();
    const warnLog = logs.find(
      (log) => log.level === "WARN" && /validation/i.test(log.message),
    );
    expect(warnLog).toBeDefined();
    expect(warnLog?.message).toMatch(/batch-stage/);
  });

  it("reschedules when not ready", async () => {
    const schema = z.object({ data: z.string() });

    const stage = defineAsyncBatchStage({
      id: "batch-stage",
      name: "Batch Stage",
      mode: "async-batch",
      schemas: {
        input: schema,
        output: z.object({ result: z.string() }),
        config: z.object({}),
      },
      async execute() {
        return {
          suspended: true,
          state: {
            batchId: "batch-1",
            submittedAt: new Date().toISOString(),
            pollInterval: 5000,
            maxWaitTime: 60000,
          },
          pollConfig: {
            pollInterval: 5000,
            maxWaitTime: 60000,
            nextPollAt: new Date(Date.now() + 5000),
          },
        };
      },
      async checkCompletion() {
        return { ready: false, nextCheckIn: 30000 };
      },
    });

    const workflow = new WorkflowBuilder(
      "test-workflow",
      "Test",
      "Test",
      schema,
      z.object({ result: z.string() }),
    )
      .pipe(stage)
      .build();

    const { kernel, persistence, clock } = createTestKernel([workflow]);

    const run = await persistence.createRun({
      workflowId: "test-workflow",
      workflowName: "Test",
      workflowType: "test-workflow",
      input: { data: "hello" },
    });

    await persistence.updateRun(run.id, { status: "RUNNING" });

    await persistence.createStage({
      workflowRunId: run.id,
      stageId: "batch-stage",
      stageName: "Batch Stage",
      stageNumber: 1,
      executionGroup: 1,
      status: "SUSPENDED",
      startedAt: clock.now(),
    });

    const stages = await persistence.getStagesByRun(run.id);
    await persistence.updateStage(stages[0]!.id, {
      suspendedState: {
        batchId: "batch-1",
        submittedAt: new Date().toISOString(),
        pollInterval: 5000,
        maxWaitTime: 60000,
      },
      nextPollAt: new Date(clock.now().getTime() - 1000),
      pollInterval: 5000,
    });

    const result = await kernel.dispatch({
      type: "stage.pollSuspended",
    });

    expect(result.checked).toBe(1);
    expect(result.resumed).toBe(0);

    // Stage should still be suspended with updated nextPollAt
    const updatedStages = await persistence.getStagesByRun(run.id);
    expect(updatedStages[0]!.status).toBe("SUSPENDED");
    expect(updatedStages[0]!.nextPollAt).toBeDefined();
  });

  it("returns zeros when no suspended stages", async () => {
    const { kernel } = createTestKernel([]);

    const result = await kernel.dispatch({
      type: "stage.pollSuspended",
    });

    expect(result.checked).toBe(0);
    expect(result.resumed).toBe(0);
    expect(result.failed).toBe(0);
  });

  it("handles checkCompletion error", async () => {
    const schema = z.object({ data: z.string() });

    const stage = defineAsyncBatchStage({
      id: "batch-stage",
      name: "Batch Stage",
      mode: "async-batch",
      schemas: {
        input: schema,
        output: z.object({ result: z.string() }),
        config: z.object({}),
      },
      async execute() {
        return {
          suspended: true,
          state: {
            batchId: "batch-1",
            submittedAt: new Date().toISOString(),
            pollInterval: 1000,
            maxWaitTime: 60000,
          },
          pollConfig: {
            pollInterval: 1000,
            maxWaitTime: 60000,
            nextPollAt: new Date(Date.now() + 1000),
          },
        };
      },
      async checkCompletion() {
        return { ready: false, error: "Provider API unavailable" };
      },
    });

    const workflow = new WorkflowBuilder(
      "test-workflow",
      "Test",
      "Test",
      schema,
      z.object({ result: z.string() }),
    )
      .pipe(stage)
      .build();

    const { kernel, persistence, clock } = createTestKernel([workflow]);

    const run = await persistence.createRun({
      workflowId: "test-workflow",
      workflowName: "Test",
      workflowType: "test-workflow",
      input: { data: "hello" },
    });

    await persistence.updateRun(run.id, { status: "RUNNING" });

    await persistence.createStage({
      workflowRunId: run.id,
      stageId: "batch-stage",
      stageName: "Batch Stage",
      stageNumber: 1,
      executionGroup: 1,
      status: "SUSPENDED",
      startedAt: clock.now(),
    });

    const stages = await persistence.getStagesByRun(run.id);
    await persistence.updateStage(stages[0]!.id, {
      suspendedState: {
        batchId: "batch-1",
        submittedAt: new Date().toISOString(),
        pollInterval: 1000,
        maxWaitTime: 60000,
      },
      nextPollAt: new Date(clock.now().getTime() - 1000),
    });

    const result = await kernel.dispatch({
      type: "stage.pollSuspended",
    });

    expect(result.failed).toBe(1);

    // Stage should be failed
    const updatedStages = await persistence.getStagesByRun(run.id);
    expect(updatedStages[0]!.status).toBe("FAILED");

    // Run should be failed
    const updatedRun = await persistence.getRun(run.id);
    expect(updatedRun!.status).toBe("FAILED");
  });

  it("fails a suspended stage that exceeded maxWaitUntil instead of polling forever", async () => {
    const schema = z.object({ data: z.string() });

    const stage = defineAsyncBatchStage({
      id: "batch-stage",
      name: "Batch Stage",
      mode: "async-batch",
      schemas: {
        input: schema,
        output: z.object({ result: z.string() }),
        config: z.object({}),
      },
      async execute() {
        return {
          suspended: true,
          state: { batchId: "batch-1" },
          pollConfig: {
            pollInterval: 1000,
            maxWaitTime: 60000,
            nextPollAt: new Date(Date.now() + 1000),
          },
        };
      },
      // Never reports ready or an error — the provider is permanently
      // stuck. Without maxWaitUntil enforcement this stage (and the run)
      // would poll forever.
      async checkCompletion() {
        return { ready: false, nextCheckIn: 30000 };
      },
    });

    const workflow = new WorkflowBuilder(
      "test-workflow",
      "Test",
      "Test",
      schema,
      z.object({ result: z.string() }),
    )
      .pipe(stage)
      .build();

    const { kernel, persistence, clock } = createTestKernel([workflow]);

    const run = await persistence.createRun({
      workflowId: "test-workflow",
      workflowName: "Test",
      workflowType: "test-workflow",
      input: { data: "hello" },
    });

    await persistence.updateRun(run.id, { status: "RUNNING" });

    await persistence.createStage({
      workflowRunId: run.id,
      stageId: "batch-stage",
      stageName: "Batch Stage",
      stageNumber: 1,
      executionGroup: 1,
      status: "SUSPENDED",
      startedAt: clock.now(),
    });

    const stages = await persistence.getStagesByRun(run.id);
    await persistence.updateStage(stages[0]!.id, {
      suspendedState: { batchId: "batch-1" },
      nextPollAt: new Date(clock.now().getTime() - 1000),
      pollInterval: 1000,
      // Deadline already passed.
      maxWaitUntil: new Date(clock.now().getTime() - 500),
    });

    const result = await kernel.dispatch({
      type: "stage.pollSuspended",
    });

    expect(result.checked).toBe(1);
    expect(result.resumed).toBe(0);
    expect(result.failed).toBe(1);

    const updatedStage = await persistence.getStage(run.id, "batch-stage");
    expect(updatedStage?.status).toBe("FAILED");
    expect(updatedStage?.errorMessage).toMatch(/maxWaitUntil/);

    const updatedRun = await persistence.getRun(run.id);
    expect(updatedRun!.status).toBe("FAILED");
  });

  it("reschedules (does not time out) when nextPollAt has passed but maxWaitUntil has not", async () => {
    const schema = z.object({ data: z.string() });

    const stage = defineAsyncBatchStage({
      id: "batch-stage",
      name: "Batch Stage",
      mode: "async-batch",
      schemas: {
        input: schema,
        output: z.object({ result: z.string() }),
        config: z.object({}),
      },
      async execute() {
        return {
          suspended: true,
          state: { batchId: "batch-1" },
          pollConfig: {
            pollInterval: 1000,
            maxWaitTime: 60000,
            nextPollAt: new Date(Date.now() + 1000),
          },
        };
      },
      async checkCompletion() {
        return { ready: false, nextCheckIn: 5000 };
      },
    });

    const workflow = new WorkflowBuilder(
      "test-workflow",
      "Test",
      "Test",
      schema,
      z.object({ result: z.string() }),
    )
      .pipe(stage)
      .build();

    const { kernel, persistence, clock } = createTestKernel([workflow]);

    const run = await persistence.createRun({
      workflowId: "test-workflow",
      workflowName: "Test",
      workflowType: "test-workflow",
      input: { data: "hello" },
    });

    await persistence.updateRun(run.id, { status: "RUNNING" });

    await persistence.createStage({
      workflowRunId: run.id,
      stageId: "batch-stage",
      stageName: "Batch Stage",
      stageNumber: 1,
      executionGroup: 1,
      status: "SUSPENDED",
      startedAt: clock.now(),
    });

    const stages = await persistence.getStagesByRun(run.id);
    await persistence.updateStage(stages[0]!.id, {
      suspendedState: { batchId: "batch-1" },
      nextPollAt: new Date(clock.now().getTime() - 1000),
      pollInterval: 1000,
      // Deadline is well in the future.
      maxWaitUntil: new Date(clock.now().getTime() + 60000),
    });

    const result = await kernel.dispatch({
      type: "stage.pollSuspended",
    });

    expect(result.resumed).toBe(0);
    expect(result.failed).toBe(0);

    const updatedStage = await persistence.getStage(run.id, "batch-stage");
    expect(updatedStage?.status).toBe("SUSPENDED");
  });

  it("does not complete a stage if the run is cancelled during checkCompletion", async () => {
    const schema = z.object({ data: z.string() });
    let kernelRef: Kernel;
    let runIdRef = "";

    const stage = defineAsyncBatchStage({
      id: "batch-stage",
      name: "Batch Stage",
      mode: "async-batch",
      schemas: {
        input: schema,
        output: z.object({ result: z.string() }),
        config: z.object({}),
      },
      async execute() {
        return {
          suspended: true,
          state: { batchId: "batch-1" },
          pollConfig: {
            pollInterval: 1000,
            maxWaitTime: 60000,
            nextPollAt: new Date(Date.now() + 1000),
          },
        };
      },
      async checkCompletion() {
        await kernelRef.dispatch({
          type: "run.cancel",
          workflowRunId: runIdRef,
        });
        return { ready: true, output: { result: "late result" } };
      },
    });

    const workflow = new WorkflowBuilder(
      "test-workflow",
      "Test",
      "Test",
      schema,
      z.object({ result: z.string() }),
    )
      .pipe(stage)
      .build();

    const { kernel, persistence, clock } = createTestKernel([workflow]);
    kernelRef = kernel;

    const run = await persistence.createRun({
      workflowId: "test-workflow",
      workflowName: "Test",
      workflowType: "test-workflow",
      input: { data: "hello" },
    });
    runIdRef = run.id;

    await persistence.updateRun(run.id, { status: "RUNNING" });

    await persistence.createStage({
      workflowRunId: run.id,
      stageId: "batch-stage",
      stageName: "Batch Stage",
      stageNumber: 1,
      executionGroup: 1,
      status: "SUSPENDED",
      startedAt: clock.now(),
    });

    const stages = await persistence.getStagesByRun(run.id);
    await persistence.updateStage(stages[0]!.id, {
      suspendedState: { batchId: "batch-1" },
      nextPollAt: new Date(clock.now().getTime() - 1000),
      pollInterval: 1000,
    });

    const result = await kernel.dispatch({
      type: "stage.pollSuspended",
    });

    expect(result.checked).toBe(1);
    expect(result.resumed).toBe(0);

    const updatedRun = await persistence.getRun(run.id);
    expect(updatedRun!.status).toBe("CANCELLED");

    const updatedStage = await persistence.getStage(run.id, "batch-stage");
    expect(updatedStage?.status).toBe("CANCELLED");
  });
});

// ---------------------------------------------------------------------------
// Phase 0: a poller claims a suspended stage before doing any work on it
// ---------------------------------------------------------------------------

/**
 * Runs a durable stage up to its first suspension: the body calls
 * `ctx.step.waitFor` whose `poll` is supplied by the test, so a replay can
 * be made to complete, or to hang until the test releases it.
 */
async function suspendDurableWait(
  poll: () => Promise<{ done: boolean }>,
  timeoutMs = 60 * 60 * 1000,
) {
  let executions = 0;
  const stage = defineStage({
    id: "wait",
    name: "Wait",
    schemas: {
      input: z.object({}),
      output: z.object({ done: z.boolean() }),
      config: z.object({}),
    },
    async execute(ctx) {
      executions++;
      const value = await ctx.step.waitFor("external", {
        poll,
        ready: (result) => result.done,
        every: 1_000,
        timeout: timeoutMs,
      });
      return { output: value };
    },
  });
  const workflow = new WorkflowBuilder(
    "claimed",
    "Claimed",
    "test",
    z.object({}),
    z.object({ done: z.boolean() }),
  )
    .pipe(stage)
    .build();
  const clock = new FakeClock();
  const env = createTestKernel([workflow], {
    clock,
    stepLedger: new InMemoryStepLedger({ now: () => clock.now() }),
  });
  const created = await env.kernel.dispatch({
    type: "run.create",
    idempotencyKey: "claimed",
    workflowId: workflow.id,
    input: {},
  });
  await env.kernel.dispatch({ type: "run.claimPending", workerId: "worker" });
  await env.kernel.dispatch({
    type: "job.execute",
    workflowRunId: created.workflowRunId,
    workflowId: workflow.id,
    stageId: stage.id,
    config: {},
  });
  env.eventSink.clear();
  return {
    ...env,
    runId: created.workflowRunId,
    /** Replays so far: executions beyond the first (suspending) one. */
    replays: () => executions - 1,
  };
}

/**
 * A `poll` that suspends the first execution (not ready), holds the first
 * replay until the test releases it, and answers ready to any later one.
 */
function gatedPoll() {
  let calls = 0;
  let release!: (value: { done: boolean }) => void;
  const gate = new Promise<{ done: boolean }>((resolve) => {
    release = resolve;
  });
  return {
    poll: async () => {
      calls++;
      if (calls === 1) return { done: false };
      if (calls === 2) return gate;
      return { done: true };
    },
    release,
  };
}

/** Lets a dispatched-but-unawaited poll run up to its first real wait. */
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("kernel: stage.pollSuspended claims a stage before working on it", () => {
  it("runs the body once when two polls race for the same suspended stage", async () => {
    let ready = false;
    const env = await suspendDurableWait(async () => ({ done: ready }));
    ready = true;
    env.clock.advance(1_000);

    const [first, second] = await Promise.all([
      env.kernel.dispatch({ type: "stage.pollSuspended" }),
      env.kernel.dispatch({ type: "stage.pollSuspended" }),
    ]);

    expect(env.replays()).toBe(1);
    expect(first.resumed + second.resumed).toBe(1);
    const stage = await env.persistence.getStage(env.runId, "wait");
    expect(stage?.status).toBe("COMPLETED");
    expect(stage?.nextPollAt).toBeNull();

    await env.kernel.dispatch({
      type: "run.transition",
      workflowRunId: env.runId,
    });
    expect((await env.persistence.getRun(env.runId))?.status).toBe("COMPLETED");
    await env.flush();
    expect(env.eventSink.getByType("stage:completed")).toHaveLength(1);
  });

  it("bounds the claim lease by maxWaitUntil so a timeout is still noticed", async () => {
    const gate = gatedPoll();
    const env = await suspendDurableWait(gate.poll, 10_000);
    const before = await env.persistence.getStage(env.runId, "wait");
    expect(before?.maxWaitUntil).toEqual(
      new Date(env.clock.now().getTime() + 10_000),
    );
    env.clock.advance(1_000);

    const inFlight = env.kernel.dispatch({ type: "stage.pollSuspended" });
    await settle();

    // Held by this poller: nextPollAt is the deadline, not now + 60s.
    const held = await env.persistence.getStage(env.runId, "wait");
    expect(held?.status).toBe("SUSPENDED");
    expect(held?.nextPollAt).toEqual(before?.maxWaitUntil);
    expect(held?.version).toBe(before!.version + 1);

    gate.release({ done: true });
    expect((await inFlight).resumed).toBe(1);
    expect(
      (await env.persistence.getStage(env.runId, "wait"))?.nextPollAt,
    ).toBeNull();
  });

  it("re-polls a stage whose claimant died once the lease elapses", async () => {
    const gate = gatedPoll();
    const env = await suspendDurableWait(gate.poll);
    env.clock.advance(1_000);
    const claimedAt = env.clock.now().getTime();

    // First poller claims and then "dies" mid-replay (its body never
    // returns within the lease).
    const dead = env.kernel.dispatch({ type: "stage.pollSuspended" });
    await settle();
    const held = await env.persistence.getStage(env.runId, "wait");
    expect(held?.nextPollAt).toEqual(new Date(claimedAt + 60_000));

    // Before the lease elapses nobody else touches it.
    env.clock.advance(59_000);
    const early = await env.kernel.dispatch({ type: "stage.pollSuspended" });
    expect(early.checked).toBe(0);
    expect(env.replays()).toBe(1);

    // After the lease elapses the next poll picks it up and finishes it.
    env.clock.advance(1_000);
    const late = await env.kernel.dispatch({ type: "stage.pollSuspended" });
    expect(late.resumed).toBe(1);
    expect(env.replays()).toBe(2);
    expect((await env.persistence.getStage(env.runId, "wait"))?.status).toBe(
      "COMPLETED",
    );

    // The dead poller's replay, if it ever returns, must not undo that.
    gate.release({ done: true });
    await dead;
    expect((await env.persistence.getStage(env.runId, "wait"))?.status).toBe(
      "COMPLETED",
    );
  });

  it("leaves a COMPLETED stage alone when the loser arrives after the winner completed the run", async () => {
    const gate = gatedPoll();
    const env = await suspendDurableWait(gate.poll);
    env.clock.advance(1_000);

    // The loser claims first and stalls past its lease; the winner then
    // claims, completes the stage and the run transitions to COMPLETED.
    const loser = env.kernel.dispatch({ type: "stage.pollSuspended" });
    await settle();
    env.clock.advance(60_000);
    const winner = await env.kernel.dispatch({ type: "stage.pollSuspended" });
    expect(winner.resumed).toBe(1);
    await env.kernel.dispatch({
      type: "run.transition",
      workflowRunId: env.runId,
    });
    expect((await env.persistence.getRun(env.runId))?.status).toBe("COMPLETED");

    // The loser's replay returns into a run that is no longer RUNNING.
    gate.release({ done: true });
    expect((await loser).resumed).toBe(0);
    const stage = await env.persistence.getStage(env.runId, "wait");
    expect(stage?.status).toBe("COMPLETED");
    expect(stage?.nextPollAt).toBeNull();
    expect((await env.persistence.getRun(env.runId))?.status).toBe("COMPLETED");
  });
});
