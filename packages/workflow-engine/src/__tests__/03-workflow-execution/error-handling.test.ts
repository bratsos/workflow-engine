/**
 * Workflow Error Handling Tests (Kernel)
 *
 * Tests for error handling during workflow execution via kernel dispatch.
 * The kernel does NOT throw on stage failure -- it returns
 * { outcome: "failed", error: "..." }.
 */

import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createKernel } from "../../kernel/kernel.js";
import {
  FakeClock,
  InMemoryBlobStore,
  CollectingEventSink,
  NoopScheduler,
} from "../../kernel/testing/index.js";
import { InMemoryWorkflowPersistence } from "../../testing/in-memory-persistence.js";
import { InMemoryJobQueue } from "../../testing/in-memory-job-queue.js";
import { defineStage } from "../../core/stage-factory.js";
import { WorkflowBuilder, type Workflow } from "../../core/workflow.js";

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
  return { kernel, flush, persistence, blobStore, jobTransport, eventSink, scheduler, clock, registry };
}

describe("I want to handle workflow errors", () => {
  describe("stage failures", () => {
    it("should return failed outcome when stage throws", async () => {
      // Given: A workflow with a stage that throws
      const errorStage = defineStage({
        id: "failing-stage",
        name: "Stage failing-stage",
        schemas: {
          input: z.object({}).passthrough(),
          output: z.object({}),
          config: z.object({}),
        },
        async execute() {
          throw new Error("Stage exploded!");
        },
      });

      const workflow = new WorkflowBuilder(
        "error-workflow",
        "Error Workflow",
        "Test",
        z.object({}).passthrough(),
        z.object({}),
      )
        .pipe(errorStage)
        .build();

      const { kernel, flush } = createTestKernel([workflow]);

      const { workflowRunId } = await kernel.dispatch({
        type: "run.create",
        idempotencyKey: "key-1",
        workflowId: "error-workflow",
        input: {},
      });

      await kernel.dispatch({ type: "run.claimPending", workerId: "worker-1" });

      // When: I execute
      const result = await kernel.dispatch({
        type: "job.execute",
        workflowRunId,
        workflowId: "error-workflow",
        stageId: "failing-stage",
        config: {},
      });

      // Then: Returns failed outcome with error message
      expect(result.outcome).toBe("failed");
      expect(result.error).toBe("Stage exploded!");
    });

    it("should emit workflow:failed event on error", async () => {
      // Given: A workflow with a failing stage
      const errorStage = defineStage({
        id: "failing",
        name: "Stage failing",
        schemas: {
          input: z.object({}).passthrough(),
          output: z.object({}),
          config: z.object({}),
        },
        async execute() {
          throw new Error("Something went wrong");
        },
      });

      const workflow = new WorkflowBuilder(
        "fail-event-workflow",
        "Fail Event Workflow",
        "Test",
        z.object({}).passthrough(),
        z.object({}),
      )
        .pipe(errorStage)
        .build();

      const { kernel, flush, eventSink } = createTestKernel([workflow]);

      const { workflowRunId } = await kernel.dispatch({
        type: "run.create",
        idempotencyKey: "key-1",
        workflowId: "fail-event-workflow",
        input: {},
      });

      await kernel.dispatch({ type: "run.claimPending", workerId: "worker-1" });
      await flush();
      eventSink.clear();

      // When: I execute (and it fails)
      await kernel.dispatch({
        type: "job.execute",
        workflowRunId,
        workflowId: "fail-event-workflow",
        stageId: "failing",
        config: {},
      });

      // Transition to mark the run as failed
      await kernel.dispatch({ type: "run.transition", workflowRunId });
      await flush();

      // Then: workflow:failed event was emitted
      const failedEvents = eventSink.getByType("workflow:failed");
      expect(failedEvents).toHaveLength(1);
      expect((failedEvents[0] as any).workflowRunId).toBe(workflowRunId);
      expect((failedEvents[0] as any).error).toContain("Something went wrong");
    });

    it("should emit stage:failed event on stage error", async () => {
      // Given: A workflow with a failing stage
      const errorStage = defineStage({
        id: "stage-fail",
        name: "Stage stage-fail",
        schemas: {
          input: z.object({}).passthrough(),
          output: z.object({}),
          config: z.object({}),
        },
        async execute() {
          throw new Error("Stage failed");
        },
      });

      const workflow = new WorkflowBuilder(
        "stage-fail-event",
        "Stage Fail Event",
        "Test",
        z.object({}).passthrough(),
        z.object({}),
      )
        .pipe(errorStage)
        .build();

      const { kernel, flush, eventSink } = createTestKernel([workflow]);

      const { workflowRunId } = await kernel.dispatch({
        type: "run.create",
        idempotencyKey: "key-1",
        workflowId: "stage-fail-event",
        input: {},
      });

      await kernel.dispatch({ type: "run.claimPending", workerId: "worker-1" });
      await flush();
      eventSink.clear();

      // When: I execute
      await kernel.dispatch({
        type: "job.execute",
        workflowRunId,
        workflowId: "stage-fail-event",
        stageId: "stage-fail",
        config: {},
      });

      await flush();

      // Then: stage:failed event was emitted
      const stageFailedEvents = eventSink.getByType("stage:failed");
      expect(stageFailedEvents).toHaveLength(1);
      expect((stageFailedEvents[0] as any).stageId).toBe("stage-fail");
      expect((stageFailedEvents[0] as any).error).toContain("Stage failed");
    });
  });

  describe("persistence status updates on failure", () => {
    it("should update run status to FAILED on error", async () => {
      // Given: A failing workflow
      const errorStage = defineStage({
        id: "fail-status",
        name: "Stage fail-status",
        schemas: {
          input: z.object({}).passthrough(),
          output: z.object({}),
          config: z.object({}),
        },
        async execute() {
          throw new Error("Failure for status test");
        },
      });

      const workflow = new WorkflowBuilder(
        "fail-status-workflow",
        "Fail Status Workflow",
        "Test",
        z.object({}).passthrough(),
        z.object({}),
      )
        .pipe(errorStage)
        .build();

      const { kernel, flush, persistence } = createTestKernel([workflow]);

      const { workflowRunId } = await kernel.dispatch({
        type: "run.create",
        idempotencyKey: "key-1",
        workflowId: "fail-status-workflow",
        input: {},
      });

      await kernel.dispatch({ type: "run.claimPending", workerId: "worker-1" });

      await kernel.dispatch({
        type: "job.execute",
        workflowRunId,
        workflowId: "fail-status-workflow",
        stageId: "fail-status",
        config: {},
      });

      // Transition marks the run as failed
      await kernel.dispatch({ type: "run.transition", workflowRunId });
      await flush();

      // Then: Run status is FAILED
      const run = await persistence.getRun(workflowRunId);
      expect(run?.status).toBe("FAILED");
      expect(run?.completedAt).toBeDefined();
    });

    it("should update stage status to FAILED on error", async () => {
      // Given: A failing workflow
      const errorStage = defineStage({
        id: "stage-fail-status",
        name: "Stage stage-fail-status",
        schemas: {
          input: z.object({}).passthrough(),
          output: z.object({}),
          config: z.object({}),
        },
        async execute() {
          throw new Error("Stage status failure");
        },
      });

      const workflow = new WorkflowBuilder(
        "stage-fail-status-workflow",
        "Stage Fail Status Workflow",
        "Test",
        z.object({}).passthrough(),
        z.object({}),
      )
        .pipe(errorStage)
        .build();

      const { kernel, flush, persistence } = createTestKernel([workflow]);

      const { workflowRunId } = await kernel.dispatch({
        type: "run.create",
        idempotencyKey: "key-1",
        workflowId: "stage-fail-status-workflow",
        input: {},
      });

      await kernel.dispatch({ type: "run.claimPending", workerId: "worker-1" });

      await kernel.dispatch({
        type: "job.execute",
        workflowRunId,
        workflowId: "stage-fail-status-workflow",
        stageId: "stage-fail-status",
        config: {},
      });

      await flush();

      // Then: Stage status is FAILED with error message
      const stages = await persistence.getStagesByRun(workflowRunId);
      const uniqueStages = new Map(stages.map((s) => [s.stageId, s]));
      const failedStage = uniqueStages.get("stage-fail-status");

      expect(failedStage).toBeDefined();
      expect(failedStage?.status).toBe("FAILED");
      expect(failedStage?.errorMessage).toContain("Stage status failure");
    });
  });

  describe("partial execution failure", () => {
    it("should mark only the failing stage as failed in multi-stage workflow", async () => {
      // Given: A workflow where second stage fails
      const schema = z.object({ value: z.string() });

      const successStage = defineStage({
        id: "success-stage",
        name: "Stage success-stage",
        schemas: { input: schema, output: schema, config: z.object({}) },
        async execute(ctx) { return { output: ctx.input }; },
      });

      const errorStage = defineStage({
        id: "error-stage",
        name: "Error Stage",
        schemas: { input: schema, output: schema, config: z.object({}) },
        async execute() {
          throw new Error("Second stage failed");
        },
      });

      const workflow = new WorkflowBuilder(
        "partial-fail",
        "Partial Fail Workflow",
        "Test",
        schema,
        schema,
      )
        .pipe(successStage)
        .pipe(errorStage)
        .build();

      const { kernel, flush, persistence } = createTestKernel([workflow]);

      const { workflowRunId } = await kernel.dispatch({
        type: "run.create",
        idempotencyKey: "key-1",
        workflowId: "partial-fail",
        input: { value: "test" },
      });

      await kernel.dispatch({ type: "run.claimPending", workerId: "worker-1" });

      // Execute first stage (succeeds)
      const r1 = await kernel.dispatch({
        type: "job.execute",
        workflowRunId,
        workflowId: "partial-fail",
        stageId: "success-stage",
        config: {},
      });
      expect(r1.outcome).toBe("completed");

      // Transition to second stage
      await kernel.dispatch({ type: "run.transition", workflowRunId });

      // Execute second stage (fails)
      const r2 = await kernel.dispatch({
        type: "job.execute",
        workflowRunId,
        workflowId: "partial-fail",
        stageId: "error-stage",
        config: {},
      });
      expect(r2.outcome).toBe("failed");
      expect(r2.error).toBe("Second stage failed");

      await flush();

      // Then: First stage is COMPLETED, second is FAILED
      const stages = await persistence.getStagesByRun(workflowRunId);
      const uniqueStages = new Map(stages.map((s) => [s.stageId, s]));

      const firstStage = uniqueStages.get("success-stage");
      const secondStage = uniqueStages.get("error-stage");

      expect(firstStage?.status).toBe("COMPLETED");
      expect(secondStage?.status).toBe("FAILED");
    });

    it("should not execute stages after a failure", async () => {
      // Given: A workflow with 3 stages where the 2nd fails
      const tracker: string[] = [];
      const schema = z.object({ value: z.string() });

      const stage1 = defineStage({
        id: "stage-1",
        name: "Stage 1",
        schemas: { input: schema, output: schema, config: z.object({}) },
        async execute(ctx) {
          tracker.push("stage-1");
          return { output: ctx.input };
        },
      });

      const stage2 = defineStage({
        id: "stage-2",
        name: "Stage 2",
        schemas: { input: schema, output: schema, config: z.object({}) },
        async execute() {
          tracker.push("stage-2");
          throw new Error("Stage 2 failed");
        },
      });

      const stage3 = defineStage({
        id: "stage-3",
        name: "Stage 3",
        schemas: { input: schema, output: schema, config: z.object({}) },
        async execute(ctx) {
          tracker.push("stage-3");
          return { output: ctx.input };
        },
      });

      const workflow = new WorkflowBuilder(
        "stop-on-fail",
        "Stop On Fail Workflow",
        "Test",
        schema,
        schema,
      )
        .pipe(stage1)
        .pipe(stage2)
        .pipe(stage3)
        .build();

      const { kernel, flush } = createTestKernel([workflow]);

      const { workflowRunId } = await kernel.dispatch({
        type: "run.create",
        idempotencyKey: "key-1",
        workflowId: "stop-on-fail",
        input: { value: "test" },
      });

      await kernel.dispatch({ type: "run.claimPending", workerId: "worker-1" });

      // Execute stage 1 (succeeds)
      await kernel.dispatch({
        type: "job.execute",
        workflowRunId,
        workflowId: "stop-on-fail",
        stageId: "stage-1",
        config: {},
      });
      await kernel.dispatch({ type: "run.transition", workflowRunId });

      // Execute stage 2 (fails)
      const r2 = await kernel.dispatch({
        type: "job.execute",
        workflowRunId,
        workflowId: "stop-on-fail",
        stageId: "stage-2",
        config: {},
      });
      expect(r2.outcome).toBe("failed");

      // Transition marks workflow as failed, so stage 3 never gets enqueued
      const transition = await kernel.dispatch({ type: "run.transition", workflowRunId });
      expect(transition.action).toBe("failed");

      await flush();

      // Then: Stage 3 was never executed
      expect(tracker).toEqual(["stage-1", "stage-2"]);
      expect(tracker).not.toContain("stage-3");
    });
  });

  describe("input validation errors", () => {
    it("should return failed outcome on invalid stage input", async () => {
      // Given: A stage that requires specific input
      const strictStage = defineStage({
        id: "strict-input",
        name: "Strict Input Stage",
        schemas: {
          input: z.object({ required: z.string() }),
          output: z.object({ result: z.string() }),
          config: z.object({}),
        },
        async execute(ctx) {
          return { output: { result: ctx.input.required } };
        },
      });

      const workflow = new WorkflowBuilder(
        "input-validation",
        "Input Validation",
        "Test",
        z.object({ required: z.string() }),
        z.object({ result: z.string() }),
      )
        .pipe(strictStage)
        .build();

      const { kernel, flush, persistence } = createTestKernel([workflow]);

      // Create run manually with invalid input (bypass run.create validation)
      const run = await persistence.createRun({
        workflowId: "input-validation",
        workflowName: "Input Validation",
        workflowType: "input-validation",
        input: {}, // Missing required field
      });
      await persistence.updateRun(run.id, { status: "RUNNING" });

      // When: I execute with invalid input
      const result = await kernel.dispatch({
        type: "job.execute",
        workflowRunId: run.id,
        workflowId: "input-validation",
        stageId: "strict-input",
        config: {},
      });

      // Then: Kernel returns failed outcome
      expect(result.outcome).toBe("failed");
    });
  });

  describe("config validation errors", () => {
    it("should fail before execution with invalid config", async () => {
      // Given: A stage requiring specific config
      const configStage = defineStage({
        id: "config-required",
        name: "Config Required Stage",
        schemas: {
          input: z.object({ value: z.string() }),
          output: z.object({ value: z.string() }),
          config: z.object({
            model: z.string(),
          }),
        },
        async execute(ctx) {
          return { output: ctx.input };
        },
      });

      const workflow = new WorkflowBuilder(
        "config-validation",
        "Config Validation",
        "Test",
        z.object({ value: z.string() }),
        z.object({ value: z.string() }),
      )
        .pipe(configStage)
        .build();

      const { kernel } = createTestKernel([workflow]);

      // When: I try to create a run with missing config
      // Then: Kernel validates config at run.create time and throws
      await expect(
        kernel.dispatch({
          type: "run.create",
          idempotencyKey: "key-1",
          workflowId: "config-validation",
          input: { value: "test" },
          config: { "config-required": {} },
        }),
      ).rejects.toThrow(/invalid workflow config/i);
    });
  });
});
