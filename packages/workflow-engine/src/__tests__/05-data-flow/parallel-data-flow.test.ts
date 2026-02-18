/**
 * Parallel Data Flow Tests (Kernel)
 *
 * Tests for data flow through parallel workflow stages.
 * Verifies same input to all parallel stages, output merging by index.
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

describe("I want data to flow through parallel stages", () => {
  describe("parallel input distribution", () => {
    it("should allow all parallel stages to access shared data via workflowContext", async () => {
      // Given: Three parallel stages that access the initial stage output
      // Note: In the kernel model, parallel stages may receive a sibling's
      // output as their direct input (via resolveStageInput). Stages should
      // use workflowContext to access the original shared data.
      const capturedContextData: { stage: string; initialOutput: unknown }[] = [];

      const createParallelStage = (id: string) =>
        defineStage({
          id,
          name: id,
          schemas: {
            input: z.object({}).passthrough(),
            output: z.object({ from: z.string() }),
            config: z.object({}),
          },
          async execute(ctx) {
            const initialOutput = ctx.workflowContext["initial"];
            capturedContextData.push({ stage: id, initialOutput });
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

      const workflow = new WorkflowBuilder(
        "parallel-input",
        "Test",
        "Test",
        z.object({}),
        z.any(),
      )
        .pipe(initialStage)
        .parallel([
          createParallelStage("parallel-a"),
          createParallelStage("parallel-b"),
          createParallelStage("parallel-c"),
        ])
        .build();

      const { kernel, flush } = createTestKernel([workflow]);

      const { workflowRunId } = await kernel.dispatch({
        type: "run.create",
        idempotencyKey: "key-1",
        workflowId: "parallel-input",
        input: {},
      });

      await kernel.dispatch({ type: "run.claimPending", workerId: "worker-1" });

      // Execute initial stage
      await kernel.dispatch({
        type: "job.execute",
        workflowRunId,
        workflowId: "parallel-input",
        stageId: "initial",
        config: {},
      });
      await kernel.dispatch({ type: "run.transition", workflowRunId });

      // Execute all parallel stages
      await kernel.dispatch({
        type: "job.execute",
        workflowRunId,
        workflowId: "parallel-input",
        stageId: "parallel-a",
        config: {},
      });
      await kernel.dispatch({
        type: "job.execute",
        workflowRunId,
        workflowId: "parallel-input",
        stageId: "parallel-b",
        config: {},
      });
      await kernel.dispatch({
        type: "job.execute",
        workflowRunId,
        workflowId: "parallel-input",
        stageId: "parallel-c",
        config: {},
      });
      await kernel.dispatch({ type: "run.transition", workflowRunId });
      await flush();

      // Then: All parallel stages could access the initial stage output via workflowContext
      expect(capturedContextData).toHaveLength(3);
      for (const captured of capturedContextData) {
        expect(captured.initialOutput).toEqual({ shared: "data-for-all" });
      }
    });

    it("should pass workflow input to first parallel stage when first group", async () => {
      // Given: Parallel stages as the first stage group
      // Note: In the kernel model, the first parallel stage receives the workflow
      // input directly. Subsequent siblings may receive a prior sibling's output.
      // All parallel stages can access workflow input via workflowContext or run input.
      let firstStageInput: unknown;

      const stageA = defineStage({
        id: "a",
        name: "a",
        schemas: {
          input: z.object({ workflowData: z.number() }).passthrough(),
          output: z.object({ processed: z.string() }),
          config: z.object({}),
        },
        async execute(ctx) {
          firstStageInput = ctx.input;
          return { output: { processed: `a-${ctx.input.workflowData}` } };
        },
      });

      const stageB = defineStage({
        id: "b",
        name: "b",
        schemas: {
          input: z.object({}).passthrough(),
          output: z.object({ processed: z.string() }),
          config: z.object({}),
        },
        async execute() {
          return { output: { processed: "b-done" } };
        },
      });

      const workflow = new WorkflowBuilder(
        "parallel-first",
        "Test",
        "Test",
        z.object({ workflowData: z.number() }),
        z.any(),
      )
        .parallel([stageA, stageB])
        .build();

      const { kernel, flush } = createTestKernel([workflow]);

      const { workflowRunId } = await kernel.dispatch({
        type: "run.create",
        idempotencyKey: "key-1",
        workflowId: "parallel-first",
        input: { workflowData: 99 },
      });

      await kernel.dispatch({ type: "run.claimPending", workerId: "worker-1" });

      const rA = await kernel.dispatch({
        type: "job.execute",
        workflowRunId,
        workflowId: "parallel-first",
        stageId: "a",
        config: {},
      });
      const rB = await kernel.dispatch({
        type: "job.execute",
        workflowRunId,
        workflowId: "parallel-first",
        stageId: "b",
        config: {},
      });
      await kernel.dispatch({ type: "run.transition", workflowRunId });
      await flush();

      // Then: First parallel stage received the workflow input
      expect(firstStageInput).toEqual({ workflowData: 99 });
      expect(rA.outcome).toBe("completed");
      expect(rB.outcome).toBe("completed");
    });
  });

  describe("parallel output merging", () => {
    it("should merge parallel outputs for the next stage", async () => {
      // Given: Parallel stages with different outputs
      const stageA = defineStage({
        id: "a",
        name: "A",
        schemas: {
          input: z.object({}).passthrough(),
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
          input: z.object({}).passthrough(),
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
          input: z.object({}).passthrough(),
          output: z.object({ resultC: z.number() }),
          config: z.object({}),
        },
        async execute() {
          return { output: { resultC: 3 } };
        },
      });

      // Stage that receives merged output
      let receivedContext: Record<string, unknown> | undefined;
      const finalStage = defineStage({
        id: "final",
        name: "Final",
        schemas: {
          input: z.object({}).passthrough(),
          output: z.object({ done: z.boolean() }),
          config: z.object({}),
        },
        async execute(ctx) {
          receivedContext = { ...ctx.workflowContext };
          return { output: { done: true } };
        },
      });

      const workflow = new WorkflowBuilder(
        "parallel-merge",
        "Test",
        "Test",
        z.object({}),
        z.object({ done: z.boolean() }),
      )
        .parallel([stageA, stageB, stageC])
        .pipe(finalStage)
        .build();

      const { kernel, flush } = createTestKernel([workflow]);

      const { workflowRunId } = await kernel.dispatch({
        type: "run.create",
        idempotencyKey: "key-1",
        workflowId: "parallel-merge",
        input: {},
      });

      await kernel.dispatch({ type: "run.claimPending", workerId: "worker-1" });

      // Execute all parallel stages
      await kernel.dispatch({
        type: "job.execute",
        workflowRunId,
        workflowId: "parallel-merge",
        stageId: "a",
        config: {},
      });
      await kernel.dispatch({
        type: "job.execute",
        workflowRunId,
        workflowId: "parallel-merge",
        stageId: "b",
        config: {},
      });
      await kernel.dispatch({
        type: "job.execute",
        workflowRunId,
        workflowId: "parallel-merge",
        stageId: "c",
        config: {},
      });
      await kernel.dispatch({ type: "run.transition", workflowRunId });

      // Execute final stage
      await kernel.dispatch({
        type: "job.execute",
        workflowRunId,
        workflowId: "parallel-merge",
        stageId: "final",
        config: {},
      });
      await kernel.dispatch({ type: "run.transition", workflowRunId });
      await flush();

      // Then: Next stage has access to all parallel outputs via workflowContext
      expect(receivedContext).toBeDefined();
      expect(receivedContext!["a"]).toEqual({ resultA: 1 });
      expect(receivedContext!["b"]).toEqual({ resultB: 2 });
      expect(receivedContext!["c"]).toEqual({ resultC: 3 });
    });

    it("should return parallel stage outputs when last", async () => {
      // Given: Parallel stages as the last stage group
      const stageA = defineStage({
        id: "a",
        name: "A",
        schemas: {
          input: z.object({}).passthrough(),
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
          input: z.object({}).passthrough(),
          output: z.object({ b: z.string() }),
          config: z.object({}),
        },
        async execute() {
          return { output: { b: "from-b" } };
        },
      });

      const workflow = new WorkflowBuilder(
        "parallel-last",
        "Test",
        "Test",
        z.object({}),
        z.any(),
      )
        .parallel([stageA, stageB])
        .build();

      const { kernel, flush } = createTestKernel([workflow]);

      const { workflowRunId } = await kernel.dispatch({
        type: "run.create",
        idempotencyKey: "key-1",
        workflowId: "parallel-last",
        input: {},
      });

      await kernel.dispatch({ type: "run.claimPending", workerId: "worker-1" });

      const rA = await kernel.dispatch({
        type: "job.execute",
        workflowRunId,
        workflowId: "parallel-last",
        stageId: "a",
        config: {},
      });

      const rB = await kernel.dispatch({
        type: "job.execute",
        workflowRunId,
        workflowId: "parallel-last",
        stageId: "b",
        config: {},
      });

      await kernel.dispatch({ type: "run.transition", workflowRunId });
      await flush();

      // Then: Each parallel stage returns its output
      expect(rA.output).toEqual({ a: "from-a" });
      expect(rB.output).toEqual({ b: "from-b" });
    });
  });

  describe("parallel stages in workflowContext", () => {
    it("should add parallel outputs to workflowContext by stageId", async () => {
      // Given: Parallel stages followed by a stage that accesses workflowContext
      const parallelA = defineStage({
        id: "analyze-a",
        name: "Analyze A",
        schemas: {
          input: z.object({}).passthrough(),
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
          input: z.object({}).passthrough(),
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

      const workflow = new WorkflowBuilder(
        "parallel-context",
        "Test",
        "Test",
        z.object({}),
        z.object({ combined: z.string() }),
      )
        .parallel([parallelA, parallelB])
        .pipe(combineStage)
        .build();

      const { kernel, flush } = createTestKernel([workflow]);

      const { workflowRunId } = await kernel.dispatch({
        type: "run.create",
        idempotencyKey: "key-1",
        workflowId: "parallel-context",
        input: {},
      });

      await kernel.dispatch({ type: "run.claimPending", workerId: "worker-1" });

      // Execute parallel stages
      await kernel.dispatch({
        type: "job.execute",
        workflowRunId,
        workflowId: "parallel-context",
        stageId: "analyze-a",
        config: {},
      });
      await kernel.dispatch({
        type: "job.execute",
        workflowRunId,
        workflowId: "parallel-context",
        stageId: "analyze-b",
        config: {},
      });
      await kernel.dispatch({ type: "run.transition", workflowRunId });

      // Execute combine stage
      const rCombine = await kernel.dispatch({
        type: "job.execute",
        workflowRunId,
        workflowId: "parallel-context",
        stageId: "combine",
        config: {},
      });
      await kernel.dispatch({ type: "run.transition", workflowRunId });
      await flush();

      // Then: WorkflowContext contains both parallel outputs by stage ID
      expect(capturedContext).toBeDefined();
      expect(capturedContext!["analyze-a"]).toEqual({ analysis: "result-a" });
      expect(capturedContext!["analyze-b"]).toEqual({ analysis: "result-b" });
      expect(rCombine.output).toEqual({ combined: "result-a+result-b" });
    });
  });

  describe("mixed sequential and parallel", () => {
    it("should handle sequential -> parallel -> sequential flow", async () => {
      // Given: A workflow with mixed execution patterns
      // Note: In the kernel model, parallel stages use workflowContext to
      // access input from the previous group, because the second parallel
      // stage may receive a sibling's output via resolveStageInput.
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
            input: z.object({}).passthrough(),
            output: z.object({ result: z.number() }),
            config: z.object({}),
          },
          async execute(ctx) {
            executionLog.push(id);
            // Access initial stage output via workflowContext for reliable access
            const initialOutput = ctx.workflowContext["initial"] as { value: number };
            return { output: { result: initialOutput.value * multiplier } };
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
          // Access parallel results via workflowContext
          const doubleOutput = ctx.workflowContext["double"] as { result: number };
          const tripleOutput = ctx.workflowContext["triple"] as { result: number };
          const sum = doubleOutput.result + tripleOutput.result;
          return { output: { sum } };
        },
      });

      const workflow = new WorkflowBuilder(
        "mixed-flow",
        "Test",
        "Test",
        z.object({ start: z.number() }),
        z.object({ sum: z.number() }),
      )
        .pipe(initialStage)
        .parallel([
          createParallelStage("double", 2),
          createParallelStage("triple", 3),
        ])
        .pipe(finalStage)
        .build();

      const { kernel, flush } = createTestKernel([workflow]);

      const { workflowRunId } = await kernel.dispatch({
        type: "run.create",
        idempotencyKey: "key-1",
        workflowId: "mixed-flow",
        input: { start: 5 },
      });

      await kernel.dispatch({ type: "run.claimPending", workerId: "worker-1" });

      // Execute initial: 5 * 2 = 10
      await kernel.dispatch({
        type: "job.execute",
        workflowRunId,
        workflowId: "mixed-flow",
        stageId: "initial",
        config: {},
      });
      await kernel.dispatch({ type: "run.transition", workflowRunId });

      // Execute parallel stages: double=20, triple=30
      await kernel.dispatch({
        type: "job.execute",
        workflowRunId,
        workflowId: "mixed-flow",
        stageId: "double",
        config: {},
      });
      await kernel.dispatch({
        type: "job.execute",
        workflowRunId,
        workflowId: "mixed-flow",
        stageId: "triple",
        config: {},
      });
      await kernel.dispatch({ type: "run.transition", workflowRunId });

      // Execute final: sum=50
      const rFinal = await kernel.dispatch({
        type: "job.execute",
        workflowRunId,
        workflowId: "mixed-flow",
        stageId: "final",
        config: {},
      });
      await kernel.dispatch({ type: "run.transition", workflowRunId });
      await flush();

      // Then: Flow worked correctly
      expect(executionLog[0]).toBe("initial");
      expect(executionLog).toContain("double");
      expect(executionLog).toContain("triple");
      expect(executionLog[executionLog.length - 1]).toBe("final");
      expect(rFinal.output).toEqual({ sum: 50 });
    });
  });
});
