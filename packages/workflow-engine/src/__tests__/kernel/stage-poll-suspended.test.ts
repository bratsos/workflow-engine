import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  defineAsyncBatchStage,
  defineStage,
} from "../../core/stage-factory.js";
import type { StepApi } from "../../core/steps.js";
import type { CompletionCheckResult } from "../../core/types.js";
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
  /** Runs in the body after the wait, so only a replay reaches it. */
  afterWait?: (step: StepApi) => Promise<unknown>,
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
      await afterWait?.(ctx.step);
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
  const stepLedger = new InMemoryStepLedger({ now: () => clock.now() });
  const env = createTestKernel([workflow], { clock, stepLedger });
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
    stepLedger,
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

describe("kernel: stage.pollSuspended retries a replay that throws", () => {
  it("keeps the stage suspended with its ledger and replays it after a backoff", async () => {
    let ready = false;
    const env = await suspendDurableWait(async () => ({ done: ready }));
    ready = true;
    env.clock.advance(1_000);
    vi.spyOn(env.blobStore, "put").mockRejectedValueOnce(
      new Error("blob store unavailable"),
    );

    const first = await env.kernel.dispatch({ type: "stage.pollSuspended" });

    // Not a failure: the run keeps going, the error and the retry are on record.
    expect(first).toMatchObject({ checked: 1, resumed: 0, failed: 0 });
    const retrying = await env.persistence.getStage(env.runId, "wait");
    expect(retrying).toMatchObject({
      status: "SUSPENDED",
      attempt: 1,
      errorMessage: "blob store unavailable",
      nextPollAt: new Date(env.clock.now().getTime() + 2_000),
    });
    expect((await env.persistence.getRun(env.runId))?.status).toBe("RUNNING");
    await env.flush();
    expect(env.eventSink.getByType("stage:failed")).toHaveLength(0);
    expect(env.eventSink.getByType("stage:retrying")).toMatchObject([
      {
        stageId: "wait",
        attempt: 1,
        maxAttempts: 3,
        error: "blob store unavailable",
      },
    ]);
    expect(await env.stepLedger.list(retrying!.id)).toMatchObject([
      { stepId: "external", status: "completed" },
    ]);

    // Nobody replays it before the backoff elapses; then it completes.
    expect(
      (await env.kernel.dispatch({ type: "stage.pollSuspended" })).checked,
    ).toBe(0);
    env.clock.advance(2_000);
    const second = await env.kernel.dispatch({ type: "stage.pollSuspended" });
    expect(second.resumed).toBe(1);
    expect(await env.persistence.getStage(env.runId, "wait")).toMatchObject({
      status: "COMPLETED",
      attempt: 1,
      errorMessage: null,
    });
  });

  it("re-opens a step that failed in the replay and runs it again", async () => {
    let charges = 0;
    let ready = false;
    const env = await suspendDurableWait(
      async () => ({ done: ready }),
      undefined,
      (step) =>
        step.run("charge", async () => {
          if (++charges === 1) throw new Error("503 Service Unavailable");
          return "charged";
        }),
    );
    ready = true;
    env.clock.advance(1_000);

    await env.kernel.dispatch({ type: "stage.pollSuspended" });
    const retrying = await env.persistence.getStage(env.runId, "wait");
    expect(retrying).toMatchObject({
      status: "SUSPENDED",
      errorMessage: "503 Service Unavailable",
    });
    expect(await env.stepLedger.list(retrying!.id)).toMatchObject([
      { stepId: "external", status: "completed" },
      { stepId: "charge", status: "running", attempt: 1, leaseExpiresAt: null },
    ]);

    env.clock.advance(2_000);
    expect(
      (await env.kernel.dispatch({ type: "stage.pollSuspended" })).resumed,
    ).toBe(1);
    expect(charges).toBe(2);
    expect(await env.stepLedger.list(retrying!.id)).toMatchObject([
      { stepId: "external", status: "completed" },
      { stepId: "charge", status: "completed", attempt: 2 },
    ]);
  });

  it("fails the stage and the run once the attempt budget is spent", async () => {
    let ready = false;
    const env = await suspendDurableWait(async () => ({ done: ready }));
    ready = true;
    vi.spyOn(env.blobStore, "put").mockRejectedValue(
      new Error("blob store down"),
    );

    // The budget is the job's: attempt 1 of 3, so two retries and a third failure.
    for (const backoffMs of [2_000, 4_000, 0]) {
      env.clock.advance(60_000);
      await env.kernel.dispatch({ type: "stage.pollSuspended" });
      if (backoffMs > 0) {
        expect(
          (await env.persistence.getStage(env.runId, "wait"))?.nextPollAt,
        ).toEqual(new Date(env.clock.now().getTime() + backoffMs));
      }
    }

    expect(await env.persistence.getStage(env.runId, "wait")).toMatchObject({
      status: "FAILED",
      errorMessage: "blob store down",
      nextPollAt: null,
    });
    expect((await env.persistence.getRun(env.runId))?.status).toBe("FAILED");
    await env.flush();
    expect(
      env.eventSink.getByType("stage:retrying").map((e) => e.attempt),
    ).toEqual([1, 2]);
    expect(env.eventSink.getByType("stage:failed")).toHaveLength(1);
  });

  it("fails at once on a deterministic error, as job.execute does", async () => {
    let ready = false;
    const env = await suspendDurableWait(
      async () => ({ done: ready }),
      undefined,
      async (step) => {
        await step.run("dup", async () => 1);
        await step.run("dup", async () => 2);
      },
    );
    ready = true;
    env.clock.advance(1_000);

    const result = await env.kernel.dispatch({ type: "stage.pollSuspended" });

    expect(result.failed).toBe(1);
    expect(await env.persistence.getStage(env.runId, "wait")).toMatchObject({
      status: "FAILED",
      attempt: 0,
    });
    expect((await env.persistence.getRun(env.runId))?.status).toBe("FAILED");
    await env.flush();
    expect(env.eventSink.getByType("stage:retrying")).toHaveLength(0);
  });
});

describe("kernel: stage.pollSuspended and a legacy checkCompletion answer the engine cannot persist", () => {
  /** A legacy stage suspended through `job.execute`; `answer` is its poll. */
  async function suspendLegacy(answer: () => CompletionCheckResult<unknown>) {
    const out = z.object({ result: z.string() });
    const clock = new FakeClock();
    const stage = defineAsyncBatchStage({
      id: "batch-stage",
      name: "Batch Stage",
      mode: "async-batch",
      schemas: { input: z.object({}), output: out, config: z.object({}) },
      async execute() {
        return {
          suspended: true,
          state: { batchId: "batch-1" },
          pollConfig: {
            pollInterval: 1000,
            maxWaitTime: 60 * 60 * 1000,
            nextPollAt: new Date(clock.now().getTime() + 1000),
          },
        };
      },
      async checkCompletion() {
        return answer() as { ready: boolean; output?: { result: string } };
      },
    });
    const workflow = new WorkflowBuilder(
      "legacy-persist",
      "Legacy",
      "test",
      z.object({}),
      out,
    )
      .pipe(stage)
      .build();
    const env = createTestKernel([workflow], { clock });
    const created = await env.kernel.dispatch({
      type: "run.create",
      idempotencyKey: "legacy-persist",
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
    return { ...env, runId: created.workflowRunId };
  }

  it.each([
    ["its output blob write", true, "blob"],
    ["the commit of its ready answer", true, "commit"],
    ["the commit of its not-ready answer", false, "commit"],
  ] as const)("retries a poll when %s fails once, keeping the stage suspended", async (_case, ready, point) => {
    let answer: CompletionCheckResult<unknown> = ready
      ? { ready: true, output: { result: "done" } }
      : { ready: false };
    const env = await suspendLegacy(() => answer);
    env.clock.advance(1_000);
    if (point === "blob")
      vi.spyOn(env.blobStore, "put").mockRejectedValueOnce(
        new Error("blob store unavailable"),
      );
    else
      vi.spyOn(env.persistence, "withTransaction").mockRejectedValueOnce(
        new Error("commit failed"),
      );

    const first = await env.kernel.dispatch({ type: "stage.pollSuspended" });

    // A store error is not a verdict on the stage: it is retried, as a
    // replay that throws is, and nothing fails.
    expect(first).toMatchObject({ checked: 1, resumed: 0, failed: 0 });
    expect(
      await env.persistence.getStage(env.runId, "batch-stage"),
    ).toMatchObject({
      status: "SUSPENDED",
      attempt: 1,
      nextPollAt: new Date(env.clock.now().getTime() + 2_000),
    });
    expect((await env.persistence.getRun(env.runId))?.status).toBe("RUNNING");
    await env.flush();
    expect(env.eventSink.getByType("stage:failed")).toHaveLength(0);
    expect(env.eventSink.getByType("workflow:failed")).toHaveLength(0);
    expect(env.eventSink.getByType("stage:retrying")).toMatchObject([
      { stageId: "batch-stage", attempt: 1, maxAttempts: 3 },
    ]);

    // Nobody polls it before the backoff elapses; the next poll completes it.
    expect(
      (await env.kernel.dispatch({ type: "stage.pollSuspended" })).checked,
    ).toBe(0);
    answer = { ready: true, output: { result: "done" } };
    env.clock.advance(2_000);
    expect(
      await env.kernel.dispatch({ type: "stage.pollSuspended" }),
    ).toMatchObject({ resumed: 1, failed: 0 });
    expect(
      await env.persistence.getStage(env.runId, "batch-stage"),
    ).toMatchObject({ status: "COMPLETED" });
  });

  it("fails the stage and the run with the store's error once the attempt budget is spent", async () => {
    let polls = 0;
    const env = await suspendLegacy(() => {
      polls++;
      return { ready: true, output: { result: "done" } };
    });
    vi.spyOn(env.blobStore, "put").mockRejectedValue(
      new Error("blob store down"),
    );

    // The budget is the job's: attempt 1 of 3, so two retries and a third failure.
    for (const backoffMs of [2_000, 4_000, 0]) {
      env.clock.advance(60_000);
      await env.kernel.dispatch({ type: "stage.pollSuspended" });
      if (backoffMs > 0) {
        expect(
          (await env.persistence.getStage(env.runId, "batch-stage"))
            ?.nextPollAt,
        ).toEqual(new Date(env.clock.now().getTime() + backoffMs));
      }
    }

    expect(
      await env.persistence.getStage(env.runId, "batch-stage"),
    ).toMatchObject({
      status: "FAILED",
      errorMessage: "blob store down",
      nextPollAt: null,
    });
    expect((await env.persistence.getRun(env.runId))?.status).toBe("FAILED");
    await env.flush();
    expect(
      env.eventSink.getByType("stage:retrying").map((e) => e.attempt),
    ).toEqual([1, 2]);
    expect(env.eventSink.getByType("stage:failed")).toHaveLength(1);
    expect(polls).toBe(3);
  });

  it("counts only consecutive failures: a poll that persists ends the streak", async () => {
    let answer: CompletionCheckResult<unknown> = { ready: false };
    const env = await suspendLegacy(() => answer);
    const streak = async () =>
      (
        (await env.persistence.getStage(env.runId, "batch-stage"))
          ?.suspendedState as { metadata?: Record<string, unknown> }
      ).metadata?.__replayFailures;
    vi.spyOn(env.persistence, "withTransaction").mockRejectedValueOnce(
      new Error("commit failed"),
    );
    env.clock.advance(60_000);
    await env.kernel.dispatch({ type: "stage.pollSuspended" });
    expect(await streak()).toBe(1);

    // The next poll persists a not-ready answer: the streak is cleared.
    env.clock.advance(60_000);
    await env.kernel.dispatch({ type: "stage.pollSuspended" });
    expect(await streak()).toBeUndefined();
    expect(
      (await env.persistence.getStage(env.runId, "batch-stage"))?.status,
    ).toBe("SUSPENDED");
  });
});

describe("kernel: stage.pollSuspended and definition pinning", () => {
  it("skips a suspended stage this build cannot serve and hands the claim back", async () => {
    // A rolling deploy has both builds polling the same table. The build
    // that cannot serve the run must not poll it — and must not hold the
    // 60s claim lease either, or it starves the build that can.
    const schema = z.object({ data: z.string() });
    let polls = 0;
    const batchStage = defineAsyncBatchStage({
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
            maxWaitTime: 60_000,
          },
          pollConfig: {
            pollInterval: 1000,
            maxWaitTime: 60_000,
            nextPollAt: new Date(),
          },
        };
      },
      async checkCompletion() {
        polls++;
        return { ready: true, output: { result: "done" } };
      },
    });
    const build = (extra: boolean) => {
      const b = new WorkflowBuilder(
        "pinned-poll-wf",
        "Pinned",
        "Test",
        schema,
        z.object({ result: z.string() }),
      ).pipe(batchStage);
      return (
        extra ? b.pipe(createPassthroughStage("stage-2", schema)) : b
      ).build();
    };
    const v1 = build(false);
    const v2 = build(true);

    const { kernel, persistence, registry, clock } = createTestKernel([v1]);
    const created = await kernel.dispatch({
      type: "run.create",
      idempotencyKey: "pinned-poll-1",
      workflowId: v1.id,
      input: { data: "hello" },
    });
    await kernel.dispatch({ type: "run.claimPending", workerId: "w1" });
    await kernel.dispatch({
      type: "job.execute",
      workflowRunId: created.workflowRunId,
      workflowId: v1.id,
      stageId: "batch-stage",
      config: {},
    });

    const [suspended] = await persistence.getStagesByRun(created.workflowRunId);
    expect(suspended!.status).toBe("SUSPENDED");
    await persistence.updateStage(suspended!.id, {
      nextPollAt: new Date(clock.now().getTime() - 1000),
    });

    // The deploy lands under the suspended run.
    registry.set(v1.id, v2);

    const result = await kernel.dispatch({ type: "stage.pollSuspended" });

    expect(result.resumed).toBe(0);
    expect(result.failed).toBe(0);
    expect(polls).toBe(0);

    const [after] = await persistence.getStagesByRun(created.workflowRunId);
    expect(after!.status).toBe("SUSPENDED");
    // The claim was handed back: nextPollAt is not parked a lease into the
    // future, so a host that can serve the run picks it up on its next tick.
    expect(after!.nextPollAt!.getTime()).toBeLessThanOrEqual(
      clock.now().getTime(),
    );
  });

  it("leaves a suspended stage of a run this build does not serve at the deadline it already had", async () => {
    const schema = z.object({ data: z.string() });
    const batchStage = defineAsyncBatchStage({
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
            maxWaitTime: 60_000,
            nextPollAt: new Date(),
          },
        };
      },
      async checkCompletion() {
        return { ready: true, output: { result: "done" } };
      },
    });

    const workflow = new WorkflowBuilder(
      "pinned-poll-wf",
      "Pinned",
      "Test",
      schema,
      z.object({ result: z.string() }),
    )
      .pipe(batchStage)
      .build();

    const { kernel, persistence, clock } = createTestKernel([workflow]);

    const run = await persistence.createRun({
      workflowId: workflow.id,
      workflowName: workflow.name,
      workflowType: workflow.id,
      input: { data: "hello" },
      definitionVersion: "v-old",
    });
    await persistence.updateRun(run.id, { status: "RUNNING" });

    const pastDate = new Date(clock.now().getTime() - 1000);
    const created = await persistence.createStage({
      workflowRunId: run.id,
      stageId: "batch-stage",
      stageName: "Batch Stage",
      stageNumber: 1,
      executionGroup: 1,
      status: "SUSPENDED",
      startedAt: clock.now(),
    });
    await persistence.updateStage(created.id, {
      suspendedState: { batchId: "batch-1" },
      nextPollAt: pastDate,
      pollInterval: 1000,
    });

    const beforeStage = await persistence.getStage(run.id, "batch-stage");
    const beforeNextPollAt = beforeStage!.nextPollAt;
    const beforeVersion = beforeStage!.version;

    await kernel.dispatch({ type: "stage.pollSuspended" });

    const afterStage = await persistence.getStage(run.id, "batch-stage");
    expect(afterStage!.nextPollAt).toEqual(beforeNextPollAt);
    expect(afterStage!.version).toBe(beforeVersion);
  });

  it("caps and orders the suspended-stage query rather than slicing in JS", async () => {
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
            maxWaitTime: 60_000,
            nextPollAt: new Date(),
          },
        };
      },
      async checkCompletion() {
        return { ready: false, nextCheckIn: 10_000 };
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

    const createSuspendedRunAndStage = async (id: string, nextPollAt: Date) => {
      const run = await persistence.createRun({
        id,
        workflowId: workflow.id,
        workflowName: workflow.name,
        workflowType: workflow.id,
        input: { data: "hello" },
      });
      await persistence.updateRun(run.id, { status: "RUNNING" });
      const created = await persistence.createStage({
        workflowRunId: run.id,
        stageId: "batch-stage",
        stageName: "Batch Stage",
        stageNumber: 1,
        executionGroup: 1,
        status: "SUSPENDED",
        startedAt: clock.now(),
      });
      await persistence.updateStage(created.id, {
        suspendedState: { batchId: "batch-1" },
        nextPollAt,
        pollInterval: 1000,
      });
      const stageRecord = (await persistence.getStage(run.id, "batch-stage"))!;
      return { run, stageRecord };
    };

    const oldestTime = new Date(clock.now().getTime() - 3000);
    const middleTime = new Date(clock.now().getTime() - 2000);
    const newestTime = new Date(clock.now().getTime() - 1000);

    const middle = await createSuspendedRunAndStage("run-middle", middleTime);
    const newest = await createSuspendedRunAndStage("run-newest", newestTime);
    const oldest = await createSuspendedRunAndStage("run-oldest", oldestTime);

    const result = await kernel.dispatch({
      type: "stage.pollSuspended",
      maxChecks: 1,
    });

    expect(result.checked).toBe(1);

    const oldestAfter = await persistence.getStage(
      oldest.run.id,
      "batch-stage",
    );
    const middleAfter = await persistence.getStage(
      middle.run.id,
      "batch-stage",
    );
    const newestAfter = await persistence.getStage(
      newest.run.id,
      "batch-stage",
    );

    expect(oldestAfter!.version).toBeGreaterThan(oldest.stageRecord.version);
    expect(oldestAfter!.nextPollAt!.getTime()).toBeGreaterThan(
      oldestTime.getTime(),
    );

    expect(middleAfter!.version).toBe(middle.stageRecord.version);
    expect(middleAfter!.nextPollAt).toEqual(middleTime);

    expect(newestAfter!.version).toBe(newest.stageRecord.version);
    expect(newestAfter!.nextPollAt).toEqual(newestTime);
  });
});
