/**
 * Basic Workflow Execution Tests
 *
 * Tests for executing workflows with the WorkflowExecutor.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { z } from "zod";
import { WorkflowBuilder } from "../../core/workflow.js";
import { WorkflowExecutor } from "../../core/executor.js";
import { defineStage } from "../../core/stage-factory.js";
import {
  InMemoryWorkflowPersistence,
  InMemoryAICallLogger,
  createPassthroughStage,
  TestSchemas,
} from "../utils/index.js";

describe("I want to execute workflows", () => {
  let persistence: InMemoryWorkflowPersistence;
  let aiLogger: InMemoryAICallLogger;

  beforeEach(() => {
    persistence = new InMemoryWorkflowPersistence();
    aiLogger = new InMemoryAICallLogger();
  });

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

      // Create a workflow run record
      await persistence.createRun({
        id: "run-1",
        workflowId: "single-stage",
        workflowName: "Single Stage Workflow",
        status: "PENDING",
        input: { value: 21 },
      });

      // When: I execute it
      const executor = new WorkflowExecutor(workflow, "run-1", "single-stage", {
        persistence,
        aiLogger,
      });

      const result = await executor.execute({ value: 21 }, {});

      // Then: Returns the doubled value
      expect(result).toEqual({ result: 42 });
    });

    it("should emit workflow events during execution", async () => {
      // Given: A simple workflow
      const stage = createPassthroughStage("simple", TestSchemas.string);

      const workflow = new WorkflowBuilder(
        "events-test",
        "Events Test",
        "Test",
        TestSchemas.string,
        TestSchemas.string,
      )
        .pipe(stage)
        .build();

      await persistence.createRun({
        id: "run-events",
        workflowId: "events-test",
        workflowName: "Events Test",
        status: "PENDING",
        input: { value: "test" },
      });

      const executor = new WorkflowExecutor(
        workflow,
        "run-events",
        "events-test",
        {
          persistence,
          aiLogger,
        },
      );

      // Collect events
      const events: Array<{ event: string; data: unknown }> = [];
      executor.on("workflow:started", (data) =>
        events.push({ event: "workflow:started", data }),
      );
      executor.on("workflow:completed", (data) =>
        events.push({ event: "workflow:completed", data }),
      );
      executor.on("stage:started", (data) =>
        events.push({ event: "stage:started", data }),
      );
      executor.on("stage:completed", (data) =>
        events.push({ event: "stage:completed", data }),
      );

      // When: I execute
      await executor.execute({ value: "test" }, {});

      // Then: Events were emitted in order
      expect(events.map((e) => e.event)).toEqual([
        "workflow:started",
        "stage:started",
        "stage:completed",
        "workflow:completed",
      ]);
    });

    it("should update persistence status during execution", async () => {
      // Given: A workflow
      const stage = createPassthroughStage("track-status", TestSchemas.string);

      const workflow = new WorkflowBuilder(
        "status-test",
        "Status Test",
        "Test",
        TestSchemas.string,
        TestSchemas.string,
      )
        .pipe(stage)
        .build();

      await persistence.createRun({
        id: "run-status",
        workflowId: "status-test",
        workflowName: "Status Test",
        status: "PENDING",
        input: { value: "test" },
      });

      const executor = new WorkflowExecutor(
        workflow,
        "run-status",
        "status-test",
        {
          persistence,
          aiLogger,
        },
      );

      // When: I execute
      await executor.execute({ value: "test" }, {});

      // Then: Run status is COMPLETED
      const run = await persistence.getRun("run-status");
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

      await persistence.createRun({
        id: "run-multi",
        workflowId: "multi-stage",
        workflowName: "Multi-Stage Workflow",
        status: "PENDING",
        input: { value: 5 },
      });

      const executor = new WorkflowExecutor(
        workflow,
        "run-multi",
        "multi-stage",
        {
          persistence,
          aiLogger,
        },
      );

      // When: I execute with value=5
      // (5 + 1) = 6, then 6 * 2 = 12, then 12 * 12 = 144
      const result = await executor.execute({ value: 5 }, {});

      // Then: Returns the final computed value
      expect(result).toEqual({ result: 144 });
    });

    it("should create stage records for each stage", async () => {
      // Given: A multi-stage workflow
      const stageA = createPassthroughStage("stage-a", TestSchemas.string);
      const stageB = createPassthroughStage("stage-b", TestSchemas.string);
      const stageC = createPassthroughStage("stage-c", TestSchemas.string);

      const workflow = new WorkflowBuilder(
        "stage-records",
        "Stage Records Test",
        "Test",
        TestSchemas.string,
        TestSchemas.string,
      )
        .pipe(stageA)
        .pipe(stageB)
        .pipe(stageC)
        .build();

      await persistence.createRun({
        id: "run-records",
        workflowId: "stage-records",
        workflowName: "Stage Records Test",
        status: "PENDING",
        input: { value: "test" },
      });

      const executor = new WorkflowExecutor(
        workflow,
        "run-records",
        "stage-records",
        {
          persistence,
          aiLogger,
        },
      );

      // When: I execute
      await executor.execute({ value: "test" }, {});

      // Then: Stage records exist for each stage
      const stages = await persistence.getStagesByRun("run-records", {});

      // Get unique stages by stageId (in-memory persistence may have duplicates due to indexing)
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
    it("should execute parallel stages concurrently", async () => {
      // Given: A workflow with parallel stages
      const executionOrder: string[] = [];

      const stageA = defineStage({
        id: "parallel-a",
        name: "Parallel A",
        schemas: {
          input: TestSchemas.string,
          output: z.object({ from: z.string() }),
          config: z.object({}),
        },
        async execute(ctx) {
          executionOrder.push("a-start");
          await new Promise((r) => setTimeout(r, 10));
          executionOrder.push("a-end");
          return { output: { from: "a" } };
        },
      });

      const stageB = defineStage({
        id: "parallel-b",
        name: "Parallel B",
        schemas: {
          input: TestSchemas.string,
          output: z.object({ from: z.string() }),
          config: z.object({}),
        },
        async execute(ctx) {
          executionOrder.push("b-start");
          await new Promise((r) => setTimeout(r, 10));
          executionOrder.push("b-end");
          return { output: { from: "b" } };
        },
      });

      const workflow = new WorkflowBuilder(
        "parallel-test",
        "Parallel Test",
        "Test",
        TestSchemas.string,
        z.any(),
      )
        .parallel([stageA, stageB])
        .build();

      await persistence.createRun({
        id: "run-parallel",
        workflowId: "parallel-test",
        workflowName: "Parallel Test",
        status: "PENDING",
        input: { value: "test" },
      });

      const executor = new WorkflowExecutor(
        workflow,
        "run-parallel",
        "parallel-test",
        {
          persistence,
          aiLogger,
        },
      );

      // When: I execute
      const result = await executor.execute({ value: "test" }, {});

      // Then: Both stages executed
      expect(result).toEqual({
        0: { from: "a" },
        1: { from: "b" },
      });

      // And: Execution was parallel (both started before either ended)
      expect(executionOrder[0]).toBe("a-start");
      expect(executionOrder[1]).toBe("b-start");
      // The end order doesn't matter for parallelism proof
    });

    it("should collect outputs from parallel stages", async () => {
      // Given: Parallel stages returning different data
      const fetchUser = defineStage({
        id: "fetch-user",
        name: "Fetch User",
        schemas: {
          input: z.object({ userId: z.string() }),
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
          input: z.object({ userId: z.string() }),
          output: z.object({ orders: z.array(z.string()) }),
          config: z.object({}),
        },
        async execute(ctx) {
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

      await persistence.createRun({
        id: "run-collect",
        workflowId: "parallel-collect",
        workflowName: "Parallel Collect",
        status: "PENDING",
        input: { userId: "123" },
      });

      const executor = new WorkflowExecutor(
        workflow,
        "run-collect",
        "parallel-collect",
        {
          persistence,
          aiLogger,
        },
      );

      // When: I execute
      const result = await executor.execute({ userId: "123" }, {});

      // Then: Both outputs are collected
      expect(result).toEqual({
        0: { user: { name: "User-123" } },
        1: { orders: ["order-1", "order-2"] },
      });
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

      await persistence.createRun({
        id: "run-config",
        workflowId: "config-test",
        workflowName: "Config Test",
        status: "PENDING",
        input: { value: 10 },
      });

      const executor = new WorkflowExecutor(
        workflow,
        "run-config",
        "config-test",
        {
          persistence,
          aiLogger,
        },
      );

      // When: I execute with config
      const result = await executor.execute(
        { value: 10 },
        { configured: { multiplier: 5 } },
      );

      // Then: Stage received the config
      expect(capturedConfig).toEqual({ multiplier: 5 });
      expect(result).toEqual({ result: 50 });
    });

    it("should validate config before execution", async () => {
      // Given: A stage requiring specific config
      const strictStage = defineStage({
        id: "strict",
        name: "Strict Stage",
        schemas: {
          input: TestSchemas.string,
          output: TestSchemas.string,
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
        TestSchemas.string,
        TestSchemas.string,
      )
        .pipe(strictStage)
        .build();

      await persistence.createRun({
        id: "run-validate",
        workflowId: "validation-test",
        workflowName: "Validation Test",
        status: "PENDING",
        input: "test",
      });

      const executor = new WorkflowExecutor(
        workflow,
        "run-validate",
        "validation-test",
        {
          persistence,
          aiLogger,
        },
      );

      // When: I execute with invalid config
      // Then: Throws validation error
      await expect(
        executor.execute("test", { strict: { required: 123 } }), // Wrong type
      ).rejects.toThrow(/config validation failed/i);
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
          const producerOutput = ctx.require("producer" as never) as {
            produced: string;
          };
          return { output: { final: `consumed-${producerOutput.produced}` } };
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

      await persistence.createRun({
        id: "run-context",
        workflowId: "context-test",
        workflowName: "Context Test",
        status: "PENDING",
        input: { initial: "start" },
      });

      const executor = new WorkflowExecutor(
        workflow,
        "run-context",
        "context-test",
        {
          persistence,
          aiLogger,
        },
      );

      // When: I execute
      const result = await executor.execute({ initial: "start" }, {});

      // Then: Consumer could access producer output
      expect(capturedContext).toHaveProperty("producer");
      expect(result).toEqual({ final: "consumed-from-start" });
    });
  });
});
