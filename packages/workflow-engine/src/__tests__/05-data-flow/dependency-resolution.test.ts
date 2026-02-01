/**
 * Dependency Resolution Tests
 *
 * Tests for stage dependency resolution and accessing dependency outputs.
 * Verifies that dependencies complete before dependent stages and that
 * dependent stages can access multiple dependency outputs.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { WorkflowExecutor } from "../../core/executor";
import { defineStage } from "../../core/stage-factory";
import { WorkflowBuilder } from "../../core/workflow";
import { InMemoryAICallLogger } from "../utils/in-memory-ai-logger";
import { InMemoryWorkflowPersistence } from "../utils/in-memory-persistence";

describe("I want to ensure proper dependency resolution", () => {
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

  describe("dependency completion order", () => {
    it("should ensure dependencies complete before dependent stage", async () => {
      // Given: Stage C depends on Stage A and Stage B
      const executionOrder: string[] = [];

      const stageA = defineStage({
        id: "stage-a",
        name: "Stage A",
        schemas: {
          input: z.object({}),
          output: z.object({ valueA: z.number() }),
          config: z.object({}),
        },
        async execute() {
          await new Promise((resolve) => setTimeout(resolve, 50));
          executionOrder.push("stage-a");
          return { output: { valueA: 10 } };
        },
      });

      const stageB = defineStage({
        id: "stage-b",
        name: "Stage B",
        schemas: {
          input: z.object({ valueA: z.number() }),
          output: z.object({ valueB: z.number() }),
          config: z.object({}),
        },
        async execute() {
          await new Promise((resolve) => setTimeout(resolve, 30));
          executionOrder.push("stage-b");
          return { output: { valueB: 20 } };
        },
      });

      type DependencyContext = {
        "stage-a": { valueA: number };
        "stage-b": { valueB: number };
      };

      const stageC = defineStage<
        z.ZodObject<{ valueB: z.ZodNumber }>,
        z.ZodObject<{ combined: z.ZodNumber }>,
        z.ZodObject<{}>,
        DependencyContext
      >({
        id: "stage-c",
        name: "Stage C",
        dependencies: ["stage-a", "stage-b"],
        schemas: {
          input: z.object({ valueB: z.number() }),
          output: z.object({ combined: z.number() }),
          config: z.object({}),
        },
        async execute(ctx) {
          executionOrder.push("stage-c");
          // Access both dependencies via ctx.require
          const aOutput = ctx.require("stage-a");
          const bOutput = ctx.require("stage-b");
          return { output: { combined: aOutput.valueA + bOutput.valueB } };
        },
      });

      const workflow = new WorkflowBuilder("dep-order", "Dependency Order Test")
        .pipe(stageA)
        .pipe(stageB)
        .pipe(stageC)
        .build();

      // When: Execute the workflow
      await createRun("run-1", "dep-order", {});
      const executor = new WorkflowExecutor(workflow, "run-1", "test", {
        persistence,
        aiLogger,
      });

      const result = await executor.execute({}, {});

      // Then: Stage C executed after both A and B completed
      expect(executionOrder).toEqual(["stage-a", "stage-b", "stage-c"]);
      expect(result).toEqual({ combined: 30 });
    });

    it("should ensure parallel dependencies complete before dependent stage", async () => {
      // Given: Stage D depends on parallel stages A and B
      const executionOrder: string[] = [];
      const endTimes: Record<string, number> = {};
      let stageDStartTime = 0;

      const stageA = defineStage({
        id: "parallel-a",
        name: "Parallel A",
        schemas: {
          input: z.object({}),
          output: z.object({ a: z.string() }),
          config: z.object({}),
        },
        async execute() {
          await new Promise((resolve) => setTimeout(resolve, 80));
          executionOrder.push("parallel-a");
          endTimes["parallel-a"] = Date.now();
          return { output: { a: "from-a" } };
        },
      });

      const stageB = defineStage({
        id: "parallel-b",
        name: "Parallel B",
        schemas: {
          input: z.object({}),
          output: z.object({ b: z.string() }),
          config: z.object({}),
        },
        async execute() {
          await new Promise((resolve) => setTimeout(resolve, 40));
          executionOrder.push("parallel-b");
          endTimes["parallel-b"] = Date.now();
          return { output: { b: "from-b" } };
        },
      });

      type ParallelContext = {
        "parallel-a": { a: string };
        "parallel-b": { b: string };
      };

      const stageD = defineStage<
        z.ZodObject<{}, "passthrough">,
        z.ZodObject<{ combined: z.ZodString }>,
        z.ZodObject<{}>,
        ParallelContext
      >({
        id: "dependent-d",
        name: "Dependent D",
        dependencies: ["parallel-a", "parallel-b"],
        schemas: {
          input: z.object({}).passthrough(),
          output: z.object({ combined: z.string() }),
          config: z.object({}),
        },
        async execute(ctx) {
          stageDStartTime = Date.now();
          executionOrder.push("dependent-d");
          const a = ctx.require("parallel-a");
          const b = ctx.require("parallel-b");
          return { output: { combined: `${a.a}+${b.b}` } };
        },
      });

      const workflow = new WorkflowBuilder(
        "parallel-dep",
        "Parallel Dependency Test",
      )
        .parallel([stageA, stageB])
        .pipe(stageD)
        .build();

      // When: Execute the workflow
      await createRun("run-2", "parallel-dep", {});
      const executor = new WorkflowExecutor(workflow, "run-2", "test", {
        persistence,
        aiLogger,
      });

      const result = await executor.execute({}, {});

      // Then: Dependent stage started after both parallel stages completed
      expect(executionOrder).toContain("parallel-a");
      expect(executionOrder).toContain("parallel-b");
      expect(executionOrder[executionOrder.length - 1]).toBe("dependent-d");

      const latestParallelEnd = Math.max(
        endTimes["parallel-a"],
        endTimes["parallel-b"],
      );
      expect(stageDStartTime).toBeGreaterThanOrEqual(latestParallelEnd);

      expect(result).toEqual({ combined: "from-a+from-b" });
    });
  });

  describe("accessing multiple dependencies", () => {
    it("should allow accessing multiple dependencies via ctx.require", async () => {
      // Given: A stage that depends on multiple previous stages
      let capturedDependencies: Record<string, unknown> = {};

      const stageA = defineStage({
        id: "data-source",
        name: "Data Source",
        schemas: {
          input: z.object({}),
          output: z.object({ items: z.array(z.string()), count: z.number() }),
          config: z.object({}),
        },
        async execute() {
          return { output: { items: ["a", "b", "c"], count: 3 } };
        },
      });

      const stageB = defineStage({
        id: "config-source",
        name: "Config Source",
        schemas: {
          input: z.object({ items: z.array(z.string()), count: z.number() }),
          output: z.object({ prefix: z.string(), multiplier: z.number() }),
          config: z.object({}),
        },
        async execute() {
          return { output: { prefix: "item-", multiplier: 2 } };
        },
      });

      const stageC = defineStage({
        id: "metadata-source",
        name: "Metadata Source",
        schemas: {
          input: z.object({ prefix: z.string(), multiplier: z.number() }),
          output: z.object({ version: z.string(), timestamp: z.number() }),
          config: z.object({}),
        },
        async execute() {
          return { output: { version: "1.0.0", timestamp: 1234567890 } };
        },
      });

      type MultiDependencyContext = {
        "data-source": { items: string[]; count: number };
        "config-source": { prefix: string; multiplier: number };
        "metadata-source": { version: string; timestamp: number };
      };

      const stageD = defineStage<
        z.ZodObject<{ version: z.ZodString; timestamp: z.ZodNumber }>,
        z.ZodObject<{ result: z.ZodString }>,
        z.ZodObject<{}>,
        MultiDependencyContext
      >({
        id: "processor",
        name: "Processor",
        dependencies: ["data-source", "config-source", "metadata-source"],
        schemas: {
          input: z.object({ version: z.string(), timestamp: z.number() }),
          output: z.object({ result: z.string() }),
          config: z.object({}),
        },
        async execute(ctx) {
          // Access all three dependencies
          const data = ctx.require("data-source");
          const config = ctx.require("config-source");
          const metadata = ctx.require("metadata-source");

          capturedDependencies = { data, config, metadata };

          // Use data from all dependencies
          const processedItems = data.items.map(
            (item) => `${config.prefix}${item}`,
          );
          const totalCount = data.count * config.multiplier;

          return {
            output: {
              result: `v${metadata.version}: ${processedItems.join(", ")} (${totalCount} items)`,
            },
          };
        },
      });

      const workflow = new WorkflowBuilder("multi-dep", "Multi Dependency Test")
        .pipe(stageA)
        .pipe(stageB)
        .pipe(stageC)
        .pipe(stageD)
        .build();

      // When: Execute the workflow
      await createRun("run-3", "multi-dep", {});
      const executor = new WorkflowExecutor(workflow, "run-3", "test", {
        persistence,
        aiLogger,
      });

      const result = await executor.execute({}, {});

      // Then: All dependencies were accessible
      expect(capturedDependencies).toEqual({
        data: { items: ["a", "b", "c"], count: 3 },
        config: { prefix: "item-", multiplier: 2 },
        metadata: { version: "1.0.0", timestamp: 1234567890 },
      });

      expect(result).toEqual({
        result: "v1.0.0: item-a, item-b, item-c (6 items)",
      });
    });

    it("should allow mixing ctx.require and ctx.optional for dependencies", async () => {
      // Given: A stage with required and optional dependencies
      let requiredData: unknown;
      let optionalData: unknown;

      const requiredStage = defineStage({
        id: "required-dep",
        name: "Required Dependency",
        schemas: {
          input: z.object({}),
          output: z.object({ essential: z.string() }),
          config: z.object({}),
        },
        async execute() {
          return { output: { essential: "must-have" } };
        },
      });

      type MixedDependencyContext = {
        "required-dep": { essential: string };
        "optional-dep"?: { bonus: string };
      };

      const dependentStage = defineStage<
        z.ZodObject<{ essential: z.ZodString }>,
        z.ZodObject<{ result: z.ZodString }>,
        z.ZodObject<{}>,
        MixedDependencyContext
      >({
        id: "mixed-consumer",
        name: "Mixed Consumer",
        dependencies: ["required-dep"],
        schemas: {
          input: z.object({ essential: z.string() }),
          output: z.object({ result: z.string() }),
          config: z.object({}),
        },
        async execute(ctx) {
          requiredData = ctx.require("required-dep");
          optionalData = ctx.optional(
            "optional-dep" as keyof MixedDependencyContext,
          );

          const base = ctx.require("required-dep").essential;
          const bonus = ctx.optional(
            "optional-dep" as keyof MixedDependencyContext,
          );

          return {
            output: {
              result: bonus
                ? `${base} with ${(bonus as { bonus: string }).bonus}`
                : base,
            },
          };
        },
      });

      const workflow = new WorkflowBuilder(
        "mixed-deps",
        "Mixed Dependencies Test",
      )
        .pipe(requiredStage)
        .pipe(dependentStage)
        .build();

      // When: Execute the workflow
      await createRun("run-4", "mixed-deps", {});
      const executor = new WorkflowExecutor(workflow, "run-4", "test", {
        persistence,
        aiLogger,
      });

      const result = await executor.execute({}, {});

      // Then: Required dependency was accessible, optional was undefined
      expect(requiredData).toEqual({ essential: "must-have" });
      expect(optionalData).toBeUndefined();
      expect(result).toEqual({ result: "must-have" });
    });

    it("should allow accessing non-immediate dependencies", async () => {
      // Given: Stage D needs Stage A output, though B and C are between them
      let capturedAOutput: unknown;

      const stageA = defineStage({
        id: "origin",
        name: "Origin",
        schemas: {
          input: z.object({}),
          output: z.object({ originalData: z.string() }),
          config: z.object({}),
        },
        async execute() {
          return { output: { originalData: "from-origin" } };
        },
      });

      const stageB = defineStage({
        id: "middle-1",
        name: "Middle 1",
        schemas: {
          input: z.object({ originalData: z.string() }),
          output: z.object({ modified: z.string() }),
          config: z.object({}),
        },
        async execute(ctx) {
          return {
            output: { modified: `${ctx.input.originalData}-modified-1` },
          };
        },
      });

      const stageC = defineStage({
        id: "middle-2",
        name: "Middle 2",
        schemas: {
          input: z.object({ modified: z.string() }),
          output: z.object({ further: z.string() }),
          config: z.object({}),
        },
        async execute(ctx) {
          return { output: { further: `${ctx.input.modified}-modified-2` } };
        },
      });

      type FullContext = {
        origin: { originalData: string };
        "middle-1": { modified: string };
        "middle-2": { further: string };
      };

      const stageD = defineStage<
        z.ZodObject<{ further: z.ZodString }>,
        z.ZodObject<{ final: z.ZodString }>,
        z.ZodObject<{}>,
        FullContext
      >({
        id: "destination",
        name: "Destination",
        dependencies: ["origin", "middle-1", "middle-2"],
        schemas: {
          input: z.object({ further: z.string() }),
          output: z.object({ final: z.string() }),
          config: z.object({}),
        },
        async execute(ctx) {
          // Access the origin directly, skipping middle stages
          const origin = ctx.require("origin");
          capturedAOutput = origin;

          // Also access all others to demonstrate full access
          const middle1 = ctx.require("middle-1");
          const middle2 = ctx.require("middle-2");

          return {
            output: {
              final: `Original: ${origin.originalData}, Final: ${middle2.further}`,
            },
          };
        },
      });

      const workflow = new WorkflowBuilder(
        "non-immediate",
        "Non-Immediate Dependencies Test",
      )
        .pipe(stageA)
        .pipe(stageB)
        .pipe(stageC)
        .pipe(stageD)
        .build();

      // When: Execute the workflow
      await createRun("run-5", "non-immediate", {});
      const executor = new WorkflowExecutor(workflow, "run-5", "test", {
        persistence,
        aiLogger,
      });

      const result = await executor.execute({}, {});

      // Then: Origin stage output was accessible from the end of the chain
      expect(capturedAOutput).toEqual({ originalData: "from-origin" });
      expect(result).toEqual({
        final:
          "Original: from-origin, Final: from-origin-modified-1-modified-2",
      });
    });

    it("should allow accessing parallel stage outputs as dependencies", async () => {
      // Given: Sequential stage followed by parallel stages, then a combiner
      let capturedParallelOutputs: Record<string, unknown> = {};

      const setupStage = defineStage({
        id: "setup",
        name: "Setup",
        schemas: {
          input: z.object({}),
          output: z.object({ seed: z.number() }),
          config: z.object({}),
        },
        async execute() {
          return { output: { seed: 42 } };
        },
      });

      const parallelA = defineStage({
        id: "worker-a",
        name: "Worker A",
        dependencies: ["setup"],
        schemas: {
          input: z.object({ seed: z.number() }),
          output: z.object({ resultA: z.number() }),
          config: z.object({}),
        },
        async execute(ctx) {
          return { output: { resultA: ctx.input.seed * 2 } };
        },
      });

      const parallelB = defineStage({
        id: "worker-b",
        name: "Worker B",
        dependencies: ["setup"],
        schemas: {
          input: z.object({ seed: z.number() }),
          output: z.object({ resultB: z.number() }),
          config: z.object({}),
        },
        async execute(ctx) {
          return { output: { resultB: ctx.input.seed * 3 } };
        },
      });

      const parallelC = defineStage({
        id: "worker-c",
        name: "Worker C",
        dependencies: ["setup"],
        schemas: {
          input: z.object({ seed: z.number() }),
          output: z.object({ resultC: z.number() }),
          config: z.object({}),
        },
        async execute(ctx) {
          return { output: { resultC: ctx.input.seed * 4 } };
        },
      });

      type ParallelWorkersContext = {
        setup: { seed: number };
        "worker-a": { resultA: number };
        "worker-b": { resultB: number };
        "worker-c": { resultC: number };
      };

      const combinerStage = defineStage<
        z.ZodObject<{}, "passthrough">,
        z.ZodObject<{ total: z.ZodNumber }>,
        z.ZodObject<{}>,
        ParallelWorkersContext
      >({
        id: "combiner",
        name: "Combiner",
        dependencies: ["setup", "worker-a", "worker-b", "worker-c"],
        schemas: {
          input: z.object({}).passthrough(),
          output: z.object({ total: z.number() }),
          config: z.object({}),
        },
        async execute(ctx) {
          const setup = ctx.require("setup");
          const a = ctx.require("worker-a");
          const b = ctx.require("worker-b");
          const c = ctx.require("worker-c");

          capturedParallelOutputs = { setup, a, b, c };

          return {
            output: {
              total: setup.seed + a.resultA + b.resultB + c.resultC,
            },
          };
        },
      });

      const workflow = new WorkflowBuilder(
        "parallel-deps",
        "Parallel Dependencies Test",
      )
        .pipe(setupStage)
        .parallel([parallelA, parallelB, parallelC])
        .pipe(combinerStage)
        .build();

      // When: Execute the workflow
      await createRun("run-6", "parallel-deps", {});
      const executor = new WorkflowExecutor(workflow, "run-6", "test", {
        persistence,
        aiLogger,
      });

      const result = await executor.execute({}, {});

      // Then: All parallel outputs were accessible
      expect(capturedParallelOutputs).toEqual({
        setup: { seed: 42 },
        a: { resultA: 84 },
        b: { resultB: 126 },
        c: { resultC: 168 },
      });

      // 42 + 84 + 126 + 168 = 420
      expect(result).toEqual({ total: 420 });
    });
  });

  describe("dependency validation", () => {
    it("should throw when accessing undeclared dependency that does not exist", async () => {
      // Given: A stage that tries to require a non-existent stage
      const stage = defineStage({
        id: "bad-require",
        name: "Bad Require",
        schemas: {
          input: z.object({}),
          output: z.object({}),
          config: z.object({}),
        },
        async execute(ctx) {
          // Try to require a stage that doesn't exist
          ctx.require("nonexistent" as any);
          return { output: {} };
        },
      });

      const workflow = new WorkflowBuilder(
        "bad-require-test",
        "Bad Require Test",
      )
        .pipe(stage)
        .build();

      // When/Then: Execution throws
      await createRun("run-7", "bad-require-test", {});
      const executor = new WorkflowExecutor(workflow, "run-7", "test", {
        persistence,
        aiLogger,
      });

      await expect(executor.execute({}, {})).rejects.toThrow(
        /Missing required stage/,
      );
    });

    it("should return undefined when accessing missing optional dependency", async () => {
      // Given: A stage that uses ctx.optional for a non-existent stage
      let optionalResult: unknown = "not-set";

      const stage = defineStage({
        id: "safe-optional",
        name: "Safe Optional",
        schemas: {
          input: z.object({}),
          output: z.object({ found: z.boolean() }),
          config: z.object({}),
        },
        async execute(ctx) {
          optionalResult = ctx.optional("nonexistent" as any);
          return { output: { found: optionalResult !== undefined } };
        },
      });

      const workflow = new WorkflowBuilder(
        "safe-optional-test",
        "Safe Optional Test",
      )
        .pipe(stage)
        .build();

      // When: Execute
      await createRun("run-8", "safe-optional-test", {});
      const executor = new WorkflowExecutor(workflow, "run-8", "test", {
        persistence,
        aiLogger,
      });

      const result = await executor.execute({}, {});

      // Then: ctx.optional returned undefined without throwing
      expect(optionalResult).toBeUndefined();
      expect(result).toEqual({ found: false });
    });
  });
});
