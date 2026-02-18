/**
 * Context Access Tests (Kernel)
 *
 * Tests for accessing previous stage outputs via workflowContext.
 * Verifies accumulation, non-adjacent access, and typed retrieval.
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
import {
  getStageOutput,
  requireStageOutput,
} from "../../core/schema-helpers.js";

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

describe("I want to access previous stage outputs", () => {
  describe("workflowContext accumulation", () => {
    it("should accumulate all outputs in workflowContext", async () => {
      // Given: Three sequential stages
      let contextAtC: Record<string, unknown> | undefined;

      const stageA = defineStage({
        id: "stage-a",
        name: "Stage A",
        schemas: {
          input: z.object({}),
          output: z.object({ fromA: z.string() }),
          config: z.object({}),
        },
        async execute() {
          return { output: { fromA: "a-output" } };
        },
      });

      const stageB = defineStage({
        id: "stage-b",
        name: "Stage B",
        schemas: {
          input: z.object({ fromA: z.string() }),
          output: z.object({ fromB: z.string() }),
          config: z.object({}),
        },
        async execute() {
          return { output: { fromB: "b-output" } };
        },
      });

      const stageC = defineStage({
        id: "stage-c",
        name: "Stage C",
        schemas: {
          input: z.object({ fromB: z.string() }),
          output: z.object({ fromC: z.string() }),
          config: z.object({}),
        },
        async execute(ctx) {
          contextAtC = { ...ctx.workflowContext };
          return { output: { fromC: "c-output" } };
        },
      });

      const workflow = new WorkflowBuilder(
        "accumulate",
        "Test",
        "Test",
        z.object({}),
        z.object({ fromC: z.string() }),
      )
        .pipe(stageA)
        .pipe(stageB)
        .pipe(stageC)
        .build();

      const { kernel, flush } = createTestKernel([workflow]);

      // When: Execute via kernel dispatch
      const { workflowRunId } = await kernel.dispatch({
        type: "run.create",
        idempotencyKey: "key-1",
        workflowId: "accumulate",
        input: {},
      });

      await kernel.dispatch({ type: "run.claimPending", workerId: "worker-1" });

      await kernel.dispatch({
        type: "job.execute",
        workflowRunId,
        workflowId: "accumulate",
        stageId: "stage-a",
        config: {},
      });
      await kernel.dispatch({ type: "run.transition", workflowRunId });

      await kernel.dispatch({
        type: "job.execute",
        workflowRunId,
        workflowId: "accumulate",
        stageId: "stage-b",
        config: {},
      });
      await kernel.dispatch({ type: "run.transition", workflowRunId });

      await kernel.dispatch({
        type: "job.execute",
        workflowRunId,
        workflowId: "accumulate",
        stageId: "stage-c",
        config: {},
      });
      await kernel.dispatch({ type: "run.transition", workflowRunId });
      await flush();

      // Then: C has access to both A and B outputs
      expect(contextAtC).toBeDefined();
      expect(contextAtC!["stage-a"]).toEqual({ fromA: "a-output" });
      expect(contextAtC!["stage-b"]).toEqual({ fromB: "b-output" });
    });

    it("should add outputs progressively as stages complete", async () => {
      // Given: Stages that record context size at each step
      const contextSizes: { stage: string; size: number }[] = [];

      const createStage = (id: string) =>
        defineStage({
          id,
          name: id,
          schemas: {
            input: z.any(),
            output: z.object({ id: z.string() }),
            config: z.object({}),
          },
          async execute(ctx) {
            contextSizes.push({
              stage: id,
              size: Object.keys(ctx.workflowContext).length,
            });
            return { output: { id } };
          },
        });

      const workflow = new WorkflowBuilder(
        "progressive",
        "Test",
        "Test",
        z.object({}),
        z.object({ id: z.string() }),
      )
        .pipe(createStage("first"))
        .pipe(createStage("second"))
        .pipe(createStage("third"))
        .pipe(createStage("fourth"))
        .build();

      const { kernel, flush } = createTestKernel([workflow]);

      const { workflowRunId } = await kernel.dispatch({
        type: "run.create",
        idempotencyKey: "key-1",
        workflowId: "progressive",
        input: {},
      });

      await kernel.dispatch({ type: "run.claimPending", workerId: "worker-1" });

      for (const stageId of ["first", "second", "third", "fourth"]) {
        await kernel.dispatch({
          type: "job.execute",
          workflowRunId,
          workflowId: "progressive",
          stageId,
          config: {},
        });
        await kernel.dispatch({ type: "run.transition", workflowRunId });
      }
      await flush();

      // Then: Each stage sees more context than the previous
      expect(contextSizes).toEqual([
        { stage: "first", size: 0 },
        { stage: "second", size: 1 },
        { stage: "third", size: 2 },
        { stage: "fourth", size: 3 },
      ]);
    });
  });

  describe("non-adjacent stage access", () => {
    it("should access non-adjacent stage output", async () => {
      // Given: Stage D needs Stage A output (not directly before)
      let aOutputFromD: unknown;

      const stageA = defineStage({
        id: "stage-a",
        name: "Stage A",
        schemas: {
          input: z.object({}),
          output: z.object({ important: z.number() }),
          config: z.object({}),
        },
        async execute() {
          return { output: { important: 42 } };
        },
      });

      const stageB = defineStage({
        id: "stage-b",
        name: "Stage B",
        schemas: {
          input: z.object({ important: z.number() }),
          output: z.object({ intermediate: z.string() }),
          config: z.object({}),
        },
        async execute() {
          return { output: { intermediate: "b-result" } };
        },
      });

      const stageC = defineStage({
        id: "stage-c",
        name: "Stage C",
        schemas: {
          input: z.object({ intermediate: z.string() }),
          output: z.object({ another: z.boolean() }),
          config: z.object({}),
        },
        async execute() {
          return { output: { another: true } };
        },
      });

      const stageD = defineStage({
        id: "stage-d",
        name: "Stage D",
        schemas: {
          input: z.object({ another: z.boolean() }),
          output: z.object({ final: z.string() }),
          config: z.object({}),
        },
        async execute(ctx) {
          aOutputFromD = ctx.workflowContext["stage-a"];
          const aData = ctx.workflowContext["stage-a"] as { important: number };
          return { output: { final: `Got ${aData.important} from A` } };
        },
      });

      const workflow = new WorkflowBuilder(
        "non-adjacent",
        "Test",
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
        workflowId: "non-adjacent",
        input: {},
      });

      await kernel.dispatch({ type: "run.claimPending", workerId: "worker-1" });

      for (const stageId of ["stage-a", "stage-b", "stage-c", "stage-d"]) {
        await kernel.dispatch({
          type: "job.execute",
          workflowRunId,
          workflowId: "non-adjacent",
          stageId,
          config: {},
        });
        await kernel.dispatch({ type: "run.transition", workflowRunId });
      }
      await flush();

      // Then: D accessed A's output correctly
      expect(aOutputFromD).toEqual({ important: 42 });
    });
  });

  describe("ctx.require helper", () => {
    it("should return typed output for existing stage", async () => {
      // Given: A stage that uses ctx.require
      let retrievedOutput: unknown;

      const firstStage = defineStage({
        id: "extract",
        name: "Extract",
        schemas: {
          input: z.object({}),
          output: z.object({ data: z.string(), count: z.number() }),
          config: z.object({}),
        },
        async execute() {
          return { output: { data: "extracted", count: 100 } };
        },
      });

      type ExtractContext = {
        extract: { data: string; count: number };
      };

      const secondStage = defineStage<
        z.ZodObject<{ data: z.ZodString; count: z.ZodNumber }>,
        z.ZodObject<{ result: z.ZodString }>,
        z.ZodObject<{}>,
        ExtractContext
      >({
        id: "process",
        name: "Process",
        schemas: {
          input: z.object({ data: z.string(), count: z.number() }),
          output: z.object({ result: z.string() }),
          config: z.object({}),
        },
        async execute(ctx) {
          retrievedOutput = ctx.require("extract");
          const extracted = ctx.require("extract");
          return { output: { result: `${extracted.data}-${extracted.count}` } };
        },
      });

      const workflow = new WorkflowBuilder(
        "require-test",
        "Test",
        "Test",
        z.object({}),
        z.object({ result: z.string() }),
      )
        .pipe(firstStage)
        .pipe(secondStage)
        .build();

      const { kernel, flush } = createTestKernel([workflow]);

      const { workflowRunId } = await kernel.dispatch({
        type: "run.create",
        idempotencyKey: "key-1",
        workflowId: "require-test",
        input: {},
      });

      await kernel.dispatch({ type: "run.claimPending", workerId: "worker-1" });

      await kernel.dispatch({
        type: "job.execute",
        workflowRunId,
        workflowId: "require-test",
        stageId: "extract",
        config: {},
      });
      await kernel.dispatch({ type: "run.transition", workflowRunId });

      const r2 = await kernel.dispatch({
        type: "job.execute",
        workflowRunId,
        workflowId: "require-test",
        stageId: "process",
        config: {},
      });
      await kernel.dispatch({ type: "run.transition", workflowRunId });
      await flush();

      // Then: ctx.require returned the correct data
      expect(retrievedOutput).toEqual({ data: "extracted", count: 100 });
      expect(r2.output).toEqual({ result: "extracted-100" });
    });

    it("should throw for missing required stage", async () => {
      // Given: A stage that requires a non-existent stage
      const badStage = defineStage({
        id: "bad",
        name: "Bad",
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
        "require-missing",
        "Test",
        "Test",
        z.object({}),
        z.object({}),
      )
        .pipe(badStage)
        .build();

      const { kernel, flush } = createTestKernel([workflow]);

      const { workflowRunId } = await kernel.dispatch({
        type: "run.create",
        idempotencyKey: "key-1",
        workflowId: "require-missing",
        input: {},
      });

      await kernel.dispatch({ type: "run.claimPending", workerId: "worker-1" });

      // When: Execute the stage that requires a non-existent stage
      const result = await kernel.dispatch({
        type: "job.execute",
        workflowRunId,
        workflowId: "require-missing",
        stageId: "bad",
        config: {},
      });

      // Then: job.execute returns failed outcome (kernel catches stage errors)
      expect(result.outcome).toBe("failed");
    });
  });

  describe("ctx.optional helper", () => {
    it("should return undefined for missing optional stage", async () => {
      // Given: A stage that uses ctx.optional for non-existent stage
      let optionalResult: unknown = "not-set";

      const stage = defineStage({
        id: "check-optional",
        name: "Check Optional",
        schemas: {
          input: z.object({}),
          output: z.object({ hasOptional: z.boolean() }),
          config: z.object({}),
        },
        async execute(ctx) {
          optionalResult = ctx.optional("maybe-stage" as any);
          return { output: { hasOptional: optionalResult !== undefined } };
        },
      });

      const workflow = new WorkflowBuilder(
        "optional-missing",
        "Test",
        "Test",
        z.object({}),
        z.object({ hasOptional: z.boolean() }),
      )
        .pipe(stage)
        .build();

      const { kernel, flush } = createTestKernel([workflow]);

      const { workflowRunId } = await kernel.dispatch({
        type: "run.create",
        idempotencyKey: "key-1",
        workflowId: "optional-missing",
        input: {},
      });

      await kernel.dispatch({ type: "run.claimPending", workerId: "worker-1" });

      const result = await kernel.dispatch({
        type: "job.execute",
        workflowRunId,
        workflowId: "optional-missing",
        stageId: "check-optional",
        config: {},
      });
      await kernel.dispatch({ type: "run.transition", workflowRunId });
      await flush();

      // Then: ctx.optional returned undefined (no throw)
      expect(optionalResult).toBeUndefined();
      expect(result.output).toEqual({ hasOptional: false });
    });

    it("should return typed data for existing optional stage", async () => {
      // Given: A stage that uses ctx.optional for an existing stage
      let optionalResult: unknown;

      const firstStage = defineStage({
        id: "optional-source",
        name: "Optional Source",
        schemas: {
          input: z.object({}),
          output: z.object({ optional: z.string() }),
          config: z.object({}),
        },
        async execute() {
          return { output: { optional: "present" } };
        },
      });

      type OptionalContext = {
        "optional-source": { optional: string };
      };

      const secondStage = defineStage<
        z.ZodObject<{ optional: z.ZodString }>,
        z.ZodObject<{ found: z.ZodBoolean; value: z.ZodString }>,
        z.ZodObject<{}>,
        OptionalContext
      >({
        id: "check",
        name: "Check",
        schemas: {
          input: z.object({ optional: z.string() }),
          output: z.object({ found: z.boolean(), value: z.string() }),
          config: z.object({}),
        },
        async execute(ctx) {
          optionalResult = ctx.optional("optional-source");
          const data = ctx.optional("optional-source");
          return {
            output: {
              found: data !== undefined,
              value: data?.optional ?? "missing",
            },
          };
        },
      });

      const workflow = new WorkflowBuilder(
        "optional-exists",
        "Test",
        "Test",
        z.object({}),
        z.object({ found: z.boolean(), value: z.string() }),
      )
        .pipe(firstStage)
        .pipe(secondStage)
        .build();

      const { kernel, flush } = createTestKernel([workflow]);

      const { workflowRunId } = await kernel.dispatch({
        type: "run.create",
        idempotencyKey: "key-1",
        workflowId: "optional-exists",
        input: {},
      });

      await kernel.dispatch({ type: "run.claimPending", workerId: "worker-1" });

      await kernel.dispatch({
        type: "job.execute",
        workflowRunId,
        workflowId: "optional-exists",
        stageId: "optional-source",
        config: {},
      });
      await kernel.dispatch({ type: "run.transition", workflowRunId });

      const r2 = await kernel.dispatch({
        type: "job.execute",
        workflowRunId,
        workflowId: "optional-exists",
        stageId: "check",
        config: {},
      });
      await kernel.dispatch({ type: "run.transition", workflowRunId });
      await flush();

      // Then: ctx.optional returned the data
      expect(optionalResult).toEqual({ optional: "present" });
      expect(r2.output).toEqual({ found: true, value: "present" });
    });
  });

  describe("requireStageOutput helper function", () => {
    it("should get entire stage output", () => {
      // Given: A workflow context with stage outputs
      const workflowContext = {
        "data-extraction": { items: ["a", "b", "c"], count: 3 },
        validation: { valid: true },
      };

      // When: Using requireStageOutput
      const result = requireStageOutput<{ items: string[]; count: number }>(
        workflowContext,
        "data-extraction",
      );

      // Then: Returns the full output
      expect(result).toEqual({ items: ["a", "b", "c"], count: 3 });
    });

    it("should get specific field from stage output", () => {
      // Given: A workflow context with nested data
      const workflowContext = {
        guidelines: { guidelines: ["rule1", "rule2"], version: 1 },
      };

      // When: Using requireStageOutput with field
      const guidelines = requireStageOutput<string[]>(
        workflowContext,
        "guidelines",
        "guidelines",
      );

      // Then: Returns just the field
      expect(guidelines).toEqual(["rule1", "rule2"]);
    });

    it("should throw for missing stage", () => {
      // Given: Empty context
      const workflowContext = {};

      // When/Then: Throws with helpful error
      expect(() => requireStageOutput(workflowContext, "nonexistent")).toThrow(
        /Missing output from required stage: nonexistent/,
      );
    });

    it("should throw for missing field", () => {
      // Given: Stage output without requested field
      const workflowContext = {
        myStage: { existing: "value" },
      };

      // When/Then: Throws with available fields
      expect(() =>
        requireStageOutput(workflowContext, "myStage", "nonexistent"),
      ).toThrow(/Missing required field 'nonexistent'/);
    });
  });

  describe("getStageOutput helper function", () => {
    it("should return undefined for missing stage", () => {
      // Given: Empty context
      const workflowContext = {};

      // When: Using getStageOutput
      const result = getStageOutput(workflowContext, "missing");

      // Then: Returns undefined
      expect(result).toBeUndefined();
    });

    it("should return undefined for missing field", () => {
      // Given: Stage output without requested field
      const workflowContext = {
        myStage: { existing: "value" },
      };

      // When: Using getStageOutput with missing field
      const result = getStageOutput(workflowContext, "myStage", "nonexistent");

      // Then: Returns undefined
      expect(result).toBeUndefined();
    });

    it("should return data when present", () => {
      // Given: Complete context
      const workflowContext = {
        source: { data: [1, 2, 3] },
      };

      // When: Using getStageOutput
      const result = getStageOutput<{ data: number[] }>(
        workflowContext,
        "source",
      );

      // Then: Returns the data
      expect(result).toEqual({ data: [1, 2, 3] });
    });
  });

  describe("context with parallel stages", () => {
    it("should include all parallel stage outputs in context", async () => {
      // Given: Parallel stages followed by a stage that checks context
      let contextAfterParallel: Record<string, unknown> | undefined;

      const parallelA = defineStage({
        id: "parallel-a",
        name: "Parallel A",
        schemas: {
          input: z.object({}).passthrough(),
          output: z.object({ a: z.number() }),
          config: z.object({}),
        },
        async execute() {
          return { output: { a: 1 } };
        },
      });

      const parallelB = defineStage({
        id: "parallel-b",
        name: "Parallel B",
        schemas: {
          input: z.object({}).passthrough(),
          output: z.object({ b: z.number() }),
          config: z.object({}),
        },
        async execute() {
          return { output: { b: 2 } };
        },
      });

      const finalStage = defineStage({
        id: "final",
        name: "Final",
        schemas: {
          input: z.object({}).passthrough(),
          output: z.object({ done: z.boolean() }),
          config: z.object({}),
        },
        async execute(ctx) {
          contextAfterParallel = { ...ctx.workflowContext };
          return { output: { done: true } };
        },
      });

      const workflow = new WorkflowBuilder(
        "parallel-context",
        "Test",
        "Test",
        z.object({}),
        z.object({ done: z.boolean() }),
      )
        .parallel([parallelA, parallelB])
        .pipe(finalStage)
        .build();

      const { kernel, flush } = createTestKernel([workflow]);

      const { workflowRunId } = await kernel.dispatch({
        type: "run.create",
        idempotencyKey: "key-1",
        workflowId: "parallel-context",
        input: {},
      });

      await kernel.dispatch({ type: "run.claimPending", workerId: "worker-1" });

      // Execute both parallel stages
      await kernel.dispatch({
        type: "job.execute",
        workflowRunId,
        workflowId: "parallel-context",
        stageId: "parallel-a",
        config: {},
      });
      await kernel.dispatch({
        type: "job.execute",
        workflowRunId,
        workflowId: "parallel-context",
        stageId: "parallel-b",
        config: {},
      });

      // One transition after parallel group
      await kernel.dispatch({ type: "run.transition", workflowRunId });

      // Execute final stage
      await kernel.dispatch({
        type: "job.execute",
        workflowRunId,
        workflowId: "parallel-context",
        stageId: "final",
        config: {},
      });
      await kernel.dispatch({ type: "run.transition", workflowRunId });
      await flush();

      // Then: Both parallel outputs are in context
      expect(contextAfterParallel).toBeDefined();
      expect(contextAfterParallel!["parallel-a"]).toEqual({ a: 1 });
      expect(contextAfterParallel!["parallel-b"]).toEqual({ b: 2 });
    });
  });
});
