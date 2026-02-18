/**
 * Full Workflow Scenarios Tests (Kernel)
 *
 * Integration tests for complete end-to-end workflow scenarios.
 * Tests workflows from start to finish with multiple stages,
 * configuration, and parallel execution patterns.
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

describe("I want to run complete workflow scenarios", () => {
  describe("end-to-end workflow with multiple stages", () => {
    it("should execute a complete data processing pipeline", async () => {
      // Given: A multi-stage workflow that processes data end-to-end
      const ingestStage = defineStage({
        id: "ingest",
        name: "Ingest Data",
        schemas: {
          input: z.object({ source: z.string(), limit: z.number() }),
          output: z.object({ rawData: z.array(z.string()), count: z.number() }),
          config: z.object({}),
        },
        async execute(ctx) {
          const rawData = Array.from(
            { length: ctx.input.limit },
            (_, i) => `${ctx.input.source}-item-${i + 1}`,
          );
          return { output: { rawData, count: rawData.length } };
        },
      });

      const cleanStage = defineStage({
        id: "clean",
        name: "Clean Data",
        schemas: {
          input: z.object({ rawData: z.array(z.string()), count: z.number() }),
          output: z.object({
            cleanData: z.array(z.string()),
            removedCount: z.number(),
          }),
          config: z.object({}),
        },
        async execute(ctx) {
          const cleanData = ctx.input.rawData.filter(
            (item) => !item.includes("2"),
          );
          return {
            output: {
              cleanData,
              removedCount: ctx.input.count - cleanData.length,
            },
          };
        },
      });

      const transformStage = defineStage({
        id: "transform",
        name: "Transform Data",
        schemas: {
          input: z.object({
            cleanData: z.array(z.string()),
            removedCount: z.number(),
          }),
          output: z.object({
            transformedData: z.array(
              z.object({ id: z.string(), value: z.string() }),
            ),
          }),
          config: z.object({}),
        },
        async execute(ctx) {
          const transformedData = ctx.input.cleanData.map((item, index) => ({
            id: `id-${index}`,
            value: item.toUpperCase(),
          }));
          return { output: { transformedData } };
        },
      });

      const outputStage = defineStage({
        id: "output",
        name: "Output Data",
        schemas: {
          input: z.object({
            transformedData: z.array(
              z.object({ id: z.string(), value: z.string() }),
            ),
          }),
          output: z.object({
            summary: z.object({
              totalRecords: z.number(),
              processedAt: z.string(),
            }),
            records: z.array(z.object({ id: z.string(), value: z.string() })),
          }),
          config: z.object({}),
        },
        async execute(ctx) {
          return {
            output: {
              summary: {
                totalRecords: ctx.input.transformedData.length,
                processedAt: new Date().toISOString(),
              },
              records: ctx.input.transformedData,
            },
          };
        },
      });

      const workflow = new WorkflowBuilder(
        "data-pipeline",
        "Data Pipeline",
        "End-to-end data processing",
        z.object({ source: z.string(), limit: z.number() }),
        z.object({
          summary: z.object({
            totalRecords: z.number(),
            processedAt: z.string(),
          }),
          records: z.array(z.object({ id: z.string(), value: z.string() })),
        }),
      )
        .pipe(ingestStage)
        .pipe(cleanStage)
        .pipe(transformStage)
        .pipe(outputStage)
        .build();

      const { kernel, flush, persistence, blobStore, eventSink } = createTestKernel([workflow]);

      const input = { source: "db", limit: 5 };

      // When: I execute the complete pipeline
      const { workflowRunId } = await kernel.dispatch({
        type: "run.create",
        idempotencyKey: "key-e2e",
        workflowId: "data-pipeline",
        input,
      });
      await kernel.dispatch({ type: "run.claimPending", workerId: "worker-1" });

      // Execute each stage sequentially
      for (const stageId of ["ingest", "clean", "transform", "output"]) {
        await kernel.dispatch({
          type: "job.execute",
          workflowRunId,
          workflowId: "data-pipeline",
          stageId,
          config: {},
        });
        await kernel.dispatch({ type: "run.transition", workflowRunId });
      }
      await flush();

      // Then: Pipeline produces final output
      const run = await persistence.getRun(workflowRunId);
      expect(run!.status).toBe("COMPLETED");

      // Verify the last stage output via blobStore
      const keys = await blobStore.list("");
      const outputKey = keys.find((k) => k.includes("/output/output.json"));
      expect(outputKey).toBeDefined();
      const finalOutput = (await blobStore.get(outputKey!)) as any;
      expect(finalOutput.summary.totalRecords).toBe(4); // 5 - 1 item containing "2"
      expect(finalOutput.records).toHaveLength(4);
      expect(finalOutput.records[0].value).toBe("DB-ITEM-1");

      // And: Events emitted for all stages
      const stageStartedEvents = eventSink.getByType("stage:started");
      const stageCompletedEvents = eventSink.getByType("stage:completed");
      expect(stageStartedEvents).toHaveLength(4);
      expect(stageCompletedEvents).toHaveLength(4);

      const startedStageIds = stageStartedEvents.map((e: any) => e.stageId);
      expect(startedStageIds).toContain("ingest");
      expect(startedStageIds).toContain("clean");
      expect(startedStageIds).toContain("transform");
      expect(startedStageIds).toContain("output");
    });

    it("should handle workflow with error recovery logic", async () => {
      // Given: A workflow where one stage handles errors from context
      let retryAttempted = false;

      const fetchStage = defineStage({
        id: "fetch",
        name: "Fetch Data",
        schemas: {
          input: z.object({ url: z.string() }),
          output: z.object({
            data: z.string().nullable(),
            success: z.boolean(),
            errorMessage: z.string().optional(),
          }),
          config: z.object({}),
        },
        async execute(ctx) {
          if (ctx.input.url.includes("invalid")) {
            return {
              output: {
                data: null,
                success: false,
                errorMessage: "Invalid URL format",
              },
            };
          }
          return {
            output: {
              data: `Data from ${ctx.input.url}`,
              success: true,
            },
          };
        },
      });

      const processStage = defineStage({
        id: "process",
        name: "Process Data",
        schemas: {
          input: z.object({
            data: z.string().nullable(),
            success: z.boolean(),
            errorMessage: z.string().optional(),
          }),
          output: z.object({
            result: z.string(),
            wasRetried: z.boolean(),
          }),
          config: z.object({}),
        },
        async execute(ctx) {
          if (!ctx.input.success) {
            retryAttempted = true;
            return {
              output: {
                result: "Using fallback data",
                wasRetried: true,
              },
            };
          }
          return {
            output: {
              result: `Processed: ${ctx.input.data}`,
              wasRetried: false,
            },
          };
        },
      });

      const workflow = new WorkflowBuilder(
        "error-handling-workflow",
        "Error Handling Workflow",
        "Handles errors gracefully",
        z.object({ url: z.string() }),
        z.object({ result: z.string(), wasRetried: z.boolean() }),
      )
        .pipe(fetchStage)
        .pipe(processStage)
        .build();

      const { kernel, flush, persistence } = createTestKernel([workflow]);

      // When: I execute with an invalid URL
      const { workflowRunId } = await kernel.dispatch({
        type: "run.create",
        idempotencyKey: "key-error",
        workflowId: "error-handling-workflow",
        input: { url: "invalid-url" },
      });
      await kernel.dispatch({ type: "run.claimPending", workerId: "worker-1" });

      const fetchResult = await kernel.dispatch({
        type: "job.execute",
        workflowRunId,
        workflowId: "error-handling-workflow",
        stageId: "fetch",
        config: {},
      });
      await kernel.dispatch({ type: "run.transition", workflowRunId });

      const processResult = await kernel.dispatch({
        type: "job.execute",
        workflowRunId,
        workflowId: "error-handling-workflow",
        stageId: "process",
        config: {},
      });
      await kernel.dispatch({ type: "run.transition", workflowRunId });
      await flush();

      // Then: Workflow completes with graceful degradation
      expect(processResult.outcome).toBe("completed");
      expect(processResult.output).toEqual({
        result: "Using fallback data",
        wasRetried: true,
      });
      expect(retryAttempted).toBe(true);

      // And: Run completed successfully
      const run = await persistence.getRun(workflowRunId);
      expect(run?.status).toBe("COMPLETED");
    });
  });

  describe("workflow with configuration at each stage", () => {
    it("should pass and use stage-specific configuration", async () => {
      // Given: Stages that use their configuration
      const capturedConfigs: Record<string, unknown> = {};

      const extractStage = defineStage({
        id: "extract",
        name: "Extract",
        schemas: {
          input: z.object({ text: z.string() }),
          output: z.object({ words: z.array(z.string()) }),
          config: z.object({
            minWordLength: z.number().default(1),
            maxWords: z.number().default(100),
          }),
        },
        async execute(ctx) {
          capturedConfigs["extract"] = ctx.config;
          const words = ctx.input.text
            .split(/\s+/)
            .filter((w) => w.length >= ctx.config.minWordLength)
            .slice(0, ctx.config.maxWords);
          return { output: { words } };
        },
      });

      const analyzeStage = defineStage({
        id: "analyze",
        name: "Analyze",
        schemas: {
          input: z.object({ words: z.array(z.string()) }),
          output: z.object({
            wordCount: z.number(),
            averageLength: z.number(),
            longestWord: z.string(),
          }),
          config: z.object({
            includeLongestWord: z.boolean().default(true),
          }),
        },
        async execute(ctx) {
          capturedConfigs["analyze"] = ctx.config;
          const totalLength = ctx.input.words.reduce(
            (sum, w) => sum + w.length,
            0,
          );
          const longestWord = ctx.config.includeLongestWord
            ? ctx.input.words.reduce(
                (a, b) => (a.length > b.length ? a : b),
                "",
              )
            : "";

          return {
            output: {
              wordCount: ctx.input.words.length,
              averageLength: totalLength / ctx.input.words.length || 0,
              longestWord,
            },
          };
        },
      });

      const formatStage = defineStage({
        id: "format",
        name: "Format",
        schemas: {
          input: z.object({
            wordCount: z.number(),
            averageLength: z.number(),
            longestWord: z.string(),
          }),
          output: z.object({ report: z.string() }),
          config: z.object({
            template: z
              .string()
              .default("Words: {wordCount}, Avg: {averageLength}"),
          }),
        },
        async execute(ctx) {
          capturedConfigs["format"] = ctx.config;
          const report = ctx.config.template
            .replace("{wordCount}", String(ctx.input.wordCount))
            .replace("{averageLength}", ctx.input.averageLength.toFixed(2))
            .replace("{longestWord}", ctx.input.longestWord);

          return { output: { report } };
        },
      });

      const workflow = new WorkflowBuilder(
        "config-workflow",
        "Configurable Workflow",
        "Test configuration passing",
        z.object({ text: z.string() }),
        z.object({ report: z.string() }),
      )
        .pipe(extractStage)
        .pipe(analyzeStage)
        .pipe(formatStage)
        .build();

      const config = {
        extract: { minWordLength: 4, maxWords: 5 },
        analyze: { includeLongestWord: true },
        format: {
          template:
            "Found {wordCount} words (avg {averageLength}), longest: {longestWord}",
        },
      };

      const { kernel, flush, persistence } = createTestKernel([workflow]);

      // When: I execute with stage-specific configs
      const { workflowRunId } = await kernel.dispatch({
        type: "run.create",
        idempotencyKey: "key-config",
        workflowId: "config-workflow",
        input: { text: "The quick brown fox jumps over the lazy dog" },
        config,
      });
      await kernel.dispatch({ type: "run.claimPending", workerId: "worker-1" });

      for (const stageId of ["extract", "analyze", "format"]) {
        await kernel.dispatch({
          type: "job.execute",
          workflowRunId,
          workflowId: "config-workflow",
          stageId,
          config,
        });
        await kernel.dispatch({ type: "run.transition", workflowRunId });
      }
      await flush();

      // Then: Each stage used its config
      expect(capturedConfigs["extract"]).toEqual({
        minWordLength: 4,
        maxWords: 5,
      });
      expect(capturedConfigs["analyze"]).toEqual({ includeLongestWord: true });
      expect(
        (capturedConfigs["format"] as { template: string }).template,
      ).toContain("Found {wordCount}");

      // And: Result reflects the configuration
      const run = await persistence.getRun(workflowRunId);
      expect(run!.status).toBe("COMPLETED");
    });

    it("should use workflow default configs when provided via getDefaultConfig", async () => {
      // Given: A stage with defaults that can be retrieved via getDefaultConfig
      let capturedConfig: { timeout: number; retries: number } | undefined;

      const stage = defineStage({
        id: "with-defaults",
        name: "With Defaults",
        schemas: {
          input: z.object({ value: z.string() }),
          output: z.object({ value: z.string() }),
          config: z.object({
            timeout: z.number().default(30000),
            retries: z.number().default(3),
          }),
        },
        async execute(ctx) {
          capturedConfig = ctx.config;
          return { output: ctx.input };
        },
      });

      const workflow = new WorkflowBuilder(
        "default-config-workflow",
        "Default Config",
        "Test",
        z.object({ value: z.string() }),
        z.object({ value: z.string() }),
      )
        .pipe(stage)
        .build();

      const defaultConfig = workflow.getDefaultConfig();
      const { kernel, flush } = createTestKernel([workflow]);

      // When: I execute using the workflow's default config
      const { workflowRunId } = await kernel.dispatch({
        type: "run.create",
        idempotencyKey: "key-defaults",
        workflowId: "default-config-workflow",
        input: { value: "test" },
        config: defaultConfig,
      });
      await kernel.dispatch({ type: "run.claimPending", workerId: "worker-1" });

      await kernel.dispatch({
        type: "job.execute",
        workflowRunId,
        workflowId: "default-config-workflow",
        stageId: "with-defaults",
        config: defaultConfig,
      });
      await kernel.dispatch({ type: "run.transition", workflowRunId });
      await flush();

      // Then: Default config values are used
      expect(capturedConfig).toEqual({ timeout: 30000, retries: 3 });
    });
  });

  describe("workflow with parallel branches that merge", () => {
    it("should execute parallel branches and merge results", async () => {
      // Given: A workflow with parallel branches that merge
      const executionOrder: string[] = [];

      const splitStage = defineStage({
        id: "split",
        name: "Split Input",
        schemas: {
          input: z.object({ data: z.string() }),
          output: z.object({ parts: z.array(z.string()) }),
          config: z.object({}),
        },
        async execute(ctx) {
          executionOrder.push("split");
          return { output: { parts: ctx.input.data.split(",") } };
        },
      });

      const branchA = defineStage({
        id: "branch-a",
        name: "Branch A",
        schemas: {
          input: z.object({ parts: z.array(z.string()) }).passthrough(),
          output: z.object({ uppercase: z.array(z.string()) }),
          config: z.object({}),
        },
        async execute(ctx) {
          executionOrder.push("branch-a");
          // Access split output via workflowContext for reliable access
          const splitOutput = ctx.workflowContext["split"] as { parts: string[] };
          return {
            output: { uppercase: splitOutput.parts.map((p) => p.toUpperCase()) },
          };
        },
      });

      const branchB = defineStage({
        id: "branch-b",
        name: "Branch B",
        schemas: {
          input: z.object({}).passthrough(),
          output: z.object({ lengths: z.array(z.number()) }),
          config: z.object({}),
        },
        async execute(ctx) {
          executionOrder.push("branch-b");
          const splitOutput = ctx.workflowContext["split"] as { parts: string[] };
          return { output: { lengths: splitOutput.parts.map((p) => p.length) } };
        },
      });

      const branchC = defineStage({
        id: "branch-c",
        name: "Branch C",
        schemas: {
          input: z.object({}).passthrough(),
          output: z.object({ reversed: z.array(z.string()) }),
          config: z.object({}),
        },
        async execute(ctx) {
          executionOrder.push("branch-c");
          const splitOutput = ctx.workflowContext["split"] as { parts: string[] };
          return {
            output: {
              reversed: splitOutput.parts.map((p) =>
                p.split("").reverse().join(""),
              ),
            },
          };
        },
      });

      const mergeStage = defineStage({
        id: "merge",
        name: "Merge Results",
        schemas: {
          input: z.any(),
          output: z.object({
            combined: z.array(
              z.object({
                uppercase: z.string(),
                length: z.number(),
                reversed: z.string(),
              }),
            ),
          }),
          config: z.object({}),
        },
        async execute(ctx) {
          executionOrder.push("merge");
          const branchAOutput = ctx.require("branch-a" as never) as {
            uppercase: string[];
          };
          const branchBOutput = ctx.require("branch-b" as never) as {
            lengths: number[];
          };
          const branchCOutput = ctx.require("branch-c" as never) as {
            reversed: string[];
          };

          const combined = branchAOutput.uppercase.map((u, i) => ({
            uppercase: u,
            length: branchBOutput.lengths[i],
            reversed: branchCOutput.reversed[i],
          }));

          return { output: { combined } };
        },
      });

      const workflow = new WorkflowBuilder(
        "parallel-merge-workflow",
        "Parallel Merge",
        "Test parallel execution with merge",
        z.object({ data: z.string() }),
        z.object({
          combined: z.array(
            z.object({
              uppercase: z.string(),
              length: z.number(),
              reversed: z.string(),
            }),
          ),
        }),
      )
        .pipe(splitStage)
        .parallel([branchA, branchB, branchC])
        .pipe(mergeStage)
        .build();

      const { kernel, flush, persistence } = createTestKernel([workflow]);

      // When: I execute the parallel workflow
      const { workflowRunId } = await kernel.dispatch({
        type: "run.create",
        idempotencyKey: "key-parallel-merge",
        workflowId: "parallel-merge-workflow",
        input: { data: "one,two,three" },
      });
      await kernel.dispatch({ type: "run.claimPending", workerId: "worker-1" });

      // Execute split stage
      await kernel.dispatch({
        type: "job.execute",
        workflowRunId,
        workflowId: "parallel-merge-workflow",
        stageId: "split",
        config: {},
      });
      await kernel.dispatch({ type: "run.transition", workflowRunId });

      // Execute all parallel branches
      for (const stageId of ["branch-a", "branch-b", "branch-c"]) {
        await kernel.dispatch({
          type: "job.execute",
          workflowRunId,
          workflowId: "parallel-merge-workflow",
          stageId,
          config: {},
        });
      }
      await kernel.dispatch({ type: "run.transition", workflowRunId });

      // Execute merge stage
      const mergeResult = await kernel.dispatch({
        type: "job.execute",
        workflowRunId,
        workflowId: "parallel-merge-workflow",
        stageId: "merge",
        config: {},
      });
      await kernel.dispatch({ type: "run.transition", workflowRunId });
      await flush();

      // Then: All branches executed and merged correctly
      expect(mergeResult.output).toEqual({
        combined: [
          { uppercase: "ONE", length: 3, reversed: "eno" },
          { uppercase: "TWO", length: 3, reversed: "owt" },
          { uppercase: "THREE", length: 5, reversed: "eerht" },
        ],
      });

      // And: Execution order shows split first, then branches, then merge
      expect(executionOrder[0]).toBe("split");
      expect(executionOrder).toContain("branch-a");
      expect(executionOrder).toContain("branch-b");
      expect(executionOrder).toContain("branch-c");
      expect(executionOrder[executionOrder.length - 1]).toBe("merge");

      // And: Run completed
      const run = await persistence.getRun(workflowRunId);
      expect(run!.status).toBe("COMPLETED");
    });

    it("should handle diamond pattern workflow", async () => {
      // Given: A diamond pattern: A -> [B, C] -> D
      const stageA = defineStage({
        id: "stage-a",
        name: "Stage A",
        schemas: {
          input: z.object({ value: z.number() }),
          output: z.object({ doubled: z.number() }),
          config: z.object({}),
        },
        async execute(ctx) {
          return { output: { doubled: ctx.input.value * 2 } };
        },
      });

      const stageB = defineStage({
        id: "stage-b",
        name: "Stage B",
        schemas: {
          input: z.object({ doubled: z.number() }).passthrough(),
          output: z.object({ added: z.number() }),
          config: z.object({}),
        },
        async execute(ctx) {
          // Access stage-a output via workflowContext
          const aOutput = ctx.workflowContext["stage-a"] as { doubled: number };
          return { output: { added: aOutput.doubled + 10 } };
        },
      });

      const stageC = defineStage({
        id: "stage-c",
        name: "Stage C",
        schemas: {
          input: z.object({}).passthrough(),
          output: z.object({ multiplied: z.number() }),
          config: z.object({}),
        },
        async execute(ctx) {
          const aOutput = ctx.workflowContext["stage-a"] as { doubled: number };
          return { output: { multiplied: aOutput.doubled * 3 } };
        },
      });

      const stageD = defineStage({
        id: "stage-d",
        name: "Stage D",
        schemas: {
          input: z.any(),
          output: z.object({ final: z.number() }),
          config: z.object({}),
        },
        async execute(ctx) {
          const bOutput = ctx.require("stage-b" as never) as { added: number };
          const cOutput = ctx.require("stage-c" as never) as {
            multiplied: number;
          };
          return { output: { final: bOutput.added + cOutput.multiplied } };
        },
      });

      const workflow = new WorkflowBuilder(
        "diamond-workflow",
        "Diamond Pattern",
        "Test diamond execution pattern",
        z.object({ value: z.number() }),
        z.object({ final: z.number() }),
      )
        .pipe(stageA)
        .parallel([stageB, stageC])
        .pipe(stageD)
        .build();

      const { kernel, flush, persistence } = createTestKernel([workflow]);

      // When: I execute the diamond workflow
      // value=5 -> A: doubled=10 -> B: added=20, C: multiplied=30 -> D: final=50
      const { workflowRunId } = await kernel.dispatch({
        type: "run.create",
        idempotencyKey: "key-diamond",
        workflowId: "diamond-workflow",
        input: { value: 5 },
      });
      await kernel.dispatch({ type: "run.claimPending", workerId: "worker-1" });

      // Execute stage A
      await kernel.dispatch({
        type: "job.execute",
        workflowRunId,
        workflowId: "diamond-workflow",
        stageId: "stage-a",
        config: {},
      });
      await kernel.dispatch({ type: "run.transition", workflowRunId });

      // Execute parallel stages B and C
      await kernel.dispatch({
        type: "job.execute",
        workflowRunId,
        workflowId: "diamond-workflow",
        stageId: "stage-b",
        config: {},
      });
      await kernel.dispatch({
        type: "job.execute",
        workflowRunId,
        workflowId: "diamond-workflow",
        stageId: "stage-c",
        config: {},
      });
      await kernel.dispatch({ type: "run.transition", workflowRunId });

      // Execute stage D
      const dResult = await kernel.dispatch({
        type: "job.execute",
        workflowRunId,
        workflowId: "diamond-workflow",
        stageId: "stage-d",
        config: {},
      });
      await kernel.dispatch({ type: "run.transition", workflowRunId });
      await flush();

      // Then: All stages contributed to final result
      expect(dResult.output).toEqual({ final: 50 });

      // And: D had access to all previous outputs via workflowContext
      const run = await persistence.getRun(workflowRunId);
      expect(run!.status).toBe("COMPLETED");
    });
  });
});
