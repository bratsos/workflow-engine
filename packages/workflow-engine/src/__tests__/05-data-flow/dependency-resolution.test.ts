/**
 * Dependency Resolution Tests (Kernel)
 *
 * Tests for stage dependency resolution and accessing dependency outputs.
 * Verifies that dependencies complete before dependent stages and that
 * dependent stages can access multiple dependency outputs.
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

describe("I want to ensure proper dependency resolution", () => {
  describe("dependency completion order", () => {
    it("should ensure dependencies complete before dependent stage", async () => {
      // Given: Stage C depends on Stage A and Stage B (sequential pipeline)
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
          const aOutput = ctx.require("stage-a");
          const bOutput = ctx.require("stage-b");
          return { output: { combined: aOutput.valueA + bOutput.valueB } };
        },
      });

      const workflow = new WorkflowBuilder(
        "dep-order",
        "Dependency Order Test",
        "Test",
        z.object({}),
        z.object({ combined: z.number() }),
      )
        .pipe(stageA)
        .pipe(stageB)
        .pipe(stageC)
        .build();

      const { kernel, flush } = createTestKernel([workflow]);

      const { workflowRunId } = await kernel.dispatch({
        type: "run.create",
        idempotencyKey: "key-1",
        workflowId: "dep-order",
        input: {},
      });

      await kernel.dispatch({ type: "run.claimPending", workerId: "worker-1" });

      // Execute stages in order with transitions
      await kernel.dispatch({
        type: "job.execute",
        workflowRunId,
        workflowId: "dep-order",
        stageId: "stage-a",
        config: {},
      });
      await kernel.dispatch({ type: "run.transition", workflowRunId });

      await kernel.dispatch({
        type: "job.execute",
        workflowRunId,
        workflowId: "dep-order",
        stageId: "stage-b",
        config: {},
      });
      await kernel.dispatch({ type: "run.transition", workflowRunId });

      const rC = await kernel.dispatch({
        type: "job.execute",
        workflowRunId,
        workflowId: "dep-order",
        stageId: "stage-c",
        config: {},
      });
      await kernel.dispatch({ type: "run.transition", workflowRunId });
      await flush();

      // Then: Stage C executed after both A and B completed
      expect(executionOrder).toEqual(["stage-a", "stage-b", "stage-c"]);
      expect(rC.output).toEqual({ combined: 30 });
    });

    it("should ensure parallel dependencies complete before dependent stage", async () => {
      // Given: Parallel stages A and B, then dependent stage D
      const executionOrder: string[] = [];

      const stageA = defineStage({
        id: "parallel-a",
        name: "Parallel A",
        schemas: {
          input: z.object({}).passthrough(),
          output: z.object({ a: z.string() }),
          config: z.object({}),
        },
        async execute() {
          executionOrder.push("parallel-a");
          return { output: { a: "from-a" } };
        },
      });

      const stageB = defineStage({
        id: "parallel-b",
        name: "Parallel B",
        schemas: {
          input: z.object({}).passthrough(),
          output: z.object({ b: z.string() }),
          config: z.object({}),
        },
        async execute() {
          executionOrder.push("parallel-b");
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
          executionOrder.push("dependent-d");
          const a = ctx.require("parallel-a");
          const b = ctx.require("parallel-b");
          return { output: { combined: `${a.a}+${b.b}` } };
        },
      });

      const workflow = new WorkflowBuilder(
        "parallel-dep",
        "Parallel Dependency Test",
        "Test",
        z.object({}),
        z.object({ combined: z.string() }),
      )
        .parallel([stageA, stageB])
        .pipe(stageD)
        .build();

      const { kernel, flush } = createTestKernel([workflow]);

      const { workflowRunId } = await kernel.dispatch({
        type: "run.create",
        idempotencyKey: "key-1",
        workflowId: "parallel-dep",
        input: {},
      });

      await kernel.dispatch({ type: "run.claimPending", workerId: "worker-1" });

      // Execute both parallel stages
      await kernel.dispatch({
        type: "job.execute",
        workflowRunId,
        workflowId: "parallel-dep",
        stageId: "parallel-a",
        config: {},
      });
      await kernel.dispatch({
        type: "job.execute",
        workflowRunId,
        workflowId: "parallel-dep",
        stageId: "parallel-b",
        config: {},
      });

      // One transition after parallel group
      await kernel.dispatch({ type: "run.transition", workflowRunId });

      // Execute dependent stage
      const rD = await kernel.dispatch({
        type: "job.execute",
        workflowRunId,
        workflowId: "parallel-dep",
        stageId: "dependent-d",
        config: {},
      });
      await kernel.dispatch({ type: "run.transition", workflowRunId });
      await flush();

      // Then: Dependent stage started after both parallel stages completed
      expect(executionOrder).toContain("parallel-a");
      expect(executionOrder).toContain("parallel-b");
      expect(executionOrder[executionOrder.length - 1]).toBe("dependent-d");
      expect(rD.output).toEqual({ combined: "from-a+from-b" });
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
          const data = ctx.require("data-source");
          const config = ctx.require("config-source");
          const metadata = ctx.require("metadata-source");

          capturedDependencies = { data, config, metadata };

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

      const workflow = new WorkflowBuilder(
        "multi-dep",
        "Multi Dependency Test",
        "Test",
        z.object({}),
        z.object({ result: z.string() }),
      )
        .pipe(stageA)
        .pipe(stageB)
        .pipe(stageC)
        .pipe(stageD)
        .build();

      const { kernel, flush } = createTestKernel([workflow]);

      const { workflowRunId } = await kernel.dispatch({
        type: "run.create",
        idempotencyKey: "key-1",
        workflowId: "multi-dep",
        input: {},
      });

      await kernel.dispatch({ type: "run.claimPending", workerId: "worker-1" });

      for (const stageId of [
        "data-source",
        "config-source",
        "metadata-source",
        "processor",
      ]) {
        await kernel.dispatch({
          type: "job.execute",
          workflowRunId,
          workflowId: "multi-dep",
          stageId,
          config: {},
        });
        await kernel.dispatch({ type: "run.transition", workflowRunId });
      }
      await flush();

      // Then: All dependencies were accessible
      expect(capturedDependencies).toEqual({
        data: { items: ["a", "b", "c"], count: 3 },
        config: { prefix: "item-", multiplier: 2 },
        metadata: { version: "1.0.0", timestamp: 1234567890 },
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
        "Test",
        z.object({}),
        z.object({ result: z.string() }),
      )
        .pipe(requiredStage)
        .pipe(dependentStage)
        .build();

      const { kernel, flush } = createTestKernel([workflow]);

      const { workflowRunId } = await kernel.dispatch({
        type: "run.create",
        idempotencyKey: "key-1",
        workflowId: "mixed-deps",
        input: {},
      });

      await kernel.dispatch({ type: "run.claimPending", workerId: "worker-1" });

      await kernel.dispatch({
        type: "job.execute",
        workflowRunId,
        workflowId: "mixed-deps",
        stageId: "required-dep",
        config: {},
      });
      await kernel.dispatch({ type: "run.transition", workflowRunId });

      const rDep = await kernel.dispatch({
        type: "job.execute",
        workflowRunId,
        workflowId: "mixed-deps",
        stageId: "mixed-consumer",
        config: {},
      });
      await kernel.dispatch({ type: "run.transition", workflowRunId });
      await flush();

      // Then: Required dependency was accessible, optional was undefined
      expect(requiredData).toEqual({ essential: "must-have" });
      expect(optionalData).toBeUndefined();
      expect(rDep.output).toEqual({ result: "must-have" });
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
          const origin = ctx.require("origin");
          capturedAOutput = origin;

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
        "Test",
        z.object({}),
        z.object({ final: z.string() }),
      )
        .pipe(stageA)
        .pipe(stageB)
        .pipe(stageC)
        .pipe(stageD)
        .build();

      const { kernel, flush } = createTestKernel([workflow]);

      const { workflowRunId } = await kernel.dispatch({
        type: "run.create",
        idempotencyKey: "key-1",
        workflowId: "non-immediate",
        input: {},
      });

      await kernel.dispatch({ type: "run.claimPending", workerId: "worker-1" });

      for (const stageId of ["origin", "middle-1", "middle-2", "destination"]) {
        await kernel.dispatch({
          type: "job.execute",
          workflowRunId,
          workflowId: "non-immediate",
          stageId,
          config: {},
        });
        await kernel.dispatch({ type: "run.transition", workflowRunId });
      }
      await flush();

      // Then: Origin stage output was accessible from the end of the chain
      expect(capturedAOutput).toEqual({ originalData: "from-origin" });
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
          input: z.object({}).passthrough(),
          output: z.object({ resultA: z.number() }),
          config: z.object({}),
        },
        async execute(ctx) {
          // Access setup output via workflowContext (kernel pattern for parallel stages)
          const setup = ctx.workflowContext["setup"] as { seed: number };
          return { output: { resultA: setup.seed * 2 } };
        },
      });

      const parallelB = defineStage({
        id: "worker-b",
        name: "Worker B",
        dependencies: ["setup"],
        schemas: {
          input: z.object({}).passthrough(),
          output: z.object({ resultB: z.number() }),
          config: z.object({}),
        },
        async execute(ctx) {
          const setup = ctx.workflowContext["setup"] as { seed: number };
          return { output: { resultB: setup.seed * 3 } };
        },
      });

      const parallelC = defineStage({
        id: "worker-c",
        name: "Worker C",
        dependencies: ["setup"],
        schemas: {
          input: z.object({}).passthrough(),
          output: z.object({ resultC: z.number() }),
          config: z.object({}),
        },
        async execute(ctx) {
          const setup = ctx.workflowContext["setup"] as { seed: number };
          return { output: { resultC: setup.seed * 4 } };
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
        "Test",
        z.object({}),
        z.object({ total: z.number() }),
      )
        .pipe(setupStage)
        .parallel([parallelA, parallelB, parallelC])
        .pipe(combinerStage)
        .build();

      const { kernel, flush } = createTestKernel([workflow]);

      const { workflowRunId } = await kernel.dispatch({
        type: "run.create",
        idempotencyKey: "key-1",
        workflowId: "parallel-deps",
        input: {},
      });

      await kernel.dispatch({ type: "run.claimPending", workerId: "worker-1" });

      // Execute setup stage
      await kernel.dispatch({
        type: "job.execute",
        workflowRunId,
        workflowId: "parallel-deps",
        stageId: "setup",
        config: {},
      });
      await kernel.dispatch({ type: "run.transition", workflowRunId });

      // Execute all parallel stages
      await kernel.dispatch({
        type: "job.execute",
        workflowRunId,
        workflowId: "parallel-deps",
        stageId: "worker-a",
        config: {},
      });
      await kernel.dispatch({
        type: "job.execute",
        workflowRunId,
        workflowId: "parallel-deps",
        stageId: "worker-b",
        config: {},
      });
      await kernel.dispatch({
        type: "job.execute",
        workflowRunId,
        workflowId: "parallel-deps",
        stageId: "worker-c",
        config: {},
      });
      await kernel.dispatch({ type: "run.transition", workflowRunId });

      // Execute combiner stage
      const rCombiner = await kernel.dispatch({
        type: "job.execute",
        workflowRunId,
        workflowId: "parallel-deps",
        stageId: "combiner",
        config: {},
      });
      await kernel.dispatch({ type: "run.transition", workflowRunId });
      await flush();

      // Then: All parallel outputs were accessible
      expect(capturedParallelOutputs).toEqual({
        setup: { seed: 42 },
        a: { resultA: 84 },
        b: { resultB: 126 },
        c: { resultC: 168 },
      });

      // 42 + 84 + 126 + 168 = 420
      expect(rCombiner.output).toEqual({ total: 420 });
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
          ctx.require("nonexistent" as any);
          return { output: {} };
        },
      });

      const workflow = new WorkflowBuilder(
        "bad-require-test",
        "Bad Require Test",
        "Test",
        z.object({}),
        z.object({}),
      )
        .pipe(stage)
        .build();

      const { kernel } = createTestKernel([workflow]);

      const { workflowRunId } = await kernel.dispatch({
        type: "run.create",
        idempotencyKey: "key-1",
        workflowId: "bad-require-test",
        input: {},
      });

      await kernel.dispatch({ type: "run.claimPending", workerId: "worker-1" });

      // When: Execute the stage that requires a non-existent dependency
      const result = await kernel.dispatch({
        type: "job.execute",
        workflowRunId,
        workflowId: "bad-require-test",
        stageId: "bad-require",
        config: {},
      });

      // Then: job.execute returns failed outcome
      expect(result.outcome).toBe("failed");
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
        "Test",
        z.object({}),
        z.object({ found: z.boolean() }),
      )
        .pipe(stage)
        .build();

      const { kernel, flush } = createTestKernel([workflow]);

      const { workflowRunId } = await kernel.dispatch({
        type: "run.create",
        idempotencyKey: "key-1",
        workflowId: "safe-optional-test",
        input: {},
      });

      await kernel.dispatch({ type: "run.claimPending", workerId: "worker-1" });

      const result = await kernel.dispatch({
        type: "job.execute",
        workflowRunId,
        workflowId: "safe-optional-test",
        stageId: "safe-optional",
        config: {},
      });
      await kernel.dispatch({ type: "run.transition", workflowRunId });
      await flush();

      // Then: ctx.optional returned undefined without throwing
      expect(optionalResult).toBeUndefined();
      expect(result.output).toEqual({ found: false });
    });
  });
});
