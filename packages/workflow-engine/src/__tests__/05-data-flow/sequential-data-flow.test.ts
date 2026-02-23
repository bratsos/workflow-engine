/**
 * Sequential Data Flow Tests (Kernel)
 *
 * Tests for data flow through sequential workflow stages.
 * Verifies input passing, output chaining, and data transformation.
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

describe("I want data to flow through sequential stages", () => {
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

      const workflow = new WorkflowBuilder(
        "test-workflow",
        "Test",
        "Test",
        z.object({ userId: z.string(), count: z.number() }),
        z.object({ received: z.boolean() }),
      )
        .pipe(firstStage)
        .build();

      const { kernel, flush } = createTestKernel([workflow]);

      const { workflowRunId } = await kernel.dispatch({
        type: "run.create",
        idempotencyKey: "key-1",
        workflowId: "test-workflow",
        input: { userId: "user-123", count: 42 },
      });

      await kernel.dispatch({ type: "run.claimPending", workerId: "worker-1" });

      await kernel.dispatch({
        type: "job.execute",
        workflowRunId,
        workflowId: "test-workflow",
        stageId: "first",
        config: {},
      });
      await kernel.dispatch({ type: "run.transition", workflowRunId });
      await flush();

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

      const workflow = new WorkflowBuilder(
        "validate-test",
        "Test",
        "Test",
        z.object({ name: z.string(), age: z.number() }),
        z.object({ valid: z.boolean() }),
      )
        .pipe(typedStage)
        .build();

      const { kernel, persistence } = createTestKernel([workflow]);

      // Create run manually with invalid input (bypass run.create validation)
      const run = await persistence.createRun({
        workflowId: "validate-test",
        workflowName: "Test",
        workflowType: "validate-test",
        input: { name: 123, age: "invalid" },
      });
      await persistence.updateRun(run.id, { status: "RUNNING" });

      // When: Execute with invalid input
      const result = await kernel.dispatch({
        type: "job.execute",
        workflowRunId: run.id,
        workflowId: "validate-test",
        stageId: "typed",
        config: {},
      });

      // Then: job.execute returns failed outcome
      expect(result.outcome).toBe("failed");
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

      const workflow = new WorkflowBuilder(
        "chain-test",
        "Test",
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
        workflowId: "chain-test",
        input: { initial: "start" },
      });

      await kernel.dispatch({ type: "run.claimPending", workerId: "worker-1" });

      await kernel.dispatch({
        type: "job.execute",
        workflowRunId,
        workflowId: "chain-test",
        stageId: "stage-a",
        config: {},
      });
      await kernel.dispatch({ type: "run.transition", workflowRunId });

      const rB = await kernel.dispatch({
        type: "job.execute",
        workflowRunId,
        workflowId: "chain-test",
        stageId: "stage-b",
        config: {},
      });
      await kernel.dispatch({ type: "run.transition", workflowRunId });
      await flush();

      // Then: Stage B received Stage A's output
      expect(stageAInput).toEqual({ initial: "start" });
      expect(stageBInput).toEqual({ processed: true, value: 100 });
      expect(rB.output).toEqual({ final: "Value was 100" });
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

      const workflow = new WorkflowBuilder(
        "multi-chain",
        "Test",
        "Test",
        z.object({ step: z.number() }),
        z.object({ step: z.number() }),
      )
        .pipe(stageA)
        .pipe(stageB)
        .pipe(stageC)
        .build();

      const { kernel, flush } = createTestKernel([workflow]);

      const { workflowRunId } = await kernel.dispatch({
        type: "run.create",
        idempotencyKey: "key-1",
        workflowId: "multi-chain",
        input: { step: 0 },
      });

      await kernel.dispatch({ type: "run.claimPending", workerId: "worker-1" });

      let lastResult: any;
      for (const stageId of ["a", "b", "c"]) {
        lastResult = await kernel.dispatch({
          type: "job.execute",
          workflowRunId,
          workflowId: "multi-chain",
          stageId,
          config: {},
        });
        await kernel.dispatch({ type: "run.transition", workflowRunId });
      }
      await flush();

      // Then: Each stage received previous stage's output
      expect(inputs).toEqual([
        { stage: "a", input: { step: 0 } },
        { stage: "b", input: { step: 1 } },
        { stage: "c", input: { step: 2 } },
      ]);
      expect(lastResult.output).toEqual({ step: 3 });
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

      const workflow = new WorkflowBuilder(
        "transform-pipeline",
        "Test",
        "Test",
        z.object({ base: z.string() }),
        z.object({ result: z.string() }),
      )
        .pipe(addFieldStage)
        .pipe(modifyStage)
        .pipe(finalizeStage)
        .build();

      const { kernel, flush } = createTestKernel([workflow]);

      const { workflowRunId } = await kernel.dispatch({
        type: "run.create",
        idempotencyKey: "key-1",
        workflowId: "transform-pipeline",
        input: { base: "hello" },
      });

      await kernel.dispatch({ type: "run.claimPending", workerId: "worker-1" });

      let lastResult: any;
      for (const stageId of ["add-field", "modify", "finalize"]) {
        lastResult = await kernel.dispatch({
          type: "job.execute",
          workflowRunId,
          workflowId: "transform-pipeline",
          stageId,
          config: {},
        });
        await kernel.dispatch({ type: "run.transition", workflowRunId });
      }
      await flush();

      // Then: Final output reflects all transformations
      expect(lastResult.output).toEqual({ result: "HELLO-84-true" });
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

      const workflow = new WorkflowBuilder(
        "nested-transform",
        "Test",
        "Test",
        z.object({
          users: z.array(z.object({ name: z.string(), age: z.number() })),
        }),
        z.object({
          count: z.number(),
          avgAge: z.number(),
          allNames: z.string(),
        }),
      )
        .pipe(flattenStage)
        .pipe(summarizeStage)
        .build();

      const { kernel, flush } = createTestKernel([workflow]);

      const input = {
        users: [
          { name: "Alice", age: 30 },
          { name: "Bob", age: 25 },
          { name: "Charlie", age: 35 },
        ],
      };

      const { workflowRunId } = await kernel.dispatch({
        type: "run.create",
        idempotencyKey: "key-1",
        workflowId: "nested-transform",
        input,
      });

      await kernel.dispatch({ type: "run.claimPending", workerId: "worker-1" });

      await kernel.dispatch({
        type: "job.execute",
        workflowRunId,
        workflowId: "nested-transform",
        stageId: "flatten",
        config: {},
      });
      await kernel.dispatch({ type: "run.transition", workflowRunId });

      const rSummarize = await kernel.dispatch({
        type: "job.execute",
        workflowRunId,
        workflowId: "nested-transform",
        stageId: "summarize",
        config: {},
      });
      await kernel.dispatch({ type: "run.transition", workflowRunId });
      await flush();

      // Then: Complex transformation works correctly
      expect(rSummarize.output).toEqual({
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

      const workflow = new WorkflowBuilder(
        "order-test",
        "Test",
        "Test",
        z.object({}),
        z.any(),
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
        workflowId: "order-test",
        input: {},
      });

      await kernel.dispatch({ type: "run.claimPending", workerId: "worker-1" });

      for (const stageId of ["first", "second", "third", "fourth"]) {
        await kernel.dispatch({
          type: "job.execute",
          workflowRunId,
          workflowId: "order-test",
          stageId,
          config: {},
        });
        await kernel.dispatch({ type: "run.transition", workflowRunId });
      }
      await flush();

      // Then: Stages executed in order
      expect(executionOrder).toEqual(["first", "second", "third", "fourth"]);
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

      const workflow = new WorkflowBuilder(
        "final-output",
        "Test",
        "Test",
        z.object({}),
        z.object({ final: z.string(), count: z.number() }),
      )
        .pipe(stageA)
        .pipe(stageB)
        .build();

      const { kernel, flush } = createTestKernel([workflow]);

      const { workflowRunId } = await kernel.dispatch({
        type: "run.create",
        idempotencyKey: "key-1",
        workflowId: "final-output",
        input: {},
      });

      await kernel.dispatch({ type: "run.claimPending", workerId: "worker-1" });

      await kernel.dispatch({
        type: "job.execute",
        workflowRunId,
        workflowId: "final-output",
        stageId: "a",
        config: {},
      });
      await kernel.dispatch({ type: "run.transition", workflowRunId });

      const rB = await kernel.dispatch({
        type: "job.execute",
        workflowRunId,
        workflowId: "final-output",
        stageId: "b",
        config: {},
      });
      await kernel.dispatch({ type: "run.transition", workflowRunId });
      await flush();

      // Then: Only last stage's output is returned
      expect(rB.output).toEqual({
        final: "processed: middle",
        count: 42,
      });
    });
  });
});
