/**
 * DX Improvement Tests
 *
 * Behavioral coverage for factory-level ergonomics:
 * - onProgress auto-fills stageId/stageName (still overridable)
 * - defineAsyncBatchStage derives pollConfig/nextPollAt from state
 * - defineWorkflow() options-object alternative to `new WorkflowBuilder(...)`
 */

import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { StageContext } from "../../core/stage.js";
import {
  defineAsyncBatchStage,
  defineStage,
} from "../../core/stage-factory.js";
import type { ProgressUpdate } from "../../core/types.js";
import {
  defineWorkflow,
  type Workflow,
  WorkflowBuilder,
} from "../../core/workflow.js";
import { createKernel } from "../../kernel/kernel.js";
import {
  CollectingEventSink,
  FakeClock,
  InMemoryBlobStore,
  NoopScheduler,
} from "../../kernel/testing/index.js";
import { InMemoryJobQueue } from "../../testing/in-memory-job-queue.js";
import { InMemoryWorkflowPersistence } from "../../testing/in-memory-persistence.js";

function createMockContext(overrides: {
  stageId: string;
  stageName: string;
  input?: unknown;
  onProgress?: (update: ProgressUpdate) => void;
}): StageContext<any, any, any> {
  return {
    workflowRunId: "run-1",
    stageId: overrides.stageId,
    stageName: overrides.stageName,
    stageNumber: 0,
    input: overrides.input ?? {},
    config: {},
    workflowContext: {},
    onProgress: overrides.onProgress ?? (() => {}),
    onLog: () => {},
    log: () => {},
    annotate: (() => {}) as StageContext<any, any, any>["annotate"],
    storage: {
      save: async () => {},
      load: async <T>(): Promise<T> => null as T,
      exists: async () => false,
      delete: async () => {},
      getStageKey: () => "key",
    },
  };
}

function createTestKernel(workflows: Workflow<any, any>[] = []) {
  const persistence = new InMemoryWorkflowPersistence();
  const blobStore = new InMemoryBlobStore();
  const jobTransport = new InMemoryJobQueue("test-worker");
  const eventSink = new CollectingEventSink();
  const scheduler = new NoopScheduler();
  const clock = new FakeClock();

  const registry = new Map<string, Workflow<any, any>>();
  for (const w of workflows) registry.set(w.id, w);

  const kernel = createKernel({
    persistence,
    blobStore,
    jobTransport,
    eventSink,
    scheduler,
    clock,
    registry: { getWorkflow: (id) => registry.get(id) },
  });

  const flush = () => kernel.dispatch({ type: "outbox.flush" as const });
  return { kernel, flush, persistence, blobStore, eventSink, clock };
}

describe("onProgress auto-fills stageId/stageName", () => {
  it("forwards the stage's own stageId/stageName when only progress/message are passed", async () => {
    const seen: ProgressUpdate[] = [];

    const stage = defineStage({
      id: "progress-stage",
      name: "Progress Stage",
      schemas: {
        input: z.object({}),
        output: z.object({}),
        config: z.object({}),
      },
      async execute(ctx) {
        ctx.onProgress({ progress: 50, message: "halfway" });
        return { output: {} };
      },
    });

    await stage.execute(
      createMockContext({
        stageId: "progress-stage",
        stageName: "Progress Stage",
        onProgress: (update) => seen.push(update),
      }),
    );

    expect(seen).toEqual([
      {
        stageId: "progress-stage",
        stageName: "Progress Stage",
        progress: 50,
        message: "halfway",
      },
    ]);
  });

  it("still allows callers to override the auto-filled stageId/stageName", async () => {
    const seen: ProgressUpdate[] = [];

    const stage = defineStage({
      id: "override-stage",
      name: "Override Stage",
      schemas: {
        input: z.object({}),
        output: z.object({}),
        config: z.object({}),
      },
      async execute(ctx) {
        ctx.onProgress({
          progress: 10,
          message: "custom",
          stageId: "custom-id",
          stageName: "Custom Name",
        });
        return { output: {} };
      },
    });

    await stage.execute(
      createMockContext({
        stageId: "override-stage",
        stageName: "Override Stage",
        onProgress: (update) => seen.push(update),
      }),
    );

    expect(seen).toEqual([
      {
        stageId: "custom-id",
        stageName: "Custom Name",
        progress: 10,
        message: "custom",
      },
    ]);
  });
});

describe("defineAsyncBatchStage derives pollConfig from state", () => {
  it("suspends successfully when only state.batchId/pollInterval/maxWaitTime are provided (no pollConfig)", async () => {
    const stage = defineAsyncBatchStage({
      id: "derived-poll-stage",
      name: "Derived Poll Stage",
      mode: "async-batch",
      schemas: {
        input: z.object({}),
        output: z.object({ result: z.string() }),
        config: z.object({}),
      },
      async execute() {
        return {
          suspended: true,
          state: {
            batchId: "batch-1",
            pollInterval: 5000,
            maxWaitTime: 60000,
          },
        };
      },
      async checkCompletion() {
        return { ready: true, output: { result: "done" } };
      },
    });

    const workflow = new WorkflowBuilder(
      "derived-poll",
      "Test",
      "Test",
      z.object({}),
      z.object({ result: z.string() }),
    )
      .pipe(stage)
      .build();

    const { kernel } = createTestKernel([workflow]);

    const { workflowRunId } = await kernel.dispatch({
      type: "run.create",
      idempotencyKey: "key-1",
      workflowId: "derived-poll",
      input: {},
    });
    await kernel.dispatch({ type: "run.claimPending", workerId: "worker-1" });

    const jobResult = await kernel.dispatch({
      type: "job.execute",
      workflowRunId,
      workflowId: "derived-poll",
      stageId: "derived-poll-stage",
      config: {},
    });

    expect(jobResult.outcome).toBe("suspended");
    expect(jobResult.nextPollAt).toBeInstanceOf(Date);
    // nextPollAt should be ~pollInterval (5000ms) after submission.
    expect(jobResult.nextPollAt!.getTime()).toBeGreaterThan(Date.now() - 1000);
  });

  it("still honors an explicit pollConfig when provided", async () => {
    const explicitNextPollAt = new Date(Date.now() + 123456);

    const stage = defineAsyncBatchStage({
      id: "explicit-poll-stage",
      name: "Explicit Poll Stage",
      mode: "async-batch",
      schemas: {
        input: z.object({}),
        output: z.object({ result: z.string() }),
        config: z.object({}),
      },
      async execute() {
        return {
          suspended: true,
          state: { batchId: "batch-2" },
          pollConfig: {
            pollInterval: 999,
            maxWaitTime: 999999,
            nextPollAt: explicitNextPollAt,
          },
        };
      },
      async checkCompletion() {
        return { ready: true, output: { result: "done" } };
      },
    });

    const workflow = new WorkflowBuilder(
      "explicit-poll",
      "Test",
      "Test",
      z.object({}),
      z.object({ result: z.string() }),
    )
      .pipe(stage)
      .build();

    const { kernel } = createTestKernel([workflow]);

    const { workflowRunId } = await kernel.dispatch({
      type: "run.create",
      idempotencyKey: "key-1",
      workflowId: "explicit-poll",
      input: {},
    });
    await kernel.dispatch({ type: "run.claimPending", workerId: "worker-1" });

    const jobResult = await kernel.dispatch({
      type: "job.execute",
      workflowRunId,
      workflowId: "explicit-poll",
      stageId: "explicit-poll-stage",
      config: {},
    });

    expect(jobResult.outcome).toBe("suspended");
    expect(jobResult.nextPollAt?.getTime()).toBe(explicitNextPollAt.getTime());
  });
});

describe("defineWorkflow() options-object API", () => {
  it("builds an equivalent workflow to `new WorkflowBuilder(...)`", () => {
    const schema = z.object({ value: z.string() });
    const stage = defineStage({
      id: "echo",
      name: "Echo",
      schemas: { input: schema, output: schema, config: z.object({}) },
      async execute(ctx) {
        return { output: ctx.input };
      },
    });

    const workflow = defineWorkflow({
      id: "define-workflow-test",
      name: "Define Workflow Test",
      description: "Built via defineWorkflow()",
      input: schema,
    })
      .pipe(stage)
      .build();

    expect(workflow.id).toBe("define-workflow-test");
    expect(workflow.name).toBe("Define Workflow Test");
    expect(workflow.description).toBe("Built via defineWorkflow()");
    expect(workflow.hasStage("echo")).toBe(true);
    // The final output schema comes from the last piped stage, not the
    // (omitted) `output` option.
    expect(workflow.outputSchema).toBe(stage.outputSchema);
  });

  it("works end-to-end through the kernel", async () => {
    const schema = z.object({ value: z.number() });
    const doubleStage = defineStage({
      id: "double",
      name: "Double",
      schemas: {
        input: schema,
        output: z.object({ result: z.number() }),
        config: z.object({}),
      },
      async execute(ctx) {
        return { output: { result: ctx.input.value * 2 } };
      },
    });

    const workflow = defineWorkflow({
      id: "define-workflow-kernel",
      name: "Define Workflow Kernel Test",
      input: schema,
    })
      .pipe(doubleStage)
      .build();

    const { kernel } = createTestKernel([workflow]);

    const { workflowRunId } = await kernel.dispatch({
      type: "run.create",
      idempotencyKey: "key-1",
      workflowId: "define-workflow-kernel",
      input: { value: 21 },
    });
    await kernel.dispatch({ type: "run.claimPending", workerId: "worker-1" });

    const jobResult = await kernel.dispatch({
      type: "job.execute",
      workflowRunId,
      workflowId: "define-workflow-kernel",
      stageId: "double",
      config: {},
    });

    expect(jobResult.outcome).toBe("completed");
    expect(jobResult.output).toEqual({ result: 42 });
  });
});
