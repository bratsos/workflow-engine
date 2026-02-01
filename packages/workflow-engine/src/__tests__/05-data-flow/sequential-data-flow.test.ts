/**
 * Sequential Data Flow Tests
 *
 * Tests for data flow through sequential workflow stages.
 * Verifies input passing, output chaining, and data transformation.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { z } from "zod";
import { WorkflowBuilder } from "../../core/workflow";
import { WorkflowExecutor } from "../../core/executor";
import { defineStage } from "../../core/stage-factory";
import { InMemoryWorkflowPersistence } from "../utils/in-memory-persistence";
import { InMemoryAICallLogger } from "../utils/in-memory-ai-logger";

describe("I want data to flow through sequential stages", () => {
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

  describe("workflow input to first stage", () => {
    it("should pass workflow input to first stage ctx.input", async () => {
      // Given: A stage that captures its input
      let capturedInput: unknown;

      const firstStage = defineStage({
        id: "first",
        name: "First Stage",
        schemas: {
          input: z.object({ userId: z.string(), count: z.number() }),
          output: z.object({ received: z.boolean() }),
          config: z.object({}),
        },
        async execute(ctx) {
          capturedInput = ctx.input;
          return { output: { received: true } };
        },
      });

      const workflow = new WorkflowBuilder("test-workflow", "Test")
        .pipe(firstStage)
        .build();

      // When: Execute with specific input
      await createRun("run-1", "test-workflow", {
        userId: "user-123",
        count: 42,
      });
      const executor = new WorkflowExecutor(workflow, "run-1", "test", {
        persistence,
        aiLogger,
      });

      await executor.execute({ userId: "user-123", count: 42 }, {});

      // Then: First stage receives the workflow input
      expect(capturedInput).toEqual({ userId: "user-123", count: 42 });
    });

    it("should validate workflow input against first stage schema", async () => {
      // Given: A stage expecting specific input shape
      const typedStage = defineStage({
        id: "typed",
        name: "Typed Stage",
        schemas: {
          input: z.object({ name: z.string(), age: z.number() }),
          output: z.object({ valid: z.boolean() }),
          config: z.object({}),
        },
        async execute() {
          return { output: { valid: true } };
        },
      });

      const workflow = new WorkflowBuilder("validate-test", "Test")
        .pipe(typedStage)
        .build();

      await createRun("run-2", "validate-test", { name: 123, age: "invalid" });
      const executor = new WorkflowExecutor(workflow, "run-2", "test", {
        persistence,
        aiLogger,
      });

      // When/Then: Invalid input throws during stage execution
      // Note: The executor validates input against stage schemas
      await expect(
        executor.execute({ name: 123, age: "invalid" } as any, {}),
      ).rejects.toThrow();
    });
  });

  describe("stage output to next stage input", () => {
    it("should pass stage output as next stage input", async () => {
      // Given: Two stages where A outputs what B expects
      let stageAInput: unknown;
      let stageBInput: unknown;

      const stageA = defineStage({
        id: "stage-a",
        name: "Stage A",
        schemas: {
          input: z.object({ initial: z.string() }),
          output: z.object({ processed: z.boolean(), value: z.number() }),
          config: z.object({}),
        },
        async execute(ctx) {
          stageAInput = ctx.input;
          return { output: { processed: true, value: 100 } };
        },
      });

      const stageB = defineStage({
        id: "stage-b",
        name: "Stage B",
        schemas: {
          input: z.object({ processed: z.boolean(), value: z.number() }),
          output: z.object({ final: z.string() }),
          config: z.object({}),
        },
        async execute(ctx) {
          stageBInput = ctx.input;
          return { output: { final: `Value was ${ctx.input.value}` } };
        },
      });

      const workflow = new WorkflowBuilder("chain-test", "Test")
        .pipe(stageA)
        .pipe(stageB)
        .build();

      // When: Execute the workflow
      await createRun("run-3", "chain-test", { initial: "start" });
      const executor = new WorkflowExecutor(workflow, "run-3", "test", {
        persistence,
        aiLogger,
      });

      const result = await executor.execute({ initial: "start" }, {});

      // Then: Stage B received Stage A's output
      expect(stageAInput).toEqual({ initial: "start" });
      expect(stageBInput).toEqual({ processed: true, value: 100 });
      expect(result).toEqual({ final: "Value was 100" });
    });

    it("should chain through multiple stages", async () => {
      // Given: Three stages that transform data sequentially
      const inputs: unknown[] = [];

      const stageA = defineStage({
        id: "a",
        name: "A",
        schemas: {
          input: z.object({ step: z.number() }),
          output: z.object({ step: z.number() }),
          config: z.object({}),
        },
        async execute(ctx) {
          inputs.push({ stage: "a", input: ctx.input });
          return { output: { step: ctx.input.step + 1 } };
        },
      });

      const stageB = defineStage({
        id: "b",
        name: "B",
        schemas: {
          input: z.object({ step: z.number() }),
          output: z.object({ step: z.number() }),
          config: z.object({}),
        },
        async execute(ctx) {
          inputs.push({ stage: "b", input: ctx.input });
          return { output: { step: ctx.input.step + 1 } };
        },
      });

      const stageC = defineStage({
        id: "c",
        name: "C",
        schemas: {
          input: z.object({ step: z.number() }),
          output: z.object({ step: z.number() }),
          config: z.object({}),
        },
        async execute(ctx) {
          inputs.push({ stage: "c", input: ctx.input });
          return { output: { step: ctx.input.step + 1 } };
        },
      });

      const workflow = new WorkflowBuilder("multi-chain", "Test")
        .pipe(stageA)
        .pipe(stageB)
        .pipe(stageC)
        .build();

      // When: Execute
      await createRun("run-4", "multi-chain", { step: 0 });
      const executor = new WorkflowExecutor(workflow, "run-4", "test", {
        persistence,
        aiLogger,
      });

      const result = await executor.execute({ step: 0 }, {});

      // Then: Each stage received previous stage's output
      expect(inputs).toEqual([
        { stage: "a", input: { step: 0 } },
        { stage: "b", input: { step: 1 } },
        { stage: "c", input: { step: 2 } },
      ]);
      expect(result).toEqual({ step: 3 });
    });
  });

  describe("data transformation pipeline", () => {
    it("should transform data through pipeline", async () => {
      // Given: Stages that add, modify, and remove fields
      const addFieldStage = defineStage({
        id: "add-field",
        name: "Add Field",
        schemas: {
          input: z.object({ base: z.string() }),
          output: z.object({ base: z.string(), added: z.number() }),
          config: z.object({}),
        },
        async execute(ctx) {
          return { output: { base: ctx.input.base, added: 42 } };
        },
      });

      const modifyStage = defineStage({
        id: "modify",
        name: "Modify",
        schemas: {
          input: z.object({ base: z.string(), added: z.number() }),
          output: z.object({
            base: z.string(),
            added: z.number(),
            modified: z.boolean(),
          }),
          config: z.object({}),
        },
        async execute(ctx) {
          return {
            output: {
              base: ctx.input.base.toUpperCase(),
              added: ctx.input.added * 2,
              modified: true,
            },
          };
        },
      });

      const finalizeStage = defineStage({
        id: "finalize",
        name: "Finalize",
        schemas: {
          input: z.object({
            base: z.string(),
            added: z.number(),
            modified: z.boolean(),
          }),
          output: z.object({ result: z.string() }),
          config: z.object({}),
        },
        async execute(ctx) {
          return {
            output: {
              result: `${ctx.input.base}-${ctx.input.added}-${ctx.input.modified}`,
            },
          };
        },
      });

      const workflow = new WorkflowBuilder("transform-pipeline", "Test")
        .pipe(addFieldStage)
        .pipe(modifyStage)
        .pipe(finalizeStage)
        .build();

      // When: Execute
      await createRun("run-5", "transform-pipeline", { base: "hello" });
      const executor = new WorkflowExecutor(workflow, "run-5", "test", {
        persistence,
        aiLogger,
      });

      const result = await executor.execute({ base: "hello" }, {});

      // Then: Final output reflects all transformations
      expect(result).toEqual({ result: "HELLO-84-true" });
    });

    it("should handle complex nested data transformation", async () => {
      // Given: Stages working with nested data structures
      const flattenStage = defineStage({
        id: "flatten",
        name: "Flatten",
        schemas: {
          input: z.object({
            users: z.array(z.object({ name: z.string(), age: z.number() })),
          }),
          output: z.object({
            names: z.array(z.string()),
            ages: z.array(z.number()),
          }),
          config: z.object({}),
        },
        async execute(ctx) {
          return {
            output: {
              names: ctx.input.users.map((u) => u.name),
              ages: ctx.input.users.map((u) => u.age),
            },
          };
        },
      });

      const summarizeStage = defineStage({
        id: "summarize",
        name: "Summarize",
        schemas: {
          input: z.object({
            names: z.array(z.string()),
            ages: z.array(z.number()),
          }),
          output: z.object({
            count: z.number(),
            avgAge: z.number(),
            allNames: z.string(),
          }),
          config: z.object({}),
        },
        async execute(ctx) {
          const sum = ctx.input.ages.reduce((a, b) => a + b, 0);
          return {
            output: {
              count: ctx.input.names.length,
              avgAge: sum / ctx.input.ages.length,
              allNames: ctx.input.names.join(", "),
            },
          };
        },
      });

      const workflow = new WorkflowBuilder("nested-transform", "Test")
        .pipe(flattenStage)
        .pipe(summarizeStage)
        .build();

      // When: Execute with nested input
      const input = {
        users: [
          { name: "Alice", age: 30 },
          { name: "Bob", age: 25 },
          { name: "Charlie", age: 35 },
        ],
      };
      await createRun("run-6", "nested-transform", input);
      const executor = new WorkflowExecutor(workflow, "run-6", "test", {
        persistence,
        aiLogger,
      });

      const result = await executor.execute(
        {
          users: [
            { name: "Alice", age: 30 },
            { name: "Bob", age: 25 },
            { name: "Charlie", age: 35 },
          ],
        },
        {},
      );

      // Then: Complex transformation works correctly
      expect(result).toEqual({
        count: 3,
        avgAge: 30,
        allNames: "Alice, Bob, Charlie",
      });
    });
  });

  describe("execution order verification", () => {
    it("should execute stages in definition order", async () => {
      // Given: Stages that record execution order
      const executionOrder: string[] = [];

      const createStage = (id: string) =>
        defineStage({
          id,
          name: id,
          schemas: {
            input: z.object({}).passthrough(),
            output: z.object({}).passthrough(),
            config: z.object({}),
          },
          async execute(ctx) {
            executionOrder.push(id);
            return { output: { ...ctx.input, [id]: true } };
          },
        });

      const workflow = new WorkflowBuilder("order-test", "Test")
        .pipe(createStage("first"))
        .pipe(createStage("second"))
        .pipe(createStage("third"))
        .pipe(createStage("fourth"))
        .build();

      // When: Execute
      await createRun("run-7", "order-test", {});
      const executor = new WorkflowExecutor(workflow, "run-7", "test", {
        persistence,
        aiLogger,
      });

      await executor.execute({}, {});

      // Then: Stages executed in order
      expect(executionOrder).toEqual(["first", "second", "third", "fourth"]);
    });

    it("should wait for each stage to complete before next", async () => {
      // Given: Stages with delays that record timing
      const timestamps: { stage: string; start: number; end: number }[] = [];

      const createSlowStage = (id: string, delayMs: number) =>
        defineStage({
          id,
          name: id,
          schemas: {
            input: z.any(),
            output: z.any(),
            config: z.object({}),
          },
          async execute(ctx) {
            const start = Date.now();
            await new Promise((resolve) => setTimeout(resolve, delayMs));
            const end = Date.now();
            timestamps.push({ stage: id, start, end });
            return { output: ctx.input };
          },
        });

      const workflow = new WorkflowBuilder("timing-test", "Test")
        .pipe(createSlowStage("slow-1", 50))
        .pipe(createSlowStage("slow-2", 50))
        .build();

      // When: Execute
      await createRun("run-8", "timing-test", {});
      const executor = new WorkflowExecutor(workflow, "run-8", "test", {
        persistence,
        aiLogger,
      });

      await executor.execute({}, {});

      // Then: Second stage started after first ended
      expect(timestamps).toHaveLength(2);
      expect(timestamps[1].start).toBeGreaterThanOrEqual(timestamps[0].end);
    });
  });

  describe("final workflow output", () => {
    it("should return last stage output as workflow result", async () => {
      // Given: A workflow where only the last stage output matters
      const stageA = defineStage({
        id: "a",
        name: "A",
        schemas: {
          input: z.object({}),
          output: z.object({ intermediate: z.string() }),
          config: z.object({}),
        },
        async execute() {
          return { output: { intermediate: "middle" } };
        },
      });

      const stageB = defineStage({
        id: "b",
        name: "B",
        schemas: {
          input: z.object({ intermediate: z.string() }),
          output: z.object({ final: z.string(), count: z.number() }),
          config: z.object({}),
        },
        async execute(ctx) {
          return {
            output: {
              final: `processed: ${ctx.input.intermediate}`,
              count: 42,
            },
          };
        },
      });

      const workflow = new WorkflowBuilder("final-output", "Test")
        .pipe(stageA)
        .pipe(stageB)
        .build();

      // When: Execute
      await createRun("run-9", "final-output", {});
      const executor = new WorkflowExecutor(workflow, "run-9", "test", {
        persistence,
        aiLogger,
      });

      const result = await executor.execute({}, {});

      // Then: Only last stage's output is returned
      expect(result).toEqual({
        final: "processed: middle",
        count: 42,
      });
    });
  });
});
