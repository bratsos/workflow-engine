/**
 * Context Access Tests
 *
 * Tests for accessing previous stage outputs via workflowContext.
 * Verifies accumulation, non-adjacent access, and typed retrieval.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { WorkflowExecutor } from "../../core/executor";
import { getStageOutput, requireStageOutput } from "../../core/schema-helpers";
import { defineStage } from "../../core/stage-factory";
import { WorkflowBuilder } from "../../core/workflow";
import { InMemoryAICallLogger } from "../utils/in-memory-ai-logger";
import { InMemoryWorkflowPersistence } from "../utils/in-memory-persistence";

describe("I want to access previous stage outputs", () => {
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

      const workflow = new WorkflowBuilder("accumulate", "Test")
        .pipe(stageA)
        .pipe(stageB)
        .pipe(stageC)
        .build();

      // When: Execute
      await createRun("run-1", "accumulate", {});
      const executor = new WorkflowExecutor(workflow, "run-1", "test", {
        persistence,
        aiLogger,
      });

      await executor.execute({}, {});

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

      const workflow = new WorkflowBuilder("progressive", "Test")
        .pipe(createStage("first"))
        .pipe(createStage("second"))
        .pipe(createStage("third"))
        .pipe(createStage("fourth"))
        .build();

      // When: Execute
      await createRun("run-2", "progressive", {});
      const executor = new WorkflowExecutor(workflow, "run-2", "test", {
        persistence,
        aiLogger,
      });

      await executor.execute({}, {});

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
          // Access stage-a output, not the direct input
          aOutputFromD = ctx.workflowContext["stage-a"];
          const aData = ctx.workflowContext["stage-a"] as { important: number };
          return { output: { final: `Got ${aData.important} from A` } };
        },
      });

      const workflow = new WorkflowBuilder("non-adjacent", "Test")
        .pipe(stageA)
        .pipe(stageB)
        .pipe(stageC)
        .pipe(stageD)
        .build();

      // When: Execute
      await createRun("run-3", "non-adjacent", {});
      const executor = new WorkflowExecutor(workflow, "run-3", "test", {
        persistence,
        aiLogger,
      });

      const result = await executor.execute({}, {});

      // Then: D accessed A's output correctly
      expect(aOutputFromD).toEqual({ important: 42 });
      expect(result).toEqual({ final: "Got 42 from A" });
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
          // Use ctx.require with typed context
          retrievedOutput = ctx.require("extract");
          const extracted = ctx.require("extract");
          return { output: { result: `${extracted.data}-${extracted.count}` } };
        },
      });

      const workflow = new WorkflowBuilder("require-test", "Test")
        .pipe(firstStage)
        .pipe(secondStage)
        .build();

      // When: Execute
      await createRun("run-4", "require-test", {});
      const executor = new WorkflowExecutor(workflow, "run-4", "test", {
        persistence,
        aiLogger,
      });

      const result = await executor.execute({}, {});

      // Then: ctx.require returned the correct data
      expect(retrievedOutput).toEqual({ data: "extracted", count: 100 });
      expect(result).toEqual({ result: "extracted-100" });
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
          // Try to require a stage that doesn't exist
          ctx.require("nonexistent" as any);
          return { output: {} };
        },
      });

      const workflow = new WorkflowBuilder("require-missing", "Test")
        .pipe(badStage)
        .build();

      // When/Then: Execution throws
      await createRun("run-5", "require-missing", {});
      const executor = new WorkflowExecutor(workflow, "run-5", "test", {
        persistence,
        aiLogger,
      });

      await expect(executor.execute({}, {})).rejects.toThrow(
        /Missing required stage/,
      );
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

      const workflow = new WorkflowBuilder("optional-missing", "Test")
        .pipe(stage)
        .build();

      // When: Execute
      await createRun("run-6", "optional-missing", {});
      const executor = new WorkflowExecutor(workflow, "run-6", "test", {
        persistence,
        aiLogger,
      });

      const result = await executor.execute({}, {});

      // Then: ctx.optional returned undefined (no throw)
      expect(optionalResult).toBeUndefined();
      expect(result).toEqual({ hasOptional: false });
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

      const workflow = new WorkflowBuilder("optional-exists", "Test")
        .pipe(firstStage)
        .pipe(secondStage)
        .build();

      // When: Execute
      await createRun("run-7", "optional-exists", {});
      const executor = new WorkflowExecutor(workflow, "run-7", "test", {
        persistence,
        aiLogger,
      });

      const result = await executor.execute({}, {});

      // Then: ctx.optional returned the data
      expect(optionalResult).toEqual({ optional: "present" });
      expect(result).toEqual({ found: true, value: "present" });
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
          input: z.object({}),
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
          input: z.object({}),
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

      const workflow = new WorkflowBuilder("parallel-context", "Test")
        .parallel([parallelA, parallelB])
        .pipe(finalStage)
        .build();

      // When: Execute
      await createRun("run-8", "parallel-context", {});
      const executor = new WorkflowExecutor(workflow, "run-8", "test", {
        persistence,
        aiLogger,
      });

      await executor.execute({}, {});

      // Then: Both parallel outputs are in context
      expect(contextAfterParallel).toBeDefined();
      expect(contextAfterParallel!["parallel-a"]).toEqual({ a: 1 });
      expect(contextAfterParallel!["parallel-b"]).toEqual({ b: 2 });
    });
  });
});
