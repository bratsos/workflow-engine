import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  defineAsyncBatchStage,
  defineStage,
} from "../../core/stage-factory.js";
import { WorkflowBuilder } from "../../core/workflow.js";
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

describe("kernel: job.execute", () => {
  it("executes a sync stage end-to-end", async () => {
    const schema = z.object({ data: z.string() });
    const stage = defineStage({
      id: "transform",
      name: "Transform",
      schemas: {
        input: schema,
        output: z.object({ result: z.string() }),
        config: z.object({}),
      },
      async execute(ctx) {
        return { output: { result: ctx.input.data.toUpperCase() } };
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

    const { kernel, flush, persistence, blobStore, eventSink } =
      createTestKernel([workflow]);

    // Create and claim a run
    const createResult = await kernel.dispatch({
      type: "run.create",
      idempotencyKey: "key-1",
      workflowId: "test-workflow",
      input: { data: "hello" },
    });

    await persistence.updateRun(createResult.workflowRunId, {
      status: "RUNNING",
    });
    await flush();
    eventSink.clear();

    // Execute the stage
    const result = await kernel.dispatch({
      type: "job.execute",
      workflowRunId: createResult.workflowRunId,
      workflowId: "test-workflow",
      stageId: "transform",
      config: {},
    });

    expect(result.outcome).toBe("completed");
    expect(result.output).toEqual({ result: "HELLO" });

    // Verify stage record
    const stages = await persistence.getStagesByRun(createResult.workflowRunId);
    expect(stages).toHaveLength(1);
    expect(stages[0]!.status).toBe("COMPLETED");

    // Verify events
    await flush();
    const startedEvents = eventSink.getByType("stage:started");
    expect(startedEvents).toHaveLength(1);
    const completedEvents = eventSink.getByType("stage:completed");
    expect(completedEvents).toHaveLength(1);

    // Verify output was stored in blobStore (not persistence artifacts)
    expect(blobStore.size()).toBe(1);

    const finalRun = await persistence.getRun(createResult.workflowRunId);
    expect(finalRun!.version).toBeGreaterThanOrEqual(1);
  });

  it("persists returned stage artifacts to blob storage", async () => {
    const schema = z.object({ data: z.string() });
    const stage = defineStage({
      id: "artifact-stage",
      name: "Artifact Stage",
      schemas: {
        input: schema,
        output: z.object({ result: z.string() }),
        config: z.object({}),
      },
      async execute(ctx) {
        return {
          output: { result: ctx.input.data.toUpperCase() },
          artifacts: {
            raw: { original: ctx.input.data },
            meta: { length: ctx.input.data.length },
          },
        };
      },
    });

    const workflow = new WorkflowBuilder(
      "artifact-workflow",
      "Artifact Workflow",
      "Test",
      schema,
      z.object({ result: z.string() }),
    )
      .pipe(stage)
      .build();

    const { kernel, persistence, blobStore } = createTestKernel([workflow]);

    const createResult = await kernel.dispatch({
      type: "run.create",
      idempotencyKey: "key-artifacts",
      workflowId: "artifact-workflow",
      input: { data: "hello" },
    });

    await persistence.updateRun(createResult.workflowRunId, {
      status: "RUNNING",
    });

    const result = await kernel.dispatch({
      type: "job.execute",
      workflowRunId: createResult.workflowRunId,
      workflowId: "artifact-workflow",
      stageId: "artifact-stage",
      config: {},
    });

    expect(result.outcome).toBe("completed");
    expect(blobStore.size()).toBe(3);

    const rawArtifactKey =
      "workflow-v2/artifact-workflow/" +
      `${createResult.workflowRunId}/artifact-stage/artifacts/raw.json`;
    expect(await blobStore.has(rawArtifactKey)).toBe(true);
  });

  it("handles a failed stage", async () => {
    const schema = z.object({ data: z.string() });
    const stage = defineStage({
      id: "failing",
      name: "Failing Stage",
      schemas: { input: schema, output: schema, config: z.object({}) },
      async execute() {
        throw new Error("Stage execution failed");
      },
    });

    const workflow = new WorkflowBuilder(
      "test-workflow",
      "Test",
      "Test",
      schema,
      schema,
    )
      .pipe(stage)
      .build();

    const { kernel, flush, persistence, eventSink } = createTestKernel([
      workflow,
    ]);

    const createResult = await kernel.dispatch({
      type: "run.create",
      idempotencyKey: "key-1",
      workflowId: "test-workflow",
      input: { data: "hello" },
    });

    await persistence.updateRun(createResult.workflowRunId, {
      status: "RUNNING",
    });
    await flush();
    eventSink.clear();

    const result = await kernel.dispatch({
      type: "job.execute",
      workflowRunId: createResult.workflowRunId,
      workflowId: "test-workflow",
      stageId: "failing",
      config: {},
    });

    expect(result.outcome).toBe("failed");
    expect(result.error).toBe("Stage execution failed");

    // Verify stage record
    const stages = await persistence.getStagesByRun(createResult.workflowRunId);
    expect(stages[0]!.status).toBe("FAILED");

    // Verify events
    await flush();
    const failedEvents = eventSink.getByType("stage:failed");
    expect(failedEvents).toHaveLength(1);
  });

  it("handles a suspended stage", async () => {
    const schema = z.object({ data: z.string() });
    const stage = defineAsyncBatchStage({
      id: "suspending",
      name: "Suspending Stage",
      mode: "async-batch",
      schemas: {
        input: schema,
        output: z.object({ result: z.string() }),
        config: z.object({}),
      },
      async execute(ctx) {
        return {
          suspended: true,
          state: {
            batchId: "batch-123",
            submittedAt: new Date().toISOString(),
            pollInterval: 60000,
            maxWaitTime: 3600000,
          },
          pollConfig: {
            pollInterval: 60000,
            maxWaitTime: 3600000,
            nextPollAt: new Date(Date.now() + 60000),
          },
        };
      },
      async checkCompletion(state) {
        return { ready: true, output: { result: "done" } };
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

    const { kernel, persistence, eventSink } = createTestKernel([workflow]);

    const createResult = await kernel.dispatch({
      type: "run.create",
      idempotencyKey: "key-1",
      workflowId: "test-workflow",
      input: { data: "hello" },
    });

    await persistence.updateRun(createResult.workflowRunId, {
      status: "RUNNING",
    });
    eventSink.clear();

    const result = await kernel.dispatch({
      type: "job.execute",
      workflowRunId: createResult.workflowRunId,
      workflowId: "test-workflow",
      stageId: "suspending",
      config: {},
    });

    expect(result.outcome).toBe("suspended");
    expect(result.nextPollAt).toBeDefined();

    // Verify stage record
    const stages = await persistence.getStagesByRun(createResult.workflowRunId);
    expect(stages[0]!.status).toBe("SUSPENDED");
    expect(stages[0]!.suspendedState).toBeDefined();
  });

  it("throws on missing workflow", async () => {
    const { kernel } = createTestKernel([]);

    await expect(
      kernel.dispatch({
        type: "job.execute",
        workflowRunId: "run-1",
        workflowId: "nonexistent",
        stageId: "stage-1",
        config: {},
      }),
    ).rejects.toThrow(/not found in registry/);
  });

  it("stage is visible as RUNNING during execution", async () => {
    const schema = z.object({ data: z.string() });
    let observedStatus: string | undefined;
    let startedEventCount = 0;

    const stage = defineStage({
      id: "observable",
      name: "Observable",
      schemas: {
        input: schema,
        output: schema,
        config: z.object({}),
      },
      async execute(ctx) {
        // During execution (Phase 2), the RUNNING status should
        // already be committed from Phase 1.
        const stages = await persistence.getStagesByRun(ctx.workflowRunId);
        observedStatus = stages[0]?.status;

        // The stage:started outbox event should also be committed.
        const outbox = await persistence.getUnpublishedOutboxEvents(100);
        startedEventCount = outbox.filter(
          (e) => e.eventType === "stage:started",
        ).length;

        return { output: ctx.input };
      },
    });

    const workflow = new WorkflowBuilder(
      "test-workflow",
      "Test",
      "Test",
      schema,
      schema,
    )
      .pipe(stage)
      .build();

    const { kernel, persistence } = createTestKernel([workflow]);

    const createResult = await kernel.dispatch({
      type: "run.create",
      idempotencyKey: "key-observable",
      workflowId: "test-workflow",
      input: { data: "hello" },
    });

    await persistence.updateRun(createResult.workflowRunId, {
      status: "RUNNING",
    });

    const result = await kernel.dispatch({
      type: "job.execute",
      workflowRunId: createResult.workflowRunId,
      workflowId: "test-workflow",
      stageId: "observable",
      config: {},
    });

    expect(result.outcome).toBe("completed");
    expect(observedStatus).toBe("RUNNING");
    expect(startedEventCount).toBe(1);
  });

  it("progress events are written to outbox with completion event", async () => {
    const schema = z.object({ data: z.string() });
    const stage = defineStage({
      id: "progress-stage",
      name: "Progress Stage",
      schemas: {
        input: schema,
        output: schema,
        config: z.object({}),
      },
      async execute(ctx) {
        ctx.onProgress({ progress: 50, message: "halfway" });
        ctx.onProgress({ progress: 100, message: "done" });
        return { output: ctx.input };
      },
    });

    const workflow = new WorkflowBuilder(
      "test-workflow",
      "Test",
      "Test",
      schema,
      schema,
    )
      .pipe(stage)
      .build();

    const { kernel, flush, persistence, eventSink } = createTestKernel([
      workflow,
    ]);

    const createResult = await kernel.dispatch({
      type: "run.create",
      idempotencyKey: "key-progress",
      workflowId: "test-workflow",
      input: { data: "hello" },
    });

    await persistence.updateRun(createResult.workflowRunId, {
      status: "RUNNING",
    });
    await flush();
    eventSink.clear();

    const result = await kernel.dispatch({
      type: "job.execute",
      workflowRunId: createResult.workflowRunId,
      workflowId: "test-workflow",
      stageId: "progress-stage",
      config: {},
    });

    expect(result.outcome).toBe("completed");

    // Flush and verify all events are published
    await flush();
    const progressEvents = eventSink.getByType("stage:progress");
    expect(progressEvents).toHaveLength(2);
    const completedEvents = eventSink.getByType("stage:completed");
    expect(completedEvents).toHaveLength(1);
  });

  it("discards ghost job when run is not RUNNING", async () => {
    const workflow = createSimpleWorkflow();
    const { kernel, persistence } = createTestKernel([workflow]);

    // Create a run but do NOT claim it (stays PENDING)
    const createResult = await kernel.dispatch({
      type: "run.create",
      idempotencyKey: "key-1",
      workflowId: "test-workflow",
      input: { data: "hello" },
    });

    // Attempt to execute a job against this PENDING run (ghost job scenario)
    const result = await kernel.dispatch({
      type: "job.execute",
      idempotencyKey: "ghost-job-1",
      workflowRunId: createResult.workflowRunId,
      workflowId: "test-workflow",
      stageId: "stage-1",
      config: {},
    });

    expect(result.outcome).toBe("failed");
    expect(result.error).toContain("expected RUNNING");
  });

  it("validates input against stage schema", async () => {
    const inputSchema = z.object({ number: z.number() });
    const stage = defineStage({
      id: "strict",
      name: "Strict",
      schemas: {
        input: inputSchema,
        output: inputSchema,
        config: z.object({}),
      },
      async execute(ctx) {
        return { output: ctx.input };
      },
    });

    const workflow = new WorkflowBuilder(
      "test-workflow",
      "Test",
      "Test",
      inputSchema,
      inputSchema,
    )
      .pipe(stage)
      .build();

    const { kernel, persistence } = createTestKernel([workflow]);

    // Create run with wrong input type
    const run = await persistence.createRun({
      workflowId: "test-workflow",
      workflowName: "Test",
      workflowType: "test-workflow",
      input: { number: "not-a-number" }, // Wrong type
    });

    await persistence.updateRun(run.id, { status: "RUNNING" });

    const result = await kernel.dispatch({
      type: "job.execute",
      workflowRunId: run.id,
      workflowId: "test-workflow",
      stageId: "strict",
      config: {},
    });

    expect(result.outcome).toBe("failed");
    // Deterministic Zod validation failures are marked non-retryable so
    // hosts fail the job terminally instead of burning retry attempts.
    expect(result.retryable).toBe(false);
    expect(result.error).toContain("ZodError");
  });

  it("does not re-execute an already-COMPLETED stage (stale-lease duplicate guard)", async () => {
    let executionCount = 0;
    const schema = z.object({ data: z.string() });
    const stage = defineStage({
      id: "counted",
      name: "Counted",
      schemas: { input: schema, output: schema, config: z.object({}) },
      async execute(ctx) {
        executionCount++;
        return { output: ctx.input };
      },
    });

    const workflow = new WorkflowBuilder(
      "test-workflow",
      "Test",
      "Test",
      schema,
      schema,
    )
      .pipe(stage)
      .build();

    const { kernel, persistence } = createTestKernel([workflow]);

    const createResult = await kernel.dispatch({
      type: "run.create",
      idempotencyKey: "key-dup",
      workflowId: "test-workflow",
      input: { data: "hello" },
    });
    await persistence.updateRun(createResult.workflowRunId, {
      status: "RUNNING",
    });

    const first = await kernel.dispatch({
      type: "job.execute",
      workflowRunId: createResult.workflowRunId,
      workflowId: "test-workflow",
      stageId: "counted",
      config: {},
    });
    expect(first.outcome).toBe("completed");
    expect(executionCount).toBe(1);

    // Simulate a stale-lease duplicate delivery of the same job (e.g. a
    // heartbeat gap caused releaseStaleJobs to re-enqueue it even though
    // the stage already completed).
    const duplicate = await kernel.dispatch({
      type: "job.execute",
      workflowRunId: createResult.workflowRunId,
      workflowId: "test-workflow",
      stageId: "counted",
      config: {},
    });

    expect(duplicate.outcome).toBe("completed");
    expect(duplicate.output).toEqual(first.output);
    expect(executionCount).toBe(1);
  });

  it("fails loudly when a downstream stage's previous-group output is missing", async () => {
    const schema = z.object({ data: z.string() });
    const workflow = createTwoStageWorkflow();
    const { kernel, persistence } = createTestKernel([workflow]);

    const createResult = await kernel.dispatch({
      type: "run.create",
      idempotencyKey: "key-missing-output",
      workflowId: "test-workflow",
      input: { data: "hello" },
    });
    await persistence.updateRun(createResult.workflowRunId, {
      status: "RUNNING",
    });

    // Execute stage-1 (group 1) normally so stage-2 (group 2) becomes
    // eligible, but simulate the group-1 output blob going missing —
    // e.g. corrupted/expired storage — by never actually persisting a
    // COMPLETED stage-1 record. Instead, directly attempt stage-2, whose
    // execution group is 2, so resolveStageInput must resolve group 1's
    // output from workflowContext and find nothing.
    const result = await kernel.dispatch({
      type: "job.execute",
      workflowRunId: createResult.workflowRunId,
      workflowId: "test-workflow",
      stageId: "stage-2",
      config: {},
    });

    expect(result.outcome).toBe("failed");
    expect(result.error).toMatch(/missing the output of execution group/);

    // The workflow's original input must NOT have silently leaked into
    // stage-2 as a fallback.
    const stages = await persistence.getStagesByRun(createResult.workflowRunId);
    const stage2 = stages.find((s) => s.stageId === "stage-2");
    expect(stage2!.status).toBe("FAILED");
  });

  it("stores the per-stage config slice — not the full run-config map — when Phase 1 creates the stage record", async () => {
    // Regression test: job-execute's Phase 1 upsertStage `create` branch
    // used to store the entire run-config map (keyed by every stage id)
    // verbatim in the stage record's `config` column, instead of slicing
    // out just this stage's entry the way run.claimPending/run.transition/
    // run.rerunFrom all do. The bug only surfaces when Phase 1 hits the
    // `create` branch — i.e. no stage record exists yet — so dispatch
    // job.execute directly without a prior run.claimPending/run.transition
    // having created a PENDING record first.
    const workflow = createSimpleWorkflow();
    const { kernel, persistence } = createTestKernel([workflow]);

    const createResult = await kernel.dispatch({
      type: "run.create",
      idempotencyKey: "key-config-slice",
      workflowId: "test-workflow",
      input: { data: "hello" },
    });
    await persistence.updateRun(createResult.workflowRunId, {
      status: "RUNNING",
    });

    const fullRunConfigMap = {
      "stage-1": { own: "value" },
      "other-stage": { secret: "must-not-leak-into-stage-1" },
    };

    const result = await kernel.dispatch({
      type: "job.execute",
      workflowRunId: createResult.workflowRunId,
      workflowId: "test-workflow",
      stageId: "stage-1",
      config: fullRunConfigMap,
    });

    expect(result.outcome).toBe("completed");

    const stageRecord = await persistence.getStage(
      createResult.workflowRunId,
      "stage-1",
    );
    expect(stageRecord?.config).toEqual({ own: "value" });
  });

  it("logs a WARN and falls back to raw config when the stage config fails schema validation", async () => {
    const schema = z.object({ data: z.string() });
    const stage = defineStage({
      id: "strict-config",
      name: "Strict Config",
      schemas: {
        input: schema,
        output: schema,
        config: z.object({ requiredField: z.string() }),
      },
      async execute(ctx) {
        return { output: ctx.input };
      },
    });

    const workflow = new WorkflowBuilder(
      "test-workflow",
      "Test",
      "Test",
      schema,
      schema,
    )
      .pipe(stage)
      .build();

    const { kernel, persistence } = createTestKernel([workflow]);

    // Satisfy config validation at run-creation time...
    const createResult = await kernel.dispatch({
      type: "run.create",
      idempotencyKey: "key-config-warn",
      workflowId: "test-workflow",
      input: { data: "hello" },
      config: { "strict-config": { requiredField: "valid" } },
    });
    await persistence.updateRun(createResult.workflowRunId, {
      status: "RUNNING",
    });

    // ...but dispatch job.execute directly with a config missing
    // `requiredField` — configSchema.parse() throws inside LocalExecutor,
    // which must fall back to the raw config AND log a WARN (no behavior
    // change to the stage outcome itself).
    const result = await kernel.dispatch({
      type: "job.execute",
      workflowRunId: createResult.workflowRunId,
      workflowId: "test-workflow",
      stageId: "strict-config",
      config: { "strict-config": {} },
    });

    expect(result.outcome).toBe("completed");

    const logs = persistence.getAllLogs();
    const warnLog = logs.find(
      (log) => log.level === "WARN" && /config/i.test(log.message),
    );
    expect(warnLog).toBeDefined();
    expect(warnLog?.message).toMatch(/strict-config/);
  });
});
