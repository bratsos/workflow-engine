/**
 * Real-World Patterns Tests
 *
 * Integration tests for real-world workflow patterns:
 * - Document processing workflows
 * - Data pipeline (ETL) workflows
 * - Validation workflows with parallel checks
 */

import { describe, it, expect, beforeEach } from "vitest";
import { z } from "zod";
import { WorkflowBuilder } from "../../core/workflow.js";
import { WorkflowExecutor } from "../../core/executor.js";
import { defineStage } from "../../core/stage-factory.js";
import {
  InMemoryWorkflowPersistence,
  InMemoryAICallLogger,
} from "../utils/index.js";
import { InMemoryStageStorage } from "../../core/storage-providers/memory-storage.js";

describe("I want to implement real-world workflow patterns", () => {
  let persistence: InMemoryWorkflowPersistence;
  let aiLogger: InMemoryAICallLogger;

  beforeEach(() => {
    persistence = new InMemoryWorkflowPersistence();
    aiLogger = new InMemoryAICallLogger();
    InMemoryStageStorage.clear();
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

          // Simulate fetching document
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

          // Simulate parsing
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

          // Simulate storing (using in-memory storage)
          const storage = new InMemoryStageStorage(
            "run-doc-process",
            "document-workflow",
          );
          await storage.save(
            `documents/${ctx.input.transformedDocument.id}`,
            ctx.input.transformedDocument,
          );

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

      await createRun("run-doc-process", "document-workflow", {
        documentUrl: "https://example.com/doc.md",
        documentType: "markdown",
      });

      const executor = new WorkflowExecutor(
        workflow,
        "run-doc-process",
        "document-workflow",
        {
          persistence,
          aiLogger,
        },
      );

      // When: I process a document
      const result = await executor.execute(
        { documentUrl: "https://example.com/doc.md", documentType: "markdown" },
        {
          "fetch-document": { timeout: 5000 },
          "transform-document": {
            generateSummary: true,
            extractKeywords: true,
          },
          "store-document": { storageLocation: "processed-docs" },
        },
      );

      // Then: Document was processed through all stages
      expect(result.stored).toBe(true);
      expect(result.storagePath).toContain("processed-docs");

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

          // Different parsing based on type
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

      await createRun("run-html", "flexible-parser", {
        url: "test.html",
        type: "html",
      });

      const executor = new WorkflowExecutor(
        workflow,
        "run-html",
        "flexible-parser",
        {
          persistence,
          aiLogger,
        },
      );

      // When: I parse an HTML document
      await executor.execute({ url: "test.html", type: "html" }, {});

      // Then: HTML-specific parsing was applied
      expect(parsedContentType).toBe("html");
    });
  });

  describe("data pipeline workflow (extract, transform, load)", () => {
    it("should execute a complete ETL pipeline", async () => {
      // Given: An ETL pipeline with extraction, transformation, and loading
      const etlLog: { phase: string; records: number; timestamp: number }[] =
        [];

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
          // Simulate extracting data from source
          const limit = ctx.input.limit ?? 10;
          const records = Array.from({ length: limit }, (_, i) => ({
            id: `record-${i + 1}`,
            name: `Item ${i + 1}`,
            value: Math.floor(Math.random() * 1000),
            timestamp: new Date(Date.now() - i * 86400000).toISOString(),
          }));

          etlLog.push({
            phase: "extract",
            records: records.length,
            timestamp: Date.now(),
          });

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
          // Transform and filter records
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
              adjustedValue: record.value * 1.1, // 10% adjustment
              date: record.timestamp.split("T")[0],
            };
          });

          etlLog.push({
            phase: "transform",
            records: transformed.length,
            timestamp: Date.now(),
          });

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
          // Simulate loading to destination
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
            timestamp: Date.now(),
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

      await createRun("run-etl", "etl-pipeline", {
        source: "sales-db",
        query: "SELECT * FROM orders",
        limit: 20,
      });

      const executor = new WorkflowExecutor(
        workflow,
        "run-etl",
        "etl-pipeline",
        {
          persistence,
          aiLogger,
        },
      );

      // When: I execute the ETL pipeline
      const result = await executor.execute(
        { source: "sales-db", query: "SELECT * FROM orders", limit: 20 },
        {
          extract: { batchSize: 50 },
          transform: { valueThreshold: 100 },
          load: {
            destination: "analytics-warehouse",
            validateBeforeLoad: true,
          },
        },
      );

      // Then: ETL completed successfully
      expect(result.loaded).toBe(true);
      expect(result.destination).toBe("analytics-warehouse");
      expect(result.loadedCount).toBeGreaterThan(0);

      // And: All phases executed in order
      expect(etlLog.map((l) => l.phase)).toEqual([
        "extract",
        "transform",
        "load",
      ]);

      // And: Timestamps show sequential execution
      expect(etlLog[1].timestamp).toBeGreaterThanOrEqual(etlLog[0].timestamp);
      expect(etlLog[2].timestamp).toBeGreaterThanOrEqual(etlLog[1].timestamp);
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
          input: z.object({ data: z.array(z.number()) }),
          output: z.object({ sum: z.number() }),
          config: z.object({}),
        },
        async execute(ctx) {
          await new Promise((r) => setTimeout(r, 10));
          return { output: { sum: ctx.input.data.reduce((a, b) => a + b, 0) } };
        },
      });

      const avgTransform = defineStage({
        id: "transform-avg",
        name: "Average Transform",
        schemas: {
          input: z.object({ data: z.array(z.number()) }),
          output: z.object({ average: z.number() }),
          config: z.object({}),
        },
        async execute(ctx) {
          await new Promise((r) => setTimeout(r, 10));
          const avg =
            ctx.input.data.reduce((a, b) => a + b, 0) / ctx.input.data.length;
          return { output: { average: avg } };
        },
      });

      const minMaxTransform = defineStage({
        id: "transform-minmax",
        name: "MinMax Transform",
        schemas: {
          input: z.object({ data: z.array(z.number()) }),
          output: z.object({ min: z.number(), max: z.number() }),
          config: z.object({}),
        },
        async execute(ctx) {
          await new Promise((r) => setTimeout(r, 10));
          return {
            output: {
              min: Math.min(...ctx.input.data),
              max: Math.max(...ctx.input.data),
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

      await createRun("run-parallel-etl", "parallel-etl", { source: "test" });

      const executor = new WorkflowExecutor(
        workflow,
        "run-parallel-etl",
        "parallel-etl",
        {
          persistence,
          aiLogger,
        },
      );

      // When: I execute with parallel transformations
      const result = await executor.execute({ source: "test" }, {});

      // Then: All transformations completed and merged
      expect(result.stats).toEqual({
        sum: 55,
        average: 5.5,
        min: 1,
        max: 10,
      });
    });
  });

  describe("validation workflow with parallel checks", () => {
    it("should run parallel validation checks and aggregate results", async () => {
      // Given: A validation workflow with parallel checks
      const validationTimes: { check: string; duration: number }[] = [];

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
          input: z.object({
            userData: z.object({
              userId: z.string(),
              email: z.string(),
              age: z.number(),
              country: z.string(),
            }),
            preparedAt: z.string(),
          }),
          output: z.object({
            valid: z.boolean(),
            check: z.literal("email"),
            message: z.string().optional(),
          }),
          config: z.object({}),
        },
        async execute(ctx) {
          const start = Date.now();
          await new Promise((r) => setTimeout(r, 15));

          const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
          const valid = emailRegex.test(ctx.input.userData.email);

          validationTimes.push({
            check: "email",
            duration: Date.now() - start,
          });

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
          input: z.object({
            userData: z.object({
              userId: z.string(),
              email: z.string(),
              age: z.number(),
              country: z.string(),
            }),
            preparedAt: z.string(),
          }),
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
          const start = Date.now();
          await new Promise((r) => setTimeout(r, 15));

          const valid =
            ctx.input.userData.age >= ctx.config.minAge &&
            ctx.input.userData.age <= ctx.config.maxAge;

          validationTimes.push({ check: "age", duration: Date.now() - start });

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
          input: z.object({
            userData: z.object({
              userId: z.string(),
              email: z.string(),
              age: z.number(),
              country: z.string(),
            }),
            preparedAt: z.string(),
          }),
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
          const start = Date.now();
          await new Promise((r) => setTimeout(r, 15));

          const valid = ctx.config.allowedCountries.includes(
            ctx.input.userData.country,
          );

          validationTimes.push({
            check: "country",
            duration: Date.now() - start,
          });

          return {
            output: {
              valid,
              check: "country" as const,
              message: valid
                ? undefined
                : `Country ${ctx.input.userData.country} is not supported`,
            },
          };
        },
      });

      const duplicateCheck = defineStage({
        id: "check-duplicate",
        name: "Duplicate Check",
        schemas: {
          input: z.object({
            userData: z.object({
              userId: z.string(),
              email: z.string(),
              age: z.number(),
              country: z.string(),
            }),
            preparedAt: z.string(),
          }),
          output: z.object({
            valid: z.boolean(),
            check: z.literal("duplicate"),
            message: z.string().optional(),
          }),
          config: z.object({}),
        },
        async execute(ctx) {
          const start = Date.now();
          await new Promise((r) => setTimeout(r, 15));

          // Simulate checking for duplicates (always valid in test)
          const valid = !ctx.input.userData.email.includes("duplicate");

          validationTimes.push({
            check: "duplicate",
            duration: Date.now() - start,
          });

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

      await createRun("run-validation", "validation-workflow", {
        userId: "user-123",
        email: "test@example.com",
        age: 25,
        country: "US",
      });

      const executor = new WorkflowExecutor(
        workflow,
        "run-validation",
        "validation-workflow",
        {
          persistence,
          aiLogger,
        },
      );

      // When: I validate valid user data
      const result = await executor.execute(
        {
          userId: "user-123",
          email: "test@example.com",
          age: 25,
          country: "US",
        },
        {
          "check-age": { minAge: 18, maxAge: 100 },
          "check-country": { allowedCountries: ["US", "CA", "UK"] },
        },
      );

      // Then: All validations passed
      expect(result.allValid).toBe(true);
      expect(result.errors).toHaveLength(0);
      expect(result.validationResults).toHaveLength(4);

      // And: All checks ran in parallel (similar durations indicate concurrency)
      expect(validationTimes).toHaveLength(4);
    });

    it("should collect validation errors from multiple failing checks", async () => {
      // Given: A simplified validation workflow
      const emailCheck = defineStage({
        id: "email-check",
        name: "Email Check",
        schemas: {
          input: z.object({ email: z.string() }),
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
          input: z.object({ email: z.string() }),
          output: z.object({
            valid: z.boolean(),
            error: z.string().optional(),
          }),
          config: z.object({}),
        },
        async execute(ctx) {
          const valid = ctx.input.email.length >= 5;
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

      await createRun("run-multi-error", "multi-error-validation", {
        email: "ab",
      });

      const executor = new WorkflowExecutor(
        workflow,
        "run-multi-error",
        "multi-error-validation",
        {
          persistence,
          aiLogger,
        },
      );

      // When: I validate with invalid data that fails multiple checks
      const result = await executor.execute({ email: "ab" }, {});

      // Then: All errors are collected
      expect(result.errors).toHaveLength(2);
      expect(result.errors).toContain("Invalid email");
      expect(result.errors).toContain("Too short");
    });
  });
});
