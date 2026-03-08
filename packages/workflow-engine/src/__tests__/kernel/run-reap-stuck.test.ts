import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineStage } from "../../core/stage-factory.js";
import { type Workflow, WorkflowBuilder } from "../../core/workflow.js";
import { createKernel } from "../../kernel/kernel.js";
import {
  CollectingEventSink,
  FakeClock,
  InMemoryBlobStore,
  NoopScheduler,
} from "../../kernel/testing/index.js";
import { InMemoryJobQueue } from "../../testing/in-memory-job-queue.js";
import { InMemoryWorkflowPersistence } from "../../testing/in-memory-persistence.js";

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

function createTestKernel(workflows: Workflow<any, any>[] = []) {
  const persistence = new InMemoryWorkflowPersistence();
  const blobStore = new InMemoryBlobStore();
  const jobTransport = new InMemoryJobQueue("test-worker");
  const eventSink = new CollectingEventSink();
  const scheduler = new NoopScheduler();
  // Use current real time so FakeClock aligns with new Date() used by persistence
  const clock = new FakeClock(new Date());
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

  return { kernel, persistence, jobTransport, eventSink, clock };
}

describe("kernel: run.reapStuck", () => {
  it("marks stuck RUNNING run as FAILED when no activity past threshold", async () => {
    const workflow = createSimpleWorkflow();
    const { kernel, persistence, clock } = createTestKernel([workflow]);

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
    const { kernel, clock } = createTestKernel([workflow]);

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
    const { kernel, clock } = createTestKernel([workflow]);

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
});
