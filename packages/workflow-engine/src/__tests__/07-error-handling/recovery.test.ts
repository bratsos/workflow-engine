/**
 * Error Recovery Tests
 *
 * Tests for workflow recovery after failures, rewritten to use kernel dispatch()
 * and the run.rerunFrom kernel command.
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
    persistence, blobStore, jobTransport, eventSink, scheduler, clock,
    registry: { getWorkflow: (id) => registry.get(id) },
  });
  const flush = () => kernel.dispatch({ type: "outbox.flush" as const });
  return { kernel, flush, persistence, blobStore, jobTransport, eventSink, scheduler, clock, registry };
}

const StringSchema = z.object({ value: z.string() });

describe("I want to recover from workflow failures", () => {
  describe("preserving completed outputs", () => {
    it("should preserve completed stage outputs on failure", async () => {
      // Given: A workflow where the second stage fails
      const stage1Output = { value: "stage1-output" };

      const stage1 = defineStage({
        id: "preserve-stage-1",
        name: "Stage 1",
        schemas: { input: StringSchema, output: StringSchema, config: z.object({}) },
        async execute() {
          return { output: stage1Output };
        },
      });

      const stage2 = defineStage({
        id: "preserve-stage-2",
        name: "Stage 2",
        schemas: { input: StringSchema, output: StringSchema, config: z.object({}) },
        async execute() {
          throw new Error("Stage 2 failed");
        },
      });

      const workflow = new WorkflowBuilder(
        "preserve-outputs-workflow",
        "Preserve Outputs Workflow",
        "Test",
        StringSchema,
        StringSchema,
      )
        .pipe(stage1)
        .pipe(stage2)
        .build();

      const { kernel, flush, persistence, blobStore } = createTestKernel([workflow]);

      const createResult = await kernel.dispatch({
        type: "run.create",
        idempotencyKey: "key-preserve-outputs",
        workflowId: "preserve-outputs-workflow",
        input: { value: "initial" },
      });

      await persistence.updateRun(createResult.workflowRunId, { status: "RUNNING" });
      await flush();

      // Execute stage 1 successfully
      const result1 = await kernel.dispatch({
        type: "job.execute",
        workflowRunId: createResult.workflowRunId,
        workflowId: "preserve-outputs-workflow",
        stageId: "preserve-stage-1",
        config: {},
      });
      expect(result1.outcome).toBe("completed");
      expect(result1.output).toEqual(stage1Output);

      // Execute stage 2 (fails)
      const result2 = await kernel.dispatch({
        type: "job.execute",
        workflowRunId: createResult.workflowRunId,
        workflowId: "preserve-outputs-workflow",
        stageId: "preserve-stage-2",
        config: {},
      });
      expect(result2.outcome).toBe("failed");

      // Then: Stage 1's output is preserved
      const stages = await persistence.getStagesByRun(createResult.workflowRunId);
      const stageMap = new Map(stages.map((s) => [s.stageId, s]));
      const completedStage = stageMap.get("preserve-stage-1");

      expect(completedStage).toBeDefined();
      expect(completedStage?.status).toBe("COMPLETED");

      // Output is stored as an artifact reference in blobStore
      const outputRef = completedStage?.outputData as { _artifactKey?: string };
      expect(outputRef?._artifactKey).toBeDefined();
      expect(blobStore.size()).toBeGreaterThanOrEqual(1);
    });

    it("should preserve multiple completed stage outputs before failure", async () => {
      // Given: A 4-stage workflow where stage 3 fails
      const outputs: Record<string, { value: string }> = {
        "multi-stage-1": { value: "output-1" },
        "multi-stage-2": { value: "output-2" },
      };

      const createSuccessStage = (id: string) =>
        defineStage({
          id,
          name: `Stage ${id}`,
          schemas: { input: StringSchema, output: StringSchema, config: z.object({}) },
          async execute() {
            return { output: outputs[id] };
          },
        });

      const failingStage = defineStage({
        id: "multi-stage-3",
        name: "Stage 3",
        schemas: { input: StringSchema, output: StringSchema, config: z.object({}) },
        async execute() {
          throw new Error("Stage 3 failed");
        },
      });

      const stage4 = defineStage({
        id: "multi-stage-4",
        name: "Stage 4",
        schemas: { input: StringSchema, output: StringSchema, config: z.object({}) },
        async execute(ctx) {
          return { output: ctx.input };
        },
      });

      const workflow = new WorkflowBuilder(
        "multi-preserve-workflow",
        "Multi Preserve Workflow",
        "Test",
        StringSchema,
        StringSchema,
      )
        .pipe(createSuccessStage("multi-stage-1"))
        .pipe(createSuccessStage("multi-stage-2"))
        .pipe(failingStage)
        .pipe(stage4)
        .build();

      const { kernel, flush, persistence } = createTestKernel([workflow]);

      const createResult = await kernel.dispatch({
        type: "run.create",
        idempotencyKey: "key-multi-preserve",
        workflowId: "multi-preserve-workflow",
        input: { value: "initial" },
      });

      await persistence.updateRun(createResult.workflowRunId, { status: "RUNNING" });
      await flush();

      // Execute stages 1 and 2 successfully
      const r1 = await kernel.dispatch({
        type: "job.execute",
        workflowRunId: createResult.workflowRunId,
        workflowId: "multi-preserve-workflow",
        stageId: "multi-stage-1",
        config: {},
      });
      expect(r1.outcome).toBe("completed");

      const r2 = await kernel.dispatch({
        type: "job.execute",
        workflowRunId: createResult.workflowRunId,
        workflowId: "multi-preserve-workflow",
        stageId: "multi-stage-2",
        config: {},
      });
      expect(r2.outcome).toBe("completed");

      // Execute stage 3 (fails)
      const r3 = await kernel.dispatch({
        type: "job.execute",
        workflowRunId: createResult.workflowRunId,
        workflowId: "multi-preserve-workflow",
        stageId: "multi-stage-3",
        config: {},
      });
      expect(r3.outcome).toBe("failed");

      // Then: Stages 1 and 2 outputs are preserved, stage 3 is FAILED
      const stages = await persistence.getStagesByRun(createResult.workflowRunId);
      const stageMap = new Map(stages.map((s) => [s.stageId, s]));

      expect(stageMap.get("multi-stage-1")?.status).toBe("COMPLETED");
      const stage1Ref = stageMap.get("multi-stage-1")?.outputData as {
        _artifactKey?: string;
      };
      expect(stage1Ref?._artifactKey).toBeDefined();

      expect(stageMap.get("multi-stage-2")?.status).toBe("COMPLETED");
      const stage2Ref = stageMap.get("multi-stage-2")?.outputData as {
        _artifactKey?: string;
      };
      expect(stage2Ref?._artifactKey).toBeDefined();

      expect(stageMap.get("multi-stage-3")?.status).toBe("FAILED");
      expect(stageMap.get("multi-stage-4")).toBeUndefined(); // Never executed
    });
  });

  describe("retry from failed stage", () => {
    it("should allow retry from failed stage using run.rerunFrom", async () => {
      // Given: A 2-stage workflow where stage2 fails on first attempt, succeeds on second
      let stage2Attempts = 0;

      const stage1 = defineStage({
        id: "stage1-id",
        name: "Stage 1",
        schemas: { input: StringSchema, output: StringSchema, config: z.object({}) },
        async execute() {
          return { output: { value: "stage1-done" } };
        },
      });

      const stage2 = defineStage({
        id: "stage2-id",
        name: "Stage 2",
        schemas: { input: z.any(), output: StringSchema, config: z.object({}) },
        async execute() {
          stage2Attempts++;
          if (stage2Attempts === 1) throw new Error("stage2 failed on first attempt");
          return { output: { value: "stage2-done" } };
        },
      });

      const workflow = new WorkflowBuilder(
        "retry-wf",
        "Retry Workflow",
        "Test",
        StringSchema,
        StringSchema,
      )
        .pipe(stage1)
        .pipe(stage2)
        .build();

      const { kernel, flush, persistence } = createTestKernel([workflow]);

      // Create and claim
      const { workflowRunId } = await kernel.dispatch({
        type: "run.create",
        idempotencyKey: "key-retry-1",
        workflowId: "retry-wf",
        input: { value: "start" },
      });
      await kernel.dispatch({ type: "run.claimPending", workerId: "w1" });

      // Execute stage1 successfully
      await kernel.dispatch({
        type: "job.execute",
        workflowRunId,
        workflowId: "retry-wf",
        stageId: "stage1-id",
        config: {},
      });
      await kernel.dispatch({ type: "run.transition", workflowRunId });

      // Execute stage2 (fails on first attempt)
      await kernel.dispatch({
        type: "job.execute",
        workflowRunId,
        workflowId: "retry-wf",
        stageId: "stage2-id",
        config: {},
      });
      const transResult = await kernel.dispatch({ type: "run.transition", workflowRunId });
      expect(transResult.action).toBe("failed");

      const failedRun = await persistence.getRun(workflowRunId);
      expect(failedRun!.status).toBe("FAILED");

      // Retry from the failed stage
      await kernel.dispatch({
        type: "run.rerunFrom",
        workflowRunId,
        fromStageId: "stage2-id",
      });

      // Execute stage2 again (succeeds this time)
      await kernel.dispatch({
        type: "job.execute",
        workflowRunId,
        workflowId: "retry-wf",
        stageId: "stage2-id",
        config: {},
      });
      await kernel.dispatch({ type: "run.transition", workflowRunId });
      await flush();

      // Verify: run is COMPLETED, stage2 was attempted twice
      const run = await persistence.getRun(workflowRunId);
      expect(run!.status).toBe("COMPLETED");
      expect(stage2Attempts).toBe(2);
    });

    it("should not re-execute completed stages on retry", async () => {
      // Given: A 2-stage workflow with execution counters on both stages
      let stage1Count = 0;
      let stage2Count = 0;

      const stage1 = defineStage({
        id: "stage1-id",
        name: "Stage 1",
        schemas: { input: StringSchema, output: StringSchema, config: z.object({}) },
        async execute() {
          stage1Count++;
          return { output: { value: "stage1-done" } };
        },
      });

      const stage2 = defineStage({
        id: "stage2-id",
        name: "Stage 2",
        schemas: { input: z.any(), output: StringSchema, config: z.object({}) },
        async execute() {
          stage2Count++;
          if (stage2Count === 1) throw new Error("stage2 fails first time");
          return { output: { value: "stage2-done" } };
        },
      });

      const workflow = new WorkflowBuilder(
        "no-reexec-wf",
        "No Re-Execute Workflow",
        "Test",
        StringSchema,
        StringSchema,
      )
        .pipe(stage1)
        .pipe(stage2)
        .build();

      const { kernel, flush, persistence } = createTestKernel([workflow]);

      // Create and claim
      const { workflowRunId } = await kernel.dispatch({
        type: "run.create",
        idempotencyKey: "key-no-reexec",
        workflowId: "no-reexec-wf",
        input: { value: "start" },
      });
      await kernel.dispatch({ type: "run.claimPending", workerId: "w1" });

      // Execute stage1, transition, execute stage2 (fails), transition (FAILED)
      await kernel.dispatch({
        type: "job.execute",
        workflowRunId,
        workflowId: "no-reexec-wf",
        stageId: "stage1-id",
        config: {},
      });
      await kernel.dispatch({ type: "run.transition", workflowRunId });
      await kernel.dispatch({
        type: "job.execute",
        workflowRunId,
        workflowId: "no-reexec-wf",
        stageId: "stage2-id",
        config: {},
      });
      await kernel.dispatch({ type: "run.transition", workflowRunId });

      // Retry from stage2
      await kernel.dispatch({
        type: "run.rerunFrom",
        workflowRunId,
        fromStageId: "stage2-id",
      });

      // Execute stage2 again (succeeds)
      await kernel.dispatch({
        type: "job.execute",
        workflowRunId,
        workflowId: "no-reexec-wf",
        stageId: "stage2-id",
        config: {},
      });
      await kernel.dispatch({ type: "run.transition", workflowRunId });
      await flush();

      // Verify: stage1 was only executed once, stage2 was executed twice
      expect(stage1Count).toBe(1);
      expect(stage2Count).toBe(2);

      const run = await persistence.getRun(workflowRunId);
      expect(run!.status).toBe("COMPLETED");
    });

    it("should use output from last completed stage when retrying", async () => {
      // Given: A 2-stage workflow where stage1 outputs a specific value
      // and stage2 captures its input
      let capturedInput: unknown = null;
      let stage2Count = 0;

      const stage1 = defineStage({
        id: "stage1-id",
        name: "Stage 1",
        schemas: { input: StringSchema, output: z.object({ processed: z.string() }), config: z.object({}) },
        async execute() {
          return { output: { processed: "stage1-result" } };
        },
      });

      const stage2 = defineStage({
        id: "stage2-id",
        name: "Stage 2",
        schemas: { input: z.any(), output: StringSchema, config: z.object({}) },
        async execute(ctx) {
          stage2Count++;
          capturedInput = ctx.input;
          if (stage2Count === 1) throw new Error("stage2 fails first time");
          return { output: { value: "stage2-done" } };
        },
      });

      const workflow = new WorkflowBuilder(
        "input-pass-wf",
        "Input Pass Workflow",
        "Test",
        StringSchema,
        StringSchema,
      )
        .pipe(stage1)
        .pipe(stage2)
        .build();

      const { kernel, flush, persistence } = createTestKernel([workflow]);

      // Create and claim
      const { workflowRunId } = await kernel.dispatch({
        type: "run.create",
        idempotencyKey: "key-input-pass",
        workflowId: "input-pass-wf",
        input: { value: "start" },
      });
      await kernel.dispatch({ type: "run.claimPending", workerId: "w1" });

      // Execute stage1, transition, execute stage2 (fails), transition (FAILED)
      await kernel.dispatch({
        type: "job.execute",
        workflowRunId,
        workflowId: "input-pass-wf",
        stageId: "stage1-id",
        config: {},
      });
      await kernel.dispatch({ type: "run.transition", workflowRunId });
      await kernel.dispatch({
        type: "job.execute",
        workflowRunId,
        workflowId: "input-pass-wf",
        stageId: "stage2-id",
        config: {},
      });
      await kernel.dispatch({ type: "run.transition", workflowRunId });

      // Retry from stage2
      await kernel.dispatch({
        type: "run.rerunFrom",
        workflowRunId,
        fromStageId: "stage2-id",
      });

      // Execute stage2 again (succeeds)
      await kernel.dispatch({
        type: "job.execute",
        workflowRunId,
        workflowId: "input-pass-wf",
        stageId: "stage2-id",
        config: {},
      });
      await kernel.dispatch({ type: "run.transition", workflowRunId });
      await flush();

      // Verify: stage2 received stage1's output as input on retry
      expect(capturedInput).toEqual({ processed: "stage1-result" });

      const run = await persistence.getRun(workflowRunId);
      expect(run!.status).toBe("COMPLETED");
    });
  });

  describe("recovery state", () => {
    it("should maintain workflow context after recovery", async () => {
      // Given: A 2-stage workflow where stage1 outputs { data: "preserved" }
      // and stage2 captures ctx.workflowContext
      let capturedWorkflowContext: Record<string, unknown> = {};
      let stage2Count = 0;

      const stage1 = defineStage({
        id: "stage1-id",
        name: "Stage 1",
        schemas: { input: StringSchema, output: z.object({ data: z.string() }), config: z.object({}) },
        async execute() {
          return { output: { data: "preserved" } };
        },
      });

      const stage2 = defineStage({
        id: "stage2-id",
        name: "Stage 2",
        schemas: { input: z.any(), output: StringSchema, config: z.object({}) },
        async execute(ctx) {
          stage2Count++;
          capturedWorkflowContext = { ...ctx.workflowContext };
          if (stage2Count === 1) throw new Error("stage2 fails first time");
          return { output: { value: "stage2-done" } };
        },
      });

      const workflow = new WorkflowBuilder(
        "context-wf",
        "Context Workflow",
        "Test",
        StringSchema,
        StringSchema,
      )
        .pipe(stage1)
        .pipe(stage2)
        .build();

      const { kernel, flush, persistence } = createTestKernel([workflow]);

      // Create and claim
      const { workflowRunId } = await kernel.dispatch({
        type: "run.create",
        idempotencyKey: "key-context-recovery",
        workflowId: "context-wf",
        input: { value: "start" },
      });
      await kernel.dispatch({ type: "run.claimPending", workerId: "w1" });

      // Execute stage1, transition, execute stage2 (fails), transition (FAILED)
      await kernel.dispatch({
        type: "job.execute",
        workflowRunId,
        workflowId: "context-wf",
        stageId: "stage1-id",
        config: {},
      });
      await kernel.dispatch({ type: "run.transition", workflowRunId });
      await kernel.dispatch({
        type: "job.execute",
        workflowRunId,
        workflowId: "context-wf",
        stageId: "stage2-id",
        config: {},
      });
      await kernel.dispatch({ type: "run.transition", workflowRunId });

      // Retry from stage2
      await kernel.dispatch({
        type: "run.rerunFrom",
        workflowRunId,
        fromStageId: "stage2-id",
      });

      // Execute stage2 again (succeeds)
      await kernel.dispatch({
        type: "job.execute",
        workflowRunId,
        workflowId: "context-wf",
        stageId: "stage2-id",
        config: {},
      });
      await kernel.dispatch({ type: "run.transition", workflowRunId });
      await flush();

      // Verify: workflowContext contains stage1's output after recovery
      expect(capturedWorkflowContext).toHaveProperty("stage1-id");
      expect(capturedWorkflowContext["stage1-id"]).toEqual({ data: "preserved" });

      const run = await persistence.getRun(workflowRunId);
      expect(run!.status).toBe("COMPLETED");
    });
  });
});
