/**
 * Orchestrator Behavior Tests (Kernel)
 *
 * Tests for kernel orchestration logic (run.create, run.transition, run.claimPending).
 * Migrated from WorkflowRuntime to kernel dispatch API.
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

const StringSchema = z.object({ value: z.string() });

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

describe("I want orchestrator to manage workflow state", () => {
  describe("workflow creation", () => {
    it("should validate workflow exists in registry before creating run", async () => {
      const { kernel } = createTestKernel([]);

      await expect(
        kernel.dispatch({
          type: "run.create",
          idempotencyKey: "key-1",
          workflowId: "unknown-workflow",
          input: { value: "test" },
        }),
      ).rejects.toThrow(/not found/);
    });

    it("should validate input against workflow schema", async () => {
      const stage = createPassthroughStage(
        "process",
        z.object({ requiredField: z.string() }),
      );
      const workflow = new WorkflowBuilder(
        "validated-workflow",
        "Validated Workflow",
        "Test",
        z.object({ requiredField: z.string() }),
        z.object({ requiredField: z.string() }),
      )
        .pipe(stage)
        .build();

      const { kernel } = createTestKernel([workflow]);

      await expect(
        kernel.dispatch({
          type: "run.create",
          idempotencyKey: "key-1",
          workflowId: "validated-workflow",
          input: { wrongField: "test" },
        }),
      ).rejects.toThrow(/Invalid workflow input/);
    });

    it("should create workflow run in PENDING status", async () => {
      const stage = createPassthroughStage("process", StringSchema);
      const workflow = new WorkflowBuilder(
        "test-workflow",
        "Test Workflow",
        "Test",
        StringSchema,
        StringSchema,
      )
        .pipe(stage)
        .build();

      const { kernel, persistence } = createTestKernel([workflow]);

      const result = await kernel.dispatch({
        type: "run.create",
        idempotencyKey: "key-1",
        workflowId: "test-workflow",
        input: { value: "test" },
      });

      expect(result.workflowRunId).toBeDefined();

      const run = await persistence.getRun(result.workflowRunId);
      expect(run?.status).toBe("PENDING");
      expect(run?.workflowId).toBe("test-workflow");
      expect(run?.input).toEqual({ value: "test" });
    });

    it("should merge default config with provided config", async () => {
      const configuredStage = defineStage({
        id: "configured",
        name: "Configured Stage",
        schemas: {
          input: StringSchema,
          output: StringSchema,
          config: z.object({ setting: z.string().default("default-value") }),
        },
        async execute(ctx) {
          return { output: ctx.input };
        },
      });

      const workflow = new WorkflowBuilder(
        "config-workflow",
        "Config Workflow",
        "Test",
        StringSchema,
        StringSchema,
      )
        .pipe(configuredStage)
        .build();

      const { kernel, persistence } = createTestKernel([workflow]);

      const result = await kernel.dispatch({
        type: "run.create",
        idempotencyKey: "key-1",
        workflowId: "config-workflow",
        input: { value: "test" },
        config: { configured: { setting: "custom-value" } },
      });

      const run = await persistence.getRun(result.workflowRunId);
      expect(run?.config).toEqual({ configured: { setting: "custom-value" } });
    });

    it("should respect custom priority", async () => {
      const stage = createPassthroughStage("process", StringSchema);
      const workflow = new WorkflowBuilder(
        "priority-workflow",
        "Priority Workflow",
        "Test",
        StringSchema,
        StringSchema,
      )
        .pipe(stage)
        .build();

      const { kernel, persistence } = createTestKernel([workflow]);

      const result = await kernel.dispatch({
        type: "run.create",
        idempotencyKey: "key-1",
        workflowId: "priority-workflow",
        input: { value: "test" },
        priority: 10,
      });

      const run = await persistence.getRun(result.workflowRunId);
      expect(run?.priority).toBe(10);
    });
  });

  describe("workflow transition", () => {
    it("should transition completed workflow stages", async () => {
      const stage1 = createPassthroughStage("stage-1", StringSchema);
      const stage2 = createPassthroughStage("stage-2", StringSchema);

      const workflow = new WorkflowBuilder(
        "multi-stage",
        "Multi Stage Workflow",
        "Test",
        StringSchema,
        StringSchema,
      )
        .pipe(stage1)
        .pipe(stage2)
        .build();

      const { kernel, persistence, jobTransport } = createTestKernel([
        workflow,
      ]);

      const { workflowRunId } = await kernel.dispatch({
        type: "run.create",
        idempotencyKey: "key-1",
        workflowId: "multi-stage",
        input: { value: "test" },
      });

      await persistence.updateRun(workflowRunId, { status: "RUNNING" });
      await persistence.createStage({
        workflowRunId,
        stageId: "stage-1",
        stageName: "Stage stage-1",
        stageNumber: 1,
        executionGroup: 1,
        status: "COMPLETED",
      });

      const result = await kernel.dispatch({
        type: "run.transition",
        workflowRunId,
      });

      expect(result.action).toBe("advanced");
      expect(jobTransport.getAllJobs()).toHaveLength(1);
    });

    it("should not transition while stages are still active", async () => {
      const stage1 = createPassthroughStage("stage-1", StringSchema);
      const stage2 = createPassthroughStage("stage-2", StringSchema);

      const workflow = new WorkflowBuilder(
        "active-workflow",
        "Active Workflow",
        "Test",
        StringSchema,
        StringSchema,
      )
        .pipe(stage1)
        .pipe(stage2)
        .build();

      const { kernel, persistence } = createTestKernel([workflow]);

      const { workflowRunId } = await kernel.dispatch({
        type: "run.create",
        idempotencyKey: "key-1",
        workflowId: "active-workflow",
        input: { value: "test" },
      });

      await persistence.updateRun(workflowRunId, { status: "RUNNING" });
      await persistence.createStage({
        workflowRunId,
        stageId: "stage-1",
        stageName: "Stage stage-1",
        stageNumber: 1,
        executionGroup: 1,
        status: "RUNNING",
      });

      const result = await kernel.dispatch({
        type: "run.transition",
        workflowRunId,
      });

      expect(result.action).toBe("noop");
    });

    it("should complete workflow when all stages done", async () => {
      const stage = createPassthroughStage("only-stage", StringSchema);

      const workflow = new WorkflowBuilder(
        "complete-workflow",
        "Complete Workflow",
        "Test",
        StringSchema,
        StringSchema,
      )
        .pipe(stage)
        .build();

      const { kernel, persistence } = createTestKernel([workflow]);

      const { workflowRunId } = await kernel.dispatch({
        type: "run.create",
        idempotencyKey: "key-1",
        workflowId: "complete-workflow",
        input: { value: "test" },
      });

      await persistence.updateRun(workflowRunId, { status: "RUNNING" });
      await persistence.createStage({
        workflowRunId,
        stageId: "only-stage",
        stageName: "Stage only-stage",
        stageNumber: 1,
        executionGroup: 1,
        status: "COMPLETED",
      });

      await kernel.dispatch({ type: "run.transition", workflowRunId });

      const run = await persistence.getRun(workflowRunId);
      expect(run?.status).toBe("COMPLETED");
      expect(run?.completedAt).toBeInstanceOf(Date);
    });

    it("should not transition cancelled workflows", async () => {
      const stage = createPassthroughStage("stage", StringSchema);
      const workflow = new WorkflowBuilder(
        "cancelled-workflow",
        "Cancelled Workflow",
        "Test",
        StringSchema,
        StringSchema,
      )
        .pipe(stage)
        .build();

      const { kernel, persistence } = createTestKernel([workflow]);

      const { workflowRunId } = await kernel.dispatch({
        type: "run.create",
        idempotencyKey: "key-1",
        workflowId: "cancelled-workflow",
        input: { value: "test" },
      });

      await persistence.updateRun(workflowRunId, { status: "CANCELLED" });

      const result = await kernel.dispatch({
        type: "run.transition",
        workflowRunId,
      });

      expect(result.action).toBe("noop");

      const run = await persistence.getRun(workflowRunId);
      expect(run?.status).toBe("CANCELLED");
    });
  });

  describe("parallel stage handling", () => {
    it("should enqueue all stages in an execution group", async () => {
      const stageA = createPassthroughStage("parallel-a", StringSchema);
      const stageB = createPassthroughStage("parallel-b", StringSchema);

      const workflow = new WorkflowBuilder(
        "parallel-workflow",
        "Parallel Workflow",
        "Test",
        StringSchema,
        z.any(),
      )
        .parallel([stageA, stageB])
        .build();

      const { kernel, persistence, jobTransport } = createTestKernel([
        workflow,
      ]);

      const { workflowRunId } = await kernel.dispatch({
        type: "run.create",
        idempotencyKey: "key-1",
        workflowId: "parallel-workflow",
        input: { value: "test" },
      });

      // Claim pending triggers RUNNING + creates stage records + enqueues jobs
      await kernel.dispatch({ type: "run.claimPending", workerId: "worker-1" });

      const allJobs = jobTransport.getAllJobs();
      expect(allJobs).toHaveLength(2);

      const stageIds = allJobs.map((j) => j.stageId);
      expect(stageIds).toContain("parallel-a");
      expect(stageIds).toContain("parallel-b");
    });
  });

  describe("suspended stage polling", () => {
    it("should find suspended stages ready to poll", async () => {
      const { persistence } = createTestKernel([]);

      await persistence.createRun({
        id: "run-suspended",
        workflowId: "test-workflow",
        workflowName: "Test Workflow",
        input: { value: "test" },
      });

      const stage = await persistence.createStage({
        workflowRunId: "run-suspended",
        stageId: "suspended-stage",
        stageName: "Suspended Stage",
        stageNumber: 1,
        executionGroup: 1,
        status: "SUSPENDED",
      });

      await persistence.updateStage(stage.id, {
        nextPollAt: new Date(Date.now() - 1000),
        suspendedState: { batchId: "batch-123" },
      });

      const suspendedStages = await persistence.getSuspendedStages(new Date());
      const uniqueStageIds = [
        ...new Set(suspendedStages.map((s) => s.stageId)),
      ];
      expect(uniqueStageIds).toHaveLength(1);
      expect(uniqueStageIds[0]).toBe("suspended-stage");
    });

    it("should not return suspended stages not yet ready", async () => {
      const { persistence } = createTestKernel([]);

      await persistence.createRun({
        id: "run-future",
        workflowId: "test-workflow",
        workflowName: "Test Workflow",
        input: { value: "test" },
      });

      const stage = await persistence.createStage({
        workflowRunId: "run-future",
        stageId: "future-stage",
        stageName: "Future Stage",
        stageNumber: 1,
        executionGroup: 1,
        status: "SUSPENDED",
      });

      await persistence.updateStage(stage.id, {
        nextPollAt: new Date(Date.now() + 60000),
        suspendedState: { batchId: "batch-future" },
      });

      const suspendedStages = await persistence.getSuspendedStages(new Date());
      expect(suspendedStages).toHaveLength(0);
    });
  });

  describe("error handling", () => {
    it("should handle non-existent run gracefully on transition", async () => {
      const { kernel } = createTestKernel([]);

      const result = await kernel.dispatch({
        type: "run.transition",
        workflowRunId: "non-existent-run",
      });

      expect(result.action).toBe("noop");
    });
  });
});
