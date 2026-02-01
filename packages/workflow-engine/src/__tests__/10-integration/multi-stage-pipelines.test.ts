/**
 * Multi-Stage Pipeline Tests
 *
 * Integration tests for complex pipelines with 5+ stages.
 * Tests sequential, mixed, and context accumulation patterns.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { WorkflowExecutor } from "../../core/executor.js";
import { defineStage } from "../../core/stage-factory.js";
import { WorkflowBuilder } from "../../core/workflow.js";
import {
  InMemoryAICallLogger,
  InMemoryWorkflowPersistence,
} from "../utils/index.js";

describe("I want to build multi-stage pipelines", () => {
  let persistence: InMemoryWorkflowPersistence;
  let aiLogger: InMemoryAICallLogger;

  beforeEach(() => {
    persistence = new InMemoryWorkflowPersistence();
    aiLogger = new InMemoryAICallLogger();
  });

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

      await createRun("run-7stage", "content-pipeline", {
        contentId: "content-123",
      });

      const executor = new WorkflowExecutor(
        workflow,
        "run-7stage",
        "content-pipeline",
        {
          persistence,
          aiLogger,
        },
      );

      // When: I execute the 7-stage pipeline
      const result = await executor.execute({ contentId: "content-123" }, {});

      // Then: All 7 stages executed in order
      expect(executionLog).toHaveLength(7);
      expect(executionLog.map((e) => e.stage)).toEqual([
        "fetch",
        "parse",
        "validate",
        "normalize",
        "enrich",
        "format",
        "publish",
      ]);

      // And: Final output is correct
      expect(result.published).toBe(true);
      expect(result.url).toBe("/content/published-123");
      expect(result.stats.tagsCount).toBe(2);
    });

    it("should track timing across 6-stage pipeline", async () => {
      // Given: A 6-stage pipeline with timing tracking
      const stageTimes: { stage: string; duration: number }[] = [];

      const createTimedStage = (id: string, delayMs: number) =>
        defineStage({
          id,
          name: `Stage ${id}`,
          schemas: {
            input: z.object({}).passthrough(),
            output: z.object({ stageId: z.string(), timestamp: z.number() }),
            config: z.object({}),
          },
          async execute() {
            const start = Date.now();
            await new Promise((r) => setTimeout(r, delayMs));
            const duration = Date.now() - start;
            stageTimes.push({ stage: id, duration });
            return { output: { stageId: id, timestamp: Date.now() } };
          },
        });

      const workflow = new WorkflowBuilder(
        "timed-pipeline",
        "Timed Pipeline",
        "6-stage with timing",
        z.object({}),
        z.object({ stageId: z.string(), timestamp: z.number() }),
      )
        .pipe(createTimedStage("stage-1", 10))
        .pipe(createTimedStage("stage-2", 15))
        .pipe(createTimedStage("stage-3", 10))
        .pipe(createTimedStage("stage-4", 20))
        .pipe(createTimedStage("stage-5", 10))
        .pipe(createTimedStage("stage-6", 15))
        .build();

      await createRun("run-timed", "timed-pipeline", {});

      const executor = new WorkflowExecutor(
        workflow,
        "run-timed",
        "timed-pipeline",
        {
          persistence,
          aiLogger,
        },
      );

      const startTime = Date.now();

      // When: I execute the pipeline
      const result = await executor.execute({}, {});

      const totalTime = Date.now() - startTime;

      // Then: All stages completed
      expect(stageTimes).toHaveLength(6);
      expect(result.stageId).toBe("stage-6");

      // And: Total time accounts for all stages (sequential execution)
      // Minimum expected: 10+15+10+20+10+15 = 80ms
      expect(totalTime).toBeGreaterThanOrEqual(70); // Allow some variance
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
          input: z.object({ prepared: z.string() }),
          output: z.object({ result1: z.string() }),
          config: z.object({}),
        },
        async execute(ctx) {
          executionLog.push("parallel-1-start");
          await new Promise((r) => setTimeout(r, 15));
          executionLog.push("parallel-1-end");
          return { output: { result1: `P1:${ctx.input.prepared}` } };
        },
      });

      const parallel2 = defineStage({
        id: "parallel-2",
        name: "Parallel 2",
        schemas: {
          input: z.object({ prepared: z.string() }),
          output: z.object({ result2: z.string() }),
          config: z.object({}),
        },
        async execute(ctx) {
          executionLog.push("parallel-2-start");
          await new Promise((r) => setTimeout(r, 15));
          executionLog.push("parallel-2-end");
          return { output: { result2: `P2:${ctx.input.prepared}` } };
        },
      });

      const parallel3 = defineStage({
        id: "parallel-3",
        name: "Parallel 3",
        schemas: {
          input: z.object({ prepared: z.string() }),
          output: z.object({ result3: z.string() }),
          config: z.object({}),
        },
        async execute(ctx) {
          executionLog.push("parallel-3-start");
          await new Promise((r) => setTimeout(r, 15));
          executionLog.push("parallel-3-end");
          return { output: { result3: `P3:${ctx.input.prepared}` } };
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
          input: z.object({ merged: z.string() }),
          output: z.object({ transformed4: z.string() }),
          config: z.object({}),
        },
        async execute(ctx) {
          executionLog.push("parallel-4-start");
          await new Promise((r) => setTimeout(r, 10));
          executionLog.push("parallel-4-end");
          return { output: { transformed4: ctx.input.merged.split("|")[0] } };
        },
      });

      const parallel5 = defineStage({
        id: "parallel-5",
        name: "Parallel 5",
        schemas: {
          input: z.object({ merged: z.string() }),
          output: z.object({ transformed5: z.string() }),
          config: z.object({}),
        },
        async execute(ctx) {
          executionLog.push("parallel-5-start");
          await new Promise((r) => setTimeout(r, 10));
          executionLog.push("parallel-5-end");
          return {
            output: { transformed5: ctx.input.merged.split("|").pop()! },
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

      await createRun("run-mixed", "mixed-pipeline", { data: "test" });

      const executor = new WorkflowExecutor(
        workflow,
        "run-mixed",
        "mixed-pipeline",
        {
          persistence,
          aiLogger,
        },
      );

      // When: I execute the mixed pipeline
      const result = await executor.execute({ data: "test" }, {});

      // Then: Result is computed correctly
      expect(result.final).toBe("P1:TEST+P3:TEST");

      // And: Sequential stages ran in order
      expect(executionLog.indexOf("seq-1")).toBeLessThan(
        executionLog.indexOf("parallel-1-start"),
      );
      expect(executionLog.indexOf("parallel-1-end")).toBeLessThan(
        executionLog.indexOf("seq-2"),
      );
      expect(executionLog.indexOf("seq-2")).toBeLessThan(
        executionLog.indexOf("parallel-4-start"),
      );
      expect(executionLog.indexOf("parallel-4-end")).toBeLessThan(
        executionLog.indexOf("seq-3"),
      );

      // And: Parallel stages ran concurrently (all started before any ended)
      const firstGroupStarts = executionLog.filter((e) =>
        ["parallel-1-start", "parallel-2-start", "parallel-3-start"].includes(
          e,
        ),
      );
      const firstGroupEnds = executionLog.filter((e) =>
        ["parallel-1-end", "parallel-2-end", "parallel-3-end"].includes(e),
      );

      expect(firstGroupStarts.length).toBe(3);
      expect(firstGroupEnds.length).toBe(3);

      // All starts should come before first end
      const firstEndIndex = executionLog.findIndex((e) =>
        ["parallel-1-end", "parallel-2-end", "parallel-3-end"].includes(e),
      );
      const lastStartIndex = Math.max(
        executionLog.indexOf("parallel-1-start"),
        executionLog.indexOf("parallel-2-start"),
        executionLog.indexOf("parallel-3-start"),
      );
      expect(lastStartIndex).toBeLessThan(firstEndIndex);
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

      await createRun("run-accumulation", "accumulation-pipeline", {
        initial: "start",
      });

      const executor = new WorkflowExecutor(
        workflow,
        "run-accumulation",
        "accumulation-pipeline",
        {
          persistence,
          aiLogger,
        },
      );

      // When: I execute the pipeline
      const result = await executor.execute({ initial: "start" }, {});

      // Then: Final result has all accumulated values
      expect(result.final).toBe("start-1-2-3-4");
      expect(result.allValues).toEqual([
        "start-1",
        "start-1-2",
        "start-1-2-3",
        "start-1-2-3-4",
      ]);

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

      await createRun("run-selective", "selective-access", { seed: 5 });

      const executor = new WorkflowExecutor(
        workflow,
        "run-selective",
        "selective-access",
        {
          persistence,
          aiLogger,
        },
      );

      // When: I execute with seed=5
      // init: 5*2=10
      // step-2: 10+10=20
      // step-3: 20*3=60
      // step-4: 60-5=55
      // step-5: 55/2=27.5
      // finalize: access init(10), step-3(60), step-5(27.5), combined=97.5
      const result = await executor.execute({ seed: 5 }, {});

      // Then: Final stage accessed specific earlier outputs
      expect(result.summary.fromInit).toBe(10);
      expect(result.summary.fromStep3).toBe(60);
      expect(result.summary.fromStep5).toBe(27.5);
      expect(result.summary.combined).toBe(97.5);
    });
  });
});
