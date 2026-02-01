/**
 * Full Workflow Scenarios Tests
 *
 * Integration tests for complete end-to-end workflow scenarios.
 * Tests workflows from start to finish with multiple stages,
 * configuration, and parallel execution patterns.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { z } from "zod";
import { WorkflowBuilder } from "../../core/workflow.js";
import { WorkflowExecutor } from "../../core/executor.js";
import { defineStage } from "../../core/stage-factory.js";
import {
  InMemoryWorkflowPersistence,
  InMemoryAICallLogger,
  TestSchemas,
} from "../utils/index.js";

describe("I want to run complete workflow scenarios", () => {
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
          // Simulate ingesting data from source
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
          // Simulate cleaning: filter items that contain "2"
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

      await createRun("run-e2e", "data-pipeline", { source: "db", limit: 5 });

      const executor = new WorkflowExecutor(
        workflow,
        "run-e2e",
        "data-pipeline",
        {
          persistence,
          aiLogger,
        },
      );

      // Collect all events
      const events: string[] = [];
      executor.on("workflow:started", () => events.push("workflow:started"));
      executor.on("workflow:completed", () =>
        events.push("workflow:completed"),
      );
      executor.on("stage:started", (data) =>
        events.push(`stage:started:${(data as { stageId: string }).stageId}`),
      );
      executor.on("stage:completed", (data) =>
        events.push(`stage:completed:${(data as { stageId: string }).stageId}`),
      );

      // When: I execute the complete pipeline
      const result = await executor.execute({ source: "db", limit: 5 }, {});

      // Then: Pipeline produces final output
      expect(result.summary.totalRecords).toBe(4); // 5 - 1 item containing "2"
      expect(result.records).toHaveLength(4);
      expect(result.records[0].value).toBe("DB-ITEM-1");

      // And: All stages executed in order
      expect(events).toContain("workflow:started");
      expect(events).toContain("workflow:completed");
      expect(events).toContain("stage:started:ingest");
      expect(events).toContain("stage:completed:ingest");
      expect(events).toContain("stage:started:clean");
      expect(events).toContain("stage:completed:clean");
      expect(events).toContain("stage:started:transform");
      expect(events).toContain("stage:completed:transform");
      expect(events).toContain("stage:started:output");
      expect(events).toContain("stage:completed:output");
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
          // Simulate fetch that might fail
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
            // Graceful degradation
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

      await createRun("run-error", "error-handling-workflow", {
        url: "invalid-url",
      });

      const executor = new WorkflowExecutor(
        workflow,
        "run-error",
        "error-handling-workflow",
        {
          persistence,
          aiLogger,
        },
      );

      // When: I execute with an invalid URL
      const result = await executor.execute({ url: "invalid-url" }, {});

      // Then: Workflow completes with graceful degradation
      expect(result.wasRetried).toBe(true);
      expect(result.result).toBe("Using fallback data");
      expect(retryAttempted).toBe(true);

      // And: Run completed successfully
      const run = await persistence.getRun("run-error");
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

      await createRun("run-config", "config-workflow", {
        text: "The quick brown fox jumps over the lazy dog",
      });

      const executor = new WorkflowExecutor(
        workflow,
        "run-config",
        "config-workflow",
        {
          persistence,
          aiLogger,
        },
      );

      // When: I execute with stage-specific configs
      const result = await executor.execute(
        { text: "The quick brown fox jumps over the lazy dog" },
        {
          extract: { minWordLength: 4, maxWords: 5 },
          analyze: { includeLongestWord: true },
          format: {
            template:
              "Found {wordCount} words (avg {averageLength}), longest: {longestWord}",
          },
        },
      );

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
      expect(result.report).toContain("5 words"); // maxWords: 5
      expect(result.report).toContain("longest: jumps"); // includeLongestWord: true
    });

    it("should use workflow default configs when provided via getDefaultConfig", async () => {
      // Given: A stage with defaults that can be retrieved via getDefaultConfig
      let capturedConfig: { timeout: number; retries: number } | undefined;

      const stage = defineStage({
        id: "with-defaults",
        name: "With Defaults",
        schemas: {
          input: TestSchemas.string,
          output: TestSchemas.string,
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
        TestSchemas.string,
        TestSchemas.string,
      )
        .pipe(stage)
        .build();

      await createRun("run-defaults", "default-config-workflow", {
        value: "test",
      });

      const executor = new WorkflowExecutor(
        workflow,
        "run-defaults",
        "default-config-workflow",
        {
          persistence,
          aiLogger,
        },
      );

      // When: I execute using the workflow's default config
      const defaultConfig = workflow.getDefaultConfig();
      await executor.execute({ value: "test" }, defaultConfig);

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
          input: z.object({ parts: z.array(z.string()) }),
          output: z.object({ uppercase: z.array(z.string()) }),
          config: z.object({}),
        },
        async execute(ctx) {
          executionOrder.push("branch-a-start");
          await new Promise((r) => setTimeout(r, 20));
          executionOrder.push("branch-a-end");
          return {
            output: { uppercase: ctx.input.parts.map((p) => p.toUpperCase()) },
          };
        },
      });

      const branchB = defineStage({
        id: "branch-b",
        name: "Branch B",
        schemas: {
          input: z.object({ parts: z.array(z.string()) }),
          output: z.object({ lengths: z.array(z.number()) }),
          config: z.object({}),
        },
        async execute(ctx) {
          executionOrder.push("branch-b-start");
          await new Promise((r) => setTimeout(r, 20));
          executionOrder.push("branch-b-end");
          return { output: { lengths: ctx.input.parts.map((p) => p.length) } };
        },
      });

      const branchC = defineStage({
        id: "branch-c",
        name: "Branch C",
        schemas: {
          input: z.object({ parts: z.array(z.string()) }),
          output: z.object({ reversed: z.array(z.string()) }),
          config: z.object({}),
        },
        async execute(ctx) {
          executionOrder.push("branch-c-start");
          await new Promise((r) => setTimeout(r, 20));
          executionOrder.push("branch-c-end");
          return {
            output: {
              reversed: ctx.input.parts.map((p) =>
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

      await createRun("run-parallel-merge", "parallel-merge-workflow", {
        data: "one,two,three",
      });

      const executor = new WorkflowExecutor(
        workflow,
        "run-parallel-merge",
        "parallel-merge-workflow",
        {
          persistence,
          aiLogger,
        },
      );

      // When: I execute the parallel workflow
      const result = await executor.execute({ data: "one,two,three" }, {});

      // Then: All branches executed and merged correctly
      expect(result.combined).toEqual([
        { uppercase: "ONE", length: 3, reversed: "eno" },
        { uppercase: "TWO", length: 3, reversed: "owt" },
        { uppercase: "THREE", length: 5, reversed: "eerht" },
      ]);

      // And: Parallel branches ran concurrently (all started before any ended)
      const branchStarts = executionOrder.filter((e) => e.endsWith("-start"));
      const branchEnds = executionOrder.filter((e) => e.endsWith("-end"));
      const firstBranchEndIndex = executionOrder.findIndex((e) =>
        e.endsWith("-end"),
      );
      const lastBranchStartIndex = executionOrder.lastIndexOf(
        branchStarts[branchStarts.length - 1],
      );

      expect(lastBranchStartIndex).toBeLessThan(firstBranchEndIndex);

      // And: Split ran before branches, merge ran after
      expect(executionOrder[0]).toBe("split");
      expect(executionOrder[executionOrder.length - 1]).toBe("merge");
    });

    it("should handle diamond pattern workflow", async () => {
      // Given: A diamond pattern: A -> [B, C] -> D
      const contextAtD: Record<string, unknown> = {};

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
          input: z.object({ doubled: z.number() }),
          output: z.object({ added: z.number() }),
          config: z.object({}),
        },
        async execute(ctx) {
          return { output: { added: ctx.input.doubled + 10 } };
        },
      });

      const stageC = defineStage({
        id: "stage-c",
        name: "Stage C",
        schemas: {
          input: z.object({ doubled: z.number() }),
          output: z.object({ multiplied: z.number() }),
          config: z.object({}),
        },
        async execute(ctx) {
          return { output: { multiplied: ctx.input.doubled * 3 } };
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
          Object.assign(contextAtD, ctx.workflowContext);
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

      await createRun("run-diamond", "diamond-workflow", { value: 5 });

      const executor = new WorkflowExecutor(
        workflow,
        "run-diamond",
        "diamond-workflow",
        {
          persistence,
          aiLogger,
        },
      );

      // When: I execute the diamond workflow
      // value=5 -> A: doubled=10 -> B: added=20, C: multiplied=30 -> D: final=50
      const result = await executor.execute({ value: 5 }, {});

      // Then: All stages contributed to final result
      expect(result.final).toBe(50);

      // And: D had access to all previous outputs
      expect(contextAtD).toHaveProperty("stage-a");
      expect(contextAtD).toHaveProperty("stage-b");
      expect(contextAtD).toHaveProperty("stage-c");
    });
  });
});
