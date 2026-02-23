/**
 * Kernel Tests: lease.reapStale command
 *
 * Tests for releasing stale job leases via the kernel dispatch interface.
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

describe("kernel: lease.reapStale", () => {
  it("releases stale jobs", async () => {
    const workflow = createSimpleWorkflow();
    const { kernel, jobTransport } = createTestKernel([workflow]);

    // Enqueue and dequeue a job (making it "locked")
    await jobTransport.enqueue({
      workflowRunId: "run-1",
      stageId: "stage-1",
      priority: 5,
    });
    await jobTransport.dequeue();

    // Simulate the job being stale by setting its locked time far in the past
    jobTransport.setJobLockedAt(
      jobTransport.getAllJobs()[0]!.id,
      new Date(Date.now() - 120_000),
    );

    const result = await kernel.dispatch({
      type: "lease.reapStale",
      staleThresholdMs: 60_000,
    });

    expect(result.released).toBe(1);
  });

  it("returns 0 when no stale jobs", async () => {
    const { kernel } = createTestKernel([]);

    const result = await kernel.dispatch({
      type: "lease.reapStale",
      staleThresholdMs: 60_000,
    });

    expect(result.released).toBe(0);
  });
});
