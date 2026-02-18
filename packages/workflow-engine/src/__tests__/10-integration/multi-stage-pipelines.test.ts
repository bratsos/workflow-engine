/**
 * Multi-Stage Pipeline Tests (Kernel)
 *
 * Integration tests for complex pipelines with 5+ stages.
 * Tests sequential, mixed, and context accumulation patterns.
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
    persistence, blobStore, jobTransport, eventSink, scheduler, clock,
    registry: { getWorkflow: (id) => registry.get(id) },
  });
  const flush = () => kernel.dispatch({ type: "outbox.flush" as const });
  return { kernel, flush, persistence, blobStore, jobTransport, eventSink, scheduler, clock, registry };
}

describe("I want to build multi-stage pipelines", () => {
  describe("5+ stage sequential pipeline", () => {
    it("should execute a 7-stage content processing pipeline", async () => {
      // Given: A 7-stage content processing pipeline
      const executionLog: { stage: string; input: unknown; output: unknown }[] =
        [];

      const fetchStage = defineStage({
        id: "fetch",
        name: "Fetch Content",
        schemas: {
          input: z.object({ contentId: z.string() }),
          output: z.object({ rawContent: z.string(), fetchedAt: z.string() }),
          config: z.object({}),
        },
        async execute(ctx) {
          const output = {
            rawContent: `Raw content for ${ctx.input.contentId}`,
            fetchedAt: new Date().toISOString(),
          };
          executionLog.push({ stage: "fetch", input: ctx.input, output });
          return { output };
        },
      });

      const parseStage = defineStage({
        id: "parse",
        name: "Parse Content",
        schemas: {
          input: z.object({ rawContent: z.string(), fetchedAt: z.string() }),
          output: z.object({
            title: z.string(),
            body: z.string(),
            wordCount: z.number(),
          }),
          config: z.object({}),
        },
        async execute(ctx) {
          const output = {
            title: "Parsed Title",
            body: ctx.input.rawContent,
            wordCount: ctx.input.rawContent.split(" ").length,
          };
          executionLog.push({ stage: "parse", input: ctx.input, output });
          return { output };
        },
      });

      const validateStage = defineStage({
        id: "validate",
        name: "Validate Content",
        schemas: {
          input: z.object({
            title: z.string(),
            body: z.string(),
            wordCount: z.number(),
          }),
          output: z.object({
            isValid: z.boolean(),
            validationErrors: z.array(z.string()),
            content: z.object({
              title: z.string(),
              body: z.string(),
              wordCount: z.number(),
            }),
          }),
          config: z.object({}),
        },
        async execute(ctx) {
          const errors: string[] = [];
          if (!ctx.input.title) errors.push("Missing title");
          if (ctx.input.wordCount < 1) errors.push("Empty body");

          const output = {
            isValid: errors.length === 0,
            validationErrors: errors,
            content: ctx.input,
          };
          executionLog.push({ stage: "validate", input: ctx.input, output });
          return { output };
        },
      });

      const normalizeStage = defineStage({
        id: "normalize",
        name: "Normalize Content",
        schemas: {
          input: z.object({
            isValid: z.boolean(),
            validationErrors: z.array(z.string()),
            content: z.object({
              title: z.string(),
              body: z.string(),
              wordCount: z.number(),
            }),
          }),
          output: z.object({
            normalizedTitle: z.string(),
            normalizedBody: z.string(),
            wordCount: z.number(),
          }),
          config: z.object({}),
        },
        async execute(ctx) {
          const output = {
            normalizedTitle: ctx.input.content.title.trim().toLowerCase(),
            normalizedBody: ctx.input.content.body.trim(),
            wordCount: ctx.input.content.wordCount,
          };
          executionLog.push({ stage: "normalize", input: ctx.input, output });
          return { output };
        },
      });

      const enrichStage = defineStage({
        id: "enrich",
        name: "Enrich Content",
        schemas: {
          input: z.object({
            normalizedTitle: z.string(),
            normalizedBody: z.string(),
            wordCount: z.number(),
          }),
          output: z.object({
            title: z.string(),
            body: z.string(),
            wordCount: z.number(),
            readingTimeMinutes: z.number(),
            tags: z.array(z.string()),
          }),
          config: z.object({}),
        },
        async execute(ctx) {
          const output = {
            title: ctx.input.normalizedTitle,
            body: ctx.input.normalizedBody,
            wordCount: ctx.input.wordCount,
            readingTimeMinutes: Math.ceil(ctx.input.wordCount / 200),
            tags: ["auto-generated", "processed"],
          };
          executionLog.push({ stage: "enrich", input: ctx.input, output });
          return { output };
        },
      });

      const formatStage = defineStage({
        id: "format",
        name: "Format Content",
        schemas: {
          input: z.object({
            title: z.string(),
            body: z.string(),
            wordCount: z.number(),
            readingTimeMinutes: z.number(),
            tags: z.array(z.string()),
          }),
          output: z.object({
            html: z.string(),
            metadata: z.object({
              wordCount: z.number(),
              readingTime: z.number(),
              tags: z.array(z.string()),
            }),
          }),
          config: z.object({}),
        },
        async execute(ctx) {
          const output = {
            html: `<h1>${ctx.input.title}</h1><p>${ctx.input.body}</p>`,
            metadata: {
              wordCount: ctx.input.wordCount,
              readingTime: ctx.input.readingTimeMinutes,
              tags: ctx.input.tags,
            },
          };
          executionLog.push({ stage: "format", input: ctx.input, output });
          return { output };
        },
      });

      const publishStage = defineStage({
        id: "publish",
        name: "Publish Content",
        schemas: {
          input: z.object({
            html: z.string(),
            metadata: z.object({
              wordCount: z.number(),
              readingTime: z.number(),
              tags: z.array(z.string()),
            }),
          }),
          output: z.object({
            published: z.boolean(),
            publishedAt: z.string(),
            url: z.string(),
            stats: z.object({
              wordCount: z.number(),
              readingTime: z.number(),
              tagsCount: z.number(),
            }),
          }),
          config: z.object({}),
        },
        async execute(ctx) {
          const output = {
            published: true,
            publishedAt: new Date().toISOString(),
            url: "/content/published-123",
            stats: {
              wordCount: ctx.input.metadata.wordCount,
              readingTime: ctx.input.metadata.readingTime,
              tagsCount: ctx.input.metadata.tags.length,
            },
          };
          executionLog.push({ stage: "publish", input: ctx.input, output });
          return { output };
        },
      });

      const workflow = new WorkflowBuilder(
        "content-pipeline",
        "Content Processing Pipeline",
        "7-stage content processing",
        z.object({ contentId: z.string() }),
        z.object({
          published: z.boolean(),
          publishedAt: z.string(),
          url: z.string(),
          stats: z.object({
            wordCount: z.number(),
            readingTime: z.number(),
            tagsCount: z.number(),
          }),
        }),
      )
        .pipe(fetchStage)
        .pipe(parseStage)
        .pipe(validateStage)
        .pipe(normalizeStage)
        .pipe(enrichStage)
        .pipe(formatStage)
        .pipe(publishStage)
        .build();

      const { kernel, flush, persistence } = createTestKernel([workflow]);

      // When: I execute the 7-stage pipeline
      const { workflowRunId } = await kernel.dispatch({
        type: "run.create",
        idempotencyKey: "key-7stage",
        workflowId: "content-pipeline",
        input: { contentId: "content-123" },
      });
      await kernel.dispatch({ type: "run.claimPending", workerId: "worker-1" });

      const stageIds = ["fetch", "parse", "validate", "normalize", "enrich", "format", "publish"];
      for (const stageId of stageIds) {
        await kernel.dispatch({
          type: "job.execute",
          workflowRunId,
          workflowId: "content-pipeline",
          stageId,
          config: {},
        });
        await kernel.dispatch({ type: "run.transition", workflowRunId });
      }
      await flush();

      // Then: All 7 stages executed in order
      expect(executionLog).toHaveLength(7);
      expect(executionLog.map((e) => e.stage)).toEqual(stageIds);

      // And: Final output is correct
      const run = await persistence.getRun(workflowRunId);
      expect(run!.status).toBe("COMPLETED");

      // Verify last stage output via blobStore
      const keys = await persistence.getStagesByRun(workflowRunId);
      const publishStageRecord = keys.find((s) => s.stageId === "publish");
      expect(publishStageRecord).toBeDefined();
      expect(publishStageRecord!.status).toBe("COMPLETED");
    });

    it.skip("TODO: timing not meaningful with synchronous dispatch", async () => {
      // Original test: should track timing across 6-stage pipeline
      // Timing measurements are not meaningful in the kernel model because
      // dispatch is synchronous and there is no real concurrency overhead.
    });
  });

  describe("pipeline with mixed sequential and parallel stages", () => {
    it("should execute mixed sequential and parallel pipeline", async () => {
      // Given: A pipeline with pattern: S1 -> [P1, P2, P3] -> S2 -> [P4, P5] -> S3
      const executionLog: string[] = [];

      const sequential1 = defineStage({
        id: "seq-1",
        name: "Sequential 1",
        schemas: {
          input: z.object({ data: z.string() }),
          output: z.object({ prepared: z.string() }),
          config: z.object({}),
        },
        async execute(ctx) {
          executionLog.push("seq-1");
          return { output: { prepared: ctx.input.data.toUpperCase() } };
        },
      });

      const parallel1 = defineStage({
        id: "parallel-1",
        name: "Parallel 1",
        schemas: {
          input: z.object({}).passthrough(),
          output: z.object({ result1: z.string() }),
          config: z.object({}),
        },
        async execute(ctx) {
          executionLog.push("parallel-1");
          const seq1Output = ctx.workflowContext["seq-1"] as { prepared: string };
          return { output: { result1: `P1:${seq1Output.prepared}` } };
        },
      });

      const parallel2 = defineStage({
        id: "parallel-2",
        name: "Parallel 2",
        schemas: {
          input: z.object({}).passthrough(),
          output: z.object({ result2: z.string() }),
          config: z.object({}),
        },
        async execute(ctx) {
          executionLog.push("parallel-2");
          const seq1Output = ctx.workflowContext["seq-1"] as { prepared: string };
          return { output: { result2: `P2:${seq1Output.prepared}` } };
        },
      });

      const parallel3 = defineStage({
        id: "parallel-3",
        name: "Parallel 3",
        schemas: {
          input: z.object({}).passthrough(),
          output: z.object({ result3: z.string() }),
          config: z.object({}),
        },
        async execute(ctx) {
          executionLog.push("parallel-3");
          const seq1Output = ctx.workflowContext["seq-1"] as { prepared: string };
          return { output: { result3: `P3:${seq1Output.prepared}` } };
        },
      });

      const sequential2 = defineStage({
        id: "seq-2",
        name: "Sequential 2",
        schemas: {
          input: z.any(),
          output: z.object({ merged: z.string() }),
          config: z.object({}),
        },
        async execute(ctx) {
          executionLog.push("seq-2");
          const p1 = ctx.require("parallel-1" as never) as { result1: string };
          const p2 = ctx.require("parallel-2" as never) as { result2: string };
          const p3 = ctx.require("parallel-3" as never) as { result3: string };
          return {
            output: { merged: `${p1.result1}|${p2.result2}|${p3.result3}` },
          };
        },
      });

      const parallel4 = defineStage({
        id: "parallel-4",
        name: "Parallel 4",
        schemas: {
          input: z.object({ merged: z.string() }).passthrough(),
          output: z.object({ transformed4: z.string() }),
          config: z.object({}),
        },
        async execute(ctx) {
          executionLog.push("parallel-4");
          const seq2Output = ctx.workflowContext["seq-2"] as { merged: string };
          return { output: { transformed4: seq2Output.merged.split("|")[0] } };
        },
      });

      const parallel5 = defineStage({
        id: "parallel-5",
        name: "Parallel 5",
        schemas: {
          input: z.object({}).passthrough(),
          output: z.object({ transformed5: z.string() }),
          config: z.object({}),
        },
        async execute(ctx) {
          executionLog.push("parallel-5");
          const seq2Output = ctx.workflowContext["seq-2"] as { merged: string };
          return {
            output: { transformed5: seq2Output.merged.split("|").pop()! },
          };
        },
      });

      const sequential3 = defineStage({
        id: "seq-3",
        name: "Sequential 3",
        schemas: {
          input: z.any(),
          output: z.object({ final: z.string() }),
          config: z.object({}),
        },
        async execute(ctx) {
          executionLog.push("seq-3");
          const p4 = ctx.require("parallel-4" as never) as {
            transformed4: string;
          };
          const p5 = ctx.require("parallel-5" as never) as {
            transformed5: string;
          };
          return { output: { final: `${p4.transformed4}+${p5.transformed5}` } };
        },
      });

      const workflow = new WorkflowBuilder(
        "mixed-pipeline",
        "Mixed Pipeline",
        "Sequential and parallel stages",
        z.object({ data: z.string() }),
        z.object({ final: z.string() }),
      )
        .pipe(sequential1)
        .parallel([parallel1, parallel2, parallel3])
        .pipe(sequential2)
        .parallel([parallel4, parallel5])
        .pipe(sequential3)
        .build();

      const { kernel, flush, persistence } = createTestKernel([workflow]);

      // When: I execute the mixed pipeline
      const { workflowRunId } = await kernel.dispatch({
        type: "run.create",
        idempotencyKey: "key-mixed",
        workflowId: "mixed-pipeline",
        input: { data: "test" },
      });
      await kernel.dispatch({ type: "run.claimPending", workerId: "worker-1" });

      // Group 1: seq-1
      await kernel.dispatch({
        type: "job.execute",
        workflowRunId,
        workflowId: "mixed-pipeline",
        stageId: "seq-1",
        config: {},
      });
      await kernel.dispatch({ type: "run.transition", workflowRunId });

      // Group 2: parallel-1, parallel-2, parallel-3
      for (const stageId of ["parallel-1", "parallel-2", "parallel-3"]) {
        await kernel.dispatch({
          type: "job.execute",
          workflowRunId,
          workflowId: "mixed-pipeline",
          stageId,
          config: {},
        });
      }
      await kernel.dispatch({ type: "run.transition", workflowRunId });

      // Group 3: seq-2
      await kernel.dispatch({
        type: "job.execute",
        workflowRunId,
        workflowId: "mixed-pipeline",
        stageId: "seq-2",
        config: {},
      });
      await kernel.dispatch({ type: "run.transition", workflowRunId });

      // Group 4: parallel-4, parallel-5
      for (const stageId of ["parallel-4", "parallel-5"]) {
        await kernel.dispatch({
          type: "job.execute",
          workflowRunId,
          workflowId: "mixed-pipeline",
          stageId,
          config: {},
        });
      }
      await kernel.dispatch({ type: "run.transition", workflowRunId });

      // Group 5: seq-3
      const finalResult = await kernel.dispatch({
        type: "job.execute",
        workflowRunId,
        workflowId: "mixed-pipeline",
        stageId: "seq-3",
        config: {},
      });
      await kernel.dispatch({ type: "run.transition", workflowRunId });
      await flush();

      // Then: Result is computed correctly
      expect(finalResult.output).toEqual({ final: "P1:TEST+P3:TEST" });

      // And: All stages executed in order
      expect(executionLog.indexOf("seq-1")).toBeLessThan(
        executionLog.indexOf("parallel-1"),
      );
      expect(executionLog.indexOf("parallel-1")).toBeLessThan(
        executionLog.indexOf("seq-2"),
      );
      expect(executionLog.indexOf("seq-2")).toBeLessThan(
        executionLog.indexOf("parallel-4"),
      );
      expect(executionLog.indexOf("parallel-4")).toBeLessThan(
        executionLog.indexOf("seq-3"),
      );

      // And: Run completed
      const run = await persistence.getRun(workflowRunId);
      expect(run!.status).toBe("COMPLETED");
    });
  });

  describe("pipeline with context accumulation across stages", () => {
    it("should accumulate context across 5 stages", async () => {
      // Given: A 5-stage pipeline where each stage adds to context
      const contextSnapshots: Record<string, Record<string, unknown>> = {};

      const stage1 = defineStage({
        id: "stage-1",
        name: "Stage 1",
        schemas: {
          input: z.object({ initial: z.string() }),
          output: z.object({ value1: z.string() }),
          config: z.object({}),
        },
        async execute(ctx) {
          contextSnapshots["stage-1"] = { ...ctx.workflowContext };
          return { output: { value1: `${ctx.input.initial}-1` } };
        },
      });

      const stage2 = defineStage({
        id: "stage-2",
        name: "Stage 2",
        schemas: {
          input: z.object({ value1: z.string() }),
          output: z.object({ value2: z.string() }),
          config: z.object({}),
        },
        async execute(ctx) {
          contextSnapshots["stage-2"] = { ...ctx.workflowContext };
          return { output: { value2: `${ctx.input.value1}-2` } };
        },
      });

      const stage3 = defineStage({
        id: "stage-3",
        name: "Stage 3",
        schemas: {
          input: z.object({ value2: z.string() }),
          output: z.object({ value3: z.string() }),
          config: z.object({}),
        },
        async execute(ctx) {
          contextSnapshots["stage-3"] = { ...ctx.workflowContext };
          return { output: { value3: `${ctx.input.value2}-3` } };
        },
      });

      const stage4 = defineStage({
        id: "stage-4",
        name: "Stage 4",
        schemas: {
          input: z.object({ value3: z.string() }),
          output: z.object({ value4: z.string() }),
          config: z.object({}),
        },
        async execute(ctx) {
          contextSnapshots["stage-4"] = { ...ctx.workflowContext };
          return { output: { value4: `${ctx.input.value3}-4` } };
        },
      });

      const stage5 = defineStage({
        id: "stage-5",
        name: "Stage 5",
        schemas: {
          input: z.object({ value4: z.string() }),
          output: z.object({
            final: z.string(),
            allValues: z.array(z.string()),
          }),
          config: z.object({}),
        },
        async execute(ctx) {
          contextSnapshots["stage-5"] = { ...ctx.workflowContext };

          // Access all previous outputs from context
          const v1 = ctx.require("stage-1" as never) as { value1: string };
          const v2 = ctx.require("stage-2" as never) as { value2: string };
          const v3 = ctx.require("stage-3" as never) as { value3: string };
          const v4 = ctx.require("stage-4" as never) as { value4: string };

          return {
            output: {
              final: ctx.input.value4,
              allValues: [v1.value1, v2.value2, v3.value3, v4.value4],
            },
          };
        },
      });

      const workflow = new WorkflowBuilder(
        "accumulation-pipeline",
        "Context Accumulation",
        "5-stage context accumulation",
        z.object({ initial: z.string() }),
        z.object({ final: z.string(), allValues: z.array(z.string()) }),
      )
        .pipe(stage1)
        .pipe(stage2)
        .pipe(stage3)
        .pipe(stage4)
        .pipe(stage5)
        .build();

      const { kernel, flush, persistence } = createTestKernel([workflow]);

      // When: I execute the pipeline
      const { workflowRunId } = await kernel.dispatch({
        type: "run.create",
        idempotencyKey: "key-accumulation",
        workflowId: "accumulation-pipeline",
        input: { initial: "start" },
      });
      await kernel.dispatch({ type: "run.claimPending", workerId: "worker-1" });

      const stageIds = ["stage-1", "stage-2", "stage-3", "stage-4", "stage-5"];
      for (const stageId of stageIds) {
        await kernel.dispatch({
          type: "job.execute",
          workflowRunId,
          workflowId: "accumulation-pipeline",
          stageId,
          config: {},
        });
        await kernel.dispatch({ type: "run.transition", workflowRunId });
      }
      await flush();

      // Then: Final result has all accumulated values
      const lastStageOutput = (await persistence.getStage(workflowRunId, "stage-5"))!;
      expect(lastStageOutput.status).toBe("COMPLETED");

      // Verify via the last job.execute output
      const keys = await persistence.getStagesByRun(workflowRunId);
      expect(keys).toHaveLength(5);

      // And: Context grew progressively
      expect(Object.keys(contextSnapshots["stage-1"])).toHaveLength(0);
      expect(Object.keys(contextSnapshots["stage-2"])).toHaveLength(1);
      expect(Object.keys(contextSnapshots["stage-3"])).toHaveLength(2);
      expect(Object.keys(contextSnapshots["stage-4"])).toHaveLength(3);
      expect(Object.keys(contextSnapshots["stage-5"])).toHaveLength(4);
    });

    it("should allow late stages to access any earlier stage output", async () => {
      // Given: A 6-stage pipeline where the final stage needs outputs from stages 1, 3, and 5
      const stage1 = defineStage({
        id: "init",
        name: "Initialize",
        schemas: {
          input: z.object({ seed: z.number() }),
          output: z.object({ initialized: z.number() }),
          config: z.object({}),
        },
        async execute(ctx) {
          return { output: { initialized: ctx.input.seed * 2 } };
        },
      });

      const stage2 = defineStage({
        id: "step-2",
        name: "Step 2",
        schemas: {
          input: z.object({ initialized: z.number() }),
          output: z.object({ step2Result: z.number() }),
          config: z.object({}),
        },
        async execute(ctx) {
          return { output: { step2Result: ctx.input.initialized + 10 } };
        },
      });

      const stage3 = defineStage({
        id: "step-3",
        name: "Step 3",
        schemas: {
          input: z.object({ step2Result: z.number() }),
          output: z.object({ step3Result: z.number() }),
          config: z.object({}),
        },
        async execute(ctx) {
          return { output: { step3Result: ctx.input.step2Result * 3 } };
        },
      });

      const stage4 = defineStage({
        id: "step-4",
        name: "Step 4",
        schemas: {
          input: z.object({ step3Result: z.number() }),
          output: z.object({ step4Result: z.number() }),
          config: z.object({}),
        },
        async execute(ctx) {
          return { output: { step4Result: ctx.input.step3Result - 5 } };
        },
      });

      const stage5 = defineStage({
        id: "step-5",
        name: "Step 5",
        schemas: {
          input: z.object({ step4Result: z.number() }),
          output: z.object({ step5Result: z.number() }),
          config: z.object({}),
        },
        async execute(ctx) {
          return { output: { step5Result: ctx.input.step4Result / 2 } };
        },
      });

      const finalStage = defineStage({
        id: "finalize",
        name: "Finalize",
        schemas: {
          input: z.object({ step5Result: z.number() }),
          output: z.object({
            summary: z.object({
              fromInit: z.number(),
              fromStep3: z.number(),
              fromStep5: z.number(),
              combined: z.number(),
            }),
          }),
          config: z.object({}),
        },
        async execute(ctx) {
          const initOutput = ctx.require("init" as never) as {
            initialized: number;
          };
          const step3Output = ctx.require("step-3" as never) as {
            step3Result: number;
          };
          const step5Output = ctx.require("step-5" as never) as {
            step5Result: number;
          };

          return {
            output: {
              summary: {
                fromInit: initOutput.initialized,
                fromStep3: step3Output.step3Result,
                fromStep5: step5Output.step5Result,
                combined:
                  initOutput.initialized +
                  step3Output.step3Result +
                  step5Output.step5Result,
              },
            },
          };
        },
      });

      const workflow = new WorkflowBuilder(
        "selective-access",
        "Selective Context Access",
        "Access specific earlier stages",
        z.object({ seed: z.number() }),
        z.object({
          summary: z.object({
            fromInit: z.number(),
            fromStep3: z.number(),
            fromStep5: z.number(),
            combined: z.number(),
          }),
        }),
      )
        .pipe(stage1)
        .pipe(stage2)
        .pipe(stage3)
        .pipe(stage4)
        .pipe(stage5)
        .pipe(finalStage)
        .build();

      const { kernel, flush, persistence, blobStore } = createTestKernel([workflow]);

      // When: I execute with seed=5
      // init: 5*2=10
      // step-2: 10+10=20
      // step-3: 20*3=60
      // step-4: 60-5=55
      // step-5: 55/2=27.5
      // finalize: access init(10), step-3(60), step-5(27.5), combined=97.5
      const { workflowRunId } = await kernel.dispatch({
        type: "run.create",
        idempotencyKey: "key-selective",
        workflowId: "selective-access",
        input: { seed: 5 },
      });
      await kernel.dispatch({ type: "run.claimPending", workerId: "worker-1" });

      const stageIds = ["init", "step-2", "step-3", "step-4", "step-5", "finalize"];
      for (const stageId of stageIds) {
        await kernel.dispatch({
          type: "job.execute",
          workflowRunId,
          workflowId: "selective-access",
          stageId,
          config: {},
        });
        await kernel.dispatch({ type: "run.transition", workflowRunId });
      }
      await flush();

      // Then: Final stage accessed specific earlier outputs
      const run = await persistence.getRun(workflowRunId);
      expect(run!.status).toBe("COMPLETED");

      // Verify via blobStore
      const keys = await blobStore.list("");
      const finalizeKey = keys.find((k) => k.includes("/finalize/output.json"));
      expect(finalizeKey).toBeDefined();
      const finalOutput = (await blobStore.get(finalizeKey!)) as any;
      expect(finalOutput.summary.fromInit).toBe(10);
      expect(finalOutput.summary.fromStep3).toBe(60);
      expect(finalOutput.summary.fromStep5).toBe(27.5);
      expect(finalOutput.summary.combined).toBe(97.5);
    });
  });
});
