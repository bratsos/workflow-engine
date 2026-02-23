/**
 * Stage Events Tests (Kernel)
 *
 * Tests for stage lifecycle events during workflow execution:
 * - stage:started
 * - stage:completed (with timing)
 * - stage:failed
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

function createPassthroughStage(id: string) {
  return defineStage({
    id,
    name: `Stage ${id}`,
    schemas: {
      input: TestStringSchema,
      output: TestStringSchema,
      config: z.object({}),
    },
    async execute(ctx) {
      return { output: ctx.input };
    },
  });
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

describe("I want to track stage lifecycle events", () => {
  describe("stage:started events", () => {
    it("should emit stage:started for each stage", async () => {
      // Given: A workflow with multiple stages
      const stageA = createPassthroughStage("stage-a");
      const stageB = createPassthroughStage("stage-b");
      const stageC = createPassthroughStage("stage-c");

      const workflow = new WorkflowBuilder(
        "multi-stage-started",
        "Multi Stage Started Test",
        "Test",
        TestStringSchema,
        TestStringSchema,
      )
        .pipe(stageA)
        .pipe(stageB)
        .pipe(stageC)
        .build();

      const { kernel, flush, eventSink } = createTestKernel([workflow]);
      const workflowRunId = await setupRun(
        kernel,
        flush,
        eventSink,
        "multi-stage-started",
        { value: "test" },
      );

      // When: Execute all stages
      for (const stageId of ["stage-a", "stage-b", "stage-c"]) {
        await kernel.dispatch({
          type: "job.execute",
          workflowRunId,
          workflowId: "multi-stage-started",
          stageId,
          config: {},
        });
        await kernel.dispatch({ type: "run.transition", workflowRunId });
      }
      await flush();

      // Then: stage:started was emitted for each stage
      const startedEvents = eventSink.getByType("stage:started");
      expect(startedEvents).toHaveLength(3);
      expect(startedEvents.map((e) => e.stageId)).toEqual([
        "stage-a",
        "stage-b",
        "stage-c",
      ]);
    });

    it("should include stageId and stageName in stage:started event", async () => {
      // Given: A stage with specific id and name
      const stage = defineStage({
        id: "my-stage-id",
        name: "My Stage Name",
        schemas: {
          input: TestStringSchema,
          output: TestStringSchema,
          config: z.object({}),
        },
        async execute(ctx) {
          return { output: ctx.input };
        },
      });

      const workflow = new WorkflowBuilder(
        "stage-info-test",
        "Stage Info Test",
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
        "stage-info-test",
        { value: "test" },
      );

      // When: Execute
      await kernel.dispatch({
        type: "job.execute",
        workflowRunId,
        workflowId: "stage-info-test",
        stageId: "my-stage-id",
        config: {},
      });
      await flush();

      // Then: Event includes both stageId and stageName
      const startedEvents = eventSink.getByType("stage:started");
      expect(startedEvents).toHaveLength(1);
      expect(startedEvents[0]!.stageId).toBe("my-stage-id");
      expect(startedEvents[0]!.stageName).toBe("My Stage Name");
    });

    it("should emit stage:started before stage:completed in event order", async () => {
      // Given: A single-stage workflow
      const stage = createPassthroughStage("timing-stage");

      const workflow = new WorkflowBuilder(
        "timing-test",
        "Timing Test",
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
        "timing-test",
        { value: "test" },
      );

      // When: Execute
      await kernel.dispatch({
        type: "job.execute",
        workflowRunId,
        workflowId: "timing-test",
        stageId: "timing-stage",
        config: {},
      });
      await flush();

      // Then: stage:started was emitted before stage:completed
      const allEvents = eventSink.events.filter(
        (e) => e.type === "stage:started" || e.type === "stage:completed",
      );
      expect(allEvents).toHaveLength(2);
      expect(allEvents[0]!.type).toBe("stage:started");
      expect(allEvents[1]!.type).toBe("stage:completed");
    });
  });

  describe("stage:completed events", () => {
    it("should emit stage:completed for each stage", async () => {
      // Given: A workflow with multiple stages
      const stageA = createPassthroughStage("stage-a");
      const stageB = createPassthroughStage("stage-b");

      const workflow = new WorkflowBuilder(
        "multi-stage-completed",
        "Multi Stage Completed Test",
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
        "multi-stage-completed",
        { value: "test" },
      );

      // When: Execute all stages
      for (const stageId of ["stage-a", "stage-b"]) {
        await kernel.dispatch({
          type: "job.execute",
          workflowRunId,
          workflowId: "multi-stage-completed",
          stageId,
          config: {},
        });
        await kernel.dispatch({ type: "run.transition", workflowRunId });
      }
      await flush();

      // Then: stage:completed was emitted for each stage
      const completedEvents = eventSink.getByType("stage:completed");
      expect(completedEvents).toHaveLength(2);
      expect(completedEvents.map((e) => e.stageId)).toEqual([
        "stage-a",
        "stage-b",
      ]);
    });

    it("should include duration in stage:completed event", async () => {
      // Given: A stage
      const stage = defineStage({
        id: "slow-stage",
        name: "Slow Stage",
        schemas: {
          input: TestStringSchema,
          output: TestStringSchema,
          config: z.object({}),
        },
        async execute(ctx) {
          return { output: ctx.input };
        },
      });

      const workflow = new WorkflowBuilder(
        "timing-complete-test",
        "Timing Complete Test",
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
        "timing-complete-test",
        { value: "test" },
      );

      // When: Execute
      await kernel.dispatch({
        type: "job.execute",
        workflowRunId,
        workflowId: "timing-complete-test",
        stageId: "slow-stage",
        config: {},
      });
      await flush();

      // Then: Event includes timing info
      const completedEvents = eventSink.getByType("stage:completed");
      expect(completedEvents).toHaveLength(1);
      expect(completedEvents[0]!.stageId).toBe("slow-stage");
      expect(completedEvents[0]!.duration).toBeDefined();
      expect(typeof completedEvents[0]!.duration).toBe("number");
    });

    it("should emit stage:completed after stage:started", async () => {
      // Given: A stage
      const stage = createPassthroughStage("order-test");

      const workflow = new WorkflowBuilder(
        "event-order-test",
        "Event Order Test",
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
        "event-order-test",
        { value: "test" },
      );

      // When: Execute
      await kernel.dispatch({
        type: "job.execute",
        workflowRunId,
        workflowId: "event-order-test",
        stageId: "order-test",
        config: {},
      });
      await flush();

      // Then: Events are in correct order
      const stageEvents = eventSink.events.filter(
        (e) => e.type === "stage:started" || e.type === "stage:completed",
      );
      expect(stageEvents.map((e) => e.type)).toEqual([
        "stage:started",
        "stage:completed",
      ]);
    });

    it("should include stageId and stageName in stage:completed event", async () => {
      // Given: A stage with specific id and name
      const stage = defineStage({
        id: "complete-info-stage",
        name: "Complete Info Stage",
        schemas: {
          input: TestStringSchema,
          output: TestStringSchema,
          config: z.object({}),
        },
        async execute(ctx) {
          return { output: ctx.input };
        },
      });

      const workflow = new WorkflowBuilder(
        "complete-info-test",
        "Complete Info Test",
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
        "complete-info-test",
        { value: "test" },
      );

      // When: Execute
      await kernel.dispatch({
        type: "job.execute",
        workflowRunId,
        workflowId: "complete-info-test",
        stageId: "complete-info-stage",
        config: {},
      });
      await flush();

      // Then: Event includes stageId and stageName
      const completedEvents = eventSink.getByType("stage:completed");
      expect(completedEvents).toHaveLength(1);
      expect(completedEvents[0]!.stageId).toBe("complete-info-stage");
      expect(completedEvents[0]!.stageName).toBe("Complete Info Stage");
    });
  });

  describe("stage:failed events", () => {
    it("should emit stage:failed on stage error", async () => {
      // Given: A stage that throws an error
      const errorStage = defineStage({
        id: "failing-stage",
        name: "Failing Stage",
        schemas: {
          input: z.object({}).passthrough(),
          output: z.object({}),
          config: z.object({}),
        },
        async execute() {
          throw new Error("Stage error message");
        },
      });

      const workflow = new WorkflowBuilder(
        "stage-failed-test",
        "Stage Failed Test",
        "Test",
        z.object({}).passthrough(),
        z.object({}),
      )
        .pipe(errorStage)
        .build();

      const { kernel, flush, eventSink } = createTestKernel([workflow]);
      const workflowRunId = await setupRun(
        kernel,
        flush,
        eventSink,
        "stage-failed-test",
        {},
      );

      // When: Execute (and it fails)
      const result = await kernel.dispatch({
        type: "job.execute",
        workflowRunId,
        workflowId: "stage-failed-test",
        stageId: "failing-stage",
        config: {},
      });
      await flush();

      // Then: stage:failed was emitted
      expect(result.outcome).toBe("failed");
      const failedEvents = eventSink.getByType("stage:failed");
      expect(failedEvents).toHaveLength(1);
      expect(failedEvents[0]!.stageId).toBe("failing-stage");
    });

    it("should include error message in stage:failed event", async () => {
      // Given: A stage that throws a specific error
      const errorStage = defineStage({
        id: "error-msg-stage",
        name: "Error Message Stage",
        schemas: {
          input: z.object({}).passthrough(),
          output: z.object({}),
          config: z.object({}),
        },
        async execute() {
          throw new Error("Specific error message");
        },
      });

      const workflow = new WorkflowBuilder(
        "error-msg-test",
        "Error Message Test",
        "Test",
        z.object({}).passthrough(),
        z.object({}),
      )
        .pipe(errorStage)
        .build();

      const { kernel, flush, eventSink } = createTestKernel([workflow]);
      const workflowRunId = await setupRun(
        kernel,
        flush,
        eventSink,
        "error-msg-test",
        {},
      );

      // When: Execute (and it fails)
      await kernel.dispatch({
        type: "job.execute",
        workflowRunId,
        workflowId: "error-msg-test",
        stageId: "error-msg-stage",
        config: {},
      });
      await flush();

      // Then: Event includes the error message
      const failedEvents = eventSink.getByType("stage:failed");
      expect(failedEvents).toHaveLength(1);
      expect(failedEvents[0]!.error).toContain("Specific error message");
    });

    it("should emit stage:started before stage:failed", async () => {
      // Given: A failing stage
      const errorStage = defineStage({
        id: "fail-order-stage",
        name: "Fail Order Stage",
        schemas: {
          input: z.object({}).passthrough(),
          output: z.object({}),
          config: z.object({}),
        },
        async execute() {
          throw new Error("Fail order test");
        },
      });

      const workflow = new WorkflowBuilder(
        "fail-order-test",
        "Fail Order Test",
        "Test",
        z.object({}).passthrough(),
        z.object({}),
      )
        .pipe(errorStage)
        .build();

      const { kernel, flush, eventSink } = createTestKernel([workflow]);
      const workflowRunId = await setupRun(
        kernel,
        flush,
        eventSink,
        "fail-order-test",
        {},
      );

      // When: Execute (and it fails)
      await kernel.dispatch({
        type: "job.execute",
        workflowRunId,
        workflowId: "fail-order-test",
        stageId: "fail-order-stage",
        config: {},
      });
      await flush();

      // Then: stage:started came before stage:failed
      const stageEvents = eventSink.events.filter(
        (e) => e.type === "stage:started" || e.type === "stage:failed",
      );
      expect(stageEvents.map((e) => e.type)).toEqual([
        "stage:started",
        "stage:failed",
      ]);
    });

    it("should only emit stage:failed for the failing stage in multi-stage workflow", async () => {
      // Given: A workflow where the second stage fails
      const successStage = createPassthroughStage("success-stage");
      const errorStage = defineStage({
        id: "error-stage",
        name: "Error Stage",
        schemas: {
          input: TestStringSchema,
          output: TestStringSchema,
          config: z.object({}),
        },
        async execute() {
          throw new Error("Second stage failed");
        },
      });

      const workflow = new WorkflowBuilder(
        "partial-fail-test",
        "Partial Fail Test",
        "Test",
        TestStringSchema,
        TestStringSchema,
      )
        .pipe(successStage)
        .pipe(errorStage)
        .build();

      const { kernel, flush, eventSink } = createTestKernel([workflow]);
      const workflowRunId = await setupRun(
        kernel,
        flush,
        eventSink,
        "partial-fail-test",
        { value: "test" },
      );

      // Execute first stage (succeeds)
      await kernel.dispatch({
        type: "job.execute",
        workflowRunId,
        workflowId: "partial-fail-test",
        stageId: "success-stage",
        config: {},
      });
      await kernel.dispatch({ type: "run.transition", workflowRunId });

      // Execute second stage (fails)
      await kernel.dispatch({
        type: "job.execute",
        workflowRunId,
        workflowId: "partial-fail-test",
        stageId: "error-stage",
        config: {},
      });
      await flush();

      // Then: First stage completed, second stage failed
      const completedEvents = eventSink.getByType("stage:completed");
      const failedEvents = eventSink.getByType("stage:failed");
      expect(completedEvents.map((e) => e.stageId)).toEqual(["success-stage"]);
      expect(failedEvents.map((e) => e.stageId)).toEqual(["error-stage"]);
    });
  });
});
