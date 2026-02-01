/**
 * Parallel Data Flow Tests
 *
 * Tests for data flow through parallel workflow stages.
 * Verifies same input to all parallel stages, output merging by index.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { z } from "zod";
import { WorkflowBuilder } from "../../core/workflow";
import { WorkflowExecutor } from "../../core/executor";
import { defineStage } from "../../core/stage-factory";
import { InMemoryWorkflowPersistence } from "../utils/in-memory-persistence";
import { InMemoryAICallLogger } from "../utils/in-memory-ai-logger";

describe("I want data to flow through parallel stages", () => {
  let persistence: InMemoryWorkflowPersistence;
  let aiLogger: InMemoryAICallLogger;

  beforeEach(() => {
    persistence = new InMemoryWorkflowPersistence();
    aiLogger = new InMemoryAICallLogger();
  });

  // Helper to create a workflow run before execution
  async function createRun(
    runId: string,
    workflowId: string,
    input: unknown = {},
  ) {
    await persistence.createRun({
      id: runId,
      workflowId,
      workflowName: workflowId,
      status: "PENDING",
      input,
    });
  }

  describe("parallel input distribution", () => {
    it("should give all parallel stages the same input", async () => {
      // Given: Three parallel stages that capture their input
      const capturedInputs: { stage: string; input: unknown }[] = [];

      const createParallelStage = (id: string) =>
        defineStage({
          id,
          name: id,
          schemas: {
            input: z.object({ shared: z.string() }),
            output: z.object({ from: z.string() }),
            config: z.object({}),
          },
          async execute(ctx) {
            capturedInputs.push({ stage: id, input: ctx.input });
            return { output: { from: id } };
          },
        });

      const initialStage = defineStage({
        id: "initial",
        name: "Initial",
        schemas: {
          input: z.object({}),
          output: z.object({ shared: z.string() }),
          config: z.object({}),
        },
        async execute() {
          return { output: { shared: "data-for-all" } };
        },
      });

      const workflow = new WorkflowBuilder("parallel-input", "Test")
        .pipe(initialStage)
        .parallel([
          createParallelStage("parallel-a"),
          createParallelStage("parallel-b"),
          createParallelStage("parallel-c"),
        ])
        .build();

      // When: Execute
      await createRun("run-1", "parallel-input", {});
      const executor = new WorkflowExecutor(workflow, "run-1", "test", {
        persistence,
        aiLogger,
      });

      await executor.execute({}, {});

      // Then: All parallel stages received the same input
      expect(capturedInputs).toHaveLength(3);
      expect(capturedInputs[0].input).toEqual({ shared: "data-for-all" });
      expect(capturedInputs[1].input).toEqual({ shared: "data-for-all" });
      expect(capturedInputs[2].input).toEqual({ shared: "data-for-all" });
    });

    it("should pass workflow input to parallel stages when first", async () => {
      // Given: Parallel stages as the first stage group
      const capturedInputs: unknown[] = [];

      const createStage = (id: string) =>
        defineStage({
          id,
          name: id,
          schemas: {
            input: z.object({ workflowData: z.number() }),
            output: z.object({ processed: z.string() }),
            config: z.object({}),
          },
          async execute(ctx) {
            capturedInputs.push(ctx.input);
            return { output: { processed: `${id}-${ctx.input.workflowData}` } };
          },
        });

      const workflow = new WorkflowBuilder("parallel-first", "Test")
        .parallel([createStage("a"), createStage("b")])
        .build();

      // When: Execute with workflow input
      await createRun("run-2", "parallel-first", { workflowData: 99 });
      const executor = new WorkflowExecutor(workflow, "run-2", "test", {
        persistence,
        aiLogger,
      });

      await executor.execute({ workflowData: 99 }, {});

      // Then: Both stages received workflow input
      expect(capturedInputs).toEqual([
        { workflowData: 99 },
        { workflowData: 99 },
      ]);
    });
  });

  describe("parallel output merging", () => {
    it("should merge parallel outputs by index", async () => {
      // Given: Parallel stages with different outputs
      const stageA = defineStage({
        id: "a",
        name: "A",
        schemas: {
          input: z.object({}),
          output: z.object({ resultA: z.number() }),
          config: z.object({}),
        },
        async execute() {
          return { output: { resultA: 1 } };
        },
      });

      const stageB = defineStage({
        id: "b",
        name: "B",
        schemas: {
          input: z.object({}),
          output: z.object({ resultB: z.number() }),
          config: z.object({}),
        },
        async execute() {
          return { output: { resultB: 2 } };
        },
      });

      const stageC = defineStage({
        id: "c",
        name: "C",
        schemas: {
          input: z.object({}),
          output: z.object({ resultC: z.number() }),
          config: z.object({}),
        },
        async execute() {
          return { output: { resultC: 3 } };
        },
      });

      // Stage that receives merged output
      let receivedInput: unknown;
      const finalStage = defineStage({
        id: "final",
        name: "Final",
        schemas: {
          input: z.object({}).passthrough(),
          output: z.object({ done: z.boolean() }),
          config: z.object({}),
        },
        async execute(ctx) {
          receivedInput = ctx.input;
          return { output: { done: true } };
        },
      });

      const workflow = new WorkflowBuilder("parallel-merge", "Test")
        .parallel([stageA, stageB, stageC])
        .pipe(finalStage)
        .build();

      // When: Execute
      await createRun("run-3", "parallel-merge", {});
      const executor = new WorkflowExecutor(workflow, "run-3", "test", {
        persistence,
        aiLogger,
      });

      await executor.execute({}, {});

      // Then: Next stage receives merged output by index
      expect(receivedInput).toEqual({
        0: { resultA: 1 },
        1: { resultB: 2 },
        2: { resultC: 3 },
      });
    });

    it("should return merged parallel outputs as workflow result when last", async () => {
      // Given: Parallel stages as the last stage group
      const stageA = defineStage({
        id: "a",
        name: "A",
        schemas: {
          input: z.object({}),
          output: z.object({ a: z.string() }),
          config: z.object({}),
        },
        async execute() {
          return { output: { a: "from-a" } };
        },
      });

      const stageB = defineStage({
        id: "b",
        name: "B",
        schemas: {
          input: z.object({}),
          output: z.object({ b: z.string() }),
          config: z.object({}),
        },
        async execute() {
          return { output: { b: "from-b" } };
        },
      });

      const workflow = new WorkflowBuilder("parallel-last", "Test")
        .parallel([stageA, stageB])
        .build();

      // When: Execute
      await createRun("run-4", "parallel-last", {});
      const executor = new WorkflowExecutor(workflow, "run-4", "test", {
        persistence,
        aiLogger,
      });

      const result = await executor.execute({}, {});

      // Then: Workflow returns merged parallel outputs
      expect(result).toEqual({
        0: { a: "from-a" },
        1: { b: "from-b" },
      });
    });
  });

  describe("parallel stages in workflowContext", () => {
    it("should add parallel outputs to workflowContext by stageId", async () => {
      // Given: Parallel stages followed by a stage that accesses workflowContext
      const parallelA = defineStage({
        id: "analyze-a",
        name: "Analyze A",
        schemas: {
          input: z.object({}),
          output: z.object({ analysis: z.string() }),
          config: z.object({}),
        },
        async execute() {
          return { output: { analysis: "result-a" } };
        },
      });

      const parallelB = defineStage({
        id: "analyze-b",
        name: "Analyze B",
        schemas: {
          input: z.object({}),
          output: z.object({ analysis: z.string() }),
          config: z.object({}),
        },
        async execute() {
          return { output: { analysis: "result-b" } };
        },
      });

      let capturedContext: Record<string, unknown> | undefined;
      const combineStage = defineStage({
        id: "combine",
        name: "Combine",
        schemas: {
          input: z.object({}).passthrough(),
          output: z.object({ combined: z.string() }),
          config: z.object({}),
        },
        async execute(ctx) {
          capturedContext = { ...ctx.workflowContext };
          const aOutput = ctx.workflowContext["analyze-a"] as {
            analysis: string;
          };
          const bOutput = ctx.workflowContext["analyze-b"] as {
            analysis: string;
          };
          return {
            output: {
              combined: `${aOutput.analysis}+${bOutput.analysis}`,
            },
          };
        },
      });

      const workflow = new WorkflowBuilder("parallel-context", "Test")
        .parallel([parallelA, parallelB])
        .pipe(combineStage)
        .build();

      // When: Execute
      await createRun("run-5", "parallel-context", {});
      const executor = new WorkflowExecutor(workflow, "run-5", "test", {
        persistence,
        aiLogger,
      });

      const result = await executor.execute({}, {});

      // Then: WorkflowContext contains both parallel outputs by stage ID
      expect(capturedContext).toBeDefined();
      expect(capturedContext!["analyze-a"]).toEqual({ analysis: "result-a" });
      expect(capturedContext!["analyze-b"]).toEqual({ analysis: "result-b" });
      expect(result).toEqual({ combined: "result-a+result-b" });
    });
  });

  describe("parallel execution timing", () => {
    it("should execute parallel stages concurrently", async () => {
      // Given: Parallel stages with delays
      const startTime = Date.now();
      const stageTimes: { stage: string; start: number; end: number }[] = [];

      const createSlowStage = (id: string, delayMs: number) =>
        defineStage({
          id,
          name: id,
          schemas: {
            input: z.object({}),
            output: z.object({ id: z.string() }),
            config: z.object({}),
          },
          async execute() {
            const start = Date.now() - startTime;
            await new Promise((resolve) => setTimeout(resolve, delayMs));
            const end = Date.now() - startTime;
            stageTimes.push({ stage: id, start, end });
            return { output: { id } };
          },
        });

      const workflow = new WorkflowBuilder("parallel-timing", "Test")
        .parallel([
          createSlowStage("fast", 50),
          createSlowStage("medium", 75),
          createSlowStage("slow", 100),
        ])
        .build();

      // When: Execute
      await createRun("run-6", "parallel-timing", {});
      const executor = new WorkflowExecutor(workflow, "run-6", "test", {
        persistence,
        aiLogger,
      });

      await executor.execute({}, {});

      // Then: All stages started at roughly the same time (within 20ms of each other)
      expect(stageTimes).toHaveLength(3);
      const starts = stageTimes.map((t) => t.start);
      const maxStartDiff = Math.max(...starts) - Math.min(...starts);
      expect(maxStartDiff).toBeLessThan(20);
    });

    it("should wait for all parallel stages before continuing", async () => {
      // Given: Parallel stages with varying durations, followed by sequential stage
      let nextStageStarted = false;
      const parallelEndTimes: number[] = [];
      let nextStageStartTime = 0;

      const createParallelStage = (id: string, delayMs: number) =>
        defineStage({
          id,
          name: id,
          schemas: {
            input: z.object({}),
            output: z.object({}),
            config: z.object({}),
          },
          async execute() {
            await new Promise((resolve) => setTimeout(resolve, delayMs));
            parallelEndTimes.push(Date.now());
            return { output: {} };
          },
        });

      const nextStage = defineStage({
        id: "next",
        name: "Next",
        schemas: {
          input: z.object({}).passthrough(),
          output: z.object({ done: z.boolean() }),
          config: z.object({}),
        },
        async execute() {
          nextStageStarted = true;
          nextStageStartTime = Date.now();
          return { output: { done: true } };
        },
      });

      const workflow = new WorkflowBuilder("parallel-wait", "Test")
        .parallel([
          createParallelStage("quick", 20),
          createParallelStage("slow", 80),
        ])
        .pipe(nextStage)
        .build();

      // When: Execute
      await createRun("run-7", "parallel-wait", {});
      const executor = new WorkflowExecutor(workflow, "run-7", "test", {
        persistence,
        aiLogger,
      });

      await executor.execute({}, {});

      // Then: Next stage started after slowest parallel stage
      expect(nextStageStarted).toBe(true);
      const latestParallelEnd = Math.max(...parallelEndTimes);
      expect(nextStageStartTime).toBeGreaterThanOrEqual(latestParallelEnd);
    });
  });

  describe("mixed sequential and parallel", () => {
    it("should handle sequential -> parallel -> sequential flow", async () => {
      // Given: A workflow with mixed execution patterns
      const executionLog: string[] = [];

      const initialStage = defineStage({
        id: "initial",
        name: "Initial",
        schemas: {
          input: z.object({ start: z.number() }),
          output: z.object({ value: z.number() }),
          config: z.object({}),
        },
        async execute(ctx) {
          executionLog.push("initial");
          return { output: { value: ctx.input.start * 2 } };
        },
      });

      const createParallelStage = (id: string, multiplier: number) =>
        defineStage({
          id,
          name: id,
          schemas: {
            input: z.object({ value: z.number() }),
            output: z.object({ result: z.number() }),
            config: z.object({}),
          },
          async execute(ctx) {
            executionLog.push(id);
            return { output: { result: ctx.input.value * multiplier } };
          },
        });

      const finalStage = defineStage({
        id: "final",
        name: "Final",
        schemas: {
          input: z.object({}).passthrough(),
          output: z.object({ sum: z.number() }),
          config: z.object({}),
        },
        async execute(ctx) {
          executionLog.push("final");
          const results = Object.values(ctx.input) as Array<{ result: number }>;
          const sum = results.reduce((acc, r) => acc + r.result, 0);
          return { output: { sum } };
        },
      });

      const workflow = new WorkflowBuilder("mixed-flow", "Test")
        .pipe(initialStage)
        .parallel([
          createParallelStage("double", 2),
          createParallelStage("triple", 3),
        ])
        .pipe(finalStage)
        .build();

      // When: Execute with start value
      await createRun("run-8", "mixed-flow", { start: 5 });
      const executor = new WorkflowExecutor(workflow, "run-8", "test", {
        persistence,
        aiLogger,
      });

      const result = await executor.execute({ start: 5 }, {});

      // Then: Flow worked correctly
      // start=5 -> initial outputs 10
      // parallel: double=20, triple=30
      // final: sum=50
      expect(executionLog[0]).toBe("initial");
      expect(executionLog).toContain("double");
      expect(executionLog).toContain("triple");
      expect(executionLog[executionLog.length - 1]).toBe("final");
      expect(result).toEqual({ sum: 50 });
    });
  });
});
