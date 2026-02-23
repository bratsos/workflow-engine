/**
 * Kernel Tests: run.claimPending command
 *
 * Tests for claiming pending workflow runs and enqueuing first-stage jobs
 * via the kernel dispatch interface.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { defineStage } from "../../core/stage-factory.js";
import type { Workflow } from "../../core/workflow.js";
import { WorkflowBuilder } from "../../core/workflow.js";
import { createKernel, type Kernel } from "../../kernel/kernel.js";
import {
  CollectingEventSink,
  FakeClock,
  InMemoryBlobStore,
  NoopScheduler,
} from "../../kernel/testing/index.js";
import { InMemoryJobQueue } from "../../testing/in-memory-job-queue.js";
import { InMemoryWorkflowPersistence } from "../../testing/in-memory-persistence.js";

// Helper: create a simple passthrough stage
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

// Helper: create a simple workflow with one stage
function createSimpleWorkflow(id: string = "test-workflow") {
  const schema = z.object({ data: z.string() });
  const stage = createPassthroughStage("stage-1", schema);
  return new WorkflowBuilder(id, "Test Workflow", "Test", schema, schema)
    .pipe(stage)
    .build();
}

// Helper: create a two-stage workflow
function createTwoStageWorkflow(id: string = "test-workflow") {
  const schema = z.object({ data: z.string() });
  const stage1 = createPassthroughStage("stage-1", schema);
  const stage2 = createPassthroughStage("stage-2", schema);
  return new WorkflowBuilder(id, "Test Workflow", "Test", schema, schema)
    .pipe(stage1)
    .pipe(stage2)
    .build();
}

function createTestKernel(workflows: Workflow<any, any>[] = []) {
  const persistence = new InMemoryWorkflowPersistence();
  const blobStore = new InMemoryBlobStore();
  const jobTransport = new InMemoryJobQueue("test-worker");
  const eventSink = new CollectingEventSink();
  const scheduler = new NoopScheduler();
  const clock = new FakeClock();

  const registry = new Map<string, Workflow<any, any>>();
  for (const w of workflows) {
    registry.set(w.id, w);
  }

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
  return {
    kernel,
    flush,
    persistence,
    blobStore,
    jobTransport,
    eventSink,
    scheduler,
    clock,
    registry,
  };
}

describe("kernel: run.claimPending", () => {
  it("claims pending runs and enqueues first-stage jobs", async () => {
    const workflow = createSimpleWorkflow();
    const { kernel, flush, persistence, jobTransport, eventSink } =
      createTestKernel([workflow]);

    // Create a run
    await kernel.dispatch({
      type: "run.create",
      idempotencyKey: "key-1",
      workflowId: "test-workflow",
      input: { data: "hello" },
    });
    await flush();
    eventSink.clear();

    // Claim pending
    const result = await kernel.dispatch({
      type: "run.claimPending",
      workerId: "worker-1",
    });

    expect(result.claimed).toHaveLength(1);
    expect(result.claimed[0]!.workflowId).toBe("test-workflow");
    expect(result.claimed[0]!.jobIds).toHaveLength(1);

    // Verify stage was created
    const stages = await persistence.getStagesByRun(
      result.claimed[0]!.workflowRunId,
    );
    expect(stages).toHaveLength(1);
    expect(stages[0]!.stageId).toBe("stage-1");
    expect(stages[0]!.status).toBe("PENDING");

    // Verify job was enqueued
    const jobs = jobTransport.getAllJobs();
    expect(jobs).toHaveLength(1);

    // Verify events
    await flush();
    const startEvents = eventSink.getByType("workflow:started");
    expect(startEvents).toHaveLength(1);
  });

  it("returns empty when no pending runs", async () => {
    const { kernel } = createTestKernel([]);

    const result = await kernel.dispatch({
      type: "run.claimPending",
      workerId: "worker-1",
    });

    expect(result.claimed).toHaveLength(0);
  });

  it("respects maxClaims", async () => {
    const workflow = createSimpleWorkflow();
    const { kernel } = createTestKernel([workflow]);

    // Create 5 runs
    for (let i = 0; i < 5; i++) {
      await kernel.dispatch({
        type: "run.create",
        idempotencyKey: `key-${i}`,
        workflowId: "test-workflow",
        input: { data: `hello-${i}` },
      });
    }

    const result = await kernel.dispatch({
      type: "run.claimPending",
      workerId: "worker-1",
      maxClaims: 2,
    });

    expect(result.claimed).toHaveLength(2);
  });

  it("handles missing workflow definition", async () => {
    const workflow = createSimpleWorkflow();
    const { kernel, flush, persistence, eventSink, registry } =
      createTestKernel([workflow]);

    // Create run then remove workflow from registry
    await kernel.dispatch({
      type: "run.create",
      idempotencyKey: "key-1",
      workflowId: "test-workflow",
      input: { data: "hello" },
    });
    registry.delete("test-workflow");

    const result = await kernel.dispatch({
      type: "run.claimPending",
      workerId: "worker-1",
    });

    // It should claim the run but fail it
    expect(result.claimed).toHaveLength(0);

    // The run should be marked as FAILED
    const runs = await persistence.getRunsByStatus("FAILED");
    expect(runs).toHaveLength(1);
    expect(runs[0]?.output).toEqual({
      error: {
        code: "WORKFLOW_NOT_FOUND",
        message: "Workflow test-workflow not found in registry",
        workerId: "worker-1",
      },
    });

    await flush();
    const failedEvents = eventSink.getByType("workflow:failed");
    expect(failedEvents).toHaveLength(1);
  });

  it("claims and enqueues parallel stages", async () => {
    const schema = z.object({ data: z.string() });
    const stage1 = createPassthroughStage("parallel-a", schema);
    const stage2 = createPassthroughStage("parallel-b", schema);
    const workflow = new WorkflowBuilder(
      "parallel-workflow",
      "Parallel Workflow",
      "Test",
      schema,
      z.object({ "parallel-a": schema, "parallel-b": schema }),
    )
      .parallel([stage1, stage2])
      .build();

    const { kernel, jobTransport } = createTestKernel([workflow]);

    await kernel.dispatch({
      type: "run.create",
      idempotencyKey: "key-1",
      workflowId: "parallel-workflow",
      input: { data: "hello" },
    });

    const result = await kernel.dispatch({
      type: "run.claimPending",
      workerId: "worker-1",
    });

    expect(result.claimed[0]!.jobIds).toHaveLength(2);
    expect(jobTransport.getAllJobs()).toHaveLength(2);
  });
});
