/**
 * Schema Helpers Tests
 *
 * Tests for requireStageOutput and NoInputSchema.
 */

import { describe, expect, it } from "vitest";
import {
  NoInputSchema,
  requireStageOutput,
} from "../../core/schema-helpers.js";

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

  describe("requireStageOutput", () => {
    describe("full output access", () => {
      it("should return stage output when present", () => {
        // Given: A workflow context with stage output
        const workflowContext: Record<string, unknown> = {
          "data-extraction": { text: "extracted content", pages: 5 },
        };

        // When: I require the stage output
        const output = requireStageOutput<{ text: string; pages: number }>(
          workflowContext,
          "data-extraction",
        );

        // Then: Returns the full output
        expect(output).toEqual({ text: "extracted content", pages: 5 });
      });

      it("should throw when stage output is missing", () => {
        // Given: An empty workflow context
        const workflowContext: Record<string, unknown> = {};

        // When/Then: Requiring missing stage throws
        expect(() =>
          requireStageOutput(workflowContext, "missing-stage"),
        ).toThrow("Missing output from required stage: missing-stage");
      });

      it("should include available stages in error message", () => {
        // Given: A workflow context with some stages
        const workflowContext: Record<string, unknown> = {
          "stage-a": { value: 1 },
          "stage-b": { value: 2 },
        };

        // When/Then: Error includes available stages
        expect(() => requireStageOutput(workflowContext, "stage-c")).toThrow(
          "Available stages: stage-a, stage-b",
        );
      });
    });

    describe("field access", () => {
      it("should return specific field when present", () => {
        // Given: A workflow context with stage output containing fields
        const workflowContext: Record<string, unknown> = {
          guidelines: {
            guidelines: [
              { id: "g1", text: "Guideline 1" },
              { id: "g2", text: "Guideline 2" },
            ],
            metadata: { count: 2 },
          },
        };

        // When: I require a specific field
        const guidelines = requireStageOutput<
          Array<{ id: string; text: string }>
        >(workflowContext, "guidelines", "guidelines");

        // Then: Returns just that field
        expect(guidelines).toEqual([
          { id: "g1", text: "Guideline 1" },
          { id: "g2", text: "Guideline 2" },
        ]);
      });

      it("should throw when field is missing", () => {
        // Given: A workflow context with stage output
        const workflowContext: Record<string, unknown> = {
          "my-stage": { existingField: "value" },
        };

        // When/Then: Requiring missing field throws
        expect(() =>
          requireStageOutput(workflowContext, "my-stage", "missingField"),
        ).toThrow("Missing required field 'missingField' in my-stage output");
      });

      it("should include available fields in error message", () => {
        // Given: A workflow context with stage output
        const workflowContext: Record<string, unknown> = {
          "my-stage": { fieldA: 1, fieldB: 2 },
        };

        // When/Then: Error includes available fields
        expect(() =>
          requireStageOutput(workflowContext, "my-stage", "fieldC"),
        ).toThrow("Available fields: fieldA, fieldB");
      });

      it("should throw when accessing field on non-object output", () => {
        // Given: A workflow context with primitive output
        const workflowContext: Record<string, unknown> = {
          "primitive-stage": "just a string",
        };

        // When/Then: Accessing field on non-object throws
        expect(() =>
          requireStageOutput(workflowContext, "primitive-stage", "field"),
        ).toThrow("output is not an object, cannot access field 'field'");
      });

      it("should throw 'not an object' when accessing a field on null output", () => {
        // Given: A workflow context with null output
        // Note: requireStageOutput only treats `undefined` as missing
        // (matching ctx.require's semantics) — null is a defined-but-falsy
        // value, so it reaches the field-access check instead, same as
        // any other non-object output.
        const workflowContext: Record<string, unknown> = {
          "null-stage": null,
        };

        // When/Then: Accessing a field on null throws "not an object"
        expect(() =>
          requireStageOutput(workflowContext, "null-stage", "field"),
        ).toThrow("output is not an object, cannot access field 'field'");
      });
    });

    describe("falsy-but-defined outputs pass through (not treated as missing)", () => {
      it("should return 0 as a legitimate stage output", () => {
        // Given: A workflow context whose stage output is 0
        const workflowContext: Record<string, unknown> = {
          "count-stage": 0,
        };

        // When: I require the stage output
        const output = requireStageOutput<number>(
          workflowContext,
          "count-stage",
        );

        // Then: Returns 0, does not throw
        expect(output).toBe(0);
      });

      it("should return an empty string as a legitimate stage output", () => {
        // Given: A workflow context whose stage output is ""
        const workflowContext: Record<string, unknown> = {
          "text-stage": "",
        };

        // When: I require the stage output
        const output = requireStageOutput<string>(
          workflowContext,
          "text-stage",
        );

        // Then: Returns "", does not throw
        expect(output).toBe("");
      });

      it("should return false as a legitimate stage output", () => {
        // Given: A workflow context whose stage output is false
        const workflowContext: Record<string, unknown> = {
          "flag-stage": false,
        };

        // When: I require the stage output
        const output = requireStageOutput<boolean>(
          workflowContext,
          "flag-stage",
        );

        // Then: Returns false, does not throw
        expect(output).toBe(false);
      });

      it("should return null as a legitimate stage output", () => {
        // Given: A workflow context whose stage output is null
        const workflowContext: Record<string, unknown> = {
          "null-stage": null,
        };

        // When: I require the stage output (no field access)
        const output = requireStageOutput<null>(workflowContext, "null-stage");

        // Then: Returns null, does not throw
        expect(output).toBeNull();
      });

      it("should still throw only when output is actually undefined", () => {
        // Given: An empty workflow context
        const workflowContext: Record<string, unknown> = {};

        // When/Then: Requiring a genuinely-missing stage still throws
        expect(() =>
          requireStageOutput(workflowContext, "missing-stage"),
        ).toThrow("Missing output from required stage: missing-stage");
      });
    });
  });

  describe("real-world usage patterns", () => {
    it("should support typed extraction from workflow context", () => {
      // Given: A realistic workflow context
      interface ExtractionOutput {
        text: string;
        tables: Array<{ headers: string[]; rows: string[][] }>;
        metadata: { pageCount: number; wordCount: number };
      }

      interface GuidelinesOutput {
        guidelines: Array<{ id: string; text: string; priority: number }>;
      }

      const workflowContext: Record<string, unknown> = {
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
      const extraction = requireStageOutput<ExtractionOutput>(
        workflowContext,
        "pdf-extraction",
      );
      const guidelines = requireStageOutput<GuidelinesOutput["guidelines"]>(
        workflowContext,
        "guidelines",
        "guidelines",
      );

      // Then: Data is correctly typed and accessible
      expect(extraction.metadata.pageCount).toBe(10);
      expect(guidelines).toHaveLength(2);
      expect(guidelines[0]?.priority).toBe(1);
    });
  });
});
