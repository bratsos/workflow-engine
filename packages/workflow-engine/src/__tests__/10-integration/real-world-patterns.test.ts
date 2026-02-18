/**
 * Real-World Patterns Tests (Kernel)
 *
 * Integration tests for real-world workflow patterns:
 * - Document processing workflows
 * - Data pipeline (ETL) workflows
 * - Validation workflows with parallel checks
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

describe("I want to implement real-world workflow patterns", () => {
  describe("document processing workflow (fetch, parse, transform, store)", () => {
    it("should process a document through all stages", async () => {
      // Given: A document processing workflow with 4 stages
      const processLog: { stage: string; action: string; data?: unknown }[] =
        [];

      const fetchStage = defineStage({
        id: "fetch-document",
        name: "Fetch Document",
        schemas: {
          input: z.object({
            documentUrl: z.string(),
            documentType: z.enum(["pdf", "html", "markdown"]),
          }),
          output: z.object({
            rawContent: z.string(),
            contentType: z.string(),
            size: z.number(),
            fetchedAt: z.string(),
          }),
          config: z.object({
            timeout: z.number().default(30000),
          }),
        },
        async execute(ctx) {
          processLog.push({
            stage: "fetch",
            action: "fetching",
            data: { url: ctx.input.documentUrl, timeout: ctx.config.timeout },
          });

          const rawContent = `# Sample Document\n\nThis is content from ${ctx.input.documentUrl}\n\n## Section 1\n\nParagraph content here.`;

          return {
            output: {
              rawContent,
              contentType: ctx.input.documentType,
              size: rawContent.length,
              fetchedAt: new Date().toISOString(),
            },
          };
        },
      });

      const parseStage = defineStage({
        id: "parse-document",
        name: "Parse Document",
        schemas: {
          input: z.object({
            rawContent: z.string(),
            contentType: z.string(),
            size: z.number(),
            fetchedAt: z.string(),
          }),
          output: z.object({
            title: z.string(),
            sections: z.array(
              z.object({
                heading: z.string(),
                content: z.string(),
              }),
            ),
            metadata: z.object({
              wordCount: z.number(),
              sectionCount: z.number(),
            }),
          }),
          config: z.object({}),
        },
        async execute(ctx) {
          processLog.push({
            stage: "parse",
            action: "parsing",
            data: { contentType: ctx.input.contentType, size: ctx.input.size },
          });

          const lines = ctx.input.rawContent.split("\n");
          const title = lines[0].replace(/^#\s*/, "");
          const sections = [
            { heading: "Introduction", content: lines.slice(2, 4).join(" ") },
            { heading: "Section 1", content: lines.slice(6).join(" ") },
          ];

          return {
            output: {
              title,
              sections,
              metadata: {
                wordCount: ctx.input.rawContent.split(/\s+/).length,
                sectionCount: sections.length,
              },
            },
          };
        },
      });

      const transformStage = defineStage({
        id: "transform-document",
        name: "Transform Document",
        schemas: {
          input: z.object({
            title: z.string(),
            sections: z.array(
              z.object({
                heading: z.string(),
                content: z.string(),
              }),
            ),
            metadata: z.object({
              wordCount: z.number(),
              sectionCount: z.number(),
            }),
          }),
          output: z.object({
            transformedDocument: z.object({
              id: z.string(),
              title: z.string(),
              content: z.string(),
              summary: z.string(),
              keywords: z.array(z.string()),
              metadata: z.object({
                wordCount: z.number(),
                readingTimeMinutes: z.number(),
                processedAt: z.string(),
              }),
            }),
          }),
          config: z.object({
            generateSummary: z.boolean().default(true),
            extractKeywords: z.boolean().default(true),
          }),
        },
        async execute(ctx) {
          processLog.push({
            stage: "transform",
            action: "transforming",
            data: { title: ctx.input.title, config: ctx.config },
          });

          const content = ctx.input.sections
            .map((s) => `${s.heading}: ${s.content}`)
            .join("\n\n");
          const summary = ctx.config.generateSummary
            ? `Summary of ${ctx.input.title} with ${ctx.input.metadata.sectionCount} sections`
            : "";
          const keywords = ctx.config.extractKeywords
            ? ["document", "processing", "workflow"]
            : [];

          return {
            output: {
              transformedDocument: {
                id: `doc-${Date.now()}`,
                title: ctx.input.title,
                content,
                summary,
                keywords,
                metadata: {
                  wordCount: ctx.input.metadata.wordCount,
                  readingTimeMinutes: Math.ceil(
                    ctx.input.metadata.wordCount / 200,
                  ),
                  processedAt: new Date().toISOString(),
                },
              },
            },
          };
        },
      });

      const storeStage = defineStage({
        id: "store-document",
        name: "Store Document",
        schemas: {
          input: z.object({
            transformedDocument: z.object({
              id: z.string(),
              title: z.string(),
              content: z.string(),
              summary: z.string(),
              keywords: z.array(z.string()),
              metadata: z.object({
                wordCount: z.number(),
                readingTimeMinutes: z.number(),
                processedAt: z.string(),
              }),
            }),
          }),
          output: z.object({
            stored: z.boolean(),
            documentId: z.string(),
            storagePath: z.string(),
            version: z.number(),
          }),
          config: z.object({
            storageLocation: z.string().default("default-bucket"),
          }),
        },
        async execute(ctx) {
          processLog.push({
            stage: "store",
            action: "storing",
            data: {
              documentId: ctx.input.transformedDocument.id,
              location: ctx.config.storageLocation,
            },
          });

          return {
            output: {
              stored: true,
              documentId: ctx.input.transformedDocument.id,
              storagePath: `${ctx.config.storageLocation}/${ctx.input.transformedDocument.id}`,
              version: 1,
            },
          };
        },
      });

      const workflow = new WorkflowBuilder(
        "document-workflow",
        "Document Processing Workflow",
        "Fetch, parse, transform, and store documents",
        z.object({
          documentUrl: z.string(),
          documentType: z.enum(["pdf", "html", "markdown"]),
        }),
        z.object({
          stored: z.boolean(),
          documentId: z.string(),
          storagePath: z.string(),
          version: z.number(),
        }),
      )
        .pipe(fetchStage)
        .pipe(parseStage)
        .pipe(transformStage)
        .pipe(storeStage)
        .build();

      const config = {
        "fetch-document": { timeout: 5000 },
        "transform-document": {
          generateSummary: true,
          extractKeywords: true,
        },
        "store-document": { storageLocation: "processed-docs" },
      };

      const { kernel, flush, persistence } = createTestKernel([workflow]);

      // When: I process a document
      const { workflowRunId } = await kernel.dispatch({
        type: "run.create",
        idempotencyKey: "key-doc-process",
        workflowId: "document-workflow",
        input: {
          documentUrl: "https://example.com/doc.md",
          documentType: "markdown" as const,
        },
        config,
      });
      await kernel.dispatch({ type: "run.claimPending", workerId: "worker-1" });

      const stageIds = ["fetch-document", "parse-document", "transform-document", "store-document"];
      for (const stageId of stageIds) {
        await kernel.dispatch({
          type: "job.execute",
          workflowRunId,
          workflowId: "document-workflow",
          stageId,
          config,
        });
        await kernel.dispatch({ type: "run.transition", workflowRunId });
      }
      await flush();

      // Then: Document was processed through all stages
      const run = await persistence.getRun(workflowRunId);
      expect(run!.status).toBe("COMPLETED");

      // Verify final stage output
      const storeStageRecord = await persistence.getStage(workflowRunId, "store-document");
      expect(storeStageRecord!.status).toBe("COMPLETED");

      // And: All stages executed in order
      expect(processLog.map((l) => l.stage)).toEqual([
        "fetch",
        "parse",
        "transform",
        "store",
      ]);

      // And: Configs were applied
      expect(processLog[0].data).toMatchObject({ timeout: 5000 });
      expect(processLog[2].data).toMatchObject({
        config: { generateSummary: true, extractKeywords: true },
      });
    });

    it("should handle documents with different content types", async () => {
      // Given: A simplified document workflow
      let parsedContentType: string | undefined;

      const fetchStage = defineStage({
        id: "fetch",
        name: "Fetch",
        schemas: {
          input: z.object({ url: z.string(), type: z.string() }),
          output: z.object({ content: z.string(), type: z.string() }),
          config: z.object({}),
        },
        async execute(ctx) {
          return {
            output: {
              content: `Content from ${ctx.input.url}`,
              type: ctx.input.type,
            },
          };
        },
      });

      const parseStage = defineStage({
        id: "parse",
        name: "Parse",
        schemas: {
          input: z.object({ content: z.string(), type: z.string() }),
          output: z.object({ parsed: z.string(), format: z.string() }),
          config: z.object({}),
        },
        async execute(ctx) {
          parsedContentType = ctx.input.type;

          let parsed: string;
          switch (ctx.input.type) {
            case "html":
              parsed = ctx.input.content.replace(/<[^>]*>/g, "");
              break;
            case "markdown":
              parsed = ctx.input.content.replace(/[#*_]/g, "");
              break;
            default:
              parsed = ctx.input.content;
          }

          return { output: { parsed, format: ctx.input.type } };
        },
      });

      const workflow = new WorkflowBuilder(
        "flexible-parser",
        "Flexible Parser",
        "Parse different content types",
        z.object({ url: z.string(), type: z.string() }),
        z.object({ parsed: z.string(), format: z.string() }),
      )
        .pipe(fetchStage)
        .pipe(parseStage)
        .build();

      const { kernel, flush } = createTestKernel([workflow]);

      // When: I parse an HTML document
      const { workflowRunId } = await kernel.dispatch({
        type: "run.create",
        idempotencyKey: "key-html",
        workflowId: "flexible-parser",
        input: { url: "test.html", type: "html" },
      });
      await kernel.dispatch({ type: "run.claimPending", workerId: "worker-1" });

      for (const stageId of ["fetch", "parse"]) {
        await kernel.dispatch({
          type: "job.execute",
          workflowRunId,
          workflowId: "flexible-parser",
          stageId,
          config: {},
        });
        await kernel.dispatch({ type: "run.transition", workflowRunId });
      }
      await flush();

      // Then: HTML-specific parsing was applied
      expect(parsedContentType).toBe("html");
    });
  });

  describe("data pipeline workflow (extract, transform, load)", () => {
    it("should execute a complete ETL pipeline", async () => {
      // Given: An ETL pipeline with extraction, transformation, and loading
      const etlLog: { phase: string; records: number }[] = [];

      const extractStage = defineStage({
        id: "extract",
        name: "Extract Data",
        schemas: {
          input: z.object({
            source: z.string(),
            query: z.string(),
            limit: z.number().optional(),
          }),
          output: z.object({
            records: z.array(
              z.object({
                id: z.string(),
                name: z.string(),
                value: z.number(),
                timestamp: z.string(),
              }),
            ),
            extractedCount: z.number(),
            source: z.string(),
          }),
          config: z.object({
            batchSize: z.number().default(100),
          }),
        },
        async execute(ctx) {
          const limit = ctx.input.limit ?? 10;
          const records = Array.from({ length: limit }, (_, i) => ({
            id: `record-${i + 1}`,
            name: `Item ${i + 1}`,
            value: Math.floor(Math.random() * 1000),
            timestamp: new Date(Date.now() - i * 86400000).toISOString(),
          }));

          etlLog.push({ phase: "extract", records: records.length });

          return {
            output: {
              records,
              extractedCount: records.length,
              source: ctx.input.source,
            },
          };
        },
      });

      const transformStage = defineStage({
        id: "transform",
        name: "Transform Data",
        schemas: {
          input: z.object({
            records: z.array(
              z.object({
                id: z.string(),
                name: z.string(),
                value: z.number(),
                timestamp: z.string(),
              }),
            ),
            extractedCount: z.number(),
            source: z.string(),
          }),
          output: z.object({
            transformedRecords: z.array(
              z.object({
                id: z.string(),
                normalizedName: z.string(),
                category: z.string(),
                adjustedValue: z.number(),
                date: z.string(),
              }),
            ),
            transformedCount: z.number(),
            skippedCount: z.number(),
          }),
          config: z.object({
            valueThreshold: z.number().default(0),
            categoryRules: z
              .record(z.string())
              .default({ low: "< 300", medium: "< 700", high: ">= 700" }),
          }),
        },
        async execute(ctx) {
          const threshold = ctx.config.valueThreshold;
          const filtered = ctx.input.records.filter(
            (r) => r.value >= threshold,
          );

          const transformed = filtered.map((record) => {
            let category: string;
            if (record.value < 300) category = "low";
            else if (record.value < 700) category = "medium";
            else category = "high";

            return {
              id: record.id,
              normalizedName: record.name.toLowerCase().replace(/\s+/g, "_"),
              category,
              adjustedValue: record.value * 1.1,
              date: record.timestamp.split("T")[0],
            };
          });

          etlLog.push({ phase: "transform", records: transformed.length });

          return {
            output: {
              transformedRecords: transformed,
              transformedCount: transformed.length,
              skippedCount: ctx.input.extractedCount - transformed.length,
            },
          };
        },
      });

      const loadStage = defineStage({
        id: "load",
        name: "Load Data",
        schemas: {
          input: z.object({
            transformedRecords: z.array(
              z.object({
                id: z.string(),
                normalizedName: z.string(),
                category: z.string(),
                adjustedValue: z.number(),
                date: z.string(),
              }),
            ),
            transformedCount: z.number(),
            skippedCount: z.number(),
          }),
          output: z.object({
            loaded: z.boolean(),
            destination: z.string(),
            loadedCount: z.number(),
            skippedCount: z.number(),
            summary: z.object({
              byCategory: z.record(z.string(), z.number()),
              totalValue: z.number(),
            }),
          }),
          config: z.object({
            destination: z.string().default("data-warehouse"),
            validateBeforeLoad: z.boolean().default(true),
          }),
        },
        async execute(ctx) {
          const byCategory = ctx.input.transformedRecords.reduce(
            (acc, record) => {
              acc[record.category] = (acc[record.category] || 0) + 1;
              return acc;
            },
            {} as Record<string, number>,
          );

          const totalValue = ctx.input.transformedRecords.reduce(
            (sum, r) => sum + r.adjustedValue,
            0,
          );

          etlLog.push({
            phase: "load",
            records: ctx.input.transformedRecords.length,
          });

          return {
            output: {
              loaded: true,
              destination: ctx.config.destination,
              loadedCount: ctx.input.transformedCount,
              skippedCount: ctx.input.skippedCount,
              summary: {
                byCategory,
                totalValue: Math.round(totalValue * 100) / 100,
              },
            },
          };
        },
      });

      const workflow = new WorkflowBuilder(
        "etl-pipeline",
        "ETL Pipeline",
        "Extract, Transform, Load data pipeline",
        z.object({
          source: z.string(),
          query: z.string(),
          limit: z.number().optional(),
        }),
        z.object({
          loaded: z.boolean(),
          destination: z.string(),
          loadedCount: z.number(),
          skippedCount: z.number(),
          summary: z.object({
            byCategory: z.record(z.string(), z.number()),
            totalValue: z.number(),
          }),
        }),
      )
        .pipe(extractStage)
        .pipe(transformStage)
        .pipe(loadStage)
        .build();

      const config = {
        extract: { batchSize: 50 },
        transform: { valueThreshold: 100 },
        load: {
          destination: "analytics-warehouse",
          validateBeforeLoad: true,
        },
      };

      const { kernel, flush, persistence, blobStore } = createTestKernel([workflow]);

      // When: I execute the ETL pipeline
      const { workflowRunId } = await kernel.dispatch({
        type: "run.create",
        idempotencyKey: "key-etl",
        workflowId: "etl-pipeline",
        input: {
          source: "sales-db",
          query: "SELECT * FROM orders",
          limit: 20,
        },
        config,
      });
      await kernel.dispatch({ type: "run.claimPending", workerId: "worker-1" });

      for (const stageId of ["extract", "transform", "load"]) {
        await kernel.dispatch({
          type: "job.execute",
          workflowRunId,
          workflowId: "etl-pipeline",
          stageId,
          config,
        });
        await kernel.dispatch({ type: "run.transition", workflowRunId });
      }
      await flush();

      // Then: ETL completed successfully
      const run = await persistence.getRun(workflowRunId);
      expect(run!.status).toBe("COMPLETED");

      // Verify via the load stage output in blobStore
      const keys = await blobStore.list("");
      const loadKey = keys.find((k) => k.includes("/load/output.json"));
      expect(loadKey).toBeDefined();
      const loadOutput = (await blobStore.get(loadKey!)) as any;
      expect(loadOutput.loaded).toBe(true);
      expect(loadOutput.destination).toBe("analytics-warehouse");
      expect(loadOutput.loadedCount).toBeGreaterThan(0);

      // And: All phases executed in order
      expect(etlLog.map((l) => l.phase)).toEqual([
        "extract",
        "transform",
        "load",
      ]);
    });

    it("should handle ETL with parallel transformations", async () => {
      // Given: An ETL pipeline with parallel transformation branches
      const extractStage = defineStage({
        id: "extract",
        name: "Extract",
        schemas: {
          input: z.object({ source: z.string() }),
          output: z.object({ data: z.array(z.number()) }),
          config: z.object({}),
        },
        async execute() {
          return { output: { data: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] } };
        },
      });

      const sumTransform = defineStage({
        id: "transform-sum",
        name: "Sum Transform",
        schemas: {
          input: z.object({ data: z.array(z.number()) }).passthrough(),
          output: z.object({ sum: z.number() }),
          config: z.object({}),
        },
        async execute(ctx) {
          // Use workflowContext for reliable access to extract output
          const extractOutput = ctx.workflowContext["extract"] as { data: number[] };
          return { output: { sum: extractOutput.data.reduce((a, b) => a + b, 0) } };
        },
      });

      const avgTransform = defineStage({
        id: "transform-avg",
        name: "Average Transform",
        schemas: {
          input: z.object({}).passthrough(),
          output: z.object({ average: z.number() }),
          config: z.object({}),
        },
        async execute(ctx) {
          const extractOutput = ctx.workflowContext["extract"] as { data: number[] };
          const avg =
            extractOutput.data.reduce((a, b) => a + b, 0) / extractOutput.data.length;
          return { output: { average: avg } };
        },
      });

      const minMaxTransform = defineStage({
        id: "transform-minmax",
        name: "MinMax Transform",
        schemas: {
          input: z.object({}).passthrough(),
          output: z.object({ min: z.number(), max: z.number() }),
          config: z.object({}),
        },
        async execute(ctx) {
          const extractOutput = ctx.workflowContext["extract"] as { data: number[] };
          return {
            output: {
              min: Math.min(...extractOutput.data),
              max: Math.max(...extractOutput.data),
            },
          };
        },
      });

      const loadStage = defineStage({
        id: "load",
        name: "Load",
        schemas: {
          input: z.any(),
          output: z.object({
            stats: z.object({
              sum: z.number(),
              average: z.number(),
              min: z.number(),
              max: z.number(),
            }),
          }),
          config: z.object({}),
        },
        async execute(ctx) {
          const sumOutput = ctx.require("transform-sum" as never) as {
            sum: number;
          };
          const avgOutput = ctx.require("transform-avg" as never) as {
            average: number;
          };
          const minmaxOutput = ctx.require("transform-minmax" as never) as {
            min: number;
            max: number;
          };

          return {
            output: {
              stats: {
                sum: sumOutput.sum,
                average: avgOutput.average,
                min: minmaxOutput.min,
                max: minmaxOutput.max,
              },
            },
          };
        },
      });

      const workflow = new WorkflowBuilder(
        "parallel-etl",
        "Parallel ETL",
        "ETL with parallel transformations",
        z.object({ source: z.string() }),
        z.object({
          stats: z.object({
            sum: z.number(),
            average: z.number(),
            min: z.number(),
            max: z.number(),
          }),
        }),
      )
        .pipe(extractStage)
        .parallel([sumTransform, avgTransform, minMaxTransform])
        .pipe(loadStage)
        .build();

      const { kernel, flush, persistence } = createTestKernel([workflow]);

      // When: I execute with parallel transformations
      const { workflowRunId } = await kernel.dispatch({
        type: "run.create",
        idempotencyKey: "key-parallel-etl",
        workflowId: "parallel-etl",
        input: { source: "test" },
      });
      await kernel.dispatch({ type: "run.claimPending", workerId: "worker-1" });

      // Execute extract
      await kernel.dispatch({
        type: "job.execute",
        workflowRunId,
        workflowId: "parallel-etl",
        stageId: "extract",
        config: {},
      });
      await kernel.dispatch({ type: "run.transition", workflowRunId });

      // Execute all parallel transforms
      for (const stageId of ["transform-sum", "transform-avg", "transform-minmax"]) {
        await kernel.dispatch({
          type: "job.execute",
          workflowRunId,
          workflowId: "parallel-etl",
          stageId,
          config: {},
        });
      }
      await kernel.dispatch({ type: "run.transition", workflowRunId });

      // Execute load
      const loadResult = await kernel.dispatch({
        type: "job.execute",
        workflowRunId,
        workflowId: "parallel-etl",
        stageId: "load",
        config: {},
      });
      await kernel.dispatch({ type: "run.transition", workflowRunId });
      await flush();

      // Then: All transformations completed and merged
      expect(loadResult.output).toEqual({
        stats: {
          sum: 55,
          average: 5.5,
          min: 1,
          max: 10,
        },
      });

      // And: Run completed
      const run = await persistence.getRun(workflowRunId);
      expect(run!.status).toBe("COMPLETED");
    });
  });

  describe("validation workflow with parallel checks", () => {
    it("should run parallel validation checks and aggregate results", async () => {
      // Given: A validation workflow with parallel checks
      const validationChecks: string[] = [];

      const prepareStage = defineStage({
        id: "prepare",
        name: "Prepare Data",
        schemas: {
          input: z.object({
            userId: z.string(),
            email: z.string(),
            age: z.number(),
            country: z.string(),
          }),
          output: z.object({
            userData: z.object({
              userId: z.string(),
              email: z.string(),
              age: z.number(),
              country: z.string(),
            }),
            preparedAt: z.string(),
          }),
          config: z.object({}),
        },
        async execute(ctx) {
          return {
            output: {
              userData: ctx.input,
              preparedAt: new Date().toISOString(),
            },
          };
        },
      });

      const emailCheck = defineStage({
        id: "check-email",
        name: "Email Validation",
        schemas: {
          input: z.object({}).passthrough(),
          output: z.object({
            valid: z.boolean(),
            check: z.literal("email"),
            message: z.string().optional(),
          }),
          config: z.object({}),
        },
        async execute(ctx) {
          validationChecks.push("email");
          const prepareOutput = ctx.workflowContext["prepare"] as {
            userData: { email: string };
          };
          const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
          const valid = emailRegex.test(prepareOutput.userData.email);

          return {
            output: {
              valid,
              check: "email" as const,
              message: valid ? undefined : "Invalid email format",
            },
          };
        },
      });

      const ageCheck = defineStage({
        id: "check-age",
        name: "Age Validation",
        schemas: {
          input: z.object({}).passthrough(),
          output: z.object({
            valid: z.boolean(),
            check: z.literal("age"),
            message: z.string().optional(),
          }),
          config: z.object({
            minAge: z.number().default(18),
            maxAge: z.number().default(120),
          }),
        },
        async execute(ctx) {
          validationChecks.push("age");
          const prepareOutput = ctx.workflowContext["prepare"] as {
            userData: { age: number };
          };
          const valid =
            prepareOutput.userData.age >= ctx.config.minAge &&
            prepareOutput.userData.age <= ctx.config.maxAge;

          return {
            output: {
              valid,
              check: "age" as const,
              message: valid
                ? undefined
                : `Age must be between ${ctx.config.minAge} and ${ctx.config.maxAge}`,
            },
          };
        },
      });

      const countryCheck = defineStage({
        id: "check-country",
        name: "Country Validation",
        schemas: {
          input: z.object({}).passthrough(),
          output: z.object({
            valid: z.boolean(),
            check: z.literal("country"),
            message: z.string().optional(),
          }),
          config: z.object({
            allowedCountries: z
              .array(z.string())
              .default(["US", "CA", "UK", "DE", "FR"]),
          }),
        },
        async execute(ctx) {
          validationChecks.push("country");
          const prepareOutput = ctx.workflowContext["prepare"] as {
            userData: { country: string };
          };
          const valid = ctx.config.allowedCountries.includes(
            prepareOutput.userData.country,
          );

          return {
            output: {
              valid,
              check: "country" as const,
              message: valid
                ? undefined
                : `Country ${prepareOutput.userData.country} is not supported`,
            },
          };
        },
      });

      const duplicateCheck = defineStage({
        id: "check-duplicate",
        name: "Duplicate Check",
        schemas: {
          input: z.object({}).passthrough(),
          output: z.object({
            valid: z.boolean(),
            check: z.literal("duplicate"),
            message: z.string().optional(),
          }),
          config: z.object({}),
        },
        async execute(ctx) {
          validationChecks.push("duplicate");
          const prepareOutput = ctx.workflowContext["prepare"] as {
            userData: { email: string };
          };
          const valid = !prepareOutput.userData.email.includes("duplicate");

          return {
            output: {
              valid,
              check: "duplicate" as const,
              message: valid ? undefined : "Email already exists",
            },
          };
        },
      });

      const aggregateStage = defineStage({
        id: "aggregate-results",
        name: "Aggregate Results",
        schemas: {
          input: z.any(),
          output: z.object({
            allValid: z.boolean(),
            validationResults: z.array(
              z.object({
                check: z.string(),
                valid: z.boolean(),
                message: z.string().optional(),
              }),
            ),
            errors: z.array(z.string()),
          }),
          config: z.object({}),
        },
        async execute(ctx) {
          const emailResult = ctx.require("check-email" as never) as {
            valid: boolean;
            check: string;
            message?: string;
          };
          const ageResult = ctx.require("check-age" as never) as {
            valid: boolean;
            check: string;
            message?: string;
          };
          const countryResult = ctx.require("check-country" as never) as {
            valid: boolean;
            check: string;
            message?: string;
          };
          const duplicateResult = ctx.require("check-duplicate" as never) as {
            valid: boolean;
            check: string;
            message?: string;
          };

          const results = [
            emailResult,
            ageResult,
            countryResult,
            duplicateResult,
          ];
          const errors = results.filter((r) => !r.valid).map((r) => r.message!);

          return {
            output: {
              allValid: results.every((r) => r.valid),
              validationResults: results,
              errors,
            },
          };
        },
      });

      const workflow = new WorkflowBuilder(
        "validation-workflow",
        "Validation Workflow",
        "Parallel validation checks",
        z.object({
          userId: z.string(),
          email: z.string(),
          age: z.number(),
          country: z.string(),
        }),
        z.object({
          allValid: z.boolean(),
          validationResults: z.array(
            z.object({
              check: z.string(),
              valid: z.boolean(),
              message: z.string().optional(),
            }),
          ),
          errors: z.array(z.string()),
        }),
      )
        .pipe(prepareStage)
        .parallel([emailCheck, ageCheck, countryCheck, duplicateCheck])
        .pipe(aggregateStage)
        .build();

      const config = {
        "check-age": { minAge: 18, maxAge: 100 },
        "check-country": { allowedCountries: ["US", "CA", "UK"] },
      };

      const { kernel, flush, persistence } = createTestKernel([workflow]);

      // When: I validate valid user data
      const { workflowRunId } = await kernel.dispatch({
        type: "run.create",
        idempotencyKey: "key-validation",
        workflowId: "validation-workflow",
        input: {
          userId: "user-123",
          email: "test@example.com",
          age: 25,
          country: "US",
        },
        config,
      });
      await kernel.dispatch({ type: "run.claimPending", workerId: "worker-1" });

      // Execute prepare stage
      await kernel.dispatch({
        type: "job.execute",
        workflowRunId,
        workflowId: "validation-workflow",
        stageId: "prepare",
        config,
      });
      await kernel.dispatch({ type: "run.transition", workflowRunId });

      // Execute all parallel checks
      for (const stageId of ["check-email", "check-age", "check-country", "check-duplicate"]) {
        await kernel.dispatch({
          type: "job.execute",
          workflowRunId,
          workflowId: "validation-workflow",
          stageId,
          config,
        });
      }
      await kernel.dispatch({ type: "run.transition", workflowRunId });

      // Execute aggregate
      const aggregateResult = await kernel.dispatch({
        type: "job.execute",
        workflowRunId,
        workflowId: "validation-workflow",
        stageId: "aggregate-results",
        config,
      });
      await kernel.dispatch({ type: "run.transition", workflowRunId });
      await flush();

      // Then: All validations passed
      expect(aggregateResult.output).toMatchObject({
        allValid: true,
        errors: [],
      });
      expect((aggregateResult.output as any).validationResults).toHaveLength(4);

      // And: All checks ran
      expect(validationChecks).toHaveLength(4);

      // And: Run completed
      const run = await persistence.getRun(workflowRunId);
      expect(run!.status).toBe("COMPLETED");
    });

    it("should collect validation errors from multiple failing checks", async () => {
      // Given: A simplified validation workflow
      const emailCheck = defineStage({
        id: "email-check",
        name: "Email Check",
        schemas: {
          input: z.object({ email: z.string() }).passthrough(),
          output: z.object({
            valid: z.boolean(),
            error: z.string().optional(),
          }),
          config: z.object({}),
        },
        async execute(ctx) {
          const valid = ctx.input.email.includes("@");
          return {
            output: { valid, error: valid ? undefined : "Invalid email" },
          };
        },
      });

      const lengthCheck = defineStage({
        id: "length-check",
        name: "Length Check",
        schemas: {
          input: z.object({}).passthrough(),
          output: z.object({
            valid: z.boolean(),
            error: z.string().optional(),
          }),
          config: z.object({}),
        },
        async execute(ctx) {
          // Access workflow input via workflowContext is not available for first group.
          // For first-group parallel, we get the run input directly or sibling output.
          // Use a workaround: read email from whatever input we get
          const email = (ctx.input as any).email ?? "";
          const valid = email.length >= 5;
          return {
            output: { valid, error: valid ? undefined : "Too short" },
          };
        },
      });

      const aggregate = defineStage({
        id: "aggregate",
        name: "Aggregate",
        schemas: {
          input: z.any(),
          output: z.object({ errors: z.array(z.string()) }),
          config: z.object({}),
        },
        async execute(ctx) {
          const email = ctx.require("email-check" as never) as {
            valid: boolean;
            error?: string;
          };
          const length = ctx.require("length-check" as never) as {
            valid: boolean;
            error?: string;
          };

          const errors = [email, length]
            .filter((r) => !r.valid)
            .map((r) => r.error!);
          return { output: { errors } };
        },
      });

      const workflow = new WorkflowBuilder(
        "multi-error-validation",
        "Multi-Error Validation",
        "Test multiple validation errors",
        z.object({ email: z.string() }),
        z.object({ errors: z.array(z.string()) }),
      )
        .parallel([emailCheck, lengthCheck])
        .pipe(aggregate)
        .build();

      const { kernel, flush, persistence } = createTestKernel([workflow]);

      // When: I validate with invalid data that fails multiple checks
      const { workflowRunId } = await kernel.dispatch({
        type: "run.create",
        idempotencyKey: "key-multi-error",
        workflowId: "multi-error-validation",
        input: { email: "ab" },
      });
      await kernel.dispatch({ type: "run.claimPending", workerId: "worker-1" });

      // Execute parallel checks (first group)
      for (const stageId of ["email-check", "length-check"]) {
        await kernel.dispatch({
          type: "job.execute",
          workflowRunId,
          workflowId: "multi-error-validation",
          stageId,
          config: {},
        });
      }
      await kernel.dispatch({ type: "run.transition", workflowRunId });

      // Execute aggregate
      const aggregateResult = await kernel.dispatch({
        type: "job.execute",
        workflowRunId,
        workflowId: "multi-error-validation",
        stageId: "aggregate",
        config: {},
      });
      await kernel.dispatch({ type: "run.transition", workflowRunId });
      await flush();

      // Then: All errors are collected
      const errors = (aggregateResult.output as any).errors;
      expect(errors).toHaveLength(2);
      expect(errors).toContain("Invalid email");
      expect(errors).toContain("Too short");

      // And: Run completed
      const run = await persistence.getRun(workflowRunId);
      expect(run!.status).toBe("COMPLETED");
    });
  });
});
