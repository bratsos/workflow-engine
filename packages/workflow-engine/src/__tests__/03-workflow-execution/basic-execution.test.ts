/**
 * Basic Workflow Execution Tests (Kernel)
 *
 * Tests for executing workflows via the kernel dispatch interface.
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

describe("I want to execute workflows", () => {
  describe("single-stage execution", () => {
    it("should execute a single-stage workflow", async () => {
      // Given: A workflow with one stage that doubles a number
      const doubleStage = defineStage({
        id: "double",
        name: "Double Stage",
        schemas: {
          input: z.object({ value: z.number() }),
          output: z.object({ result: z.number() }),
          config: z.object({}),
        },
        async execute(ctx) {
          return { output: { result: ctx.input.value * 2 } };
        },
      });

      const workflow = new WorkflowBuilder(
        "single-stage",
        "Single Stage Workflow",
        "Test",
        z.object({ value: z.number() }),
        z.object({ result: z.number() }),
      )
        .pipe(doubleStage)
        .build();

      const { kernel, flush, persistence } = createTestKernel([workflow]);

      // When: I execute via kernel dispatch
      const { workflowRunId } = await kernel.dispatch({
        type: "run.create",
        idempotencyKey: "key-1",
        workflowId: "single-stage",
        input: { value: 21 },
      });

      await kernel.dispatch({ type: "run.claimPending", workerId: "worker-1" });

      const jobResult = await kernel.dispatch({
        type: "job.execute",
        workflowRunId,
        workflowId: "single-stage",
        stageId: "double",
        config: {},
      });

      await kernel.dispatch({ type: "run.transition", workflowRunId });
      await flush();

      // Then: Returns the doubled value
      expect(jobResult.outcome).toBe("completed");
      expect(jobResult.output).toEqual({ result: 42 });
    });

    it("should emit workflow events during execution", async () => {
      // Given: A simple workflow
      const stage = defineStage({
        id: "simple",
        name: "Stage simple",
        schemas: {
          input: z.object({ value: z.string() }),
          output: z.object({ value: z.string() }),
          config: z.object({}),
        },
        async execute(ctx) {
          return { output: ctx.input };
        },
      });

      const workflow = new WorkflowBuilder(
        "events-test",
        "Events Test",
        "Test",
        z.object({ value: z.string() }),
        z.object({ value: z.string() }),
      )
        .pipe(stage)
        .build();

      const { kernel, flush, eventSink } = createTestKernel([workflow]);

      // When: I execute
      const { workflowRunId } = await kernel.dispatch({
        type: "run.create",
        idempotencyKey: "key-1",
        workflowId: "events-test",
        input: { value: "test" },
      });

      await flush();
      eventSink.clear();

      await kernel.dispatch({ type: "run.claimPending", workerId: "worker-1" });
      await flush();

      const startedEvents = eventSink.getByType("workflow:started");
      expect(startedEvents).toHaveLength(1);
      eventSink.clear();

      await kernel.dispatch({
        type: "job.execute",
        workflowRunId,
        workflowId: "events-test",
        stageId: "simple",
        config: {},
      });

      await flush();

      const stageStarted = eventSink.getByType("stage:started");
      const stageCompleted = eventSink.getByType("stage:completed");
      expect(stageStarted).toHaveLength(1);
      expect(stageCompleted).toHaveLength(1);
      eventSink.clear();

      await kernel.dispatch({ type: "run.transition", workflowRunId });
      await flush();

      // Then: Events were emitted in order
      const workflowCompleted = eventSink.getByType("workflow:completed");
      expect(workflowCompleted).toHaveLength(1);
    });

    it("should update persistence status during execution", async () => {
      // Given: A workflow
      const stage = defineStage({
        id: "track-status",
        name: "Stage track-status",
        schemas: {
          input: z.object({ value: z.string() }),
          output: z.object({ value: z.string() }),
          config: z.object({}),
        },
        async execute(ctx) {
          return { output: ctx.input };
        },
      });

      const workflow = new WorkflowBuilder(
        "status-test",
        "Status Test",
        "Test",
        z.object({ value: z.string() }),
        z.object({ value: z.string() }),
      )
        .pipe(stage)
        .build();

      const { kernel, flush, persistence } = createTestKernel([workflow]);

      const { workflowRunId } = await kernel.dispatch({
        type: "run.create",
        idempotencyKey: "key-1",
        workflowId: "status-test",
        input: { value: "test" },
      });

      await kernel.dispatch({ type: "run.claimPending", workerId: "worker-1" });

      await kernel.dispatch({
        type: "job.execute",
        workflowRunId,
        workflowId: "status-test",
        stageId: "track-status",
        config: {},
      });

      await kernel.dispatch({ type: "run.transition", workflowRunId });
      await flush();

      // Then: Run status is COMPLETED
      const run = await persistence.getRun(workflowRunId);
      expect(run?.status).toBe("COMPLETED");
      expect(run?.completedAt).toBeDefined();
    });
  });

  describe("multi-stage execution", () => {
    it("should pass data between sequential stages", async () => {
      // Given: Three stages that transform data
      const addOne = defineStage({
        id: "add-one",
        name: "Add One",
        schemas: {
          input: z.object({ value: z.number() }),
          output: z.object({ value: z.number() }),
          config: z.object({}),
        },
        async execute(ctx) {
          return { output: { value: ctx.input.value + 1 } };
        },
      });

      const double = defineStage({
        id: "double",
        name: "Double",
        schemas: {
          input: z.object({ value: z.number() }),
          output: z.object({ value: z.number() }),
          config: z.object({}),
        },
        async execute(ctx) {
          return { output: { value: ctx.input.value * 2 } };
        },
      });

      const square = defineStage({
        id: "square",
        name: "Square",
        schemas: {
          input: z.object({ value: z.number() }),
          output: z.object({ result: z.number() }),
          config: z.object({}),
        },
        async execute(ctx) {
          return { output: { result: ctx.input.value * ctx.input.value } };
        },
      });

      const workflow = new WorkflowBuilder(
        "multi-stage",
        "Multi-Stage Workflow",
        "Test",
        z.object({ value: z.number() }),
        z.object({ result: z.number() }),
      )
        .pipe(addOne)
        .pipe(double)
        .pipe(square)
        .build();

      const { kernel, flush, persistence, jobTransport } = createTestKernel([workflow]);

      const { workflowRunId } = await kernel.dispatch({
        type: "run.create",
        idempotencyKey: "key-1",
        workflowId: "multi-stage",
        input: { value: 5 },
      });

      // Claim and execute stage 1: add-one (5 + 1 = 6)
      await kernel.dispatch({ type: "run.claimPending", workerId: "worker-1" });

      const r1 = await kernel.dispatch({
        type: "job.execute",
        workflowRunId,
        workflowId: "multi-stage",
        stageId: "add-one",
        config: {},
      });
      expect(r1.outcome).toBe("completed");
      expect(r1.output).toEqual({ value: 6 });

      // Transition to stage 2
      await kernel.dispatch({ type: "run.transition", workflowRunId });

      // Execute stage 2: double (6 * 2 = 12)
      const r2 = await kernel.dispatch({
        type: "job.execute",
        workflowRunId,
        workflowId: "multi-stage",
        stageId: "double",
        config: {},
      });
      expect(r2.outcome).toBe("completed");
      expect(r2.output).toEqual({ value: 12 });

      // Transition to stage 3
      await kernel.dispatch({ type: "run.transition", workflowRunId });

      // Execute stage 3: square (12 * 12 = 144)
      const r3 = await kernel.dispatch({
        type: "job.execute",
        workflowRunId,
        workflowId: "multi-stage",
        stageId: "square",
        config: {},
      });
      expect(r3.outcome).toBe("completed");
      expect(r3.output).toEqual({ result: 144 });

      // Complete the workflow
      await kernel.dispatch({ type: "run.transition", workflowRunId });
      await flush();

      const run = await persistence.getRun(workflowRunId);
      expect(run?.status).toBe("COMPLETED");
    });

    it("should create stage records for each stage", async () => {
      // Given: A multi-stage workflow
      const schema = z.object({ value: z.string() });

      const stageA = defineStage({
        id: "stage-a",
        name: "Stage stage-a",
        schemas: { input: schema, output: schema, config: z.object({}) },
        async execute(ctx) { return { output: ctx.input }; },
      });
      const stageB = defineStage({
        id: "stage-b",
        name: "Stage stage-b",
        schemas: { input: schema, output: schema, config: z.object({}) },
        async execute(ctx) { return { output: ctx.input }; },
      });
      const stageC = defineStage({
        id: "stage-c",
        name: "Stage stage-c",
        schemas: { input: schema, output: schema, config: z.object({}) },
        async execute(ctx) { return { output: ctx.input }; },
      });

      const workflow = new WorkflowBuilder(
        "stage-records",
        "Stage Records Test",
        "Test",
        schema,
        schema,
      )
        .pipe(stageA)
        .pipe(stageB)
        .pipe(stageC)
        .build();

      const { kernel, flush, persistence } = createTestKernel([workflow]);

      const { workflowRunId } = await kernel.dispatch({
        type: "run.create",
        idempotencyKey: "key-1",
        workflowId: "stage-records",
        input: { value: "test" },
      });

      await kernel.dispatch({ type: "run.claimPending", workerId: "worker-1" });

      // Execute each stage with transitions
      for (const stageId of ["stage-a", "stage-b", "stage-c"]) {
        await kernel.dispatch({
          type: "job.execute",
          workflowRunId,
          workflowId: "stage-records",
          stageId,
          config: {},
        });
        await kernel.dispatch({ type: "run.transition", workflowRunId });
      }

      await flush();

      // Then: Stage records exist for each stage
      const stages = await persistence.getStagesByRun(workflowRunId);
      const uniqueStages = new Map(stages.map((s) => [s.stageId, s]));
      expect(uniqueStages.size).toBe(3);

      expect(uniqueStages.has("stage-a")).toBe(true);
      expect(uniqueStages.has("stage-b")).toBe(true);
      expect(uniqueStages.has("stage-c")).toBe(true);

      // All stages should be completed
      for (const stage of uniqueStages.values()) {
        expect(stage.status).toBe("COMPLETED");
      }
    });
  });

  describe("parallel execution", () => {
    it("should execute parallel stages", async () => {
      // Given: A workflow with parallel stages
      // Note: In the kernel model, resolveStageInput may feed a previous
      // parallel sibling's output to later siblings, so we use passthrough
      // input schemas for parallel stages.
      const stageA = defineStage({
        id: "parallel-a",
        name: "Parallel A",
        schemas: {
          input: z.object({}).passthrough(),
          output: z.object({ from: z.string() }),
          config: z.object({}),
        },
        async execute() {
          return { output: { from: "a" } };
        },
      });

      const stageB = defineStage({
        id: "parallel-b",
        name: "Parallel B",
        schemas: {
          input: z.object({}).passthrough(),
          output: z.object({ from: z.string() }),
          config: z.object({}),
        },
        async execute() {
          return { output: { from: "b" } };
        },
      });

      const workflow = new WorkflowBuilder(
        "parallel-test",
        "Parallel Test",
        "Test",
        z.object({ value: z.string() }),
        z.any(),
      )
        .parallel([stageA, stageB])
        .build();

      const { kernel, flush, persistence, jobTransport } = createTestKernel([workflow]);

      const { workflowRunId } = await kernel.dispatch({
        type: "run.create",
        idempotencyKey: "key-1",
        workflowId: "parallel-test",
        input: { value: "test" },
      });

      // Claim creates jobs for both parallel stages
      const claimResult = await kernel.dispatch({ type: "run.claimPending", workerId: "worker-1" });
      expect(claimResult.claimed[0]!.jobIds).toHaveLength(2);

      // Execute both parallel stages
      const rA = await kernel.dispatch({
        type: "job.execute",
        workflowRunId,
        workflowId: "parallel-test",
        stageId: "parallel-a",
        config: {},
      });

      const rB = await kernel.dispatch({
        type: "job.execute",
        workflowRunId,
        workflowId: "parallel-test",
        stageId: "parallel-b",
        config: {},
      });

      expect(rA.outcome).toBe("completed");
      expect(rA.output).toEqual({ from: "a" });
      expect(rB.outcome).toBe("completed");
      expect(rB.output).toEqual({ from: "b" });

      // Transition to complete the workflow
      await kernel.dispatch({ type: "run.transition", workflowRunId });
      await flush();

      const run = await persistence.getRun(workflowRunId);
      expect(run?.status).toBe("COMPLETED");
    });

    it("should collect outputs from parallel stages", async () => {
      // Given: Parallel stages returning different data
      // Note: In the kernel model, parallel stages share the same input.
      // The resolveStageInput logic may feed a previous parallel sibling's
      // output to later siblings, so we use passthrough input schemas.
      const fetchUser = defineStage({
        id: "fetch-user",
        name: "Fetch User",
        schemas: {
          input: z.object({ userId: z.string() }).passthrough(),
          output: z.object({ user: z.object({ name: z.string() }) }),
          config: z.object({}),
        },
        async execute(ctx) {
          return { output: { user: { name: `User-${ctx.input.userId}` } } };
        },
      });

      const fetchOrders = defineStage({
        id: "fetch-orders",
        name: "Fetch Orders",
        schemas: {
          input: z.object({}).passthrough(),
          output: z.object({ orders: z.array(z.string()) }),
          config: z.object({}),
        },
        async execute() {
          return { output: { orders: ["order-1", "order-2"] } };
        },
      });

      const workflow = new WorkflowBuilder(
        "parallel-collect",
        "Parallel Collect",
        "Test",
        z.object({ userId: z.string() }),
        z.any(),
      )
        .parallel([fetchUser, fetchOrders])
        .build();

      const { kernel, flush } = createTestKernel([workflow]);

      const { workflowRunId } = await kernel.dispatch({
        type: "run.create",
        idempotencyKey: "key-1",
        workflowId: "parallel-collect",
        input: { userId: "123" },
      });

      await kernel.dispatch({ type: "run.claimPending", workerId: "worker-1" });

      // Execute both parallel stages
      const rUser = await kernel.dispatch({
        type: "job.execute",
        workflowRunId,
        workflowId: "parallel-collect",
        stageId: "fetch-user",
        config: {},
      });

      const rOrders = await kernel.dispatch({
        type: "job.execute",
        workflowRunId,
        workflowId: "parallel-collect",
        stageId: "fetch-orders",
        config: {},
      });

      await kernel.dispatch({ type: "run.transition", workflowRunId });
      await flush();

      // Then: Both outputs are collected
      expect(rUser.outcome).toBe("completed");
      expect(rUser.output).toEqual({ user: { name: "User-123" } });
      expect(rOrders.outcome).toBe("completed");
      expect(rOrders.output).toEqual({ orders: ["order-1", "order-2"] });
    });
  });

  describe("configuration handling", () => {
    it("should pass stage-specific config to stages", async () => {
      // Given: A stage that uses its config
      let capturedConfig: { multiplier: number } | null = null;

      const configuredStage = defineStage({
        id: "configured",
        name: "Configured Stage",
        schemas: {
          input: z.object({ value: z.number() }),
          output: z.object({ result: z.number() }),
          config: z.object({
            multiplier: z.number().default(1),
          }),
        },
        async execute(ctx) {
          capturedConfig = ctx.config as { multiplier: number };
          return {
            output: { result: ctx.input.value * ctx.config.multiplier },
          };
        },
      });

      const workflow = new WorkflowBuilder(
        "config-test",
        "Config Test",
        "Test",
        z.object({ value: z.number() }),
        z.object({ result: z.number() }),
      )
        .pipe(configuredStage)
        .build();

      const { kernel, flush } = createTestKernel([workflow]);

      const { workflowRunId } = await kernel.dispatch({
        type: "run.create",
        idempotencyKey: "key-1",
        workflowId: "config-test",
        input: { value: 10 },
        config: { configured: { multiplier: 5 } },
      });

      await kernel.dispatch({ type: "run.claimPending", workerId: "worker-1" });

      const result = await kernel.dispatch({
        type: "job.execute",
        workflowRunId,
        workflowId: "config-test",
        stageId: "configured",
        config: { configured: { multiplier: 5 } },
      });

      await kernel.dispatch({ type: "run.transition", workflowRunId });
      await flush();

      // Then: Stage received the config and produced correct output
      expect(capturedConfig).toEqual({ multiplier: 5 });
      expect(result.outcome).toBe("completed");
      expect(result.output).toEqual({ result: 50 });
    });

    it("should validate config before execution", async () => {
      // Given: A stage requiring specific config
      const strictStage = defineStage({
        id: "strict",
        name: "Strict Stage",
        schemas: {
          input: z.object({ value: z.string() }),
          output: z.object({ value: z.string() }),
          config: z.object({
            required: z.string(),
          }),
        },
        async execute(ctx) {
          return { output: ctx.input };
        },
      });

      const workflow = new WorkflowBuilder(
        "validation-test",
        "Validation Test",
        "Test",
        z.object({ value: z.string() }),
        z.object({ value: z.string() }),
      )
        .pipe(strictStage)
        .build();

      const { kernel } = createTestKernel([workflow]);

      // When: I try to create a run with invalid config (wrong type)
      // Then: Kernel validates config at run.create time and throws
      await expect(
        kernel.dispatch({
          type: "run.create",
          idempotencyKey: "key-1",
          workflowId: "validation-test",
          input: { value: "test" },
          config: { strict: { required: 123 } },
        }),
      ).rejects.toThrow(/invalid workflow config/i);
    });
  });

  describe("workflow context access", () => {
    it("should accumulate stage outputs in workflowContext", async () => {
      // Given: Stages where later ones access earlier outputs via workflowContext
      let capturedContext: Record<string, unknown> = {};

      const stageA = defineStage({
        id: "producer",
        name: "Producer",
        schemas: {
          input: z.object({ initial: z.string() }),
          output: z.object({ produced: z.string() }),
          config: z.object({}),
        },
        async execute(ctx) {
          return { output: { produced: `from-${ctx.input.initial}` } };
        },
      });

      const stageB = defineStage({
        id: "consumer",
        name: "Consumer",
        schemas: {
          input: z.object({ produced: z.string() }),
          output: z.object({ final: z.string() }),
          config: z.object({}),
        },
        async execute(ctx) {
          capturedContext = { ...ctx.workflowContext };
          const producerOutput = ctx.workflowContext["producer"] as { produced: string } | undefined;
          return { output: { final: `consumed-${producerOutput?.produced ?? ctx.input.produced}` } };
        },
      });

      const workflow = new WorkflowBuilder(
        "context-test",
        "Context Test",
        "Test",
        z.object({ initial: z.string() }),
        z.object({ final: z.string() }),
      )
        .pipe(stageA)
        .pipe(stageB)
        .build();

      const { kernel, flush } = createTestKernel([workflow]);

      const { workflowRunId } = await kernel.dispatch({
        type: "run.create",
        idempotencyKey: "key-1",
        workflowId: "context-test",
        input: { initial: "start" },
      });

      await kernel.dispatch({ type: "run.claimPending", workerId: "worker-1" });

      // Execute stage 1 (producer)
      await kernel.dispatch({
        type: "job.execute",
        workflowRunId,
        workflowId: "context-test",
        stageId: "producer",
        config: {},
      });
      await kernel.dispatch({ type: "run.transition", workflowRunId });

      // Execute stage 2 (consumer)
      const r2 = await kernel.dispatch({
        type: "job.execute",
        workflowRunId,
        workflowId: "context-test",
        stageId: "consumer",
        config: {},
      });

      await kernel.dispatch({ type: "run.transition", workflowRunId });
      await flush();

      // Then: Consumer could access producer output
      expect(capturedContext).toHaveProperty("producer");
      expect(r2.outcome).toBe("completed");
      expect(r2.output).toEqual({ final: "consumed-from-start" });
    });
  });
});
