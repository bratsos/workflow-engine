/**
 * Schema Helpers Tests
 *
 * Tests for NoInputSchema and the `ctx.require()` / `ctx.optional()`
 * context helpers that replaced the standalone `requireStageOutput()`.
 */

import { describe, expect, it } from "vitest";
import { z } from "zod";
import { NoInputSchema } from "../../core/schema-helpers.js";
import type { EnhancedStageContext } from "../../core/stage-factory.js";
import { defineStage } from "../../core/stage-factory.js";
import { createTestStepApi } from "../utils/index.js";

/**
 * Run `fn` inside a stage's `execute()` against a hand-built workflow
 * context, without a kernel.
 */
async function withContext<TContext extends Record<string, unknown>>(
  workflowContext: Partial<TContext>,
  fn: (ctx: EnhancedStageContext<unknown, unknown, TContext>) => unknown,
): Promise<unknown> {
  let captured: unknown;
  const stage = defineStage<TContext>()({
    id: "probe",
    name: "Probe",
    schemas: { input: "none", output: z.unknown(), config: z.object({}) },
    async execute(ctx) {
      captured = fn(ctx);
      return { output: captured };
    },
  });
  await stage.execute({
    workflowRunId: "run",
    stageId: "probe",
    stageNumber: 1,
    stageName: "Probe",
    input: {},
    config: {},
    onProgress() {},
    step: createTestStepApi(),
    abortSignal: new AbortController().signal,
    onLog() {},
    log() {},
    annotate() {},
    storage: {} as never,
    ai: {} as never,
    aiLogger: {} as never,
    workflowContext,
  });
  return captured;
}

describe("I want to use schema helpers to access stage outputs", () => {
  describe("NoInputSchema", () => {
    it("should parse empty object", () => {
      // Given: NoInputSchema
      // When: I parse an empty object
      const result = NoInputSchema.parse({});

      // Then: Returns empty object
      expect(result).toEqual({});
    });

    it("should strip extra properties", () => {
      // Given: NoInputSchema
      // When: I parse an object with extra properties
      const result = NoInputSchema.parse({ foo: "bar" });

      // Then: Returns empty object (extra properties stripped)
      expect(result).toEqual({});
    });
  });

  describe("ctx.require", () => {
    it("should return stage output when present", async () => {
      // Given: A workflow context with stage output
      type Ctx = { "data-extraction": { text: string; pages: number } };
      const workflowContext: Ctx = {
        "data-extraction": { text: "extracted content", pages: 5 },
      };

      // When: I require the stage output
      const output = await withContext<Ctx>(workflowContext, (ctx) =>
        ctx.require("data-extraction"),
      );

      // Then: Returns the full output
      expect(output).toEqual({ text: "extracted content", pages: 5 });
    });

    it("should throw when stage output is missing", async () => {
      // Given: An empty workflow context
      type Ctx = { "missing-stage": { value: number } };

      // When/Then: Requiring the missing stage throws
      await expect(
        withContext<Ctx>({}, (ctx) => ctx.require("missing-stage")),
      ).rejects.toThrow('Missing required stage output: "missing-stage"');
    });

    it("should include available stages in error message", async () => {
      // Given: A workflow context with some stages
      type Ctx = {
        "stage-a": { value: number };
        "stage-b": { value: number };
        "stage-c": { value: number };
      };
      const workflowContext: Partial<Ctx> = {
        "stage-a": { value: 1 },
        "stage-b": { value: 2 },
      };

      // When/Then: Error includes available stages
      await expect(
        withContext<Ctx>(workflowContext, (ctx) => ctx.require("stage-c")),
      ).rejects.toThrow("Available stages: stage-a, stage-b");
    });

    describe("falsy-but-defined outputs pass through (not treated as missing)", () => {
      it("should return 0, an empty string, false and null as legitimate outputs", async () => {
        // Given: Stage outputs that are falsy but not undefined
        type Ctx = {
          "count-stage": number;
          "text-stage": string;
          "flag-stage": boolean;
          "null-stage": null;
        };
        const workflowContext: Ctx = {
          "count-stage": 0,
          "text-stage": "",
          "flag-stage": false,
          "null-stage": null,
        };

        // When: I require each stage output
        const output = await withContext<Ctx>(workflowContext, (ctx) => [
          ctx.require("count-stage"),
          ctx.require("text-stage"),
          ctx.require("flag-stage"),
          ctx.require("null-stage"),
        ]);

        // Then: Each value is returned, nothing throws
        expect(output).toEqual([0, "", false, null]);
      });
    });
  });

  describe("ctx.optional", () => {
    it("should return undefined instead of throwing for a missing stage", async () => {
      // Given: An empty workflow context
      type Ctx = { "maybe-stage": { value: number } };

      // When: I optionally read the stage output
      const output = await withContext<Ctx>({}, (ctx) =>
        ctx.optional("maybe-stage"),
      );

      // Then: undefined, no throw
      expect(output).toBeUndefined();
    });
  });

  describe("real-world usage patterns", () => {
    it("should support typed extraction from workflow context", async () => {
      // Given: A realistic workflow context
      interface ExtractionOutput {
        text: string;
        tables: Array<{ headers: string[]; rows: string[][] }>;
        metadata: { pageCount: number; wordCount: number };
      }

      interface GuidelinesOutput {
        guidelines: Array<{ id: string; text: string; priority: number }>;
      }

      type Ctx = {
        "pdf-extraction": ExtractionOutput;
        guidelines: GuidelinesOutput;
      };

      const workflowContext: Ctx = {
        "pdf-extraction": {
          text: "Document content...",
          tables: [{ headers: ["Name", "Value"], rows: [["Item1", "100"]] }],
          metadata: { pageCount: 10, wordCount: 5000 },
        },
        guidelines: {
          guidelines: [
            { id: "g1", text: "Guideline 1", priority: 1 },
            { id: "g2", text: "Guideline 2", priority: 2 },
          ],
        },
      };

      // When: I access multiple stages
      const output = (await withContext<Ctx>(workflowContext, (ctx) => ({
        pageCount: ctx.require("pdf-extraction").metadata.pageCount,
        guidelines: ctx.require("guidelines").guidelines,
      }))) as {
        pageCount: number;
        guidelines: GuidelinesOutput["guidelines"];
      };

      // Then: Data is correctly typed and accessible
      expect(output.pageCount).toBe(10);
      expect(output.guidelines).toHaveLength(2);
      expect(output.guidelines[0]?.priority).toBe(1);
    });
  });
});
