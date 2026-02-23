/**
 * Progress Reporting Tests (Kernel)
 *
 * Tests for stage progress reporting during workflow execution:
 * - stage:progress events emitted through the kernel outbox
 * - Multiple progress updates
 * - Progress event details
 */

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

const TestStringSchema = z.object({ value: z.string() });

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

/** Helper: create a run, claim it, and return the runId */
async function setupRun(
  kernel: ReturnType<typeof createTestKernel>["kernel"],
  flush: () => Promise<any>,
  eventSink: CollectingEventSink,
  workflowId: string,
  input: unknown,
) {
  const { workflowRunId } = await kernel.dispatch({
    type: "run.create",
    idempotencyKey: `key-${workflowId}-${Date.now()}`,
    workflowId,
    input,
  });
  await kernel.dispatch({ type: "run.claimPending", workerId: "worker-1" });
  await flush();
  eventSink.clear();
  return workflowRunId;
}

describe("I want to track stage progress", () => {
  describe("basic progress reporting", () => {
    it("should emit stage:progress when reported", async () => {
      // Given: A stage that reports progress
      const stage = defineStage({
        id: "progress-stage",
        name: "Progress Stage",
        schemas: {
          input: TestStringSchema,
          output: TestStringSchema,
          config: z.object({}),
        },
        async execute(ctx) {
          ctx.onProgress({ progress: 50, message: "halfway done" });
          return { output: ctx.input };
        },
      });

      const workflow = new WorkflowBuilder(
        "progress-test",
        "Progress Test",
        "Test",
        TestStringSchema,
        TestStringSchema,
      )
        .pipe(stage)
        .build();

      const { kernel, flush, eventSink } = createTestKernel([workflow]);
      const workflowRunId = await setupRun(
        kernel,
        flush,
        eventSink,
        "progress-test",
        { value: "test" },
      );

      // When: Execute
      await kernel.dispatch({
        type: "job.execute",
        workflowRunId,
        workflowId: "progress-test",
        stageId: "progress-stage",
        config: {},
      });
      await flush();

      // Then: Progress event was emitted
      const progressEvents = eventSink.getByType("stage:progress");
      expect(progressEvents.length).toBeGreaterThanOrEqual(1);
      expect(progressEvents[0]).toMatchObject({
        type: "stage:progress",
        stageId: "progress-stage",
        progress: 50,
        message: "halfway done",
      });
    });

    it("should emit progress event with correct properties", async () => {
      // Given: A stage that reports progress with all properties
      const stage = defineStage({
        id: "full-progress-stage",
        name: "Full Progress Stage",
        schemas: {
          input: TestStringSchema,
          output: TestStringSchema,
          config: z.object({}),
        },
        async execute(ctx) {
          ctx.onProgress({ progress: 25, message: "started" });
          return { output: ctx.input };
        },
      });

      const workflow = new WorkflowBuilder(
        "full-progress-test",
        "Full Progress Test",
        "Test",
        TestStringSchema,
        TestStringSchema,
      )
        .pipe(stage)
        .build();

      const { kernel, flush, eventSink } = createTestKernel([workflow]);
      const workflowRunId = await setupRun(
        kernel,
        flush,
        eventSink,
        "full-progress-test",
        { value: "test" },
      );

      // When: Execute
      await kernel.dispatch({
        type: "job.execute",
        workflowRunId,
        workflowId: "full-progress-test",
        stageId: "full-progress-stage",
        config: {},
      });
      await flush();

      // Then: Progress event includes progress and message
      const progressEvents = eventSink.getByType("stage:progress");
      expect(progressEvents).toHaveLength(1);
      expect(progressEvents[0]!.progress).toBe(25);
      expect(progressEvents[0]!.message).toBe("started");
      expect(progressEvents[0]!.workflowRunId).toBe(workflowRunId);
    });
  });

  describe("multiple progress updates", () => {
    it("should emit multiple progress updates", async () => {
      // Given: A stage that reports multiple progress updates
      const stage = defineStage({
        id: "multi-progress-stage",
        name: "Multi Progress Stage",
        schemas: {
          input: TestStringSchema,
          output: TestStringSchema,
          config: z.object({}),
        },
        async execute(ctx) {
          ctx.onProgress({ progress: 25, message: "step 1" });
          ctx.onProgress({ progress: 50, message: "step 2" });
          ctx.onProgress({ progress: 75, message: "step 3" });
          ctx.onProgress({ progress: 100, message: "complete" });
          return { output: ctx.input };
        },
      });

      const workflow = new WorkflowBuilder(
        "multi-progress-test",
        "Multi Progress Test",
        "Test",
        TestStringSchema,
        TestStringSchema,
      )
        .pipe(stage)
        .build();

      const { kernel, flush, eventSink } = createTestKernel([workflow]);
      const workflowRunId = await setupRun(
        kernel,
        flush,
        eventSink,
        "multi-progress-test",
        { value: "test" },
      );

      // When: Execute
      await kernel.dispatch({
        type: "job.execute",
        workflowRunId,
        workflowId: "multi-progress-test",
        stageId: "multi-progress-stage",
        config: {},
      });
      await flush();

      // Then: All progress updates were emitted
      const progressEvents = eventSink.getByType("stage:progress");
      expect(progressEvents).toHaveLength(4);
      expect(progressEvents.map((e) => e.progress)).toEqual([25, 50, 75, 100]);
      expect(progressEvents.map((e) => e.message)).toEqual([
        "step 1",
        "step 2",
        "step 3",
        "complete",
      ]);
    });

    it("should emit progress in correct order", async () => {
      // Given: A stage that reports progress updates sequentially
      const stage = defineStage({
        id: "ordered-progress-stage",
        name: "Ordered Progress Stage",
        schemas: {
          input: TestStringSchema,
          output: TestStringSchema,
          config: z.object({}),
        },
        async execute(ctx) {
          ctx.onProgress({ progress: 10, message: "first" });
          ctx.onProgress({ progress: 50, message: "middle" });
          ctx.onProgress({ progress: 90, message: "last" });
          return { output: ctx.input };
        },
      });

      const workflow = new WorkflowBuilder(
        "ordered-progress-test",
        "Ordered Progress Test",
        "Test",
        TestStringSchema,
        TestStringSchema,
      )
        .pipe(stage)
        .build();

      const { kernel, flush, eventSink } = createTestKernel([workflow]);
      const workflowRunId = await setupRun(
        kernel,
        flush,
        eventSink,
        "ordered-progress-test",
        { value: "test" },
      );

      // When: Execute
      await kernel.dispatch({
        type: "job.execute",
        workflowRunId,
        workflowId: "ordered-progress-test",
        stageId: "ordered-progress-stage",
        config: {},
      });
      await flush();

      // Then: Progress events are in order
      const progressEvents = eventSink.getByType("stage:progress");
      expect(progressEvents).toHaveLength(3);
      expect(progressEvents[0]!.progress).toBe(10);
      expect(progressEvents[1]!.progress).toBe(50);
      expect(progressEvents[2]!.progress).toBe(90);
    });

    it("should track progress across multiple stages", async () => {
      // Given: Multiple stages that each report progress
      const stageA = defineStage({
        id: "stage-a",
        name: "Stage A",
        schemas: {
          input: TestStringSchema,
          output: TestStringSchema,
          config: z.object({}),
        },
        async execute(ctx) {
          ctx.onProgress({ progress: 50, message: "A progress" });
          return { output: ctx.input };
        },
      });

      const stageB = defineStage({
        id: "stage-b",
        name: "Stage B",
        schemas: {
          input: TestStringSchema,
          output: TestStringSchema,
          config: z.object({}),
        },
        async execute(ctx) {
          ctx.onProgress({ progress: 50, message: "B progress" });
          return { output: ctx.input };
        },
      });

      const workflow = new WorkflowBuilder(
        "multi-stage-progress-test",
        "Multi Stage Progress Test",
        "Test",
        TestStringSchema,
        TestStringSchema,
      )
        .pipe(stageA)
        .pipe(stageB)
        .build();

      const { kernel, flush, eventSink } = createTestKernel([workflow]);
      const workflowRunId = await setupRun(
        kernel,
        flush,
        eventSink,
        "multi-stage-progress-test",
        { value: "test" },
      );

      // When: Execute both stages
      await kernel.dispatch({
        type: "job.execute",
        workflowRunId,
        workflowId: "multi-stage-progress-test",
        stageId: "stage-a",
        config: {},
      });
      await kernel.dispatch({ type: "run.transition", workflowRunId });

      await kernel.dispatch({
        type: "job.execute",
        workflowRunId,
        workflowId: "multi-stage-progress-test",
        stageId: "stage-b",
        config: {},
      });
      await flush();

      // Then: Both stages emitted progress events
      const progressEvents = eventSink.getByType("stage:progress");
      expect(progressEvents).toHaveLength(2);
      expect(progressEvents.map((e) => e.message)).toContain("A progress");
      expect(progressEvents.map((e) => e.message)).toContain("B progress");
    });
  });

  describe("progress event details", () => {
    it("should include details in progress event", async () => {
      // Given: A stage that reports progress with details
      const stage = defineStage({
        id: "details-progress-stage",
        name: "Details Progress Stage",
        schemas: {
          input: TestStringSchema,
          output: TestStringSchema,
          config: z.object({}),
        },
        async execute(ctx) {
          ctx.onProgress({
            progress: 50,
            message: "processing",
            details: { itemsProcessed: 50, totalItems: 100 },
          });
          return { output: ctx.input };
        },
      });

      const workflow = new WorkflowBuilder(
        "details-progress-test",
        "Details Progress Test",
        "Test",
        TestStringSchema,
        TestStringSchema,
      )
        .pipe(stage)
        .build();

      const { kernel, flush, eventSink } = createTestKernel([workflow]);
      const workflowRunId = await setupRun(
        kernel,
        flush,
        eventSink,
        "details-progress-test",
        { value: "test" },
      );

      // When: Execute
      await kernel.dispatch({
        type: "job.execute",
        workflowRunId,
        workflowId: "details-progress-test",
        stageId: "details-progress-stage",
        config: {},
      });
      await flush();

      // Then: Progress event includes details
      const progressEvents = eventSink.getByType("stage:progress");
      expect(progressEvents).toHaveLength(1);
      expect(progressEvents[0]!.progress).toBe(50);
      expect(progressEvents[0]!.message).toBe("processing");
      expect(progressEvents[0]!.details).toEqual({
        itemsProcessed: 50,
        totalItems: 100,
      });
    });

    it("should handle progress without details", async () => {
      // Given: A stage that reports progress without details
      const stage = defineStage({
        id: "simple-progress-stage",
        name: "Simple Progress Stage",
        schemas: {
          input: TestStringSchema,
          output: TestStringSchema,
          config: z.object({}),
        },
        async execute(ctx) {
          ctx.onProgress({ progress: 50, message: "halfway" });
          return { output: ctx.input };
        },
      });

      const workflow = new WorkflowBuilder(
        "simple-progress-test",
        "Simple Progress Test",
        "Test",
        TestStringSchema,
        TestStringSchema,
      )
        .pipe(stage)
        .build();

      const { kernel, flush, eventSink } = createTestKernel([workflow]);
      const workflowRunId = await setupRun(
        kernel,
        flush,
        eventSink,
        "simple-progress-test",
        { value: "test" },
      );

      // When: Execute
      await kernel.dispatch({
        type: "job.execute",
        workflowRunId,
        workflowId: "simple-progress-test",
        stageId: "simple-progress-stage",
        config: {},
      });
      await flush();

      // Then: Progress event was emitted
      const progressEvents = eventSink.getByType("stage:progress");
      expect(progressEvents).toHaveLength(1);
      expect(progressEvents[0]!.progress).toBe(50);
      expect(progressEvents[0]!.message).toBe("halfway");
    });

    it("should pass through nested details in progress event", async () => {
      // Given: A stage that reports progress with nested details
      const stage = defineStage({
        id: "nested-details-stage",
        name: "Nested Details Stage",
        schemas: {
          input: TestStringSchema,
          output: TestStringSchema,
          config: z.object({}),
        },
        async execute(ctx) {
          ctx.onProgress({
            progress: 75,
            message: "batch processing",
            details: {
              batch: { id: "batch-1", processed: 75, total: 100 },
              errors: [],
            },
          });
          return { output: ctx.input };
        },
      });

      const workflow = new WorkflowBuilder(
        "nested-details-test",
        "Nested Details Test",
        "Test",
        TestStringSchema,
        TestStringSchema,
      )
        .pipe(stage)
        .build();

      const { kernel, flush, eventSink } = createTestKernel([workflow]);
      const workflowRunId = await setupRun(
        kernel,
        flush,
        eventSink,
        "nested-details-test",
        { value: "test" },
      );

      // When: Execute
      await kernel.dispatch({
        type: "job.execute",
        workflowRunId,
        workflowId: "nested-details-test",
        stageId: "nested-details-stage",
        config: {},
      });
      await flush();

      // Then: Nested details come through correctly
      const progressEvents = eventSink.getByType("stage:progress");
      expect(progressEvents).toHaveLength(1);
      expect(progressEvents[0]!.progress).toBe(75);
      expect(progressEvents[0]!.message).toBe("batch processing");
      expect(progressEvents[0]!.details).toEqual({
        batch: { id: "batch-1", processed: 75, total: 100 },
        errors: [],
      });
    });
  });
});
